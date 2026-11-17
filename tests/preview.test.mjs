import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, readFile, utimes, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { KnowledgeBase } from '../dist/knowledge.js';
import { Renderer } from '../dist/render.js';
import { renameFont, stripExternalReferences, rasterizeSvgPages } from '../dist/rasterize.js';
import { pdfPageCount } from '../dist/render-worker.js';

const k = new KnowledgeBase();
const example = id => JSON.parse(k.file(k.example(id).definition));
const PNG = '89504e47';

test('previews produce PNGs without a browser', async () => {
  const r = new Renderer(resolve('out/tests'));
  const preview = await r.render(example('business-invoice'), 'preview', [0], true);
  assert.deepEqual(preview.warnings, []);
  assert.equal(preview.previews[0].png.mimeType, 'image/png');
  assert.equal(Buffer.from(preview.previews[0].image, 'base64').subarray(0, 4).toString('hex'), PNG);
  assert.match(preview.previews[0].png.path, /[\\/]previews[\\/]/);
});

test('catalogue fonts referenced by /fonts/ identifiers are embedded, not replaced by Helvetica', async () => {
  const r = new Renderer(resolve('out/tests'));
  const definition = {
    version: 1,
    minorVersion: 0,
    pages: [
      {
        content: [
          { type: 'TextBlock', text: '😀', fontName: '/fonts/NotoEmoji-Regular.ttf', fontSize: 24 },
          { type: 'TextBlock', text: '∑', fontName: '/fonts/NotoSansMath-Regular.ttf', fontSize: 24 },
        ],
      },
    ],
  };
  const preview = await r.render(definition, 'preview', [0], false);
  const svg = await readFile(preview.previews[0].svg.path, 'utf8');
  assert.match(svg, /bpf-fonts-notoemoji-regular-ttf/);
  assert.match(svg, /bpf-fonts-notosansmath-regular-ttf/);
});

test('a page too large to rasterise keeps its SVG and reports a warning', async () => {
  const d = {
    version: 1,
    minorVersion: 0,
    settings: { pageSize: { width: 300, height: 3200 } },
    pages: [{ content: [{ type: 'TextBlock', text: 'Wide' }] }],
  };
  const r = new Renderer(resolve('out/tests'));
  const preview = await r.render(d, 'preview', [0], true);
  assert.equal(preview.previews.length, 1);
  assert.ok(preview.previews[0].svg.bytes > 0);
  assert.equal(preview.previews[0].png, undefined);
  assert.match(preview.warnings[0], /page 1 unavailable: Preview dimensions exceed/);
});

test('concurrent renders queue instead of failing', async () => {
  const r = new Renderer(resolve('out/tests'));
  const results = await Promise.all([
    r.render(example('first-pdf'), 'preview', [0], false),
    r.render(example('first-pdf'), 'pdf'),
    r.render(example('simple-document'), 'preview', [0], true),
  ]);
  assert.equal(results.length, 3);
  assert.ok(results[1].artifact.bytes > 100);
});

test('the PDF page count is read from the page tree; preflight is optional', async () => {
  const r = new Renderer(resolve('out/tests'));
  const preview = await r.render(example('lists'), 'preview', [0], false);
  const pdf = await r.render(example('lists'), 'pdf');
  assert.equal(pdf.pageCount, preview.pageCount);
  assert.equal(pdf.report, undefined);
  assert.equal(pdfPageCount(await readFile(pdf.artifact.path)), preview.pageCount);
  const checked = await r.render(example('lists'), 'pdf', [0], false, undefined, { preflight: true });
  assert.equal(typeof checked.report.passed, 'boolean');
});

test('expired previews are swept; documents are kept unless a TTL is set', async () => {
  const out = resolve('out/tests/sweep');
  const r = new Renderer(out, { previewTtlHours: 1 });
  const old = resolve(out, 'previews', randomUUID());
  const doc = resolve(out, randomUUID());
  const other = resolve(out, 'previews', 'not-mine');
  for (const dir of [old, doc, other]) await mkdir(dir, { recursive: true });
  const past = new Date(Date.now() - 2 * 3_600_000);
  for (const dir of [old, doc, other]) await utimes(dir, past, past);
  await r.sweep();
  const previews = await readdir(resolve(out, 'previews'));
  assert.ok(!previews.includes(old.split(/[\\/]/).pop()));
  assert.ok(previews.includes('not-mine'), 'directories the server did not create are never removed');
  assert.ok((await readdir(out)).includes(doc.split(/[\\/]/).pop()));
});

test('renamed fonts carry the private family and previews never read external references', async () => {
  const font = k.file('fonts/NotoSans-Regular.ttf');
  const renamed = renameFont(font, 'bpf-test-family');
  assert.equal(renamed.readUInt32BE(0), font.readUInt32BE(0));
  assert.ok(renamed.includes(Buffer.from('bpf-test-family', 'utf16le').swap16()));
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///C:/secret.png"/><image xlink:href=\'../x.png\'/><use href="#a"/><image href="data:image/png;base64,AA"/></svg>';
  const safe = stripExternalReferences(svg);
  assert.ok(!safe.includes('secret') && !safe.includes('x.png'));
  assert.ok(safe.includes('href="#a"') && safe.includes('href="data:'));
  await assert.rejects(rasterizeSvgPages(['<svg width="2100" height="10"></svg>'], ''), /exceed/);
  await writeFile(resolve('out/tests/renamed.ttf'), renamed);
});
