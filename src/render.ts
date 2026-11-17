import { Worker } from 'node:worker_threads';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { DATA_ROOT } from './knowledge.js';

export interface Artifact { id:string; path:string; uri:string; mimeType:string; bytes:number }
export class Renderer {
  private active=false;
  private readonly artifacts=new Map<string,Artifact>();
  constructor(readonly outDir:string,readonly resourceDir?:string,readonly license='evaluation',readonly timeoutMs=45_000) {}
  async save(name:string,data:string|Uint8Array,mimeType:string):Promise<Artifact> {
    const id=randomUUID(); const dir=resolve(this.outDir,id); await mkdir(dir,{recursive:true});
    const path=resolve(dir,name); await writeFile(path,data);
    const artifact={id,path,uri:`bonniepdf://artifacts/${id}`,mimeType,bytes:Buffer.byteLength(data)};
    this.artifacts.set(id,artifact);return artifact;
  }
  async readArtifact(id:string) { const a=this.artifacts.get(id); if(!a) throw new Error('Unknown artifact'); return {...a,data:await readFile(a.path)}; }
  async render(definition:unknown,mode:'pdf'|'preview',pages=[0],includeImages=true,signal?:AbortSignal) {
    if(this.active) throw new Error('A render is already running; retry after it finishes');
    this.active=true;
    try {
      const rendered=await this.job({definition,mode,pages},signal);
      const report=rendered.report ? {passed:rendered.report.passed,errorCount:rendered.report.errorCount,warningCount:rendered.report.warningCount,infoCount:rendered.report.infoCount,findings:rendered.report.findings.slice(0,25),truncated:rendered.report.findings.length>25,advisory:true} : undefined;
      if(mode==='pdf') return {pageCount:rendered.pageCount,artifact:await this.save('document.pdf',rendered.pdf,'application/pdf'),diagnostics:rendered.diagnostics,report};
      const snapshot=await this.save('layout.json',JSON.stringify({snapshot:rendered.snapshot,report:rendered.report}),'application/json');
      const previews: {index:number;svg:Artifact;png?:Artifact;image?:string}[]=[];
      const warnings:string[]=[];
      let browser;
      try {
        if(includeImages) browser=await chromium.launch({headless:true});
        for(const page of rendered.pages) {
          if(signal?.aborted) throw new Error('Preview cancelled');
          const svg=page.svg.replace(/(<svg\b[^>]*>)/,'$1<style>'+rendered.fontFaceCss+'</style>');
          const item:{index:number;svg:Artifact;png?:Artifact;image?:string}={index:page.index,svg:await this.save(`page-${page.index+1}.svg`,svg,'image/svg+xml')};
          if(browser) {
            const tab=await browser.newPage({viewport:{width:1200,height:1600},deviceScaleFactor:1});
            try {
              tab.setDefaultTimeout(10_000);
              // A preview must never fetch a URL referenced by document content.
              await tab.route('**/*',route=>route.abort());
              await tab.setContent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"></head><body style="margin:0;background:white">${svg}</body></html>`);
              await tab.evaluate(async()=>{ await document.fonts.ready; await Promise.all([...document.images].map(img=>img.decode().catch(()=>{}))); });
              const box=await tab.locator('svg').first().boundingBox();
              if(!box || box.width>2000 || box.height>3000) throw new Error('Preview dimensions exceed 2000 × 3000 pixels');
              const png=await tab.locator('svg').first().screenshot({timeout:10_000});
              item.png=await this.save(`page-${page.index+1}.png`,png,'image/png');
              item.image=png.toString('base64');
            } finally { await tab.close(); }
          }
          previews.push(item);
        }
      } catch(error) {
        // SVG/layout remain useful when Chromium has not been installed.
        warnings.push(`PNG preview unavailable: ${error instanceof Error?error.message:String(error)}`);
      } finally { await browser?.close(); }
      return {pageCount:rendered.pageCount,previews,snapshot,report,diagnostics:rendered.diagnostics,warnings};
    } finally {this.active=false;}
  }
  private job(input:unknown,signal?:AbortSignal):Promise<any> {
    return new Promise((resolveJob,reject)=>{
      const worker=new Worker(new URL('./render-worker.js',import.meta.url),{workerData:{...(input as object),resourceDir:this.resourceDir,dataDir:DATA_ROOT,license:this.license},resourceLimits:{maxOldGenerationSizeMb:256}});
      let done=false;
      const finish=(error?:Error,value?:unknown)=>{
        if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();
        error?reject(error):resolveJob(value);
      };
      const timer=setTimeout(()=>finish(new Error(`Rendering exceeded ${this.timeoutMs} ms`)),this.timeoutMs);
      const abort=()=>finish(new Error('Rendering cancelled'));
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted) abort();
      worker.once('message',({value,error})=>finish(error?Object.assign(new Error(error.message),{issues:error.issues}):undefined,value));
      worker.once('error',error=>finish(error instanceof Error?error:new Error(String(error))));
      worker.once('exit',code=>{if(!done)finish(new Error(`Render worker exited (${code})`));});
    });
  }
}
