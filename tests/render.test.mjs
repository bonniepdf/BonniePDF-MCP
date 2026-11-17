import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { KnowledgeBase } from '../dist/knowledge.js';
import { Renderer } from '../dist/render.js';

const k=new KnowledgeBase();
const example=id=>JSON.parse(k.file(k.example(id).definition));
test('a real invoice produces a PDF and an aligned layout snapshot',async()=>{
  const r=new Renderer(resolve('out/tests'));
  const definition=example('business-invoice');
  const preview=await r.render(definition,'preview',[0],false);
  assert.ok(preview.pageCount>=1);assert.equal(preview.previews.length,1);
  const layout=JSON.parse(await readFile(preview.snapshot.path,'utf8'));
  assert.equal(layout.snapshot.pages.length,preview.pageCount);
  assert.ok(layout.snapshot.root.children.length);
  const pdf=await r.render(definition,'pdf',[0],false);
  assert.equal((await readFile(pdf.artifact.path)).subarray(0,5).toString(),'%PDF-');
  assert.equal(pdf.pageCount,preview.pageCount);
});
test('bundled external assets resolve by content hash',async()=>{
  const r=new Renderer(resolve('out/tests'));
  const rendered=await r.render(example('images'),'pdf',[0],false);
  assert.ok(rendered.artifact.bytes>100);
});
test('resource references cannot grant arbitrary filesystem access',async()=>{
  const r=new Renderer(resolve('out/tests'));
  const d=example('images');
  const resource=Object.values(d.resources)[0];resource.ref='../package.json';
  await assert.rejects(r.render(d,'pdf',[0],false),/resource|Resource/);
});
test('worker deadlines and cancellation terminate a render',async()=>{
  const r=new Renderer(resolve('out/tests'),undefined,'evaluation',1);
  await assert.rejects(r.render(example('business-invoice'),'pdf',[0],false),/exceeded/);
  const controller=new AbortController();controller.abort();
  const normal=new Renderer(resolve('out/tests'));
  await assert.rejects(normal.render(example('first-pdf'),'preview',[0],false,controller.signal),/cancelled/);
});
test('configured resource roots allow named assets but reject traversal',async()=>{
  const base=resolve('out/tests/resources');await mkdir(base,{recursive:true});
  const d=example('images');
  const resource=Object.values(d.resources)[0];
  const bytes=k.file(resource.ref);
  await writeFile(resolve(base,'logo.png'),bytes);
  resource.ref='logo.png';
  const r=new Renderer(resolve('out/tests'),base);
  assert.ok((await r.render(d,'pdf',[0],false)).artifact.bytes>100);
  await writeFile(resolve(base,'../outside.png'),bytes);
  resource.ref='../outside.png';
  await assert.rejects(r.render(d,'pdf',[0],false),/escapes configured/);
});
