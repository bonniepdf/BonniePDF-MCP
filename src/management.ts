import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  CLIENTS,
  configureClient,
  removeConnections,
  formattedConnection,
  defaultContext,
  type ClientId,
  type ConnectionOptions,
} from './clients.js';
import { diagnose } from './doctor.js';

export const MANAGEMENT_HELP = `
Connection management:
  bonniepdf-mcp setup                         Choose clients interactively
  bonniepdf-mcp setup --client codex          Connect one client for this user
  bonniepdf-mcp setup --client all            Connect all supported clients
  bonniepdf-mcp doctor                        Test the installed server and PNG/PDF output
  bonniepdf-mcp config --client antigravity   Print a configuration entry without changing files
  bonniepdf-mcp remove --client codex         Disconnect an unchanged managed entry
  bonniepdf-mcp remove --all                  Disconnect unchanged managed entries for this installation
  bonniepdf-mcp ollama --model <name>         Use a locally installed Ollama model interactively
  bonniepdf-mcp benchmark --list-models       List models available from Ollama
  bonniepdf-mcp benchmark --model <name>      Measure model usage, tool calls and task results

Clients: ${CLIENTS.join(', ')}
Options:
  --scope user|project       Default: user (Claude Desktop supports user only)
  --project-dir <path>       Required with project scope
  --config-file <path>       Explicit client configuration location
  --replace                 Replace an existing BonniePDF entry after backing it up
  --report <path>            Also write the result as JSON
  --non-interactive          Never ask questions (requires --client for setup)

Setup preserves other MCP servers and settings. Restart the client after setup.
Remove preserves documents, sessions and configuration backups.`;

export async function runManagement(command: string, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      client: { type: 'string' },
      scope: { type: 'string' },
      'project-dir': { type: 'string' },
      'config-file': { type: 'string' },
      replace: { type: 'boolean' },
      all: { type: 'boolean' },
      'non-interactive': { type: 'boolean' },
      report: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(MANAGEMENT_HELP);
    return;
  }
  let output: unknown;
  try {
    const scope = values.scope ?? 'user';
    if (scope !== 'user' && scope !== 'project') throw new Error('Scope must be user or project.');
    let selected = values.client;
    if (!selected && command === 'setup' && stdin.isTTY && !values['non-interactive']) {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        console.log(
          'Connect BonniePDF MCP to:\n' + CLIENTS.map((client, index) => `  ${index + 1}. ${client}`).join('\n')
        );
        const answer = await prompt.question(`Choose a client (1–${CLIENTS.length}), or type all: `);
        selected = CLIENTS[Number(answer) - 1] ?? answer.trim();
      } finally {
        prompt.close();
      }
    }
    if (selected !== undefined && selected !== 'all' && !CLIENTS.includes(selected as ClientId))
      throw new Error('Unknown client. Use --help for supported clients.');
    if (values['config-file'] && (selected === 'all' || !selected))
      throw new Error('--config-file requires a single client.');
    if (scope === 'project' && (!values['project-dir'] || selected === 'all'))
      throw new Error('Project scope requires one client and --project-dir.');
    const options = (client: ClientId): ConnectionOptions => ({
      client,
      scope,
      projectDir: values['project-dir'],
      configFile: values['config-file'],
      replace: values.replace,
    });
    const context = defaultContext();
    if (command === 'doctor') {
      output = await diagnose(context, selected && selected !== 'all' ? options(selected as ClientId) : undefined);
    } else if (command === 'config') {
      if (!selected || selected === 'all') throw new Error('Choose one client with --client.');
      console.log(formattedConnection(options(selected as ClientId), context));
      return;
    } else if (command === 'setup') {
      if (!selected) throw new Error('Choose --client, or run setup in an interactive terminal.');
      const health = await diagnose(context);
      const clients = selected === 'all' ? CLIENTS : [selected as ClientId];
      const results = [];
      for (const client of clients) {
        try {
          results.push({ ok: true, ...configureClient(options(client), context) });
        } catch (error) {
          results.push({ ok: false, client, error: (error as Error).message });
        }
      }
      output = { ok: results.every(item => item.ok), health, connections: results };
      if (!results.every(item => item.ok)) process.exitCode = 1;
    } else if (command === 'remove') {
      if (!values.all && (!selected || selected === 'all')) throw new Error('Choose --client or --all.');
      output = {
        ok: true,
        connections: removeConnections(values.all ? {} : options(selected as ClientId), context),
        message: 'Generated documents, sessions and backups have been preserved.',
      };
    } else throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    output = { ok: false, error: (error as Error).message };
    process.exitCode = 1;
  }
  const json = JSON.stringify(output, null, 2);
  if (values.report) {
    const path = resolve(values.report);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json + '\n', { mode: 0o600 });
  }
  console.log(json);
}
