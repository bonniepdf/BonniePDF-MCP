import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parse as toml } from 'smol-toml';
import { parse as json } from 'jsonc-parser';
import {
  CLIENTS,
  serverNamespace,
  configureClient,
  connectionFile,
  connectionEntry,
  connectionStatus,
  editConfiguration,
  removeConnections,
} from '../dist/clients.js';

function fixture() {
  mkdirSync('out/setup-tests', { recursive: true });
  const root = mkdtempSync(resolve('out/setup-tests/user with spaces-'));
  return {
    home: root,
    appData: join(root, 'Roaming'),
    stateDir: join(root, 'State'),
    platform: 'win32',
    executable: join(root, 'Installed App', 'runtime', 'node.exe'),
    entryPoint: join(root, 'Installed App', 'server', 'dist', 'index.js'),
  };
}
function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const read = path => readFileSync(path, 'utf8');

for (const client of CLIENTS) {
  test(`${client} setup preserves existing settings, is repeatable and removes only its entry`, () => {
    const context = fixture();
    const options = { client };
    const file = connectionFile(options, context);
    const namespace = serverNamespace(client);
    put(
      file,
      client === 'codex'
        ? '# Keep this comment\nmodel="example"\n[mcp_servers.other]\ncommand="other"\n'
        : `{\n  // Keep this comment\n  "theme": "dark",\n  "${namespace}": {"other": {"command": "other"}}\n}\n`
    );
    const original = read(file);
    const result = configureClient(options, context);
    assert.equal(connectionStatus(options, context).status, 'configured');
    assert.equal(result.changed, true);
    assert.equal(read(result.backup), original);
    assert.ok(read(file).includes('Keep this comment'));
    assert.equal(configureClient(options, context).changed, false);
    assert.equal(readdirSync(dirname(file)).filter(name => name.endsWith('.bak')).length, 1);
    const parsed = client === 'codex' ? toml(read(file)) : json(read(file));
    assert.deepEqual(structuredClone(parsed[namespace].bonniepdf), connectionEntry(options, context));
    const marker = join(context.stateDir, 'retained-document.pdf');
    put(marker, 'user document');
    assert.equal(removeConnections({}, context)[0].removed, true);
    const remaining = client === 'codex' ? toml(read(file)) : json(read(file));
    assert.equal(remaining[namespace].other.command, 'other');
    assert.equal(remaining[namespace].bonniepdf, undefined);
    assert.ok(existsSync(marker));
    assert.equal(connectionStatus(options, context).status, 'missing');
  });
}

test('replacing another BonniePDF connection requires explicit selection and saves a backup', () => {
  const context = fixture(),
    options = { client: 'codex' };
  const file = connectionFile(options, context);
  const original =
    '[mcp_servers.bonniepdf]\ncommand="existing"\n[mcp_servers.bonniepdf.env]\nCUSTOM="keep unless replaced"\n[mcp_servers.other]\ncommand="other"\n';
  put(file, original);
  assert.throws(() => configureClient(options, context), /--replace/);
  assert.equal(read(file), original);
  const changed = configureClient({ ...options, replace: true }, context);
  assert.equal(read(changed.backup), original);
  assert.equal(toml(read(file)).mcp_servers.other.command, 'other');
});

test('uninstall preserves an entry edited outside setup', () => {
  const context = fixture(),
    options = { client: 'claude-code' };
  const { file } = configureClient(options, context);
  const value = json(read(file));
  value.mcpServers.bonniepdf.env = { CUSTOM: 'user preference' };
  put(file, JSON.stringify(value));
  assert.equal(removeConnections({}, context)[0].removed, false);
  assert.equal(json(read(file)).mcpServers.bonniepdf.env.CUSTOM, 'user preference');
});

test('a replaced installation cannot remove its successor connection', () => {
  const context = fixture(),
    options = { client: 'antigravity' };
  configureClient(options, context);
  const successor = { ...context, entryPoint: join(context.home, 'New App', 'index.js') };
  const result = configureClient(options, successor);
  assert.equal(result.changed, true);
  assert.equal(removeConnections({}, context).length, 0);
  assert.equal(removeConnections({}, successor)[0].removed, true);
});

test('project scope uses a separate config and session directory', () => {
  const context = fixture();
  const projectDir = join(context.home, 'Project');
  mkdirSync(projectDir);
  for (const client of ['codex', 'claude-code', 'antigravity', 'vscode', 'visual-studio', 'copilot-cli']) {
    const clientProject = join(projectDir, client);
    mkdirSync(clientProject);
    const user = { client },
      project = { client, scope: 'project', projectDir: clientProject };
    assert.notEqual(connectionFile(user, context), connectionFile(project, context));
    assert.notDeepEqual(connectionEntry(user, context).args, connectionEntry(project, context).args);
    configureClient(project, context);
  }
  assert.throws(
    () => connectionFile({ client: 'claude-desktop', scope: 'project', projectDir }, context),
    /user scope/
  );
});

test('invalid or ambiguous configuration is never overwritten', () => {
  const context = fixture(),
    options = { client: 'claude-code' };
  const file = connectionFile(options, context);
  put(file, '{broken');
  assert.throws(() => configureClient(options, context), /valid object/);
  assert.equal(read(file), '{broken');
  assert.throws(() => editConfiguration('[mcp_servers]\nbonniepdf = {command="old"}', 'codex', { command: 'new' }));
  const multiline = 'instructions="""\n[mcp_servers.bonniepdf]\ncommand="in a string"\n"""\n';
  assert.throws(() => editConfiguration(multiline, 'codex', { command: 'new' }));
});

test('Copilot targets use their own schemas, platform paths and configurable homes', () => {
  const context = fixture();
  assert.equal(connectionFile({ client: 'vscode' }, context), join(context.appData, 'Code', 'User', 'mcp.json'));
  assert.equal(
    connectionFile({ client: 'vscode' }, { ...context, platform: 'darwin' }),
    join(context.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
  );
  assert.equal(
    connectionFile({ client: 'vscode' }, { ...context, platform: 'linux', configHome: join(context.home, 'Config') }),
    join(context.home, 'Config', 'Code', 'User', 'mcp.json')
  );
  assert.equal(connectionFile({ client: 'visual-studio' }, context), join(context.home, '.mcp.json'));
  assert.equal(
    connectionFile({ client: 'copilot-cli' }, { ...context, copilotHome: join(context.home, 'Copilot') }),
    join(context.home, 'Copilot', 'mcp-config.json')
  );
  assert.equal(connectionEntry({ client: 'vscode' }, context).type, 'stdio');
  assert.equal(connectionEntry({ client: 'visual-studio' }, context).type, 'stdio');
  assert.deepEqual(connectionEntry({ client: 'copilot-cli' }, context).tools, ['*']);
});

test('Visual Studio preserves Claude project configuration in the same file', () => {
  const context = fixture();
  const projectDir = context.home;
  configureClient({ client: 'claude-code', scope: 'project', projectDir }, context);
  configureClient({ client: 'visual-studio', scope: 'project', projectDir }, context);
  const file = join(projectDir, '.mcp.json');
  const before = json(read(file));
  assert.ok(before.mcpServers.bonniepdf);
  assert.ok(before.servers.bonniepdf);
  removeConnections({ client: 'visual-studio' }, context);
  assert.deepEqual(json(read(file)).mcpServers, before.mcpServers);
});

test('Copilot diagnostics detect a disabled tool list and an invalid transport', () => {
  const context = fixture();
  const options = { client: 'copilot-cli' };
  const { file } = configureClient(options, context);
  const value = json(read(file));
  value.mcpServers.bonniepdf.tools = [];
  put(file, JSON.stringify(value));
  assert.equal(connectionStatus(options, context).status, 'disabled');
  value.mcpServers.bonniepdf.tools = ['*'];
  value.mcpServers.bonniepdf.type = 'http';
  put(file, JSON.stringify(value));
  assert.equal(connectionStatus(options, context).status, 'different-launch-command');
});

test('Replacing a shared Claude/Copilot project entry transfers ownership without stale records', () => {
  const context = fixture();
  const projectDir = context.home;
  configureClient({ client: 'claude-code', scope: 'project', projectDir }, context);
  assert.throws(() => configureClient({ client: 'copilot-cli', scope: 'project', projectDir }, context), /--replace/);
  configureClient({ client: 'copilot-cli', scope: 'project', projectDir, replace: true }, context);
  const records = JSON.parse(read(join(context.stateDir, 'connections.json')));
  assert.equal(records.length, 1);
  assert.equal(records[0].client, 'copilot-cli');
  assert.equal(removeConnections({}, context)[0].removed, true);
  assert.deepEqual(JSON.parse(read(join(context.stateDir, 'connections.json'))), []);
});

test('quoted TOML tables and nested fields preserve the other server and comments', () => {
  const source =
    '# title\n[mcp_servers."bonniepdf"]\ncommand="old"\n[mcp_servers."bonniepdf".env]\nA="b"\n# other\n[mcp_servers.other]\ncommand="retained"\n';
  const edited = editConfiguration(source, 'codex', { command: 'new', args: ['a path with spaces'] });
  assert.equal(toml(edited).mcp_servers.bonniepdf.command, 'new');
  assert.equal(toml(edited).mcp_servers.other.command, 'retained');
  assert.ok(edited.includes('# title'));
});

test('Antigravity detects the legacy file but refuses ambiguous locations', () => {
  const context = fixture();
  const legacy = join(context.home, '.gemini', 'antigravity', 'mcp_config.json');
  put(legacy, '{}');
  assert.equal(connectionFile({ client: 'antigravity' }, context), legacy);
  put(join(context.home, '.gemini', 'config', 'mcp_config.json'), '{}');
  assert.throws(() => connectionFile({ client: 'antigravity' }, context), /Two Antigravity/);
  assert.equal(connectionFile({ client: 'antigravity', configFile: legacy }, context), legacy);
});

test('a broken client config does not prevent other managed connections being removed', () => {
  const context = fixture();
  const broken = configureClient({ client: 'claude-code' }, context);
  const healthy = configureClient({ client: 'antigravity' }, context);
  put(broken.file, '{unfinished edit');
  const results = removeConnections({}, context);
  assert.equal(results.find(item => item.file === broken.file).removed, false);
  assert.equal(results.find(item => item.file === healthy.file).removed, true);
  assert.equal(read(broken.file), '{unfinished edit');
});
