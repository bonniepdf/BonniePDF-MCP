import { parentPort, workerData } from 'node:worker_threads';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings, isLicenseTier, FontManager } from '@bonniepdf/core';
import { fromDefinition } from '@bonniepdf/core/definition';
import { LIMITS } from './documents.js';

const job = workerData as {
  definition: unknown;
  mode: 'pdf' | 'preview';
  pages: number[];
  preflight?: boolean;
  resourceDir?: string;
  dataDir: string;
  license: string;
};

/**
 * Registers the faces every rendering path needs: the Liberation faces behind the
 * standard-14 names, and the bundled catalogue fonts under the `/fonts/…`
 * identifiers that example definitions use. Without the latter, those documents
 * silently fall back to Helvetica.
 */
export async function registerFonts(dataDir: string) {
  const liberation = resolve(
    dirname(fileURLToPath(import.meta.resolve('@bonniepdf/core/package.json'))),
    'assets/fonts'
  );
  for (const [file, family] of [
    ['Sans', 'liberation sans'],
    ['Serif', 'liberation serif'],
    ['Mono', 'liberation mono'],
  ]) {
    for (const [suffix, subfamily] of [
      ['Regular', 'regular'],
      ['Bold', 'bold'],
      ['Italic', 'italic'],
      ['BoldItalic', 'bolditalic'],
    ]) {
      const bytes = await readFile(resolve(liberation, `Liberation${file}-${suffix}.ttf`));
      FontManager.registerFont(bytes, {
        family,
        subfamily,
        identifier: `/fonts/liberation/Liberation${file}-${suffix}.ttf`,
      });
    }
  }
  const bundled = resolve(dataDir, 'fonts');
  for (const name of await readdir(bundled).catch(() => [] as string[])) {
    if (!/\.(?:ttf|otf)$/i.test(name)) continue;
    FontManager.registerFont(new Uint8Array(await readFile(resolve(bundled, name))), { identifier: `/fonts/${name}` });
  }
}

/** Reads the page count from the PDF page tree root (the largest `/Count`). */
export function pdfPageCount(bytes: Uint8Array): number | undefined {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const counts = [
    ...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g),
  ].map(m => Number(m[1] ?? m[2]));
  return counts.length ? Math.max(...counts) : undefined;
}

async function run() {
  if (!isLicenseTier(job.license)) throw new Error('Invalid BonniePDF licence declaration');
  settings.license = job.license;
  await registerFonts(job.dataDir);
  let total = 0;
  const resources = async (ref: string) => {
    let path: string;
    if (/^assets\/[a-f0-9]{64}$/.test(ref)) path = resolve(job.dataDir, ref);
    else {
      if (!job.resourceDir) throw new Error(`Resource '${ref}' is not in the bundle; configure --resource-dir.`);
      if (isAbsolute(ref) || /^[a-z]+:/i.test(ref)) throw new Error('Resource references must be relative files');
      const base = await realpath(job.resourceDir);
      path = await realpath(resolve(base, ref));
      const rel = relative(base, path);
      if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
        throw new Error('Resource escapes configured directory');
      }
    }
    const info = await stat(path);
    if (!info.isFile() || info.size > LIMITS.resourceBytes || total + info.size > LIMITS.resourceBytesTotal) {
      throw new Error('Resource size limit exceeded');
    }
    total += info.size;
    return new Uint8Array(await readFile(path));
  };
  const options = { strict: true, limits: LIMITS, resources };
  const diagnostic = (entries: readonly any[]) =>
    entries.map(({ severity, category, message, source }) => ({
      severity,
      category,
      message,
      ...(source ? { source } : {}),
    }));

  if (job.mode === 'pdf') {
    const doc = await fromDefinition(job.definition, options);
    const pdf = await doc.generateBytesAsync();
    if (pdf.length > 32_000_000) throw new Error('PDF artifact exceeds 32 MB');
    let pageCount = pdfPageCount(pdf);
    let report;
    // The SVG pass costs a second layout, so it runs only when a preflight report is
    // wanted or the page tree could not be read.
    if (job.preflight || pageCount === undefined) {
      total = 0;
      const svgDoc = await fromDefinition(job.definition, options);
      const rendered = await svgDoc.generateSvgDocumentAsync({ captureLayout: true, maxPages: LIMITS.pages + 1 });
      pageCount = rendered.pages.length;
      report = rendered.report;
    }
    if (pageCount! > LIMITS.pages) throw new Error(`Rendered document exceeds ${LIMITS.pages} pages`);
    return { pageCount, pdf, diagnostics: diagnostic(doc.diagnostics), report };
  }

  const doc = await fromDefinition(job.definition, options);
  const rendered = await doc.generateSvgDocumentAsync({ captureLayout: true, maxPages: LIMITS.pages + 1 });
  if (rendered.pages.length > LIMITS.pages) throw new Error(`Rendered document exceeds ${LIMITS.pages} pages`);
  if (job.pages.some(p => p >= rendered.pages.length)) {
    throw new Error(`Page index out of range; document has ${rendered.pages.length} pages`);
  }
  return {
    pageCount: rendered.pages.length,
    pages: job.pages.map(index => ({ index, svg: rendered.pages[index] })),
    fontFaceCss: rendered.fontFaceCss,
    snapshot: rendered.snapshot,
    report: rendered.report,
    diagnostics: diagnostic(doc.diagnostics),
  };
}

if (parentPort) {
  run()
    .then(value => parentPort!.postMessage({ value }))
    .catch(error => parentPort!.postMessage({ error: { message: error.message, issues: error.issues } }));
}
