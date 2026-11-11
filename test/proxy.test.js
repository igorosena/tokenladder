import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from '../src/server.js';
import { TERSE_PROMPT } from '../src/transform.js';

// Fake Anthropic: records what it received, answers with an SSE stream.
function mockAnthropic() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: body ? JSON.parse(body) : null, url: req.url });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'm1', model: 'claude-test', usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000, output_tokens: 1 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'order 88213' } });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return { server, seen };
}

async function setup(mode, extra = {}) {
  const up = mockAnthropic();
  await new Promise((r) => up.server.listen(0, '127.0.0.1', r));
  const proxy = createProxy({ mode, logFile: null, anthropicUpstream: `http://127.0.0.1:${up.server.address().port}`, ...extra });
  const port = await proxy.listen(0);
  return { up, proxy, port, close: async () => { await proxy.close(); up.server.close(); } };
}

const bigLog = Array.from({ length: 3000 }, (_, i) => `2026-10-14T08:00:${String(i % 60).padStart(2, '0')}Z INFO http: GET /api/x 200 ${i % 90}ms`)
  .map((l, i) => (i === 1717 ? '2026-10-14T08:28:37Z ERROR payments: timeout order_id=88213' : l)).join('\n');

const request = {
  model: 'claude-test',
  max_tokens: 1000,
  stream: true,
  system: [{ type: 'text', text: 'You are an agent.', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: 'find the failed payment' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat server.log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigLog }] },
  ],
};

async function send(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer secret-oauth-token' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test('full mode: compresses tool_result, appends terse prompt, relays stream, logs usage', async () => {
  const s = await setup('full');
  try {
    const res = await send(s.port, request);
    assert.equal(res.status, 200);
    assert.match(res.text, /order 88213/);
    assert.match(res.text, /message_stop/);

    const got = s.up.seen[0];
    assert.equal(got.headers.authorization, 'Bearer secret-oauth-token');
    const tr = got.body.messages[2].content[0].content;
    assert.ok(tr.length < bigLog.length * 0.3, 'tool_result should be compressed');
    assert.match(tr, /order_id=88213/);
    assert.equal(got.body.system.length, 2);
    assert.equal(got.body.system[0].cache_control.type, 'ephemeral');
    assert.equal(got.body.system[1].text, TERSE_PROMPT);

    const rec = s.proxy.records[0];
    assert.deepEqual(rec.usage, { input: 1200, cacheWrite: 300, cacheWrite1h: 0, cacheRead: 5000, output: 42 });
    assert.equal(rec.model, 'claude-test');
    assert.equal(rec.compression.blocks, 1);
  } finally { await s.close(); }
});

test('passthrough mode forwards the body untouched but still measures', async () => {
  const s = await setup('passthrough');
  try {
    await send(s.port, request);
    assert.deepEqual(s.up.seen[0].body, request);
    assert.equal(s.proxy.records[0].usage.output, 42);
  } finally { await s.close(); }
});

test('same input compresses to the same bytes on every request (prompt cache stays valid)', async () => {
  const s = await setup('full');
  try {
    await send(s.port, request);
    await send(s.port, request);
    assert.equal(JSON.stringify(s.up.seen[0].body), JSON.stringify(s.up.seen[1].body));
  } finally { await s.close(); }
});

test('records list every compressed block with type and sizes', async () => {
  const s = await setup('compress');
  try {
    await send(s.port, request);
    const c = s.proxy.records[0].compression;
    assert.equal(c.terse, false);
    assert.equal(c.list.length, 1);
    assert.equal(c.list[0].type, 'log');
    assert.equal(c.list[0].before, bigLog.length);
    assert.ok(c.list[0].after < bigLog.length);
    assert.deepEqual(c.byType.log, { blocks: 1, before: c.list[0].before, after: c.list[0].after });
  } finally { await s.close(); }
});

test('dumpDir writes the original and the forwarded body, never auth headers', async () => {
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-dump-'));
  const s = await setup('full', { dumpDir });
  try {
    await send(s.port, request);
    await send(s.port, request);
    const files = fs.readdirSync(dumpDir).sort();
    assert.deepEqual(files, ['001.json', '002.json']);
    assert.equal(s.proxy.records[0].dump, '001.json');
    const d = JSON.parse(fs.readFileSync(path.join(dumpDir, '001.json'), 'utf8'));
    assert.equal(d.headers.authorization, undefined);
    assert.equal(d.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(d.body, request);                       // as the agent sent it
    assert.ok(d.sent.messages[2].content[0].content.length < bigLog.length); // as forwarded
    assert.equal(d.sent.system[1].text, TERSE_PROMPT);
    assert.deepEqual(d.usage, { input: 1200, cacheWrite: 300, cacheWrite1h: 0, cacheRead: 5000, output: 42 });
    assert.ok(!fs.readFileSync(path.join(dumpDir, '001.json'), 'utf8').includes('secret-oauth-token'));
  } finally { await s.close(); fs.rmSync(dumpDir, { recursive: true, force: true }); }
});

test('dumpDir in passthrough stores the body with sent = null', async () => {
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-dump-'));
  const s = await setup('passthrough', { dumpDir });
  try {
    await send(s.port, request);
    const d = JSON.parse(fs.readFileSync(path.join(dumpDir, '001.json'), 'utf8'));
    assert.deepEqual(d.body, request);
    assert.equal(d.sent, null);
  } finally { await s.close(); fs.rmSync(dumpDir, { recursive: true, force: true }); }
});

test('wrap: a profile with tools adds --tools to claude unless already given', async () => {
  const { agentArgsFor } = await import('../src/wrap.js');
  assert.deepEqual(agentArgsFor('claude', ['-p', 'hi'], 'lookup'), ['--tools', 'Bash,Read,Edit,Write,Grep,Glob']);
  assert.deepEqual(agentArgsFor('claude', ['--tools', 'Bash'], 'lookup'), []);
  assert.deepEqual(agentArgsFor('claude', ['--tools=Bash'], 'lookup'), []);
  assert.deepEqual(agentArgsFor('claude', [], 'model=haiku+tools=Bash/Read'), ['--tools', 'Bash,Read']);
  assert.deepEqual(agentArgsFor('claude', [], 'full'), []);
  assert.deepEqual(agentArgsFor('claude', [], undefined), []);
  assert.deepEqual(agentArgsFor('codex', [], 'lookup'), []);
});

test('codex /responses: compresses custom_tool_call_output, appends terse to developer msg, parses headerless SSE usage', async () => {
  const seen = [];
  const up = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body), url: req.url });
      // Codex backend returns SSE without a content-type header
      res.writeHead(200, {});
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6-astra', usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 500 }, output_tokens: 80 } } })}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = createProxy({ mode: 'full', logFile: null, codexUpstream: `http://127.0.0.1:${up.address().port}` });
  const port = await proxy.listen(0);
  try {
    const wrappedLog = JSON.stringify({ chunk_id: '123', exit_code: 0, output: bigLog });
    const body = {
      model: 'gpt-6-astra',
      stream: true,
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\nfoo\n</recommended_plugins>' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find the failed payment' }] },
        { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: wrappedLog }] },
      ],
    };
    const res = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'chatgpt-account-id': 'acc_1' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const got = seen[0].body;
    assert.equal(got.instructions, undefined); // Codex rejects top-level instructions
    assert.ok(got.input[0].content[1].text.includes(TERSE_PROMPT));
    const compressedOut = got.input[3].output[1].text;
    assert.ok(compressedOut.length < wrappedLog.length * 0.3);
    assert.match(compressedOut, /order_id=88213/);
    const rec = proxy.records[0];
    assert.equal(rec.provider, 'codex');
    assert.equal(rec.model, 'gpt-6-astra');
    assert.deepEqual(rec.usage, { input: 2000, cacheWrite: 500, cacheWrite1h: 0, cacheRead: 3000, output: 80 });
  } finally { await proxy.close(); up.close(); }
});
