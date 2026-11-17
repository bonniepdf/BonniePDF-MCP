// Actual Ollama measurements. Never downloads models or substitutes synthetic scores.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { connectServer, runAgent, DEFAULTS, AGENT_SYSTEM } from './ollama-agent.mjs';
import { score, summarize } from './eval-support.mjs';
import { defaultContext } from '../dist/clients.js';

const root = resolve(import.meta.dirname, '..');
export async function runEvaluation(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: 'string', multiple: true },
      brief: { type: 'string', multiple: true },
      profile: { type: 'string', multiple: true },
      repeat: { type: 'string', default: '1' },
      host: { type: 'string', default: DEFAULTS.host },
      ctx: { type: 'string', default: String(DEFAULTS.numCtx) },
      'max-steps': { type: 'string', default: '20' },
      'max-output': { type: 'string', default: String(DEFAULTS.numPredict) },
      'request-timeout-ms': { type: 'string', default: String(DEFAULTS.requestTimeoutMs) },
      images: { type: 'string', default: 'auto' },
      verbose: { type: 'boolean', default: false },
      'list-models': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(`pnpm eval --model <installed-model> [--profile lite --profile full] [--repeat 3]
  --list-models              List installed models without running them
  --brief <id>              Select a brief; repeat for several
  --host <url>              Ollama endpoint (default ${DEFAULTS.host})
  --ctx <tokens>            Context size (default ${DEFAULTS.numCtx})
  --max-output <tokens>     Per-request generation cap (default ${DEFAULTS.numPredict})
  --max-steps <n>            Model request limit per brief (default 20)
  --request-timeout-ms <ms>  Deadline per model request (default ${DEFAULTS.requestTimeoutMs})
  --images auto|on|off       Send previews only to capable models in auto mode
Reports include failures and partial usage; no model downloads are performed.`);
  } else {
    const profiles = values.profile ?? ['lite'];
    for (const p of profiles) if (!['lite', 'full'].includes(p)) throw new Error('Profile must be lite or full');
    if (!['auto', 'on', 'off'].includes(values.images)) throw new Error('Images must be auto, on or off');
    for (const key of ['repeat', 'ctx', 'max-output', 'max-steps', 'request-timeout-ms'])
      if (!Number.isInteger(Number(values[key])) || Number(values[key]) < 1)
        throw new Error(`${key} must be a positive integer`);
    const host = (/^https?:\/\//.test(values.host) ? values.host : `http://${values.host}`).replace(/\/+$/, '');
    const out = resolve(defaultContext().stateDir, 'benchmarks');
    await mkdir(out, { recursive: true });
    const reportFile = resolve(out, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    let available;
    try {
      const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      available = (await response.json()).models ?? [];
    } catch (error) {
      await writeFile(
        reportFile,
        JSON.stringify(
          {
            status: 'unavailable',
            reason: `Ollama unavailable: ${error.message}`,
            rows: [],
            summary: [],
            modelRuns: 0,
          },
          null,
          2
        )
      );
      console.error(`Ollama is not reachable. No models were run. Report: ${reportFile}`);
      process.exitCode = 2;
    }
    if (available && values['list-models']) {
      console.table(
        available.map(m => ({
          model: m.name,
          parameters: m.details?.parameter_size,
          quantization: m.details?.quantization_level,
          bytes: m.size,
        }))
      );
    } else if (available) {
      const models = values.model ?? [];
      if (!models.length)
        throw new Error(
          'Select an installed model with --model; use --list-models first. No model is selected or downloaded automatically.'
        );
      const allBriefs = JSON.parse(await readFile(resolve(root, 'evals/briefs.json'), 'utf8'));
      if (values.brief?.some(id => !allBriefs.some(b => b.id === id))) throw new Error('Unknown brief ID');
      const briefs = allBriefs.filter(b => !values.brief?.length || values.brief.includes(b.id));
      const rows = [];
      const save = async (completed = false) =>
        writeFile(
          reportFile,
          JSON.stringify(
            {
              status: completed ? 'completed' : 'running',
              settings: {
                host,
                profiles,
                repeat: Number(values.repeat),
                context: Number(values.ctx),
                maxOutput: Number(values['max-output']),
                temperature: DEFAULTS.temperature,
                maxSteps: Number(values['max-steps']),
                requestTimeoutMs: Number(values['request-timeout-ms']),
                images: values.images,
                profileOrder: 'alternating by repetition',
                agentInstructions: AGENT_SYSTEM,
              },
              installedModels: available.map(m => ({ name: m.name, digest: m.digest, details: m.details })),
              note: 'Token counts are cumulative Ollama-reported prompt evaluation and generation across requests. They include repeated context and are not unique conversation tokens. Checks are structural, not a visual quality certification.',
              summary: summarize(rows),
              rows,
            },
            null,
            2
          )
        );
      for (const model of models)
        for (const brief of briefs)
          for (let run = 1; run <= Number(values.repeat); run++)
            for (const profile of run % 2 ? profiles : [...profiles].reverse()) {
              const directory = await mkdtemp(resolve(out, 'run-'));
              const sessionDir = resolve(directory, 'sessions');
              const started = performance.now();
              let result, error, connection;
              try {
                connection = await connectServer({
                  profile,
                  outDir: resolve(directory, 'artifacts'),
                  extraArgs: ['--session-dir', sessionDir],
                });
                result = await runAgent({
                  client: connection.client,
                  model,
                  host,
                  messages: [
                    {
                      role: 'system',
                      content: AGENT_SYSTEM,
                    },
                    { role: 'user', content: brief.prompt },
                  ],
                  numCtx: Number(values.ctx),
                  numPredict: Number(values['max-output']),
                  maxSteps: Number(values['max-steps']),
                  requestTimeoutMs: Number(values['request-timeout-ms']),
                  images: values.images,
                  log: values.verbose ? line => console.error(line) : () => {},
                });
              } catch (e) {
                error = e;
                result = { trace: e.trace ?? [], usage: e.usage };
              } finally {
                if (connection) await connection.close();
              }
              const agentSeconds = (performance.now() - started) / 1000;
              let failures = error ? [error.message] : [];
              if (!error) {
                const inspector = await connectServer({
                  profile: 'full',
                  outDir: resolve(directory, 'artifacts'),
                  extraArgs: ['--session-dir', sessionDir],
                });
                try {
                  failures = (await score(inspector.client, brief, result.trace, result.answer)).failures;
                } catch (e) {
                  failures.push(`Scoring failed: ${e.message}`);
                } finally {
                  await inspector.close();
                }
              }
              if (result.stoppedAtLimit) failures.push('model request limit reached');
              const usage = result.usage;
              const row = {
                model,
                profile,
                brief: brief.id,
                run,
                passed: failures.length === 0,
                failures,
                answer: result.answer?.slice(0, 300),
                toolCalls: result.trace.length,
                toolErrors: result.trace.filter(t => t.isError).length,
                promptTokens: usage?.promptTokens ?? null,
                outputTokens: usage?.outputTokens ?? null,
                thinkingChars: usage?.thinkingChars ?? null,
                tokenCountsComplete: !error && !!usage?.requests && usage.reportedRequests === usage.requests,
                requests: usage?.requests ?? 0,
                seconds: Math.round(agentSeconds * 10) / 10,
                serverMs: result.trace.reduce((n, t) => n + (t.durationMs ?? 0), 0),
                modelMs: usage?.modelMs,
                loadMs: usage?.loadMs,
                promptEvalMs: usage?.promptEvalMs,
                outputEvalMs: usage?.outputEvalMs,
                stoppedAtLimit: !!result.stoppedAtLimit,
                directory,
              };
              rows.push(row);
              await writeFile(resolve(directory, 'trace.json'), JSON.stringify(result.trace, null, 2));
              await save();
              console.error(
                `${row.passed ? 'PASS' : 'FAIL'} ${model} ${profile} ${brief.id} ${row.seconds}s ${failures.join('; ')}`
              );
            }
      await save(true);
      console.table(summarize(rows));
      console.error(`Results: ${reportFile}`);
      if (rows.some(r => !r.passed)) process.exitCode = 1;
    }
  }
}
