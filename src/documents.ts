import { randomUUID } from 'node:crypto';
import { validateDefinition, type DocumentDefinition } from '@bonniepdf/core/definition';

export const LIMITS = { inputBytes:2_000_000, elementNodes:5000, elementDepth:24, pages:100, stringLength:100_000, arrayLength:10_000, resourceBytes:8_000_000, resourceBytesTotal:16_000_000, chartDataPoints:10_000 };
export function validate(input: unknown) { return validateDefinition(input, { strict:true, limits:LIMITS }); }
export function summary(definition: DocumentDefinition) {
  const nodes: {id:string;type:string;path:string}[] = [];
  function walk(value:any, path:string) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.type === 'string') nodes.push({ id:value.id, type:value.type, path });
    for (const [key,child] of Object.entries(value)) walk(child, `${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`);
  }
  walk(definition, '');
  return { logicalPages:definition.pages.length, elements:nodes.length, outline:nodes.slice(0,25), outlineTruncated:nodes.length>25 };
}
function assignIds(definition:any) {
  const existing = new Set<string>();
  const collect = (v:any) => { if (!v || typeof v !== 'object') return; if (typeof v.id==='string') existing.add(v.id); Object.values(v).forEach(collect); };
  collect(definition);
  let i=1;
  const visit = (v:any) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.type==='string' && !v.id) { while(existing.has(`mcp-${i}`)) i++; v.id=`mcp-${i++}`; existing.add(v.id); }
    Object.values(v).forEach(visit);
  };
  visit(definition);
}
export interface Session { definition:DocumentDefinition; revision:number; bytes:number }
export class DocumentStore {
  private readonly documents = new Map<string,Session>();
  create(input:unknown) {
    const valid = validate(input);
    if (!valid.valid) return { valid:false, errors:valid.errors.slice(0,25), warnings:valid.warnings.slice(0,25), errorCount:valid.errors.length, warningCount:valid.warnings.length };
    const definition = structuredClone(valid.definition!);
    assignIds(definition);
    const withIds = validate(definition);
    if (!withIds.valid) return { valid:false, errors:withIds.errors, warnings:withIds.warnings };
    const bytes = Buffer.byteLength(JSON.stringify(definition));
    if(this.documents.size>=50 || [...this.documents.values()].reduce((n,s)=>n+s.bytes,0)+bytes>32_000_000) throw new Error('Session capacity reached. Delete an unused document.');
    const documentId=randomUUID();
    this.documents.set(documentId,{definition,revision:1,bytes});
    return { valid:true, documentId, revision:1, ...summary(definition) };
  }
  get(id:string) { const doc=this.documents.get(id); if(!doc) throw new Error('Unknown document handle (handles last for this server connection).'); return doc; }
  delete(id:string) { this.get(id); this.documents.delete(id); return {deleted:true}; }
  read(id:string,pointer='') { const doc=this.get(id); return { documentId:id, revision:doc.revision, pointer, value:structuredClone(pointerValue(doc.definition,pointer)) }; }
  patch(id:string,revision:number,operations:Patch[]) {
    const current=this.get(id);
    if(current.revision!==revision) throw new Error(`Revision conflict: expected ${revision}, current ${current.revision}`);
    const candidate=structuredClone(current.definition);
    for(const op of operations) applyPatch(candidate,op);
    assignIds(candidate);
    const checked=validate(candidate);
    if(!checked.valid) return {valid:false,revision:current.revision,errors:checked.errors.slice(0,25),warnings:checked.warnings.slice(0,25),errorCount:checked.errors.length,warningCount:checked.warnings.length};
    const bytes=Buffer.byteLength(JSON.stringify(candidate));
    const total=[...this.documents.values()].reduce((n,s)=>n+s.bytes,0)-current.bytes+bytes;
    if(total>32_000_000) throw new Error('Session capacity reached');
    this.documents.set(id,{definition:candidate,revision:revision+1,bytes});
    const {elements,logicalPages}=summary(candidate);
    return {valid:true,documentId:id,revision:revision+1,elements,logicalPages};
  }
}
export interface Patch { op:'add'|'remove'|'replace'; path:string; value?:unknown }
function parts(pointer:string) {
  if(pointer==='') return [];
  if(!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error('Expected an RFC 6901 JSON Pointer');
  const keys=pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'));
  if(keys.some(k=>['__proto__','prototype','constructor'].includes(k))) throw new Error('Unsafe pointer key');
  return keys;
}
function index(key:string,length:number,append=false) {
  if(append && key==='-') return length;
  if(!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('Invalid array index');
  const n=Number(key); if(n>length || (!append && n===length)) throw new Error('Array index out of bounds'); return n;
}
export function pointerValue(root:any,pointer:string) {
  let value=root;
  for(const key of parts(pointer)) {
    if(!value || typeof value!=='object') throw new Error('Pointer does not exist');
    const k=Array.isArray(value)?index(key,value.length):key;
    if(!Object.hasOwn(value,k)) throw new Error('Pointer does not exist'); value=value[k];
  }
  return value;
}
function applyPatch(root:any,op:Patch) {
  const keys=parts(op.path); const key=keys.pop();
  if(key===undefined) throw new Error('Root replacement is not supported; create a new document');
  const parent=pointerValue(root,keys.length?'/'+keys.map(k=>k.replaceAll('~','~0').replaceAll('/','~1')).join('/'):'');
  if(!parent || typeof parent!=='object') throw new Error('Patch parent is not an object');
  if(op.op!=='remove' && !Object.hasOwn(op,'value')) throw new Error('add/replace requires value');
  if(Array.isArray(parent)) {
    const n=index(key,parent.length,op.op==='add');
    if(op.op==='add') parent.splice(n,0,structuredClone(op.value));
    else if(op.op==='remove') parent.splice(n,1); else parent[n]=structuredClone(op.value);
  } else {
    if(op.op!=='add' && !Object.hasOwn(parent,key)) throw new Error('Patch target does not exist');
    if(op.op==='remove') delete parent[key]; else parent[key]=structuredClone(op.value);
  }
}
