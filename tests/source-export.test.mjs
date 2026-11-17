import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeBase } from '../dist/knowledge.js';
import { SourceExporter, embedBundleResources } from '../dist/source-export.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const knowledge = new KnowledgeBase();
// The invoice carries a bundled SVG logo, so embed it as export_definition does.
const invoice = () =>
  embedBundleResources(JSON.parse(knowledge.file(knowledge.example('business-invoice').definition)), knowledge);
for (const language of ['typescript', 'dotnet']) {
  test(`${language}: native export is deterministic, reflects edits and quotes user content`, () => {
    const definition = invoice();
    definition.metadata.title = 'Updated "invoice"\n${danger()} `backticks` \\ path';
    const exporter = new SourceExporter(knowledge, language);
    const source = exporter.export(definition);
    assert.equal(source, exporter.export(definition));
    assert.ok(source.includes(JSON.stringify(definition.metadata.title)));
    assert.match(source, language === 'dotnet' ? /new Table\(/ : /new B.Table\(/);
    assert.ok(!/fromDefinition|FromDefinition|JSON\.parse/.test(source));
  });
  test(`${language}: unrepresentable native definitions fail with actionable paths`, () => {
    const definition = invoice();
    definition.pages[0].margin = 123;
    assert.throws(
      () => new SourceExporter(knowledge, language).export(definition),
      e => e.issues[0].path === '/pages/0/margin'
    );
    delete definition.pages[0].margin;
    definition.settings.defaultTextStyle.fontFamily = '/fonts/Unknown.ttf';
    assert.throws(() => new SourceExporter(knowledge, language).export(definition), /explicit native font alias/);
  });
}

test('MCP exports all three formats from the current revision without source in context', async () => {
  const out = await mkdtemp(resolve(tmpdir(), 'bonniepdf-source-export-'));
  const client = new Client({ name: 'source-export-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js'), '--out-dir', out],
    stderr: 'pipe',
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    await client.connect(transport);
    const created = (await call('create_document', { exampleId: 'business-invoice' })).structuredContent;
    const documentId = created.documentId;
    await call('patch_document', {
      documentId,
      revision: 1,
      operations: [{ op: 'replace', path: '/metadata/title', value: 'Edited invoice native export' }],
    });
    const response = await call('export_definition', { documentId, format: 'all' });
    assert.ok(!response.isError);
    assert.equal(response.structuredContent.revision, 2);
    const artifacts = response.structuredContent.artifacts;
    assert.deepEqual(
      artifacts.map(a => a.format),
      ['json', 'typescript', 'dotnet']
    );
    assert.equal(response.content.filter(c => c.type === 'resource_link').length, 3);
    assert.ok(response.content.find(c => c.type === 'text').text.length < 2500);
    for (const artifact of artifacts)
      assert.match(await readFile(artifact.path, 'utf8'), /Edited invoice native export/);
    const defaultExport = await call('export_definition', { documentId });
    assert.equal(defaultExport.structuredContent.artifact.mimeType, 'application/json');
    const definition = JSON.parse(await readFile(defaultExport.structuredContent.artifact.path, 'utf8'));
    assert.equal(definition.metadata.title, 'Edited invoice native export');
    const single = await call('export_definition', { documentId, format: 'dotnet' });
    assert.match(single.structuredContent.artifact.path, /Program\.cs$/);
    await call('patch_document', {
      documentId,
      revision: 2,
      operations: [{ op: 'add', path: '/pages/0/margin', value: 123 }],
    });
    const before = await readdir(out);
    const failed = await call('export_definition', { documentId, format: 'all' });
    assert.equal(failed.isError, true);
    assert.match(failed.structuredContent.error.message, /first-page margin/);
    assert.deepEqual(await readdir(out), before);
    assert.ok(!(await call('export_definition', { documentId })).isError);
  } finally {
    await client.close();
  }
});
