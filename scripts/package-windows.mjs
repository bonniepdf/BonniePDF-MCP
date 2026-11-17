// Build with: pnpm --filter @bonniepdf/mcp package:windows
// Generates the knowledge bundle and compiles the server before staging; does not publish.
import { readFile, writeFile, mkdir, copyFile, mkdtemp, readdir, lstat, cp, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build the Windows x64 installer on Windows x64.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
if (!process.env.npm_execpath) throw new Error('Run this script with pnpm package:windows.');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const core = JSON.parse(await readFile(fileURLToPath(import.meta.resolve('@bonniepdf/core/package.json')), 'utf8'));
const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0)
    throw (
      result.error ??
      new Error(`${executable} exited with ${result.status}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`)
    );
  return result;
};
run(process.execPath, [process.env.npm_execpath, 'run', 'build']);
const knowledge = JSON.parse(await readFile(join(root, 'data/knowledge.json'), 'utf8'));
if (knowledge.coreVersion !== core.version)
  throw new Error('Knowledge and core versions differ. Rebuild core before packaging.');
const releases = join(root, 'out', 'releases');
await mkdir(releases, { recursive: true });
const release = await mkdtemp(join(releases, `${pkg.version}-win-x64-`));
const payload = join(release, 'payload');
await mkdir(join(payload, 'runtime'), { recursive: true });
// Stage an ordinary production package. Do not run a workspace deploy: workspace
// hooks and unrelated root dependencies must never enter the installed server.
const coreRoot = dirname(fileURLToPath(import.meta.resolve('@bonniepdf/core/package.json')));
const coreTarball = join(release, 'bonniepdf-core.tgz');
run(
  process.execPath,
  [process.env.npm_execpath, '--dir', coreRoot, '--config.ignore-scripts=true', 'pack', '--out', coreTarball],
  { stdio: 'pipe', encoding: 'utf8' }
);
const server = join(payload, 'server');
await mkdir(server, { recursive: true });
for (const file of ['dist', 'data', 'README.md', 'LICENSE'])
  await cp(join(root, file), join(server, file), { recursive: true });
await mkdir(join(server, 'scripts'), { recursive: true });
for (const file of ['ollama-agent.mjs', 'eval-models.mjs', 'eval-support.mjs'])
  await copyFile(join(root, 'scripts', file), join(server, 'scripts', file));
await cp(join(root, 'evals'), join(server, 'evals'), { recursive: true });
const stagedPackage = {
  ...pkg,
  dependencies: { ...pkg.dependencies, '@bonniepdf/core': `file:${coreTarball.replaceAll('\\', '/')}` },
};
delete stagedPackage.devDependencies;
delete stagedPackage.scripts;
await writeFile(join(server, 'package.json'), JSON.stringify(stagedPackage, null, 2));
// A separate workspace boundary prevents discovery of the development estate.
await writeFile(join(server, 'pnpm-workspace.yaml'), 'packages: []\nnodeLinker: hoisted\n');
run(process.execPath, [process.env.npm_execpath, '--dir', server, 'install', '--prod', '--ignore-scripts'], {
  cwd: server,
});
await copyFile(join(server, 'pnpm-lock.yaml'), join(release, 'dependency-lock.yaml'));
for (const name of [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.pnpm/lock.yaml',
]) {
  const file = join(server, name);
  if (existsSync(file)) await unlink(file);
}
stagedPackage.dependencies['@bonniepdf/core'] = core.version;
await writeFile(join(server, 'package.json'), JSON.stringify(stagedPackage, null, 2) + '\n');

// Verify the bundled node.exe against the upstream release, and ship its complete licence.
const nodeBase = `https://nodejs.org/dist/${process.version}`;
async function upstream(path) {
  const response = await fetch(`${nodeBase}/${path}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Cannot retrieve Node.js ${path}: HTTP ${response.status}`);
  return response.text();
}
const sums = await upstream('SHASUMS256.txt');
const expected = sums
  .split(/\r?\n/)
  .find(line => /\s+win-x64\/node\.exe$/.test(line))
  ?.split(/\s+/)[0];
const nodeBytes = await readFile(process.execPath);
const nodeHash = createHash('sha256').update(nodeBytes).digest('hex');
if (!expected || expected !== nodeHash)
  throw new Error('The local Node executable does not match the official Windows x64 release.');
await copyFile(process.execPath, join(payload, 'runtime', 'node.exe'));
const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, {
  signal: AbortSignal.timeout(60000),
});
if (!nodeLicense.ok) throw new Error(`Cannot retrieve the Node.js licence: HTTP ${nodeLicense.status}`);
await writeFile(join(payload, 'runtime', 'LICENSE.txt'), await nodeLicense.text());
await copyFile(join(root, 'LICENSE'), join(payload, 'LICENSE.txt'));
await writeFile(
  join(payload, 'bonniepdf-mcp.cmd'),
  '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0server\\dist\\index.js" %*\r\n'
);
await writeFile(join(payload, 'Test connection.cmd'), '@echo off\r\ncall "%~dp0bonniepdf-mcp.cmd" doctor\r\npause\r\n');
await writeFile(
  join(payload, 'Connect assistants.cmd'),
  '@echo off\r\ncall "%~dp0bonniepdf-mcp.cmd" setup\r\npause\r\n'
);
await writeFile(
  join(payload, 'README.txt'),
  `BonniePDF MCP ${pkg.version}\r\n\r\nRun "Connect assistants.cmd" to connect a client.\r\nRun "Test connection.cmd" to test the installed runtime and PDF/PNG generation.\r\nCLI: bonniepdf-mcp.cmd setup --client codex\r\nHelp: bonniepdf-mcp.cmd --help\r\nDocuments and sessions are stored separately under the user's BonniePDF/MCP data folder.\r\nThe MCP server is Apache-2.0 licensed. BonniePDF core retains its own licence.\r\n`
);

// Inno must receive real files rather than machine-specific pnpm junctions.
async function verifyTree(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if ((await lstat(full)).isSymbolicLink()) throw new Error(`The portable payload contains a link: ${full}`);
    if (entry.isDirectory()) await verifyTree(full);
  }
}
await verifyTree(payload);
run(
  join(payload, 'runtime', 'node.exe'),
  [join(payload, 'server/dist/index.js'), 'doctor', '--report', join(release, 'doctor.json')],
  {
    env: { ...process.env, BONNIEPDF_MCP_HOME: join(release, 'self-test-state') },
  }
);
const isccCandidates = [
  process.env.ISCC_PATH,
  'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
  'C:/Program Files/Inno Setup 6/ISCC.exe',
];
const onPath = spawnSync('where.exe', ['ISCC.exe'], { encoding: 'utf8', windowsHide: true });
if (onPath.status === 0) isccCandidates.push(...onPath.stdout.trim().split(/\r?\n/));
const iscc = isccCandidates.find(path => path && existsSync(path));
if (!iscc) throw new Error('Install Inno Setup 6.3 or later, or set ISCC_PATH to ISCC.exe.');
const installer = join(release, `BonniePDFMCPSetup-${pkg.version}-x64.exe`);
run(iscc, [
  `/DAppVersion=${pkg.version}`,
  `/DPayloadDir=${payload}`,
  `/DInstallerOutput=${release}`,
  join(root, 'installer/BonniePDF-MCP.iss'),
]);
const manifest = {
  version: pkg.version,
  coreVersion: core.version,
  nodeVersion: process.version,
  nodeSha256: nodeHash,
  installer,
  installerSha256: createHash('sha256')
    .update(await readFile(installer))
    .digest('hex'),
  payload,
  signed: false,
  doctor: join(release, 'doctor.json'),
};
await writeFile(join(release, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(releases, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `Installer: ${installer}\nSHA256: ${manifest.installerSha256}\nUnsigned build; use your release signing process before distribution.`
);
