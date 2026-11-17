import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const base = 'https://github.com/bonniepdf/BonniePDF-MCP/releases/latest/download';
const launch = { command: 'npx', args: ['-y', '--package', base + '/bonniepdf-mcp.tgz', 'bonniepdf-mcp'] };
const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decode = text =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) =>
    entity[0] === '#'
      ? String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
      : entities[entity.toLowerCase()]
  );

for (const language of ['typescript', 'dotnet']) {
  const url = 'https://www.bonniepdf.dev/features/' + language + '/mcp-server';
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, url);
  const html = await response.text();
  const snippets = [...html.matchAll(/data-copy-text="([^"]*)"/g)].map(match => decode(match[1]));

  for (const prefix of ['claude mcp add --scope user bonniepdf -- ', 'codex mcp add bonniepdf -- ']) {
    assert.ok(snippets.includes(prefix + launch.command + ' ' + launch.args.join(' ')), prefix);
  }
  const json = snippets.filter(snippet => snippet.trim().startsWith('{')).map(snippet => JSON.parse(snippet));
  const configs = json.filter(config => config.mcpServers?.bonniepdf);
  assert.ok(configs.length > 0, 'The page must provide a client configuration');
  for (const config of configs) assert.deepEqual(config.mcpServers.bonniepdf, launch);
  for (const asset of ['BonniePDFMCPSetup-x64.exe', 'bonniepdf.mcpb']) {
    assert.ok(html.includes(base + '/' + asset), asset);
  }

  const advanced = await fetch('https://www.bonniepdf.dev/features/' + language + '/mcp-advanced', {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(advanced.status, 200);
  const instructions = decode(await advanced.text()).replace(/<[^>]*>/g, '');
  assert.ok(instructions.includes('git clone --branch v2026.11.13'), 'Source instructions must use the tested core');
  assert.ok(instructions.includes('node BonniePDF-MCP/dist/index.js doctor'));
  console.log('Verified the live ' + language + ' setup instructions');
}

for (const asset of ['BonniePDFMCPSetup-x64.exe', 'bonniepdf.mcpb', 'bonniepdf-mcp.tgz']) {
  const response = await fetch(base + '/' + asset, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, asset);
  assert.ok(Number(response.headers.get('content-length')) > 1000, asset);
}

if (!process.env.npm_execpath) throw new Error('Run npm run verify:website');
execFileSync(
  process.execPath,
  [process.env.npm_execpath, 'exec', '--yes', '--package', base + '/bonniepdf-mcp.tgz', '--', 'bonniepdf-mcp', 'doctor'],
  { stdio: 'inherit', timeout: 180000 }
);
