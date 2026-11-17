import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DocumentStore } from '../dist/documents.js';
import { KnowledgeBase, excerptAround, tokenize } from '../dist/knowledge.js';

const definition = () => ({
  version: 1,
  minorVersion: 0,
  pages: [
    {
      content: [
        { type: 'Heading', text: 'Quarterly Report', level: 1 },
        { type: 'TextBlock', text: 'Revenue grew strongly.' },
        { type: 'TextBlock', text: 'Costs were flat.' },
      ],
    },
  ],
});

test('find_elements locates elements by text, type and id', () => {
  const store = new DocumentStore();
  const { documentId } = store.create(definition());
  const byText = store.find(documentId, { text: 'revenue' });
  assert.equal(byText.total, 1);
  assert.equal(byText.matches[0].pointer, '/pages/0/content/1');
  assert.equal(byText.matches[0].text, 'Revenue grew strongly.');
  assert.equal(store.find(documentId, { type: 'textblock' }).total, 2);
  assert.equal(store.find(documentId, { id: 'mcp-1' }).matches[0].type, 'Heading');
  assert.equal(store.find(documentId, { type: 'TextBlock', limit: 1 }).truncated, true);
});

test('#elementId paths address elements without knowing their position', () => {
  const store = new DocumentStore();
  const { documentId } = store.create(definition());
  const id = store.find(documentId, { text: 'Costs' }).matches[0].id;
  const patched = store.patch(documentId, 1, [{ op: 'replace', path: `#${id}/text`, value: 'Costs fell.' }]);
  assert.equal(patched.revision, 2);
  assert.equal(store.read(documentId, `#${id}/text`).value, 'Costs fell.');
  assert.equal(store.read(documentId, `#${id}`).pointer, '/pages/0/content/2');
  assert.throws(() => store.read(documentId, '#missing'), /No element has id/);
});

test('move, copy and test operations follow RFC 6902', () => {
  const store = new DocumentStore();
  const { documentId } = store.create(definition());
  store.patch(documentId, 1, [{ op: 'move', from: '/pages/0/content/2', path: '/pages/0/content/1' }]);
  assert.equal(store.read(documentId, '/pages/0/content/1/text').value, 'Costs were flat.');
  store.patch(documentId, 2, [{ op: 'copy', from: '/pages/0/content/0', path: '/pages/0/content/-' }]);
  const copies = store.find(documentId, { text: 'Quarterly' }).matches;
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].id, copies[1].id, 'a copy receives a fresh unique id');
  assert.throws(
    () =>
      store.patch(documentId, 3, [
        { op: 'test', path: '/pages/0/content/0/text', value: 'Other' },
        { op: 'remove', path: '/pages/0/content/0' },
      ]),
    /Test failed/
  );
  assert.equal(store.get(documentId).revision, 3, 'a failed test leaves the document unchanged');
  assert.throws(
    () => store.patch(documentId, 3, [{ op: 'move', from: '/pages/0', path: '/pages/0/content/0' }]),
    /into itself/
  );
});

test('failed operations name the operation that failed', () => {
  const store = new DocumentStore();
  const { documentId } = store.create(definition());
  assert.throws(
    () =>
      store.patch(documentId, 1, [
        { op: 'replace', path: '/pages/0/content/1/text', value: 'x' },
        { op: 'remove', path: '/nope' },
      ]),
    /Operation 1 \(remove \/nope\)/
  );
});

test('validation failures are truncated consistently', () => {
  const store = new DocumentStore();
  const d = definition();
  for (let i = 0; i < 40; i++) d.pages[0].content.push({ type: 'TextBlock', text: 'x', fontSzie: 1 });
  const result = store.create(d);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 25);
  assert.ok(result.errorCount >= 40);
});

test('persistent sessions survive a restart and deletion removes them', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'bonniepdf-sessions-'));
  try {
    const first = new DocumentStore(dir);
    const { documentId } = first.create(definition());
    first.patch(documentId, 1, [{ op: 'replace', path: '/pages/0/content/1/text', value: 'Saved' }]);
    const second = new DocumentStore(dir);
    assert.equal(second.get(documentId).revision, 2);
    assert.equal(second.read(documentId, '/pages/0/content/1/text').value, 'Saved');
    assert.equal(second.list()[0].documentId, documentId);
    second.delete(documentId);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search ranks by relevance, folds plurals and centres excerpts on the query', () => {
  assert.deepEqual(tokenize('Tables and Categories'), ['table', 'and', 'category']);
  const k = new KnowledgeBase();
  const tables = k.search('tables', 'all', 5);
  assert.ok(tables.results.length > 0);
  assert.ok(tables.results.every((r, i, all) => i === 0 || all[i - 1].score >= r.score));
  const labels = k.search('shipping label', 'examples', 3);
  assert.equal(labels.results[0].id, 'shipping-label');
  const text = 'a '.repeat(400) + 'the needle sits here ' + 'b '.repeat(400);
  assert.match(excerptAround(text, ['needle']), /^….*needle/);
  assert.throws(() => k.example('shiping-label'), /Did you mean/);
  assert.ok(k.file('fonts/NotoSans-Regular.ttf').length > 1000);
  assert.ok(k.describe('Textblock').didYouMean.includes('TextBlock'));
});

test('descriptions expose page tokens, value types and focused wire schemas', () => {
  const k = new KnowledgeBase();
  const types = k.describe('');
  assert.ok(types.availableObjects.includes('Page'));
  assert.ok(types.availableValueTypes.includes('Length'));
  const page = k.describe('Page');
  assert.ok(page.tokens.PageSize.tokens.includes('a4'));
  assert.ok(!page.tokens.PageSize.tokens.includes('A4'));
  assert.equal(page.propertyTypes.size, 'PageSize');
  const size = k.describe('Page', 'size');
  assert.ok(size.schema.oneOf[0].enum.includes('a4'));
  assert.equal(size.schema.oneOf[1].properties.width.exclusiveMinimum, 0);
  assert.equal(size.required, false);
  const height = k.describe('Container', 'height');
  assert.equal(height.schema, k.describe('Length').schema);
  assert.ok(height.schema.oneOf.some(v => v.type === 'number'));
  const padding = k.describe('Container', 'padding');
  assert.ok(padding.$defs.Length);
  const children = k.describe('HorizontalStack', 'children');
  assert.equal(children.required, true);
  assert.equal(children.$defs.StackChild.oneOf[1].properties.weight.exclusiveMinimum, 0);
  assert.equal(children.$defs.Element, undefined);
  const child = k.describe('Container', 'child');
  assert.equal(child.schema.$ref, '#/$defs/Element');
  assert.ok(child.elementHint);
  assert.ok(JSON.stringify(child).length < 500, 'recursive element schemas stay compact');
  assert.throws(() => k.describe('Page', 'Size'), /Unknown property: Page.Size/);
  assert.throws(() => k.describe('Missing', 'size'), /Unknown property/);
  assert.throws(() => k.describe('Page', '__proto__'), /Unknown property/);
});
