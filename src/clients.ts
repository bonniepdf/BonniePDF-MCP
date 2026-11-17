import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseJson, modify, applyEdits, type ParseError } from 'jsonc-parser';

export const CLIENTS = [
  'codex',
  'claude-code',
  'claude-desktop',
  'antigravity',
  'vscode',
  'visual-studio',
  'copilot-cli',
  'zcode',
] as const;
export type ClientId = (typeof CLIENTS)[number];
export type Scope = 'user' | 'project';
export interface SetupContext {
  home: string;
  appData: string;
  stateDir: string;
  platform: NodeJS.Platform;
  executable: string;
  entryPoint: string;
  codexHome?: string;
  claudeConfigDir?: string;
  copilotHome?: string;
  configHome?: string;
}
export interface ConnectionOptions {
  client: ClientId;
  scope?: Scope;
  projectDir?: string;
  configFile?: string;
  replace?: boolean;
}
interface ConnectionRecord {
  file: string;
  client: ClientId;
  entry: Record<string, unknown>;
  installation: string;
}

export function defaultContext(): SetupContext {
  const home = homedir();
  const platform = process.platform;
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const data =
    platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'));
  return {
    home,
    appData,
    platform,
    stateDir: process.env.BONNIEPDF_MCP_HOME ? resolve(process.env.BONNIEPDF_MCP_HOME) : join(data, 'BonniePDF', 'MCP'),
    executable: process.execPath,
    entryPoint: fileURLToPath(new URL('./index.js', import.meta.url)),
    codexHome: process.env.CODEX_HOME,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    copilotHome: process.env.COPILOT_HOME,
    configHome: process.env.XDG_CONFIG_HOME,
  };
}

export function connectionFile(options: ConnectionOptions, context: SetupContext): string {
  if (!CLIENTS.includes(options.client)) throw new Error(`Choose ${CLIENTS.join(', ')}.`);
  if (options.configFile) return resolve(options.configFile);
  if (options.scope === 'project') {
    if (!options.projectDir) throw new Error('Project scope requires --project-dir.');
    const project = resolve(options.projectDir);
    if (!existsSync(project)) throw new Error(`Project directory does not exist: ${project}`);
    if (options.client === 'codex') return join(project, '.codex', 'config.toml');
    if (options.client === 'claude-code') return join(project, '.mcp.json');
    if (options.client === 'antigravity') return join(project, '.agents', 'mcp_config.json');
    if (options.client === 'vscode') return join(project, '.vscode', 'mcp.json');
    if (options.client === 'visual-studio' || options.client === 'copilot-cli') return join(project, '.mcp.json');
    if (options.client === 'zcode') return join(project, '.zcode', 'config.json');
    throw new Error('Claude Desktop uses user scope.');
  }
  if (options.client === 'codex') return join(context.codexHome ?? join(context.home, '.codex'), 'config.toml');
  if (options.client === 'claude-code')
    return context.claudeConfigDir ? join(context.claudeConfigDir, '.claude.json') : join(context.home, '.claude.json');
  if (options.client === 'visual-studio') return join(context.home, '.mcp.json');
  if (options.client === 'copilot-cli')
    return join(context.copilotHome ?? join(context.home, '.copilot'), 'mcp-config.json');
  if (options.client === 'zcode') return join(context.home, '.zcode', 'cli', 'config.json');
  if (options.client === 'vscode') {
    const base =
      context.platform === 'win32'
        ? context.appData
        : context.platform === 'darwin'
          ? join(context.home, 'Library', 'Application Support')
          : (context.configHome ?? join(context.home, '.config'));
    return join(base, 'Code', 'User', 'mcp.json');
  }
  if (options.client === 'claude-desktop') {
    if (context.platform === 'win32') return join(context.appData, 'Claude', 'claude_desktop_config.json');
    if (context.platform === 'darwin')
      return join(context.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    throw new Error('Claude Desktop setup is supported on Windows and macOS.');
  }
  const current = join(context.home, '.gemini', 'config', 'mcp_config.json');
  const legacy = join(context.home, '.gemini', 'antigravity', 'mcp_config.json');
  if (existsSync(current) && existsSync(legacy))
    throw new Error('Two Antigravity configurations exist. Select the active one with --config-file.');
  return existsSync(legacy) ? legacy : current;
}

export function connectionEntry(options: ConnectionOptions, context: SetupContext): Record<string, unknown> {
  const file = connectionFile(options, context);
  const identity = createHash('sha256').update(resolve(file).toLowerCase()).digest('hex').slice(0, 12);
  const data = join(context.stateDir, 'clients', `${options.client}-${identity}`);
  const entry: Record<string, unknown> = {
    command: context.executable,
    args: [context.entryPoint, 'serve', '--out-dir', join(data, 'artifacts'), '--session-dir', join(data, 'sessions')],
  };
  if (options.client === 'codex') Object.assign(entry, { startup_timeout_sec: 30, tool_timeout_sec: 120 });
  if (options.client === 'vscode' || options.client === 'visual-studio') entry.type = 'stdio';
  if (options.client === 'copilot-cli') Object.assign(entry, { type: 'local', tools: ['*'] });
  if (options.client === 'zcode') Object.assign(entry, { type: 'stdio', timeoutMs: 120000 });
  return entry;
}

/** ZCode nests its servers under `mcp.servers`; every other client uses one top-level key. */
export function serverNamespace(client: ClientId): readonly string[] {
  if (client === 'codex') return ['mcp_servers'];
  if (client === 'vscode' || client === 'visual-studio') return ['servers'];
  if (client === 'zcode') return ['mcp', 'servers'];
  return ['mcpServers'];
}

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// TOML deliberately uses null-prototype records; JSON uses ordinary records.
function equivalent(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(structuredClone(left), structuredClone(right));
}
/** Walk a namespace path; a defined but non-object segment is invalid configuration. */
function namespaceAt(value: Record<string, any>, namespace: readonly string[]): Record<string, any> | undefined {
  let node: unknown = value;
  for (const key of namespace) {
    if (node === undefined) return undefined;
    if (!object(node)) throw new Error('The MCP servers setting must be an object.');
    node = node[key];
  }
  if (node === undefined) return undefined;
  if (!object(node)) throw new Error('The MCP servers setting must be an object.');
  return node;
}
function parse(
  text: string,
  toml: boolean,
  namespace: readonly string[] = toml ? ['mcp_servers'] : ['mcpServers']
): Record<string, any> {
  const errors: ParseError[] = [];
  const value = toml
    ? parseToml(text, { integersAsBigInt: 'asNeeded' })
    : parseJson(text || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !object(value))
    throw new Error('Client configuration is not a valid object. Repair it before connecting BonniePDF.');
  namespaceAt(value, namespace);
  return value;
}
function withoutEntry(value: Record<string, any>, namespace: readonly string[]) {
  const copy = structuredClone(value);
  const chain: Record<string, any>[] = [copy];
  for (const key of namespace) {
    const next = chain[chain.length - 1][key];
    if (!object(next)) break;
    chain.push(next);
  }
  if (chain.length === namespace.length + 1) {
    delete chain[chain.length - 1].bonniepdf;
    for (let depth = namespace.length; depth > 0 && !Object.keys(chain[depth]).length; depth--) {
      delete chain[depth - 1][namespace[depth - 1]];
    }
  }
  return copy;
}

/** Preserve comments and unrelated settings, then prove only our parsed entry changed. */
export function editConfiguration(text: string, client: ClientId, entry?: Record<string, unknown>): string {
  const toml = client === 'codex';
  const namespace = serverNamespace(client);
  const before = parse(text, toml, namespace);
  let next: string;
  if (!toml) {
    next = applyEdits(
      text || '{}\n',
      modify(text || '{}\n', [...namespace, 'bonniepdf'], entry, {
        formattingOptions: { insertSpaces: !/^\t/m.test(text), tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
      })
    );
  } else {
    const headers = [...text.matchAll(/^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#.*)?$/gm)];
    const removals: [number, number][] = [];
    for (let i = 0; i < headers.length; i++) {
      try {
        const table = parseToml(`[${headers[i][1]}]\n__bonniepdf_probe__ = true`);
        if (object(table.mcp_servers) && Object.hasOwn(table.mcp_servers, 'bonniepdf')) {
          removals.push([headers[i].index!, headers[i + 1]?.index ?? text.length]);
        }
      } catch {
        /* Non-table syntax is caught by validation below. */
      }
    }
    next = text;
    for (const [start, end] of removals.reverse()) {
      const comments = text
        .slice(start, end)
        .split(/\r?\n/)
        .filter(line => /^[ \t]*#/.test(line))
        .join('\n');
      next = next.slice(0, start) + (comments ? comments + '\n' : '') + next.slice(end);
    }
    if (entry) next = next.trimEnd() + '\n\n' + stringifyToml({ mcp_servers: { bonniepdf: entry } });
  }
  const after = parse(next, toml, namespace);
  if (
    !isDeepStrictEqual(withoutEntry(before, namespace), withoutEntry(after, namespace)) ||
    !equivalent(namespaceAt(after, namespace)?.bonniepdf, entry)
  ) {
    throw new Error(
      'Cannot safely edit this configuration format. No settings were changed. Use the config command to merge the entry manually.'
    );
  }
  return next;
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/^\uFEFF/, '') : '';
}
function records(context: SetupContext): ConnectionRecord[] {
  const file = join(context.stateDir, 'connections.json');
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !Array.isArray(value) ||
    !value.every(
      item =>
        object(item) &&
        typeof item.file === 'string' &&
        typeof item.installation === 'string' &&
        CLIENTS.includes(item.client) &&
        object(item.entry)
    )
  ) {
    throw new Error('The BonniePDF connection record is invalid. No client settings were changed.');
  }
  return value;
}
function atomicWrite(file: string, original: string, next: string, backup: boolean): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  if (read(file) !== original) throw new Error('Configuration changed during setup. Close its editor and retry.');
  const backupFile =
    backup && existsSync(file) ? `${file}.bonniepdf-${Date.now()}-${randomUUID().slice(0, 8)}.bak` : undefined;
  if (backupFile) copyFileSync(file, backupFile, 1);
  const temporary = `${file}.bonniepdf-${randomUUID()}.tmp`;
  writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
  if (read(file) !== original) throw new Error('Configuration changed during setup. No settings were replaced.');
  renameSync(temporary, file);
  return backupFile;
}
function saveRecords(context: SetupContext, value: ConnectionRecord[]) {
  const file = join(context.stateDir, 'connections.json');
  atomicWrite(file, read(file), JSON.stringify(value, null, 2) + '\n', false);
}

export function configureClient(options: ConnectionOptions, context: SetupContext = defaultContext()) {
  const file = connectionFile(options, context);
  const entry = connectionEntry(options, context);
  const original = read(file);
  const all = records(context);
  const namespace = serverNamespace(options.client);
  const existing = namespaceAt(parse(original, options.client === 'codex', namespace), namespace)?.bonniepdf;
  const previous = all.find(item => item.file === file && item.client === options.client);
  if (existing && !equivalent(existing, entry) && !equivalent(existing, previous?.entry) && !options.replace) {
    throw new Error(
      `An existing BonniePDF connection is present in ${file}. Use --replace to replace only that entry; a backup will be saved.`
    );
  }
  const changed = !equivalent(existing, entry);
  const backup = changed
    ? atomicWrite(file, original, editConfiguration(original, options.client, entry), true)
    : undefined;
  saveRecords(context, [
    ...all.filter(item => !(item.file === file && serverNamespace(item.client).join('.') === namespace.join('.'))),
    { file, client: options.client, entry, installation: context.entryPoint },
  ]);
  return {
    client: options.client,
    file,
    changed,
    backup,
    message: 'Configuration saved. Restart or reconnect the client and approve the server if requested.',
  };
}

export function removeConnections(options: Partial<ConnectionOptions>, context: SetupContext = defaultContext()) {
  const all = records(context);
  const retained: ConnectionRecord[] = [];
  const results: { file: string; removed: boolean; message?: string }[] = [];
  for (const record of all) {
    if (record.installation !== context.entryPoint) {
      retained.push(record);
      continue;
    }
    if (
      (options.client && record.client !== options.client) ||
      (options.scope && record.file !== connectionFile(options as ConnectionOptions, context))
    ) {
      retained.push(record);
      continue;
    }
    try {
      const original = read(record.file);
      const namespace = serverNamespace(record.client);
      const current = namespaceAt(parse(original, record.client === 'codex', namespace), namespace)?.bonniepdf;
      if (current === undefined) {
        results.push({ file: record.file, removed: false, message: 'Already removed.' });
        continue;
      }
      if (!equivalent(current, record.entry)) {
        retained.push(record);
        results.push({
          file: record.file,
          removed: false,
          message: 'Entry was changed outside setup and has been preserved.',
        });
        continue;
      }
      atomicWrite(record.file, original, editConfiguration(original, record.client), true);
      results.push({ file: record.file, removed: true });
    } catch (error) {
      retained.push(record);
      results.push({
        file: record.file,
        removed: false,
        message: `Configuration preserved: ${(error as Error).message}`,
      });
    }
  }
  saveRecords(context, retained);
  return results;
}

export function formattedConnection(options: ConnectionOptions, context: SetupContext = defaultContext()) {
  const entry = connectionEntry(options, context);
  if (options.client === 'codex') return stringifyToml({ mcp_servers: { bonniepdf: entry } });
  let nested: Record<string, unknown> = { bonniepdf: entry };
  for (const key of [...serverNamespace(options.client)].reverse()) nested = { [key]: nested };
  return JSON.stringify(nested, null, 2);
}

export function connectionStatus(options: ConnectionOptions, context: SetupContext = defaultContext()) {
  const file = connectionFile(options, context);
  const namespace = serverNamespace(options.client);
  const value = namespaceAt(parse(read(file), options.client === 'codex', namespace), namespace)?.bonniepdf;
  const expected = connectionEntry(options, context);
  const status =
    value === undefined
      ? 'missing'
      : value.enabled === false ||
          value.disabled === true ||
          (options.client === 'copilot-cli' && Array.isArray(value.tools) && !value.tools.length)
        ? 'disabled'
        : equivalent(value.command, expected.command) &&
            equivalent(value.args, expected.args) &&
            equivalent(value.type, expected.type)
          ? 'configured'
          : 'different-launch-command';
  return { client: options.client, file, status };
}
