import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { KnowledgeBase } from './knowledge.js';
import { DocumentStore, validate } from './documents.js';
import { Renderer } from './render.js';

export const GUIDE = `BonniePDF authors documents from a tree of elements, not HTML. Use search_docs to find a recipe or finished design. get_example returns source or JSON on demand; create_document(exampleId) clones a verified definition without sending it through the conversation. create_document(definition) accepts a new definition. Each handle lasts for this server connection. Read only the JSON Pointer you need with get_document; edit with patch_document and its current revision. IDs added by the host link body elements to layout sourceId. Page chrome is outside the layout snapshot tree.
Use describe_element for exact keys, nested shapes and tokens. JSON keys are case-sensitive. validate_definition uses BonniePDF's strict semantic validator, not only JSON Schema. preview_definition returns page count, advisory accessibility findings, selected SVG/PNG artifacts and optionally images. Inspect the selected preview before finalising; a valid definition does not guarantee the requested content or attractive layout. render_pdf produces an artifact, never executable code. export_definition saves the JSON and its external resource files for reuse. Resources resolve only from the bundle or the host's configured resource directory. Passwords are not stored in definitions; encrypted source examples are source-only.
Many source examples use callbacks unavailable in JSON. The server labels these source-only rather than dropping content. Retrieve their TypeScript/C# source when writing code examples. It does not generate idiomatic TypeScript/C# source from arbitrary definitions, nor claim full PDF/A/PDF/UA compliance from advisory preflight. Use external validation where required.
For economical authoring, search summaries first, clone by example ID, patch only changed values, retrieve short documentation sections, and preview at most the pages needed. Content and tool responses still enter the connected assistant's context.`;

export interface ServerOptions { outDir:string; resourceDir?:string; license?:string; timeoutMs?:number }
export function createServer(options:ServerOptions) {
  const knowledge=new KnowledgeBase();
  const store=new DocumentStore();
  const renderer=new Renderer(options.outDir,options.resourceDir,options.license,options.timeoutMs);
  const server=new McpServer({name:'bonniepdf',version:'0.1.0'},{instructions:GUIDE});
  const result=(value:Record<string,unknown>)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value,...(value.valid===false?{isError:true}:{})});
  const excerpt=(text:string,offset:number,maxChars:number)=>({text:text.slice(offset,offset+maxChars),offset,nextOffset:offset+maxChars<text.length?offset+maxChars:null,totalChars:text.length});
  const tool=(name:string,description:string,inputSchema:z.ZodObject<any>,readOnlyHint:boolean,handler:(args:any,ctx:any)=>Promise<any>|any)=>{
    server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint,destructiveHint:false,openWorldHint:false}},async(args,ctx)=>{
      try{return await handler(args,ctx);}catch(error){
        const e=error as Error & {issues?:unknown[]};
        return {...result({error:{message:e.message,...(e.issues?{issues:e.issues.slice(0,25)}:{})}}),isError:true};
      }
    });
  };
  const id=z.string().uuid();
  const offset=z.number().int().min(0).default(0);
  const maxChars=z.number().int().min(256).max(16000).default(6000);
  tool('get_capabilities','Get versions, available elements, catalogue counts, limits and authoring guidance.',z.object({}),true,()=>result({
    coreVersion:knowledge.data.coreVersion,definitionVersion:knowledge.data.definitionVersion,knowledgeHash:knowledge.data.hash,exampleClock:knowledge.data.exampleClock,
    examples:knowledge.data.examples.length,editableExamples:knowledge.data.examples.filter(e=>e.definition).length,
    referencePages:knowledge.data.docs.length,elements:Object.keys(knowledge.elements.elements),guide:GUIDE,
  }));
  tool('search_docs','Search short example and public API summaries. Use editableOnly when seeking a JSON starting point.',z.object({query:z.string().max(300),kind:z.enum(['all','examples','docs']).default('all'),limit:z.number().int().min(1).max(15).default(5),language:z.enum(['typescript','dotnet']).optional(),editableOnly:z.boolean().default(false)}),true,args=>result(knowledge.search(args.query,args.kind,args.limit,args.language,args.editableOnly)));
  tool('get_doc','Read a reference page in bounded sections using its search result ID.',z.object({id:z.string().max(200),offset,maxChars}),true,args=>{
    const doc=knowledge.data.docs.find(d=>d.id===args.id);if(!doc)throw new Error('Unknown reference page');
    return result({id:doc.id,title:doc.title,url:doc.url,...excerpt(doc.text,args.offset,args.maxChars)});
  });
  tool('describe_element','Get exact definition keys, defaults, constraints and enum tokens for an element or nested shape. Omit name to list elements.',z.object({name:z.string().max(100).default('')}),true,args=>result(knowledge.describe(args.name)));
  tool('get_example','Read example metadata or a bounded section of its definition, TypeScript or C# source. Prefer create_document(exampleId) to avoid copying JSON.',z.object({exampleId:z.string().max(100),view:z.enum(['summary','definition','typescript','dotnet']).default('summary'),offset,maxChars}),true,args=>{
    const entry=knowledge.example(args.exampleId);
    if(args.view==='summary')return result({...entry});
    const file=args.view==='definition'?entry.definition:entry.source[args.view as 'typescript'|'dotnet'];
    if(!file)throw new Error(entry.unavailable??`No ${args.view} representation for this example`);
    return result({exampleId:entry.id,view:args.view,...excerpt(knowledge.file(file).toString('utf8'),args.offset,args.maxChars)});
  });
  tool('create_document','Create an editable session from either a verified exampleId or a complete JSON definition. Returns a handle, revision and short outline.',z.object({exampleId:z.string().max(100).optional(),definition:z.record(z.string(),z.unknown()).optional()}),false,args=>{
    if(Number(!!args.exampleId)+Number(!!args.definition)!==1)throw new Error('Supply exactly one of exampleId or definition');
    let definition=args.definition;
    if(args.exampleId){const entry=knowledge.example(args.exampleId);if(!entry.definition)throw new Error(`Source-only example: ${entry.unavailable}. Use get_example to retrieve its source.`);definition=JSON.parse(knowledge.file(entry.definition).toString('utf8'));}
    return result(store.create(definition));
  });
  tool('get_document','Read a definition subtree by RFC 6901 JSON Pointer, with bounded text and its current revision.',z.object({documentId:id,pointer:z.string().max(1000).default(''),offset,maxChars}),true,args=>{
    const doc=store.read(args.documentId,args.pointer);
    return result({documentId:doc.documentId,revision:doc.revision,pointer:doc.pointer,...excerpt(JSON.stringify(doc.value,null,2),args.offset,args.maxChars)});
  });
  tool('patch_document','Atomically apply add/remove/replace JSON Pointer edits. Requires the current revision; invalid edits leave the document unchanged.',z.object({documentId:id,revision:z.number().int().min(1),operations:z.array(z.object({op:z.enum(['add','remove','replace']),path:z.string().max(1000),value:z.unknown().optional()})).min(1).max(50)}),false,args=>result(store.patch(args.documentId,args.revision,args.operations)));
  tool('delete_document','Release an unused document handle from this session.',z.object({documentId:id}),false,args=>result(store.delete(args.documentId)));
  tool('validate_definition','Strictly validate a session document or supplied JSON, returning semantic errors with paths and element IDs.',z.object({documentId:id.optional(),definition:z.record(z.string(),z.unknown()).optional()}),true,args=>{
    if(Number(!!args.documentId)+Number(!!args.definition)!==1)throw new Error('Supply exactly one of documentId or definition');
    const v=validate(args.documentId?store.get(args.documentId).definition:args.definition);
    return {...result({valid:v.valid,errors:v.errors.slice(0,25),warnings:v.warnings.slice(0,25),errorCount:v.errors.length,warningCount:v.warnings.length}),...(!v.valid?{isError:true}:{})};
  });
  tool('preview_definition','Render selected zero-based pages, page count, advisory preflight and layout artifacts. Images cost context; disable includeImages when geometry is sufficient.',z.object({documentId:id,pages:z.array(z.number().int().min(0).max(99)).min(1).max(3).default([0]),includeImages:z.boolean().default(true)}),false,async(args,ctx)=>{
    const doc=store.get(args.documentId);const revision=doc.revision;
    const preview=await renderer.render(structuredClone(doc.definition),'preview',[...new Set(args.pages)] as number[],args.includeImages,ctx.signal);
    const images=(preview.previews??[]).filter(p=>p.image).map(p=>({type:'image' as const,data:p.image!,mimeType:'image/png'}));
    const value={...preview,documentId:args.documentId,revision,previews:preview.previews?.map(({image,...p})=>p)};
    const base=result(value);return {...base,content:[...base.content,...images]};
  });
  tool('render_pdf','Render a session definition to a new PDF artifact. Returns a file path/resource link, page count and diagnostics; does not send PDF bytes into context.',z.object({documentId:id}),false,async(args,ctx)=>{
    const doc=store.get(args.documentId);
    const rendered=await renderer.render(structuredClone(doc.definition),'pdf',[0],false,ctx.signal);
    const response=result({...rendered,documentId:args.documentId,revision:doc.revision});
    return {...response,content:[...response.content,{type:'resource_link' as const,uri:rendered.artifact!.uri,name:'document.pdf',mimeType:'application/pdf',description:rendered.artifact!.path}]};
  });
  tool('export_definition','Save a portable JSON definition with referenced assets embedded. Returns an artifact; does not generate idiomatic source code.',z.object({documentId:id}),false,async args=>{
    const doc=store.get(args.documentId);const definition=structuredClone(doc.definition);
    // Bundled assets can be exported without exposing large base64 payloads to the model.
    for(const resource of Object.values(definition.resources??{}) as any[]){
      if(resource.ref){
        if(!/^assets\/[a-f0-9]{64}$/.test(resource.ref))throw new Error('Export currently embeds bundle resources only; custom references remain host-dependent');
        resource.data=knowledge.file(resource.ref).toString('base64');delete resource.ref;
      }
    }
    const v=validate(definition);if(!v.valid)throw Object.assign(new Error('Exported definition failed validation'),{issues:v.errors});
    return result({documentId:args.documentId,revision:doc.revision,artifact:await renderer.save('document.json',JSON.stringify(definition,null,2),'application/json')});
  });
  server.registerResource('authoring-guide','bonniepdf://guide',{mimeType:'text/plain',description:'How to author and revise documents economically'},uri=>({contents:[{uri:uri.href,text:GUIDE,mimeType:'text/plain'}]}));
  server.registerResource('definition-schema','bonniepdf://schema/definition/1.0',{mimeType:'application/schema+json'},uri=>({contents:[{uri:uri.href,text:knowledge.file('schema.json').toString('utf8'),mimeType:'application/schema+json'}]}));
  server.registerResource('artifact',new ResourceTemplate('bonniepdf://artifacts/{id}',{list:undefined}),{description:'Artifacts explicitly produced during this connection'},async(uri,variables)=>{
    const artifact=await renderer.readArtifact(String(variables.id));
    if(artifact.bytes>8_000_000)throw new Error('Artifact too large for inline reading; open its returned local path');
    return {contents:[{uri:uri.href,mimeType:artifact.mimeType,blob:artifact.data.toString('base64')}]};
  });
  server.registerPrompt('author-document',{description:'A workflow for creating a BonniePDF document',argsSchema:z.object({brief:z.string().max(4000)})},({brief})=>({messages:[{role:'user',content:{type:'text',text:`Create this BonniePDF document: ${brief}\n\n${GUIDE}`}}]}));
  return server;
}
