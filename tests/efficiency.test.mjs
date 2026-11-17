import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

for (const profile of ['full', 'lite']) {
  test(`${profile}: combined rendering, compact outlines, batched schemas and private measurements`, async () => {
    const out = await mkdtemp(resolve(tmpdir(), 'bonniepdf-efficiency-'));
    const metrics = resolve(out, 'metrics.jsonl');
    const client = new Client({ name: 'efficiency-test', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js'), '--out-dir', out, '--profile', profile, '--metrics-file', metrics],
      stderr: 'pipe',
    });
    const call = (name, args) => client.callTool({ name, arguments: args }, { timeout: 90000 });
    try {
      await client.connect(transport);
      const outline = (await call('create_document', { exampleId: 'business-invoice' })).structuredContent;
      assert.equal(outline.outline.length, 8);
      assert.equal(outline.outlineTruncated, true);
      assert.match(outline.hint, /find_elements/);
      const schemas = await call('describe_element', { names: ['TextBlock', 'Container', 'TextBlock'] });
      assert.deepEqual(
        schemas.structuredContent.elements.map(e => e.name),
        ['TextBlock', 'Container']
      );
      const conflict = await call('describe_element', { names: ['TextBlock'], name: 'Page' });
      assert.equal(conflict.isError, true);
      const definition = {
        version: 1,
        minorVersion: 0,
        pages: [{ content: [{ type: 'TextBlock', text: 'PRIVATE_CONTENT_SENTINEL' }] }],
      };
      const combined = await call('create_document', { definition, output: 'pdf-and-preview' });
      assert.ok(!combined.isError);
      const data = combined.structuredContent;
      assert.equal(data.pageCount, 1);
      assert.equal(data.preview.revision, data.revision);
      assert.equal(combined.content.filter(c => c.type === 'image').length, 1);
      assert.ok(combined.content.some(c => c.type === 'resource_link'));
      assert.equal((await readFile(data.artifact.path)).subarray(0, 5).toString(), '%PDF-');
      const recovered = await call('create_document', { definition, output: 'preview', pages: [99] });
      assert.equal(recovered.isError, true);
      assert.match(recovered.structuredContent.hint, /Creation succeeded/);
      const retry = await call('render_pdf', { documentId: recovered.structuredContent.documentId });
      assert.ok(!retry.isError);
      const invalid = await call('create_document', { definition: { version: 99 }, output: 'pdf' });
      assert.equal(invalid.isError, true);
      const lines = (await readFile(metrics, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(lines.length, 7);
      assert.ok(lines.every(l => l.durationMs >= 0 && l.textBytes > 0));
      assert.ok(lines.some(l => l.imageBytes > 0));
      assert.ok(!JSON.stringify(lines).includes('PRIVATE_CONTENT_SENTINEL'));
      assert.ok(!JSON.stringify(lines).includes(out));
    } finally {
      await client.close();
    }
  });
}
