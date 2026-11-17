import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runAgent, runOllama } from '../scripts/ollama-agent.mjs';
import { score, summarize } from '../scripts/eval-support.mjs';

async function provider(handler, thinkingValues = [false, true]) {
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags')
      res.end(
        JSON.stringify({ models: [{ name: 'fixture', digest: 'test-only', details: { parameter_size: 'fixture' } }] })
      );
    else if (req.url === '/api/show')
      res.end(JSON.stringify({ capabilities: ['tools', 'thinking'], thinking: { values: thinkingValues } }));
    else handler(body, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    host: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
const reply = message => ({
  message,
  prompt_eval_count: 100,
  eval_count: 20,
  load_duration: 1000000,
  prompt_eval_duration: 2000000,
  eval_duration: 3000000,
});
const client = {
  listTools: async () => ({ tools: [{ name: 'create_document', inputSchema: { type: 'object' } }] }),
  callTool: async () => ({
    content: [{ type: 'text', text: '{"documentId":"fixture-id"}' }],
    structuredContent: { documentId: 'fixture-id' },
  }),
};

test('The Ollama bridge requires an explicit model and validates limits before starting a server', async () => {
  await assert.rejects(runAgent({ client, messages: [], model: '' }), /Choose an installed/);
  await assert.rejects(runOllama(['--model', 'fixture', '--ctx', '0']), /positive integer/);
  await assert.rejects(runOllama(['--model', 'fixture', '--profile', 'unknown']), /Profile/);
});

test('Ollama accounting records reported tokens and timings and retains partial usage on failure', async () => {
  let chats = 0;
  const fake = await provider((body, res) => {
    assert.equal(body.think, false);
    assert.equal(body.options.num_predict, 128);
    if (++chats === 1)
      res.end(
        JSON.stringify(
          reply({ content: '', tool_calls: [{ function: { name: 'create_document', arguments: { blank: true } } }] })
        )
      );
    else {
      res.statusCode = 500;
      res.end('fixture failure');
    }
  });
  try {
    await assert.rejects(
      runAgent({ client, messages: [], model: 'fixture', host: fake.host, numPredict: 128 }),
      error => {
        assert.equal(error.usage.promptTokens, 100);
        assert.equal(error.usage.outputTokens, 20);
        assert.equal(error.usage.reportedRequests, 1);
        assert.equal(error.trace.length, 1);
        assert.equal(error.trace[0].documentId, 'fixture-id');
        assert.equal(error.usage.loadMs, 1);
        return /500/.test(error.message);
      }
    );
  } finally {
    await fake.close();
  }
});

test('Thinking-only models retain reasoning between tool calls without forcing an unsupported setting', async () => {
  let chats = 0;
  const fake = await provider(
    (body, res) => {
      assert.equal(body.think, undefined);
      if (++chats === 1)
        res.end(
          JSON.stringify(
            reply({
              content: '',
              thinking: 'fixture reasoning',
              tool_calls: [{ function: { name: 'create_document', arguments: { blank: true } } }],
            })
          )
        );
      else {
        assert.equal(body.messages.find(m => m.role === 'assistant').thinking, 'fixture reasoning');
        res.end(JSON.stringify(reply({ content: 'Done' })));
      }
    },
    [true]
  );
  try {
    const result = await runAgent({ client, messages: [], model: 'fixture', host: fake.host });
    assert.equal(result.usage.thinkingChars, 'fixture reasoning'.length);
    assert.equal(result.trace.length, 1);
  } finally {
    await fake.close();
  }
});

test('A reasoning-only truncated response fails immediately and retains usage', async () => {
  let chats = 0;
  const fake = await provider(
    (body, res) => {
      chats++;
      res.end(JSON.stringify({ ...reply({ content: '', thinking: 'unfinished' }), done_reason: 'length' }));
    },
    [true]
  );
  try {
    await assert.rejects(runAgent({ client, messages: [], model: 'fixture', host: fake.host }), error => {
      assert.equal(error.usage.outputTokens, 20);
      assert.equal(chats, 1);
      return /Output limit reached/.test(error.message);
    });
  } finally {
    await fake.close();
  }
});

test('Ollama requests have a bounded deadline', async () => {
  const fake = await provider(() => {});
  try {
    await assert.rejects(
      runAgent({ client, messages: [], model: 'fixture', host: fake.host, requestTimeoutMs: 100 }),
      /timeout|aborted/i
    );
  } finally {
    await fake.close();
  }
});

test('Benchmark rejects a PDF saved before the final document edit', async () => {
  const inspector = {
    callTool: async ({ name }) => ({
      structuredContent:
        name === 'list_documents'
          ? { documents: [{ documentId: 'doc' }] }
          : name === 'get_document'
            ? { text: '{}', nextOffset: null }
            : { valid: true },
    }),
  };
  const result = await score(inspector, { checks: { pdf: true } }, [
    { tool: 'create_document', documentId: 'doc', pdf: true, artifactPath: resolve('missing-fixture.pdf') },
    { tool: 'patch_and_preview', arguments: { documentId: 'doc' } },
  ]);
  assert.ok(result.failures.includes('PDF was generated before the final edit'));
});

test('Benchmark summaries keep unavailable usage distinct from zero tokens', () => {
  const summary = summarize([
    {
      model: 'unavailable',
      profile: 'lite',
      passed: false,
      tokenCountsComplete: false,
      promptTokens: null,
      outputTokens: null,
      seconds: 1,
      toolCalls: 0,
    },
  ]);
  assert.equal(summary[0].measuredRuns, 0);
  assert.equal(summary[0].avgPromptTokens, null);
  assert.equal(summary[0].avgOutputTokens, null);
});

test('Benchmark CLI runs real lite/full MCP workflows against a fixture provider and scores the saved PDFs', async () => {
  const profiles = new Set();
  const fake = await provider((body, res) => {
    profiles.add(body.tools.length);
    const message = body.messages.some(m => m.role === 'tool')
      ? {
          content: 'Saved the PDF: ' + JSON.parse(body.messages.findLast(m => m.role === 'tool').content).artifact.path,
        }
      : {
          content: '',
          tool_calls: [
            {
              function: {
                name: 'create_document',
                arguments: { exampleId: 'business-invoice', output: 'pdf-and-preview' },
              },
            },
          ],
        };
    res.end(JSON.stringify(reply(message)));
  });
  const state = await mkdtemp(resolve(tmpdir(), 'bonniepdf-eval-fixture-'));
  try {
    const child = spawn(
      process.execPath,
      [
        resolve('dist/index.js'),
        'benchmark',
        '--host',
        fake.host,
        '--model',
        'fixture',
        '--profile',
        'lite',
        '--profile',
        'full',
        '--brief',
        'template-preview-pdf',
      ],
      { env: { ...process.env, BONNIEPDF_MCP_HOME: state }, windowsHide: true }
    );
    let output = '';
    child.stdout.on('data', c => (output += c));
    child.stderr.on('data', c => (output += c));
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    const reportName = (await readdir(resolve(state, 'benchmarks'))).find(name => name.startsWith('eval-'));
    const report = JSON.parse(await readFile(resolve(state, 'benchmarks', reportName), 'utf8'));
    assert.equal(report.rows.length, 2);
    assert.ok(
      report.rows.every(r => r.passed && r.promptTokens === 200 && r.outputTokens === 40 && r.tokenCountsComplete)
    );
    assert.deepEqual(profiles, new Set([7, 16]));
    assert.ok(report.rows.every(r => r.toolCalls === 1 && r.loadMs === 2 && r.serverMs >= 0));
  } finally {
    await fake.close();
  }
});
