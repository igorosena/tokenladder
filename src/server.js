// Local HTTP proxy between a coding agent and the LLM provider.
// - Auth headers pass through untouched (API keys and Claude Pro/Max OAuth).
// - Responses (including SSE streams) are relayed chunk by chunk, unchanged.
// - Usage is read from the response and logged per request.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { transformRequest, MODES } from './transform.js';
import { UsageTracker, appendLog, defaultLogFile, units, usd } from './usage.js';
import { resolveProfile } from './profiles.js';
import { route as routePrompt, firstUserPrompt } from './router.js';

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding', 'proxy-connection', 'upgrade']);
const RESP_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
// Never written to dump files.
const SECRET_HEADER = /authorization|api-key|cookie|token|secret|session/i;

export function detectProvider(req) {
  if (req.headers['anthropic-version'] || req.headers['x-api-key'] || req.url.startsWith('/v1/messages')) return 'anthropic';
  if (req.headers['chatgpt-account-id'] || req.headers['x-codex-turn-metadata']) return 'codex';
  return 'openai';
}

// options.mode     one of MODES (compress/terse flags only), or
// options.profile  a profile name/spec/object (see profiles.js), or
// options.route    { backend: 'jev' | 'rules', minConfidence, classifier? }:
//                  pick a profile per session from the first user prompt.
//                  The session is Claude Code's session_id (metadata.user_id)
//                  when present, else the whole proxy.
export function createProxy(options = {}) {
  let mode = options.mode || (options.profile || options.route ? null : 'full');
  if (mode && !MODES.includes(mode)) throw new Error(`unknown mode "${mode}" (use: ${MODES.join(', ')})`);
  const fixedProfile = options.profile ? resolveProfile(options.profile) : null;
  const router = options.route ? { backend: 'jev', ...options.route } : null;
  if (!mode) mode = router ? 'route' : fixedProfile.name;
  const decisions = new Map(); // session key -> { profile, ...router result }
  const sessionKey = (body) => {
    try { return JSON.parse(body?.metadata?.user_id || '{}').session_id || 'default'; } catch { return 'default'; }
  };
  async function profileFor(body) {
    if (fixedProfile) return { profile: fixedProfile, decision: null };
    if (!router) return { profile: mode, decision: null };
    const key = sessionKey(body);
    if (!decisions.has(key)) {
      const prompt = firstUserPrompt(body);
      const d = router.classifier ? await router.classifier(prompt, router) : await routePrompt(prompt, router);
      decisions.set(key, { ...d, prompt: prompt.slice(0, 200), key });
      options.onRoute?.(decisions.get(key));
    }
    const d = decisions.get(key);
    const p = resolveProfile(d.profile);
    // route.bare: only the model switch, nothing else the profile would do.
    // Measures what a user gets by picking the cheaper model by hand.
    if (router.bare) return { profile: { name: `${p.name}:direct`, model: p.model, compress: false, terse: false }, decision: d };
    return { profile: p, decision: d };
  }
  const upstreams = {
    anthropic: (options.anthropicUpstream || process.env.TOKENLADDER_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com').replace(/\/$/, ''),
    openai: (options.openaiUpstream || process.env.TOKENLADDER_OPENAI_UPSTREAM || 'https://api.openai.com').replace(/\/$/, ''),
    codex: (options.codexUpstream || options.openaiUpstream || process.env.TOKENLADDER_CODEX_UPSTREAM || 'https://chatgpt.com/backend-api/codex').replace(/\/$/, ''),
  };
  const logFile = options.logFile === null ? null : options.logFile || defaultLogFile();
  const session = options.session || crypto.randomBytes(4).toString('hex');
  const label = options.label || null;
  // options.dumpDir: write every request body (auth headers stripped) here, for debugging.
  const dumpDir = options.dumpDir || null;
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });
  const records = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/__tokenladder/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode, session }));
      return;
    }

    const started = Date.now();
    const provider = detectProvider(req);
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

    let body = await readBody(req);
    let cstats = null;
    let original = null; // parsed body as the agent sent it (dump only)
    let sent = null;     // parsed body as forwarded, when it differs (dump only)
    let profileName = mode;
    let decision = null;
    const isJson = (req.headers['content-type'] || '').includes('json');
    if (req.method === 'POST' && isJson && body.length) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (dumpDir) original = JSON.parse(body.toString('utf8'));
        const chosen = await profileFor(parsed);
        decision = chosen.decision;
        profileName = typeof chosen.profile === 'string' ? chosen.profile : chosen.profile.name;
        if (profileName !== 'passthrough') {
          const beforeBytes = body.toString('utf8');
          cstats = transformRequest(provider, req.url, parsed, chosen.profile, options.compressOptions);
          body = Buffer.from(JSON.stringify(parsed));
          if (dumpDir && body.toString('utf8') !== beforeBytes) sent = parsed;
        }
      } catch { /* not JSON we understand: forward as-is */ }
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers['accept-encoding'] = 'identity';

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreams[provider] + req.url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        signal: ctrl.signal,
        redirect: 'manual',
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `tokenladder could not reach ${upstreams[provider]}: ${err.message}` } }));
      }
      return;
    }

    const outHeaders = {};
    upstreamRes.headers.forEach((v, k) => { if (!RESP_DROP.has(k)) outHeaders[k] = v; });
    res.writeHead(upstreamRes.status, outHeaders);

    const tracker = new UsageTracker(provider);
    const ctype = upstreamRes.headers.get('content-type') || '';
    const isSSE = ctype.includes('event-stream') || (!ctype && (req.headers.accept || '').includes('event-stream'));
    const chunks = [];
    let size = 0;
    try {
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          res.write(chunk);
          if (isSSE) tracker.feedSSE(chunk);
          else if (ctype.includes('json') && size < 20e6) { chunks.push(chunk); size += chunk.length; }
        }
      }
    } catch { /* client or upstream aborted */ }
    res.end();
    if (!isSSE && chunks.length) tracker.feedJSON(Buffer.concat(chunks));

    const usage = tracker.result();
    if (!usage && !cstats?.blocks) return; // health checks, model lists, etc.
    const record = {
      seq: ++seq,
      ts: new Date().toISOString(),
      session,
      label,
      mode,
      profile: profileName,
      route: decision ? { backend: decision.backend, profile: decision.profile, confidence: decision.confidence, suggested: decision.suggested, error: decision.error, ms: decision.ms } : null,
      provider,
      path: req.url.split('?')[0],
      model: tracker.model,
      status: upstreamRes.status,
      ms: Date.now() - started,
      usage,
      usageRaw: tracker.raw,
      units: usage ? Math.round(units(usage)) : null,
      usd: usage ? usd(usage, tracker.model) : null,
      compression: cstats,
    };
    if (dumpDir) {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!SECRET_HEADER.test(k)) headers[k] = v;
      const file = `${String(record.seq).padStart(3, '0')}.json`;
      try {
        fs.writeFileSync(path.join(dumpDir, file), JSON.stringify({
          ...record, method: req.method, url: req.url, headers,
          body: original ?? body.toString('utf8'), sent,
        }, null, 2));
        record.dump = file;
      } catch { /* best effort */ }
    }
    records.push(record);
    if (logFile) { try { appendLog(logFile, record); } catch { /* best effort */ } }
    options.onRecord?.(record);
  });

  return {
    server,
    mode,
    session,
    records,
    decisions,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
