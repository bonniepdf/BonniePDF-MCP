import { parentPort, workerData } from 'node:worker_threads';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings, isLicenseTier, FontManager } from '@bonniepdf/core';
import { fromDefinition } from '@bonniepdf/core/definition';
import { LIMITS } from './documents.js';

const job = workerData as { definition:unknown; mode:'pdf'|'preview'; pages:number[]; resourceDir?:string; dataDir:string; license:string };
async function run() {
  if(!isLicenseTier(job.license)) throw new Error('Invalid BonniePDF licence declaration');
  settings.license=job.license;
  const fonts=resolve(dirname(fileURLToPath(import.meta.resolve('@bonniepdf/core/package.json'))),'assets/fonts');
  for(const [file,family] of [['Sans','liberation sans'],['Serif','liberation serif'],['Mono','liberation mono']]) {
    for(const [suffix,subfamily] of [['Regular','regular'],['Bold','bold'],['Italic','italic'],['BoldItalic','bolditalic']]) {
      const bytes=await readFile(resolve(fonts,`Liberation${file}-${suffix}.ttf`));
      FontManager.registerFont(bytes,{family,subfamily});
    }
  }
  let total=0;
  const resources=async (ref:string) => {
    let path:string;
    if(/^assets\/[a-f0-9]{64}$/.test(ref)) path=resolve(job.dataDir,ref);
    else {
      if(!job.resourceDir) throw new Error(`Resource '${ref}' is not in the bundle; configure --resource-dir.`);
      if(isAbsolute(ref) || /^[a-z]+:/i.test(ref)) throw new Error('Resource references must be relative files');
      const base=await realpath(job.resourceDir);
      path=await realpath(resolve(base,ref));
      const rel=relative(base,path);
      if(rel==='..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Resource escapes configured directory');
    }
    const info=await stat(path);
    if(!info.isFile() || info.size>LIMITS.resourceBytes || total+info.size>LIMITS.resourceBytesTotal) throw new Error('Resource size limit exceeded');
    total+=info.size;
    return new Uint8Array(await readFile(path));
  };
  const options={strict:true,limits:LIMITS,resources};
  const doc=await fromDefinition(job.definition,options);
  const rendered=await doc.generateSvgDocumentAsync({captureLayout:true,maxPages:LIMITS.pages+1});
  if(rendered.pages.length>LIMITS.pages) throw new Error(`Rendered document exceeds ${LIMITS.pages} pages`);
  if(job.pages.some(p=>p>=rendered.pages.length)) throw new Error(`Page index out of range; document has ${rendered.pages.length} pages`);
  const diagnostic=(entries:readonly any[])=>entries.map(({severity,category,message,source})=>({severity,category,message,...(source?{source}:{})}));
  if(job.mode==='pdf') {
    // Read a fresh definition for PDF output: preview rendering can normalise document state.
    total=0;
    const pdfDoc=await fromDefinition(job.definition,options);
    const bytes=await pdfDoc.generateBytesAsync();
    if(bytes.length>32_000_000) throw new Error('PDF artifact exceeds 32 MB');
    return {pageCount:rendered.pages.length,pdf:bytes,diagnostics:diagnostic(pdfDoc.diagnostics),report:rendered.report};
  }
  return {
    pageCount:rendered.pages.length, pages:job.pages.map(index=>({index,svg:rendered.pages[index]})),
    fontFaceCss:rendered.fontFaceCss,snapshot:rendered.snapshot,report:rendered.report,diagnostics:diagnostic(doc.diagnostics),
  };
}
run().then(value=>parentPort!.postMessage({value})).catch(error=>parentPort!.postMessage({error:{message:error.message,issues:error.issues}}));
