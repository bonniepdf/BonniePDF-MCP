#!/usr/bin/env node
// Scores local models on a fixed set of document briefs.
//
// Each brief runs in a fresh server. The model sees only the lite tool set; the
// harness then inspects the resulting document through the full tool set and
// checks it against the brief. Token counts are those Ollama reports, so runs
// can be compared on cost as well as success.
//
//   node scripts/eval.mjs --model qwen3-coder:30b --model gemma4:26b
//   node scripts/eval.mjs --brief invoice-customer --repeat 3
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { connectServer, runAgent, DEFAULTS } from './ollama-agent.mjs';

const root = resolve(import.meta.dirname, '..');
const LITE = new Set([
  'search_docs',
  'describe_element',
  'create_document',
  'find_elements',
  'get_document',
  'patch_and_preview',
  'render_pdf',
]);
const SYSTEM = `You are a document assistant with BonniePDF tools. Use the tools to do the work.
Start from an example when asked: search_docs, then create_document with its exampleId. Use find_elements to locate what to change, edit with patch_and_preview using paths like "#mcp-4/text", always pass the latest revision, call describe_element before adding a new element type, and finish with render_pdf.`;

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true },
    brief: { type: 'string', multiple: true },
    repeat: { type: 'string', default: '1' },
    ctx: { type: 'string', default: String(DEFAULTS.numCtx) },
    'max-steps': { type: 'string', default: '25' },
    images: { type: 'string', default: 'auto' },
    verbose: { type: 'boolean', default: false },
  },
});
const models = values.model?.length ? values.model : [DEFAULTS.model];
const briefs = JSON.parse(await readFile(resolve(root, 'evals/briefs.json'), 'utf8')).filter(
  b => !values.brief?.length || values.brief.includes(b.id)
);

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  return result.structuredContent;
};

/** Reads the document the agent worked on and applies the brief's checks. */
async function score(client, brief, trace) {
  const failures = [];
  const { documents } = await call(client, 'list_documents', {});
  if (!documents.length) return { failures: ['no document was created'] };
  // The agent may open several handles; judge the one it last edited or rendered.
  const touched = trace.filter(t => !t.isError && t.arguments?.documentId).map(t => t.arguments.documentId);
  const documentId = touched.at(-1) ?? documents.at(-1).documentId;
  const read = await call(client, 'get_document', { documentId, maxChars: 16000 });
  let definition;
  try {
    const parts = [read.text];
    for (let offset = read.nextOffset; offset !== null;) {
      const next = await call(client, 'get_document', { documentId, offset, maxChars: 16000 });
      parts.push(next.text);
      offset = next.nextOffset;
    }
    definition = JSON.parse(parts.join(''));
  } catch {
    return { documentId, failures: ['document could not be read back'] };
  }
  const json = JSON.stringify(definition);
  const checks = brief.checks;
  for (const text of checks.contains ?? []) if (!json.includes(text)) failures.push(`missing text "${text}"`);
  for (const [pointer, expected] of Object.entries(checks.pointerEquals ?? {})) {
    const value = await call(client, 'get_document', { documentId, pointer }).catch(() => undefined);
    if (!value || JSON.parse(value.text) !== expected) failures.push(`${pointer} is not "${expected}"`);
  }
  for (const type of checks.types ?? []) {
    const found = await call(client, 'find_elements', { documentId, type });
    if (!found.total) failures.push(`no ${type} element`);
  }
  if (checks.lastText) {
    const all = await call(client, 'find_elements', { documentId, limit: 100 });
    const last = all.matches.filter(m => m.text).at(-1);
    if (!last?.text.includes(checks.lastText))
      failures.push(`last text is "${last?.text}", expected "${checks.lastText}"`);
  }
  const validation = await call(client, 'validate_definition', { documentId });
  if (!validation.valid) failures.push(`definition invalid: ${validation.errors[0]?.message}`);
  if (checks.pdf && !trace.some(t => t.tool === 'render_pdf' && !t.isError && t.arguments?.documentId === documentId)) {
    failures.push('render_pdf was not called successfully for this document');
  }
  return { documentId, failures };
}

const rows = [];
for (const model of models) {
  for (const brief of briefs) {
    for (let run = 1; run <= Number(values.repeat); run++) {
      const { client, close } = await connectServer({ profile: 'full', outDir: resolve(root, 'out/eval') });
      const started = Date.now();
      let row;
      try {
        const result = await runAgent({
          client,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: brief.prompt },
          ],
          model,
          numCtx: Number(values.ctx),
          maxSteps: Number(values['max-steps']),
          images: values.images,
          toolFilter: LITE,
          log: values.verbose ? line => console.error(line) : () => {},
        });
        const { failures } = await score(client, brief, result.trace);
        row = {
          model,
          brief: brief.id,
          run,
          passed: failures.length === 0,
          failures,
          answer: result.answer.slice(0, 300),
          toolCalls: result.trace.length,
          toolErrors: result.trace.filter(t => t.isError).length,
          promptTokens: result.usage.promptTokens,
          outputTokens: result.usage.outputTokens,
          seconds: Math.round((Date.now() - started) / 100) / 10,
          ...(result.stoppedAtLimit ? { stoppedAtLimit: true } : {}),
        };
      } catch (error) {
        row = {
          model,
          brief: brief.id,
          run,
          passed: false,
          failures: [error.message],
          seconds: Math.round((Date.now() - started) / 100) / 10,
        };
      } finally {
        await close();
      }
      rows.push(row);
      console.error(
        `${row.passed ? 'PASS' : 'FAIL'} ${model} ${brief.id}#${run} ${row.seconds}s ${row.failures.join('; ')}`
      );
    }
  }
}

const summary = models.map(model => {
  const mine = rows.filter(r => r.model === model);
  const sum = key => mine.reduce((n, r) => n + (r[key] ?? 0), 0);
  return {
    model,
    passed: `${mine.filter(r => r.passed).length}/${mine.length}`,
    avgPromptTokens: Math.round(sum('promptTokens') / mine.length),
    avgOutputTokens: Math.round(sum('outputTokens') / mine.length),
    avgToolCalls: Math.round((10 * sum('toolCalls')) / mine.length) / 10,
    avgSeconds: Math.round(sum('seconds') / mine.length),
  };
});
console.table(summary);
await mkdir(resolve(root, 'out/eval'), { recursive: true });
const path = resolve(root, 'out/eval', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(path, JSON.stringify({ summary, rows }, null, 2));
console.error(`Results: ${path}`);
