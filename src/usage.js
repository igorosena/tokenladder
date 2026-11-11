// Usage extraction (streaming and non-streaming), cost weighting, logging.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Cost weights relative to one uncached input token. Defaults follow
// Anthropic's published ratios: 5-minute cache write 1.25×, 1-hour cache
// write 2× (Claude Code asks for 1h), cache read 0.1×, output 5×.
// Override with TOKENLADDER_WEIGHTS='{"output":8}' for other providers.
export const WEIGHTS = {
  input: 1,
  cacheWrite: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
  output: 5,
  ...(process.env.TOKENLADDER_WEIGHTS ? JSON.parse(process.env.TOKENLADDER_WEIGHTS) : {}),
};

// cacheWrite is the total; cacheWrite1h is the part of it written with a 1h
// TTL (Anthropic reports the split in usage.cache_creation; 0 when absent).
export const emptyUsage = () => ({ input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 });

// Anthropic list prices, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-10-15).
// Keyed by model-id prefix. Cache writes: 5m = 1.25x input, 1h = 2x input (as published).
export const PRICES = {
  'claude-fable-5-1': { input: 10, cacheRead: 0.25, output: 50 },
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, output: 0.5, longInput: 0.5, longCacheRead: 0.05, longOutput: 2.5, longFrom: 100_000 },
};

export function priceFor(model) {
  if (!model) return null;
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : null;
}

// Dollar cost of one request's usage at list price for the model that answered.
// null when the model is unknown. Haiku's >100K-prompt tier applies per request.
export function usd(u, model) {
  const p = priceFor(model);
  if (!p || !u) return null;
  const prompt = (u.input || 0) + (u.cacheWrite || 0) + (u.cacheRead || 0);
  const long = p.longFrom && prompt > p.longFrom;
  const input = long ? p.longInput : p.input;
  const read = long ? p.longCacheRead : p.cacheRead;
  const out = long ? p.longOutput : p.output;
  const w1h = Math.min(u.cacheWrite1h || 0, u.cacheWrite || 0);
  return ((u.input || 0) * input + ((u.cacheWrite || 0) - w1h) * input * 1.25 + w1h * input * 2 + (u.cacheRead || 0) * read + (u.output || 0) * out) / 1e6;
}

export function units(u, w = WEIGHTS) {
  const w1h = Math.min(u.cacheWrite1h || 0, u.cacheWrite || 0);
  return (u.input || 0) * w.input
    + ((u.cacheWrite || 0) - w1h) * w.cacheWrite
    + w1h * w.cacheWrite1h
    + (u.cacheRead || 0) * w.cacheRead
    + (u.output || 0) * w.output;
}

export function addUsage(a, b) {
  for (const k of Object.keys(emptyUsage())) a[k] = (a[k] || 0) + (b?.[k] || 0);
  return a;
}

// Normalize the provider's usage object. Missing fields stay undefined so a
// later partial event (Anthropic's message_delta) doesn't zero earlier ones.
function normalize(u, provider) {
  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      input: u.prompt_tokens != null ? u.prompt_tokens - cached : undefined,
      cacheRead: u.prompt_tokens != null ? cached : undefined,
      output: u.completion_tokens,
    };
  }
  if (provider === 'openai' || provider === 'codex' || 'input_tokens_details' in u) {
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    return {
      input: u.input_tokens != null ? u.input_tokens - cached : undefined,
      cacheWrite: u.input_tokens_details?.cache_write_tokens,
      cacheRead: u.input_tokens != null ? cached : undefined,
      output: u.output_tokens,
    };
  }
  return {
    input: u.input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens,
    cacheRead: u.cache_read_input_tokens,
    output: u.output_tokens,
  };
}

export class UsageTracker {
  constructor(provider) {
    this.provider = provider;
    this.usage = null;
    this.raw = null; // last usage object exactly as the provider sent it
    this.model = null;
    this.buf = '';
    this.decoder = new TextDecoder();
  }

  takeObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    this.model ||= obj.model || obj.message?.model || obj.response?.model || null;
    const raw = obj.usage ?? obj.message?.usage ?? obj.response?.usage;
    if (!raw || typeof raw !== 'object') return;
    this.raw = { ...(this.raw || {}), ...raw };
    const n = normalize(raw, this.provider);
    this.usage ||= {};
    for (const [k, v] of Object.entries(n)) if (v != null) this.usage[k] = v;
  }

  // Server-sent events: feed raw chunks as they stream through.
  feedSSE(chunk) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const event = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try { this.takeObject(JSON.parse(data)); } catch { /* ignore non-json events */ }
    }
  }

  feedJSON(buffer) {
    try { this.takeObject(JSON.parse(buffer.toString('utf8'))); } catch { /* ignore */ }
  }

  result() {
    if (!this.usage) return null;
    const u = emptyUsage();
    for (const k of Object.keys(u)) u[k] = this.usage[k] || 0;
    return u;
  }
}

export function defaultLogFile() {
  return process.env.TOKENLADDER_LOG || path.join(os.homedir(), '.tokenladder', 'usage.jsonl');
}

export function appendLog(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
