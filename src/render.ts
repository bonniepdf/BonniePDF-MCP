import { Worker } from 'node:worker_threads';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_ROOT } from './knowledge.js';
import { rasterizeSvgPages } from './rasterize.js';

export interface Artifact {
  id: string;
  path: string;
  uri: string;
  mimeType: string;
  bytes: number;
}
export interface RendererOptions {
  resourceDir?: string;
  license?: string;
  timeoutMs?: number;
  /** Renders allowed to wait behind the running one before new requests are refused. */
  maxQueued?: number;
  /** Preview artifacts (SVG, PNG, layout) older than this are removed. 0 keeps them. */
  previewTtlHours?: number;
  /** PDF and exported definitions older than this are removed. 0 (the default) keeps them. */
  artifactTtlHours?: number;
}
export interface PreviewPage {
  index: number;
  svg: Artifact;
  png?: Artifact;
  image?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR = 3_600_000;

export class Renderer {
  readonly resourceDir?: string;
  readonly license: string;
  readonly timeoutMs: number;
  private readonly maxQueued: number;
  private readonly previewTtlHours: number;
  private readonly artifactTtlHours: number;
  private readonly artifacts = new Map<string, Artifact>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lastSweep = 0;

  constructor(
    readonly outDir: string,
    options: RendererOptions | string = {},
    license?: string,
    timeoutMs?: number
  ) {
    // The positional form (outDir, resourceDir, license, timeoutMs) is kept for callers and tests.
    const o = typeof options === 'string' ? { resourceDir: options, license, timeoutMs } : options;
    this.resourceDir = o.resourceDir;
    this.license = o.license ?? license ?? 'evaluation';
    this.timeoutMs = o.timeoutMs ?? timeoutMs ?? 45_000;
    this.maxQueued = o.maxQueued ?? 4;
    this.previewTtlHours = o.previewTtlHours ?? 24;
    this.artifactTtlHours = o.artifactTtlHours ?? 0;
  }

  async save(name: string, data: string | Uint8Array, mimeType: string, kind: 'document' | 'preview' = 'document') {
    const id = randomUUID();
    const dir = resolve(this.outDir, ...(kind === 'preview' ? ['previews', id] : [id]));
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, name);
    await writeFile(path, data);
    const artifact: Artifact = {
      id,
      path,
      uri: `bonniepdf://artifacts/${id}`,
      mimeType,
      bytes: Buffer.byteLength(data),
    };
    this.artifacts.set(id, artifact);
    return artifact;
  }

  async readArtifact(id: string) {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error('Unknown artifact');
    return { ...artifact, data: await readFile(artifact.path) };
  }

  /** Removes expired artifact directories. Only UUID-named directories this server creates are touched. */
  async sweep(now = Date.now()) {
    const removeOlder = async (dir: string, hours: number) => {
      if (!hours) return;
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
        const path = resolve(dir, entry.name);
        const info = await stat(path).catch(() => undefined);
        if (info && now - info.mtimeMs > hours * HOUR) {
          await rm(path, { recursive: true, force: true });
          this.artifacts.delete(entry.name);
        }
      }
    };
    await removeOlder(resolve(this.outDir, 'previews'), this.previewTtlHours);
    await removeOlder(this.outDir, this.artifactTtlHours);
  }

  /** Renders run one at a time; up to `maxQueued` further requests wait their turn. */
  render(
    definition: unknown,
    mode: 'pdf' | 'preview',
    pages = [0],
    includeImages = true,
    signal?: AbortSignal,
    options: { preflight?: boolean; scale?: number } = {}
  ) {
    if (this.queued > this.maxQueued) throw new Error('Too many renders are waiting; retry after one finishes');
    this.queued++;
    const run = this.tail.then(() => {
      if (signal?.aborted) throw new Error('Rendering cancelled');
      return this.renderNow(definition, mode, pages, includeImages, signal, options);
    });
    const settled = run.finally(() => this.queued--);
    this.tail = settled.catch(() => undefined);
    return settled;
  }

  private async renderNow(
    definition: unknown,
    mode: 'pdf' | 'preview',
    pages: number[],
    includeImages: boolean,
    signal: AbortSignal | undefined,
    options: { preflight?: boolean; scale?: number }
  ) {
    if (Date.now() - this.lastSweep > HOUR) {
      this.lastSweep = Date.now();
      await this.sweep().catch(error => console.error(`Artifact cleanup failed: ${error.message}`));
    }
    const rendered = await this.job({ definition, mode, pages, preflight: options.preflight }, signal);
    const report = rendered.report
      ? {
          passed: rendered.report.passed,
          errorCount: rendered.report.errorCount,
          warningCount: rendered.report.warningCount,
          infoCount: rendered.report.infoCount,
          findings: rendered.report.findings.slice(0, 25),
          truncated: rendered.report.findings.length > 25,
          advisory: true,
        }
      : undefined;
    if (mode === 'pdf') {
      const artifact = await this.save('document.pdf', rendered.pdf, 'application/pdf');
      return { pageCount: rendered.pageCount as number, artifact, diagnostics: rendered.diagnostics, report };
    }

    const snapshot = await this.save(
      'layout.json',
      JSON.stringify({ snapshot: rendered.snapshot, report: rendered.report }),
      'application/json',
      'preview'
    );
    const previews: PreviewPage[] = [];
    const warnings: string[] = [];
    for (const page of rendered.pages as { index: number; svg: string }[]) {
      if (signal?.aborted) throw new Error('Preview cancelled');
      // The saved SVG carries its fonts so it opens correctly in any browser.
      const standalone = page.svg.replace(/(<svg\b[^>]*>)/, `$1<style>${rendered.fontFaceCss}</style>`);
      const item: PreviewPage = {
        index: page.index,
        svg: await this.save(`page-${page.index + 1}.svg`, standalone, 'image/svg+xml', 'preview'),
      };
      if (includeImages) {
        // A failed raster leaves this page's SVG and every other page intact.
        try {
          const [png] = await rasterizeSvgPages([page.svg], rendered.fontFaceCss, { scale: options.scale, signal });
          item.png = await this.save(`page-${page.index + 1}.png`, png, 'image/png', 'preview');
          item.image = png.toString('base64');
        } catch (error) {
          if (signal?.aborted) throw new Error('Preview cancelled');
          warnings.push(
            `PNG preview of page ${page.index + 1} unavailable: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      previews.push(item);
    }
    return {
      pageCount: rendered.pageCount as number,
      previews,
      snapshot,
      report,
      diagnostics: rendered.diagnostics,
      warnings,
    };
  }

  private job(input: object, signal?: AbortSignal): Promise<any> {
    return new Promise((resolveJob, reject) => {
      const worker = new Worker(new URL('./render-worker.js', import.meta.url), {
        workerData: { ...input, resourceDir: this.resourceDir, dataDir: DATA_ROOT, license: this.license },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      let done = false;
      const finish = (error?: Error, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void worker.terminate();
        if (error) reject(error);
        else resolveJob(value);
      };
      const timer = setTimeout(() => finish(new Error(`Rendering exceeded ${this.timeoutMs} ms`)), this.timeoutMs);
      const abort = () => finish(new Error('Rendering cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      worker.once('message', ({ value, error }) =>
        finish(error ? Object.assign(new Error(error.message), { issues: error.issues }) : undefined, value)
      );
      worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
      worker.once('exit', code => {
        if (!done) finish(new Error(`Render worker exited (${code})`));
      });
    });
  }
}
