// Install, repair and uninstall into a disposable path. No real client configs are modified.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse as toml } from 'smol-toml';
import { CLIENTS, serverNamespace } from '../dist/clients.js';

const at = (value, path) => path.reduce((node, key) => node?.[key], value);
const nest = (path, leaf) => path.reduceRight((node, key) => ({ [key]: node }), leaf);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Run the installer test on Windows.');
const manifest = JSON.parse(await readFile(join(root, 'out/releases/latest.json'), 'utf8'));
const registry = spawnSync(
  'reg.exe',
  [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{EFA4014C-302B-4F1A-B773-C2852FA81F90}_is1',
    '/reg:64',
  ],
  { encoding: 'utf8', windowsHide: true }
);
if (registry.status === 0)
  throw new Error(
    'An existing BonniePDF MCP installation is registered. Test in a clean Windows account to preserve it.'
  );
const base = join(tmpdir(), 'BonniePDF-MCP-installer-tests');
await mkdir(base, { recursive: true });
const testDir = await mkdtemp(join(base, 'install with spaces-'));
const installDir = join(testDir, 'BonniePDF MCP');
const stateDir = join(testDir, 'state');
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !['path', 'node_path', 'node_options'].includes(name.toLowerCase()))
  ),
  Path: join(process.env.SystemRoot ?? 'C:/Windows', 'System32'),
  BONNIEPDF_MCP_HOME: stateDir,
};
const run = (command, args) => {
  const result = spawnSync(command, args, { env, windowsHide: true, encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 0, `${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`);
  return result;
};
const install = () =>
  run(manifest.installer, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    `/DIR=${installDir}`,
    '/TASKS=""',
    `/LOG=${join(testDir, 'install.log')}`,
  ]);
const node = join(installDir, 'runtime/node.exe');
const entry = join(installDir, 'server/dist/index.js');
let installed = false;
try {
  install();
  installed = true;
  assert.ok(existsSync(node));
  run(node, [entry, 'doctor', '--report', join(testDir, 'doctor.json')]);
  assert.equal(JSON.parse(await readFile(join(testDir, 'doctor.json'), 'utf8')).ok, true);
  const files = [];
  for (const client of CLIENTS) {
    const file = join(testDir, client === 'codex' ? 'codex.toml' : `${client}.json`);
    await writeFile(
      file,
      client === 'codex'
        ? '# retained\n[mcp_servers.other]\ncommand="other"\n'
        : JSON.stringify(nest(serverNamespace(client), { other: { command: 'other' } }))
    );
    run(node, [entry, 'setup', '--non-interactive', '--client', client, '--config-file', file]);
    const parsed = client === 'codex' ? toml(await readFile(file, 'utf8')) : JSON.parse(await readFile(file, 'utf8'));
    const servers = at(parsed, serverNamespace(client));
    assert.equal(servers.bonniepdf.command, node);
    assert.equal(servers.bonniepdf.args[0], entry);
    assert.equal(servers.other.command, 'other');
    files.push({ file, client });
  }
  const marker = join(stateDir, 'my-document.json');
  await writeFile(marker, '{"saved":true}');
  install();
  run(node, [entry, 'doctor']);
  run(join(installDir, 'unins000.exe'), [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    `/LOG=${join(testDir, 'uninstall.log')}`,
  ]);
  installed = false;
  for (const { file, client } of files) {
    const parsed = client === 'codex' ? toml(await readFile(file, 'utf8')) : JSON.parse(await readFile(file, 'utf8'));
    const servers = at(parsed, serverNamespace(client));
    assert.equal(servers.bonniepdf, undefined);
    assert.equal(servers.other.command, 'other');
  }
  assert.ok(existsSync(marker), 'Uninstall must preserve user documents.');
  assert.ok(!existsSync(entry), 'Uninstall must remove application files.');
  const result = {
    ok: true,
    checks: [
      'silent install',
      'spaces in paths',
      'bundled runtime',
      'stdio/PDF/PNG self-test',
      'eight client configuration targets',
      'repair install',
      'uninstall disconnects',
      'user documents preserved',
    ],
    directory: testDir,
  };
  await writeFile(join(testDir, 'report.json'), JSON.stringify(result, null, 2));
  await writeFile(join(root, 'out/installer-test-latest.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (installed && existsSync(join(installDir, 'unins000.exe'))) {
    run(join(installDir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
  }
}
