#!/usr/bin/env node
// Drives the BonniePDF MCP server with a local Ollama model.
//
// Ollama serves models but is not an MCP client, so this script is the bridge: it
// starts the server over stdio, offers its tools to the model through /api/chat,
// runs the calls the model makes and returns their results until the model answers.
//
//   node scripts/ollama-agent.mjs --model <installed-model> "Make an invoice for October Services"
//   node scripts/ollama-agent.mjs --model <installed-model>  (interactive)
import { Client } from '@modelcontextprotocol/client';
import { defaultContext } from '../dist/clients.js';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const TOOL_TEXT_LIMIT = 8000;
const stateDir = defaultContext().stateDir;

export const DEFAULTS = {
  model: process.env.BONNIEPDF_OLLAMA_MODEL,
  host: process.env.OLLAMA_HOST ? normaliseHost(process.env.OLLAMA_HOST) : 'http://127.0.0.1:11434',
  profile: 'lite',
  numCtx: 16384,
  maxSteps: 30,
  temperature: 0.2,
  requestTimeoutMs: 180000,
  numPredict: 2048,
};

function normaliseHost(host) {
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return withScheme.replace(/\/+$/, '').replace('0.0.0.0', '127.0.0.1');
}

export const AGENT_SYSTEM = `You are a document assistant with BonniePDF tools. Use the tools to do the work; do not describe JSON for the user to apply.
Rules:
- Start from an example when one fits: search_docs, then create_document with its exampleId.
- Cloning does not apply requested changes. If edits are requested, create with output:"outline", then edit and save. Use a blank definition when the user asks to build from scratch.
- Use find_elements to locate what to change, then edit with patch_and_preview (or patch_document). Paths like "#mcp-4/text" address an element by id.
- To change a TextBlock's text, replace its /text property, not the element object. Preserve its other properties. Appending at the end means the final page's content array, not the first page.
- Always pass the revision returned by your most recent successful call. If a call fails, read the error, fix the problem and retry.
- Before adding a new element, call describe_element to see its valid keys.
- Fetch several types together with describe_element({names:[...]}). Batch related edits.
- For an unchanged template, create_document({exampleId, output:"pdf-and-preview"}) previews and saves in one call.
- If a call already saved the requested PDF, report its path without rendering it again. Otherwise finish with render_pdf. Answer in one or two sentences.`;

/** Starts the MCP server and returns a connected client. */
export async function connectServer({
  profile = DEFAULTS.profile,
  outDir = resolve(stateDir, 'ollama'),
  extraArgs = [],
} = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'dist/index.js'), '--profile', profile, '--out-dir', outDir, ...extraArgs],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {}); // The licence banner and logs are not useful here.
  const client = new Client({ name: 'bonniepdf-ollama', version: '0.1.0' });
  await client.connect(transport);
  return { client, close: async () => (await client.close(), await transport.close()) };
}

/** Asks Ollama whether a model accepts images. */
export async function modelCapabilities(host, model, signal) {
  const response = await fetch(`${host}/api/show`, { method: 'POST', signal, body: JSON.stringify({ model }) });
  if (!response.ok)
    throw new Error(`Ollama does not know model '${model}' (${response.status}). Try: ollama pull ${model}`);
  const info = await response.json();
  const capabilities = new Set(info.capabilities ?? []);
  capabilities.thinkingValues = info.thinking?.values;
  return capabilities;
}

/** Some models write a tool call as JSON text instead of using tool_calls. Recover it when unambiguous. */
function toolCallsFromText(content, toolNames) {
  const candidates = [content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], content].filter(Boolean);
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text.trim());
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (calls.every(c => toolNames.has(c?.name) && typeof (c.arguments ?? c.parameters ?? {}) === 'object')) {
        return calls.map(c => ({ function: { name: c.name, arguments: c.arguments ?? c.parameters ?? {} } }));
      }
    } catch {}
  }
  return [];
}

/**
 * Runs one conversation turn to completion. `messages` is extended in place, so a
 * caller can continue the conversation. Returns the answer, tool trace and token counts.
 */
export async function runAgent({
  client,
  messages,
  model = DEFAULTS.model,
  host = DEFAULTS.host,
  numCtx = DEFAULTS.numCtx,
  maxSteps = DEFAULTS.maxSteps,
  temperature = DEFAULTS.temperature,
  images = 'auto',
  toolFilter,
  log = () => {},
  signal,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
  numPredict = DEFAULTS.numPredict,
}) {
  if (!model) throw new Error('Choose an installed tool-capable model with --model or BONNIEPDF_OLLAMA_MODEL.');
  const requestSignal = () =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs);
  const capabilities = await modelCapabilities(host, model, requestSignal());
  if (!capabilities.has('tools')) throw new Error(`${model} does not support tool calling`);
  const sendImages = images === 'on' || (images === 'auto' && capabilities.has('vision'));
  const listed = (await client.listTools()).tools.filter(t => !toolFilter || toolFilter.has(t.name));
  const toolNames = new Set(listed.map(t => t.name));
  const tools = listed.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const trace = [];
  const usage = {
    promptTokens: 0,
    outputTokens: 0,
    thinkingChars: 0,
    requests: 0,
    reportedRequests: 0,
    modelMs: 0,
    loadMs: 0,
    promptEvalMs: 0,
    outputEvalMs: 0,
  };
  let nudged = false;

  try {
    for (let step = 0; step < maxSteps; step++) {
      const modelStarted = performance.now();
      const response = await fetch(`${host}/api/chat`, {
        method: 'POST',
        signal: requestSignal(),
        body: JSON.stringify({
          model,
          messages,
          tools,
          stream: false,
          ...(capabilities.thinkingValues?.includes(false) ? { think: false } : {}),
          options: { num_ctx: numCtx, temperature, num_predict: numPredict },
        }),
      });
      if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
      const reply = await response.json();
      usage.modelMs += Math.round(performance.now() - modelStarted);
      if (typeof reply.prompt_eval_count === 'number' && typeof reply.eval_count === 'number') usage.reportedRequests++;
      usage.loadMs += (reply.load_duration ?? 0) / 1e6;
      usage.promptEvalMs += (reply.prompt_eval_duration ?? 0) / 1e6;
      usage.outputEvalMs += (reply.eval_duration ?? 0) / 1e6;
      usage.promptTokens += reply.prompt_eval_count ?? 0;
      usage.outputTokens += reply.eval_count ?? 0;
      usage.requests++;
      const message = reply.message;
      usage.thinkingChars += message.thinking?.length ?? 0;
      let calls = message.tool_calls ?? [];
      if (!calls.length && message.content) calls = toolCallsFromText(message.content, toolNames);
      messages.push({
        role: 'assistant',
        content: message.content ?? '',
        ...(message.thinking ? { thinking: message.thinking } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      if (!calls.length) {
        if (reply.done_reason === 'length' && !message.content?.trim()) {
          throw new Error(
            'Output limit reached before a tool request or answer. Use a non-thinking model or increase --max-output.'
          );
        }
        // Small models sometimes describe the work instead of doing it. Remind them once.
        if (!trace.length && !nudged) {
          nudged = true;
          log('  (no tool call yet; reminding the model to use its tools)');
          messages.push({ role: 'user', content: 'Please do this with your tools now rather than describing it.' });
          continue;
        }
        return { answer: message.content ?? '', trace, usage, steps: step + 1 };
      }

      for (const call of calls) {
        const name = call.function.name;
        let args = call.function.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        log(`→ ${name} ${JSON.stringify(args).slice(0, 160)}`);
        let text;
        let isError = false;
        const toolStarted = performance.now();
        let outcome;
        const pictures = [];
        if (!toolNames.has(name)) {
          text = JSON.stringify({
            error: { message: `Unknown tool ${name}. Available: ${[...toolNames].join(', ')}` },
          });
          isError = true;
        } else {
          try {
            const result = await client.callTool({ name, arguments: args }, { timeout: 180_000 });
            outcome = result.structuredContent;
            isError = !!result.isError || !!outcome?.error;
            text = result.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            for (const c of result.content) if (c.type === 'image') pictures.push(c.data);
          } catch (error) {
            text = JSON.stringify({ error: { message: error.message } });
            isError = true;
          }
        }
        if (text.length > TOOL_TEXT_LIMIT)
          text = text.slice(0, TOOL_TEXT_LIMIT) + `… [truncated ${text.length - TOOL_TEXT_LIMIT} characters]`;
        trace.push({
          tool: name,
          arguments: args,
          isError,
          chars: text.length,
          images: pictures.length,
          durationMs: Math.round(performance.now() - toolStarted),
          documentId: outcome?.documentId,
          pdf: !isError && outcome?.artifact?.mimeType === 'application/pdf',
          artifactPath: outcome?.artifact?.path,
        });
        log(`  ${isError ? '✗' : '✓'} ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
        messages.push({ role: 'tool', tool_name: name, content: text });
        if (pictures.length && sendImages) {
          messages.push({
            role: 'user',
            content: `Rendered preview from ${name}. Check it matches the request.`,
            images: pictures,
          });
        }
      }
    }
  } catch (error) {
    error.trace = trace;
    error.usage = usage;
    throw error;
  }
  return { answer: '', trace, usage, steps: maxSteps, stoppedAtLimit: true };
}

export async function runOllama(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: 'string', default: DEFAULTS.model },
      host: { type: 'string', default: DEFAULTS.host },
      profile: { type: 'string', default: DEFAULTS.profile },
      ctx: { type: 'string', default: String(DEFAULTS.numCtx) },
      'max-steps': { type: 'string', default: String(DEFAULTS.maxSteps) },
      images: { type: 'string', default: 'auto' },
      transcript: { type: 'boolean', default: false },
      'request-timeout-ms': { type: 'string', default: String(DEFAULTS.requestTimeoutMs) },
      'max-output': { type: 'string', default: String(DEFAULTS.numPredict) },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.error(`ollama-agent [prompt] --model <installed-model> [--host http://127.0.0.1:11434]
  [--profile lite|full] [--ctx 16384] [--max-steps 30] [--images auto|on|off] [--transcript]
  [--max-output 2048] [--request-timeout-ms 180000]
Without a prompt, starts an interactive session. Type "exit" to leave.`);
    return;
  }
  if (!values.model)
    throw new Error(
      'Choose a model with --model or BONNIEPDF_OLLAMA_MODEL. Run benchmark --list-models to list installed models.'
    );
  if (!['lite', 'full'].includes(values.profile)) throw new Error('Profile must be lite or full');
  if (!['auto', 'on', 'off'].includes(values.images)) throw new Error('Images must be auto, on or off');
  for (const key of ['ctx', 'max-steps', 'max-output', 'request-timeout-ms'])
    if (!Number.isInteger(Number(values[key])) || Number(values[key]) < 1)
      throw new Error(`${key} must be a positive integer`);
  const host = normaliseHost(values.host);
  const { client, close } = await connectServer({ profile: values.profile });
  const messages = [{ role: 'system', content: AGENT_SYSTEM }];
  const options = {
    client,
    messages,
    model: values.model,
    host,
    numCtx: Number(values.ctx),
    maxSteps: Number(values['max-steps']),
    images: values.images,
    requestTimeoutMs: Number(values['request-timeout-ms']),
    numPredict: Number(values['max-output']),
    log: line => console.error(line),
  };
  const totals = { promptTokens: 0, outputTokens: 0, requests: 0 };
  const turn = async prompt => {
    messages.push({ role: 'user', content: prompt });
    const started = Date.now();
    const result = await runAgent(options);
    for (const key of Object.keys(totals)) totals[key] += result.usage[key];
    console.log(result.answer || '(The model stopped without answering; raise --max-steps or try a larger model.)');
    console.error(
      `[${values.model}: ${result.steps} requests, ${result.usage.promptTokens} prompt + ${result.usage.outputTokens} output tokens, ${((Date.now() - started) / 1000).toFixed(1)} s]`
    );
  };
  try {
    if (positionals.length) await turn(positionals.join(' '));
    else {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      console.error(`BonniePDF with ${values.model}. Describe a document, or "exit".`);
      try {
        for (;;) {
          const prompt = (await rl.question('> ')).trim();
          if (!prompt || prompt === 'exit') break;
          await turn(prompt);
        }
      } finally {
        rl.close();
      }
    }
    if (values.transcript) {
      const dir = resolve(stateDir, 'ollama');
      await mkdir(dir, { recursive: true });
      const path = resolve(dir, `transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await writeFile(path, JSON.stringify({ model: values.model, totals, messages }, null, 2));
      console.error(`Transcript: ${path}`);
    }
  } finally {
    await close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOllama().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
