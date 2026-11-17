#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { isLicenseTier } from '@bonniepdf/core';
import { createServer } from './server.js';

const {values}=parseArgs({options:{'out-dir':{type:'string'},'resource-dir':{type:'string'},license:{type:'string'},'timeout-ms':{type:'string'},help:{type:'boolean'}}});
if(values.help){
  console.error('bonniepdf-mcp [--out-dir directory] [--resource-dir directory] [--license tier] [--timeout-ms 45000]\nLocal stdio MCP server. Default licence: evaluation. Logs go to stderr.');
}else{
  const license=values.license??process.env.BONNIEPDF_LICENSE??'evaluation';
  if(!isLicenseTier(license))throw new Error('Unrecognised licence tier');
  const timeoutMs=Number(values['timeout-ms']??45000);
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw new Error('timeout-ms must be 100–120000');
  // Read the bundle before starting to fail clearly on missing/stale generated data.
  const options={outDir:resolve(values['out-dir']??fileURLToPath(new URL('../out/',import.meta.url))),resourceDir:values['resource-dir']?resolve(values['resource-dir']):undefined,license,timeoutMs};
  const server=createServer(options);
  let first=true;
  serveStdio(()=>{if(first){first=false;return server;}return createServer(options);},{onerror:error=>console.error(error.message)});
}
