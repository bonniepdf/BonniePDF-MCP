import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'dist/index.js'), '--out-dir', resolve(root, 'out/smoke')],
  stderr: 'pipe',
});
let logs = '';
transport.stderr?.on('data', chunk => {
  logs = (logs + chunk).slice(-6000);
});
const client = new Client({ name: 'bonniepdf-smoke', version: '0.1.0' });
const counts = [];
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, { timeout: 90000 });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  const data = result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
  counts.push({
    tool: name,
    inputChars: JSON.stringify(args).length,
    textChars: result.content.filter(c => c.type === 'text').reduce((n, c) => n + c.text.length, 0),
    images: result.content.filter(c => c.type === 'image').length,
  });
  return { data, result };
};
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(t => t.name === 'patch_document'));
  const resources = await client.listResources();
  assert.ok(resources.resources.some(r => r.uri === 'bonniepdf://guide'));
  const guide = await client.readResource({ uri: 'bonniepdf://guide' });
  assert.ok(guide.contents[0].text.includes('BonniePDF'));
  const schema = await client.readResource({ uri: 'bonniepdf://schema/definition/1.0' });
  assert.equal(JSON.parse(schema.contents[0].text).properties.version.const, 1);
  const { data: caps } = await call('get_capabilities');
  assert.ok(caps.editableExamples > 0);
  const { data: search } = await call('search_docs', { query: 'invoice', kind: 'examples', editableOnly: true });
  assert.ok(search.results.length);
  const { data: doc } = await call('get_doc', { id: 'typescript/text-block', maxChars: 1000 });
  assert.ok(doc.text.includes('TextBlock'));
  const { data: element } = await call('describe_element', { name: 'TextBlock' });
  assert.ok(element.keys.fontSize);
  const { data: pageSize } = await call('describe_element', { name: 'Page', property: 'size' });
  assert.ok(pageSize.schema.oneOf[0].enum.includes('a4'));
  const { data: stackChildren } = await call('describe_element', { name: 'HorizontalStack', property: 'children' });
  assert.ok(stackChildren.$defs.StackChild.oneOf[1].required.includes('weight'));
  const unknownProperty = await client.callTool({
    name: 'describe_element',
    arguments: { name: 'Page', property: 'Size' },
  });
  assert.equal(unknownProperty.isError, true);
  const { data: source } = await call('get_example', { exampleId: 'area-chart', view: 'typescript', maxChars: 1000 });
  assert.ok(source.text.includes('@bonniepdf/core'));
  const { data: created } = await call('create_document', { exampleId: 'business-invoice' });
  assert.equal(created.valid, true);
  const { data: edited } = await call('patch_document', {
    documentId: created.documentId,
    revision: 1,
    operations: [{ op: 'replace', path: '/metadata/title', value: 'MCP Verification Invoice' }],
  });
  assert.equal(edited.revision, 2);
  const { data: read } = await call('get_document', { documentId: created.documentId, pointer: '/metadata/title' });
  assert.equal(JSON.parse(read.text), 'MCP Verification Invoice');
  const { data: found } = await call('find_elements', { documentId: created.documentId, type: 'Table', limit: 1 });
  assert.ok(found.total >= 1);
  const { data: listed } = await call('list_documents');
  assert.ok(listed.documents.some(d => d.documentId === created.documentId));
  const { data: valid } = await call('validate_definition', { documentId: created.documentId });
  assert.equal(valid.valid, true);
  const { data: preview, result: previewResult } = await call('preview_definition', {
    documentId: created.documentId,
    pages: [0],
    includeImages: true,
  });
  assert.equal(preview.warnings.length, 0);
  assert.ok(previewResult.content.some(c => c.type === 'image'));
  const snapshot = JSON.parse(await readFile(preview.snapshot.path, 'utf8'));
  function marked(v) {
    return !!v.sourceId || v.children?.some(marked);
  }
  assert.ok(marked(snapshot.snapshot.root));
  const { data: combined, result: combinedResult } = await call('patch_and_preview', {
    documentId: created.documentId,
    revision: 2,
    operations: [
      { op: 'test', path: '/metadata/title', value: 'MCP Verification Invoice' },
      { op: 'replace', path: '/metadata/subject', value: 'Smoke test' },
    ],
    includeImages: true,
  });
  assert.equal(combined.revision, 3);
  assert.ok(combinedResult.content.some(c => c.type === 'image'));
  const stale = await client.callTool({
    name: 'patch_and_preview',
    arguments: {
      documentId: created.documentId,
      revision: 2,
      operations: [{ op: 'remove', path: '/metadata/subject' }],
    },
  });
  assert.equal(stale.isError, true);
  const { data: pdf } = await call('render_pdf', { documentId: created.documentId });
  assert.equal((await readFile(pdf.artifact.path)).subarray(0, 5).toString(), '%PDF-');
  const resource = await client.readResource({ uri: pdf.artifact.uri });
  assert.equal(Buffer.from(resource.contents[0].blob, 'base64').subarray(0, 5).toString(), '%PDF-');
  const { data: exported } = await call('export_definition', { documentId: created.documentId });
  assert.equal(JSON.parse(await readFile(exported.artifact.path, 'utf8')).metadata.title, 'MCP Verification Invoice');
  const invalid = await client.callTool({
    name: 'patch_document',
    arguments: { documentId: created.documentId, revision: 1, operations: [{ op: 'remove', path: '/metadata' }] },
  });
  assert.equal(invalid.isError, true);
  const malformed = await client.callTool({ name: 'preview_definition', arguments: { documentId: 'bad' } });
  assert.equal(malformed.isError, true);
  await call('delete_document', { documentId: created.documentId });
  const { data: images } = await call('create_document', { exampleId: 'images' });
  const { data: portable } = await call('export_definition', { documentId: images.documentId });
  const portableDefinition = JSON.parse(await readFile(portable.artifact.path, 'utf8'));
  assert.ok(Object.values(portableDefinition.resources).every(r => r.data && !r.ref));
  assert.equal((await call('validate_definition', { definition: portableDefinition })).data.valid, true);
  await call('delete_document', { documentId: images.documentId });
  const { data: rotationSchema } = await call('describe_element', { name: 'Rotate', property: 'mode' });
  assert.ok(JSON.stringify(rotationSchema).includes('constrained'));
  const rotationDefinition = JSON.parse(
    await readFile(resolve(root, '../BonniePDF-Spec/fixtures/document-definition/valid/rotation.json'), 'utf8')
  );
  const { data: rotated } = await call('create_document', { definition: rotationDefinition });
  assert.equal(
    (await call('preview_definition', { documentId: rotated.documentId, includeImages: false })).data.pageCount,
    1
  );
  assert.equal((await call('render_pdf', { documentId: rotated.documentId })).data.pageCount, 1);
  await call('delete_document', { documentId: rotated.documentId });
  for (const name of ['Flip', 'Translate']) {
    const { data: schema } = await call('describe_element', { name });
    assert.ok(JSON.stringify(schema).includes('contentWidth'));
  }
  const transformsDefinition = JSON.parse(
    await readFile(
      resolve(root, '../BonniePDF-Spec/fixtures/document-definition/valid/transforms.json'),
      'utf8'
    )
  );
  const { data: transformed } = await call('create_document', { definition: transformsDefinition });
  assert.equal(
    (await call('preview_definition', { documentId: transformed.documentId, includeImages: false })).data.pageCount,
    1
  );
  assert.equal((await call('render_pdf', { documentId: transformed.documentId })).data.pageCount, 1);
  await call('delete_document', { documentId: transformed.documentId });
  // The lite profile exposes a smaller tool set for small local models.
  const liteTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'dist/index.js'), '--profile', 'lite', '--out-dir', resolve(root, 'out/smoke')],
    stderr: 'pipe',
  });
  const lite = new Client({ name: 'bonniepdf-smoke-lite', version: '0.1.0' });
  await lite.connect(liteTransport);
  const liteTools = (await lite.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(liteTools, [
    'create_document',
    'describe_element',
    'find_elements',
    'get_document',
    'patch_and_preview',
    'render_pdf',
    'search_docs',
  ]);
  const liteSearch = await lite.callTool({ name: 'search_docs', arguments: { query: 'invoice' } });
  assert.ok(liteSearch.structuredContent.results.every(r => r.kind === 'example' && r.editable));
  await lite.close();
  await liteTransport.close();
  const report = {
    liteTools: liteTools.length,
    tools: tools.tools.length,
    examples: caps.examples,
    editableExamples: caps.editableExamples,
    referencePages: caps.referencePages,
    pageCount: pdf.pageCount,
    pdf: pdf.artifact.path,
    preview: preview.previews[0].png.path,
    counts,
    note: 'Character counts are a diagnostic proxy, not measured token savings.',
  };
  await mkdir(resolve(root, 'out'), { recursive: true });
  await writeFile(resolve(root, 'out/smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await client.close();
  await transport.close();
}
