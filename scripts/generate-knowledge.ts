import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { resolve, relative, basename, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { settings, FontManager } from '@bonniepdf/core';
import { toDefinition, fromDefinition, validateDefinition } from '@bonniepdf/core/definition';
import { registerBundledFonts } from '../../BonniePDF-TypeScript/examples/scripts/register-bundled-fonts.ts';
import type { ExampleEntry, DocEntry } from '../src/types.js';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(import.meta.dirname, '../data');
const check = process.argv.includes('--check');
// Examples containing the current time need a reproducible fixture clock. This is
// confined to the build process; the MCP and rendering workers use the real clock.
const exampleClock = '2026-01-01T12:00:00.000Z';
const SystemDate = globalThis.Date;
const epoch = SystemDate.parse(exampleClock);
process.env.TZ = 'UTC';
globalThis.Date = new Proxy(SystemDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [epoch], newTarget);
  },
  apply() {
    return new SystemDate(epoch).toString();
  },
  get(target, key, receiver) {
    return key === 'now' ? () => epoch : Reflect.get(target, key, receiver);
  },
});
const { examples } = await import('@bonniepdf/examples');
settings.license = 'evaluation';
registerBundledFonts();
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const files = new Map<string, Uint8Array | string>();
// Catalogue examples name fonts by their site path (/fonts/…). Register the same
// files under those identifiers so definitions are verified with the real faces,
// and bundle them (with their licence) so the server renders them identically.
const fontDir = resolve(root, 'BonniePDF-TypeScript/examples/assets/fonts');
for (const name of (await readdir(fontDir)).sort()) {
  const bytes = new Uint8Array(await readFile(resolve(fontDir, name)));
  const isFont = /\.(?:ttf|otf)$/i.test(name);
  if (isFont) FontManager.registerFont(bytes, { identifier: `/fonts/${name}` });
  if (isFont || name === 'OFL.txt') files.set(`fonts/${name}`, bytes);
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function walk(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'bin' || entry.name === 'obj') continue;
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(full)));
    else result.push(full);
  }
  return result;
}
const sourceFiles = await walk(resolve(root, 'BonniePDF-TypeScript/examples/src'));
const csFiles = await walk(resolve(root, 'BonniePDF-NET/Examples'));
const sourceIndex = await readFile(resolve(root, 'BonniePDF-TypeScript/examples/src/index.ts'), 'utf8');
const imports = [...sourceIndex.matchAll(/import \{ generate as (\w+) \} from '(.+)'/g)];
const sourceById = new Map<string, string>();
for (const block of sourceIndex.split(/\n\s*\{\s*\n\s*id:/).slice(1)) {
  const id = block.match(/^\s*'([^']+)'/)?.[1];
  const fn = block.match(/generate:\s*(\w+)/)?.[1];
  const imp = imports.find(m => m[1] === fn);
  if (id && imp) sourceById.set(id, resolve(root, 'BonniePDF-TypeScript/examples/src', imp[2] + '.ts'));
}
const catalogue: ExampleEntry[] = [];
for (const example of examples.filter(e => !e.variantOf)) {
  const entry: ExampleEntry = {
    id: example.id,
    name: example.name,
    description: example.description,
    category: example.category,
    tier: example.gallery === false ? 'conformance' : (example.tier ?? 'recipe'),
    capabilities: example.capabilities ?? [],
    industries: example.industries ?? [],
    ...(example.documentType ? { documentType: example.documentType } : {}),
    source: {},
    notes: [],
  };
  const tsSource = sourceById.get(example.id) ?? sourceFiles.find(f => basename(f) === example.id + '.ts');
  if (tsSource) {
    entry.source.typescript = `sources/${example.id}.ts`;
    files.set(entry.source.typescript, await readFile(tsSource));
  }
  const netSource = example.dotnetClass && csFiles.find(f => basename(f) === example.dotnetClass + '.cs');
  if (netSource) {
    entry.source.dotnet = `sources/${example.id}.cs`;
    files.set(entry.source.dotnet, await readFile(netSource));
  }
  try {
    const assets = new Map<string, Uint8Array>();
    for (const asset of example.requiredAssets ?? []) {
      assets.set(asset, await readFile(resolve(root, 'BonniePDF-TypeScript/examples/assets', asset)));
    }
    const original = example.generate(assets);
    const written = await toDefinition(original, {
      onUnrepresentable: 'error',
      resourceRef(resource) {
        const ref = `assets/${hash(resource.bytes)}`;
        files.set(ref, resource.bytes);
        return ref;
      },
    });
    entry.notes = written.notes;
    // A removed password changes how a security example behaves. Keep it source-only.
    if (entry.notes.length) throw new Error('Export has notes; use the original source for faithful behaviour.');
    const definition = written.definition;
    const valid = validateDefinition(definition, { strict: true });
    if (!valid.valid) throw new Error(JSON.stringify(valid.errors));
    const rebuilt = await fromDefinition(definition, { strict: true, resources: ref => files.get(ref) as Uint8Array });
    const roundTrip = await toDefinition(rebuilt, {
      onUnrepresentable: 'error',
      resourceRef: resource => `assets/${hash(resource.bytes)}`,
    });
    const canonical = (v: unknown): string =>
      JSON.stringify(v, (_, x) =>
        x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
          : x
      );
    if (canonical(definition) !== canonical(roundTrip.definition)) throw new Error('Canonical round trip differs');
    // A fixed clone must not turn run-specific measurements or other changing
    // content into a reusable claim. Keep the original source for those examples.
    const repeated = await toDefinition(example.generate(assets), {
      onUnrepresentable: 'error',
      resourceRef: resource => `assets/${hash(resource.bytes)}`,
    });
    if (canonical(definition) !== canonical(repeated.definition))
      throw new Error('Repeated generation changes document content; run the original source for current results.');
    const pdf = await rebuilt.generateBytesAsync();
    if (pdf.length < 100 || Buffer.from(pdf.subarray(0, 5)).toString() !== '%PDF-')
      throw new Error('Invalid PDF output');
    const rebuiltSvg = await rebuilt.generateSvgPagesAsync({ maxPages: 1 });
    const originalSvg = await original.generateSvgPagesAsync({ maxPages: 1 });
    if (JSON.stringify(rebuiltSvg) !== JSON.stringify(originalSvg))
      throw new Error('First-page SVG differs from the source example');
    entry.definition = `definitions/${example.id}.json`;
    entry.verification = { strict: true, pdf: true, svg: true, canonicalRoundTrip: true };
    files.set(entry.definition, json(definition));
  } catch (error) {
    entry.unavailable = error instanceof Error ? error.message : String(error);
  }
  catalogue.push(entry);
  console.error(`${entry.definition ? 'definition' : 'source only'}: ${entry.id}`);
}

// Consume only the generated public reference pages, not private guides or strategic prose.
const docs: DocEntry[] = [];
for (const language of ['typescript', 'dotnet']) {
  const dir = resolve(root, `BonniePDF-Website/src/pages/docs/${language}/reference`);
  for (const file of await walk(dir)) {
    if (!file.endsWith('.md')) continue;
    const raw = await readFile(file, 'utf8');
    if (!/^generated: true$/m.test(raw)) continue;
    const slug = relative(dir, file).replaceAll('\\', '/').replace(/\.md$/, '');
    const title = raw.match(/^title: "(.*)"$/m)?.[1] ?? slug;
    const text = raw
      .replace(/^---[\s\S]*?---\s*/, '')
      .replace(/<!--[^]*?-->/g, '')
      .trim();
    docs.push({
      id: `${language}/${slug}`,
      title,
      language,
      url: `https://www.bonniepdf.dev/docs/${language}/reference/${slug}`,
      text,
    });
  }
}
// This is the explicitly published schema artifact, not the private specification prose.
const schema = await readFile(resolve(root, 'BonniePDF-Spec/schema/published/1.0.json'));
files.set('schema.json', schema);
const coreVersion = JSON.parse(await readFile(resolve(root, 'BonniePDF-TypeScript/core/package.json'), 'utf8')).version;
const elementSource = await readFile(
  resolve(root, 'BonniePDF-TypeScript/core/src/Definition/ElementDescription.ts'),
  'utf8'
);
const description = JSON.parse(
  elementSource
    .slice(elementSource.indexOf('= {') + 2)
    .trim()
    .replace(/;$/, '')
);
delete description.$comment;
files.set('elements.json', json(description));
const body = {
  format: 1,
  coreVersion,
  exampleClock,
  definitionVersion: `${description.definition.version}.${description.definition.minorVersion}`,
  examples: catalogue,
  docs,
};
const fingerprint = createHash('sha256').update(json(body));
for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b)))
  fingerprint.update(name).update(content);
files.set('knowledge.json', json({ ...body, hash: fingerprint.digest('hex') }));
files.set(
  'manifest.json',
  json(
    Object.fromEntries(
      [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => [name, hash(content)])
    )
  )
);
let changed = 0;
for (const [name, content] of files) {
  const path = resolve(out, name);
  const bytes = Buffer.from(content);
  let same = false;
  try {
    same = bytes.equals(await readFile(path));
  } catch {}
  if (!same) {
    changed++;
    if (check) console.error(`stale: ${name}`);
    if (!check) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
  }
}
const existingFiles = await walk(out).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
for (const path of existingFiles) {
  const name = relative(out, path).replaceAll('\\', '/');
  if (!files.has(name)) {
    changed++;
    // Only remove generated files after confirming the exact path is inside data/.
    if (!check && !name.startsWith('../') && !isAbsolute(name)) await unlink(path);
  }
}
console.error(
  `${catalogue.length} examples; ${catalogue.filter(e => e.definition).length} verified definitions; ${docs.length} reference pages; ${changed} changed files.`
);
if (check && changed) process.exitCode = 1;
