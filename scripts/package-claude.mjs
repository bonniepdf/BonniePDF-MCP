import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [tarball, output, coreTarball] = process.argv.slice(2).map(path => resolve(path));
if (!tarball || !output || !process.env.npm_execpath) {
  throw new Error('Usage: npm run package:claude -- <npm tarball> <output.mcpb> [Core tarball]');
}

const scratch = await mkdtemp(join(tmpdir(), 'bonniepdf-mcpb-'));
const bundle = join(scratch, 'bundle');
const npm = (args, stdio = 'inherit') =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: scratch, stdio, encoding: 'utf8' });

try {
  await mkdir(bundle);
  await writeFile(join(bundle, 'package.json'), '{"private":true}\n');
  const packages = coreTarball ? [coreTarball, tarball] : [tarball];
  npm(['install', '--prefix', bundle, '--ignore-scripts', '--no-audit', '--no-fund', ...packages]);
  const installed = JSON.parse(await readFile(join(bundle, 'node_modules/@bonniepdf/mcp/package.json'), 'utf8'));

  // npm installs only the runner's optional native binary. Include each Claude Desktop target.
  const native = join(bundle, 'node_modules/@resvg');
  const resvg = JSON.parse(await readFile(join(native, 'resvg-js/package.json'), 'utf8'));
  for (const [name, version] of Object.entries(resvg.optionalDependencies)) {
    if (!/^@resvg\/resvg-js-(darwin|win32)-(arm64|x64)(-|$)/.test(name)) continue;
    const archive = npm(['pack', `${name}@${version}`, '--silent'], 'pipe').trim();
    const destination = join(native, name.slice('@resvg/'.length));
    await mkdir(destination, { recursive: true });
    execFileSync('tar', ['-xzf', join(scratch, archive), '-C', destination, '--strip-components=1']);
  }

  const manifest = JSON.parse(await readFile(new URL('../installer/claude-manifest.json', import.meta.url), 'utf8'));
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ ...manifest, version: installed.version }, null, 2));
  await writeFile(
    join(bundle, '.mcpbignore'),
    '/package.json\n/package-lock.json\n/node_modules/.package-lock.json\n/node_modules/.bin/\n'
  );
  await mkdir(dirname(output), { recursive: true });
  npm(['exec', '--yes', '--package', '@anthropic-ai/mcpb@2.1.2', '--', 'mcpb', 'pack', bundle, output]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
