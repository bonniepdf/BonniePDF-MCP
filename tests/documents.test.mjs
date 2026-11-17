import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentStore, validate } from '../dist/documents.js';
import { KnowledgeBase } from '../dist/knowledge.js';

const definition=()=>({version:1,minorVersion:0,pages:[{content:[{type:'TextBlock',text:'Original'}]}]});
test('strict errors include an actionable pointer',()=>{
  const d=definition();d.pages[0].content[0].fontSzie=12;
  const result=validate(d);assert.equal(result.valid,false);
  assert.ok(result.errors.some(e=>e.path==='/pages/0/content/0/fontSzie'));
});
test('handles avoid retransmitting definitions and provide stable element IDs',()=>{
  const store=new DocumentStore();const created=store.create(definition());
  assert.equal(created.valid,true);assert.equal(created.revision,1);
  assert.equal(created.outline[0].id,'mcp-1');
  const edited=store.patch(created.documentId,1,[{op:'replace',path:'/pages/0/content/0/text',value:'Revised'}]);
  assert.equal(edited.revision,2);
  assert.equal(store.read(created.documentId,'/pages/0/content/0/text').value,'Revised');
  assert.equal(store.read(created.documentId,'/pages/0/content/0/id').value,'mcp-1');
});
test('invalid edits and partial operations are atomic',()=>{
  const store=new DocumentStore();const {documentId}=store.create(definition());
  const bad=store.patch(documentId,1,[{op:'replace',path:'/pages/0/content/0/text',value:'Changed'},{op:'add',path:'/pages/0/content/0/fontSzie',value:12}]);
  assert.equal(bad.valid,false);assert.equal(store.get(documentId).revision,1);
  assert.equal(store.read(documentId,'/pages/0/content/0/text').value,'Original');
  assert.throws(()=>store.patch(documentId,1,[{op:'replace',path:'/pages/0/content/0/text',value:'Changed'},{op:'remove',path:'/nonexistent'}]));
  assert.equal(store.read(documentId,'/pages/0/content/0/text').value,'Original');
});
test('stale revisions and prototype pointers are rejected',()=>{
  const store=new DocumentStore();const {documentId}=store.create(definition());
  assert.throws(()=>store.patch(documentId,2,[{op:'remove',path:'/metadata'}]),/Revision conflict/);
  assert.throws(()=>store.patch(documentId,1,[{op:'add',path:'/__proto__/polluted',value:true}]),/Unsafe/);
  assert.equal({}.polluted,undefined);
});
test('array inserts, appends and removals follow JSON Pointer rules',()=>{
  const store=new DocumentStore();const {documentId}=store.create(definition());
  store.patch(documentId,1,[{op:'add',path:'/pages/0/content/-',value:{type:'TextBlock',text:'Second'}}]);
  store.patch(documentId,2,[{op:'remove',path:'/pages/0/content/0'}]);
  assert.equal(store.read(documentId,'/pages/0/content/0/text').value,'Second');
  assert.throws(()=>store.patch(documentId,3,[{op:'remove',path:'/pages/0/content/00'}]),/Invalid array/);
});
test('delete releases handles and oversized input is rejected',()=>{
  const store=new DocumentStore();const {documentId}=store.create(definition());
  store.delete(documentId);assert.throws(()=>store.get(documentId),/Unknown document/);
  const d=definition();d.pages[0].content[0].text='a'.repeat(100001);
  assert.equal(store.create(d).valid,false);
});
test('search is bounded, retrieves source-only examples, and can filter editable examples',()=>{
  const k=new KnowledgeBase();const all=k.search('chart','examples',3);
  assert.equal(all.results.length,3);assert.ok(all.results.some(e=>e.editable===false));
  const editable=k.search('invoice','examples',10,undefined,true);
  assert.ok(editable.results.length>0);assert.ok(editable.results.every(e=>e.editable===true));
  assert.ok(k.describe('TextBlock').keys.fontSize);
  assert.throws(()=>k.file('../package.json'),/Unknown bundle/);
});
