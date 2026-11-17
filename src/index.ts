#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { isLicenseTier } from '@bonniepdf/core';
import { createServer, type ServerOptions } from './server.js';

const HELP = `bonniepdf-mcp [options]
Local stdio MCP server. Logs go to stderr.

  --out-dir <dir>               Artifact directory (default: <package>/out)
  --resource-dir <dir>          Directory that resource references may read from
  --license <tier>              Licence declaration (default: evaluation; env BONNIEPDF_LICENSE)
  --timeout-ms <ms>             Render deadline, 100–120000 (default: 45000)
  --profile full|lite           lite exposes 7 tools with short descriptions for small models
  --session-dir <dir>           Persist document handles here so they survive restarts
  --preview-ttl-hours <h>       Remove preview artifacts older than this (default: 24; 0 keeps them)
  --artifact-ttl-hours <h>      Remove PDFs/exports older than this (default: 0, keep)`;

const { values } = parseArgs({
  options: {
    'out-dir': { type: 'string' },
    'resource-dir': { type: 'string' },
    license: { type: 'string' },
    'timeout-ms': { type: 'string' },
    profile: { type: 'string' },
    'session-dir': { type: 'string' },
    'preview-ttl-hours': { type: 'string' },
    'artifact-ttl-hours': { type: 'string' },
    help: { type: 'boolean' },
  },
});

const number = (name: string, raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be ${min}–${max}`);
  return value;
};

if (values.help) {
  console.error(HELP);
} else {
  const license = values.license ?? process.env.BONNIEPDF_LICENSE ?? 'evaluation';
  if (!isLicenseTier(license)) throw new Error('Unrecognised licence tier');
  const timeoutMs = number('timeout-ms', values['timeout-ms'], 45_000, 100, 120_000);
  if (!Number.isInteger(timeoutMs)) throw new Error('timeout-ms must be an integer');
  const profile = values.profile ?? process.env.BONNIEPDF_MCP_PROFILE ?? 'full';
  if (profile !== 'full' && profile !== 'lite') throw new Error('profile must be full or lite');
  const sessionDir = values['session-dir'] ?? process.env.BONNIEPDF_MCP_SESSION_DIR;
  const options: ServerOptions = {
    outDir: resolve(values['out-dir'] ?? fileURLToPath(new URL('../out/', import.meta.url))),
    resourceDir: values['resource-dir'] ? resolve(values['resource-dir']) : undefined,
    license,
    timeoutMs,
    profile,
    sessionDir: sessionDir ? resolve(sessionDir) : undefined,
    previewTtlHours: number('preview-ttl-hours', values['preview-ttl-hours'], 24, 0, 24 * 365),
    artifactTtlHours: number('artifact-ttl-hours', values['artifact-ttl-hours'], 0, 0, 24 * 365),
  };
  // Building the first server reads the bundle, so missing or stale data fails before serving.
  const server = createServer(options);
  let first = true;
  serveStdio(
    () => {
      if (first) {
        first = false;
        return server;
      }
      return createServer(options);
    },
    { onerror: error => console.error(error.message) }
  );
}
