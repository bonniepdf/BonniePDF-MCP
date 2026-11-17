import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const client = new Client({ name: 'efficiency-benchmark', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    resolve(root, 'dist/index.js'),
    '--out-dir',
    resolve(root, 'out/efficiency/artifacts'),
    '--metrics-file',
    resolve(root, 'out/efficiency/measurements.jsonl'),
  ],
  stderr: 'pipe',
});
const rounds = [];
let current;
async function call(name, args) {
  const started = performance.now();
  const response = await client.callTool({ name, arguments: args }, { timeout: 90000 });
  assert.ok(!response.isError, JSON.stringify(response.structuredContent));
  current.calls.push({
    tool: name,
    durationMs: Math.round(performance.now() - started),
    textChars: response.content.filter(c => c.type === 'text').reduce((n, c) => n + c.text.length, 0),
    imageBytes: response.content
      .filter(c => c.type === 'image')
      .reduce((n, c) => n + Buffer.from(c.data, 'base64').length, 0),
  });
  return response.structuredContent;
}
try {
  await client.connect(transport);
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const combined of repeat % 2 ? [true, false] : [false, true]) {
      current = { repeat, workflow: combined ? 'combined' : 'separate', calls: [] };
      rounds.push(current);
      const started = performance.now();
      const doc = await call('create_document', {
        exampleId: 'business-invoice',
        ...(combined ? { output: 'pdf-and-preview' } : { outlineLimit: 25 }),
      });
      if (!combined) {
        await call('preview_definition', { documentId: doc.documentId });
        await call('render_pdf', { documentId: doc.documentId });
      } else {
        assert.equal(doc.pageCount, doc.preview.pageCount);
        assert.ok(doc.artifact.bytes > 100);
      }
      current.durationMs = Math.round(performance.now() - started);
      current.textChars = current.calls.reduce((n, c) => n + c.textChars, 0);
      await client.callTool({ name: 'delete_document', arguments: { documentId: doc.documentId } });
    }
  }
  current = { workflow: 'compact-outline', calls: [] };
  rounds.push(current);
  await call('create_document', { exampleId: 'business-invoice' });
  const report = {
    rounds,
    note: 'Measured protocol calls, text characters, image bytes and wall time. Not token counts. Excludes model thinking, network and client image processing.',
  };
  await mkdir(resolve(root, 'out/efficiency'), { recursive: true });
  await writeFile(resolve(root, 'out/efficiency/report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
