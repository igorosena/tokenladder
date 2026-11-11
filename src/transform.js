// Request rewriting per provider. Mutates the parsed body in place and
// returns stats about what changed.

import { compress } from './compress.js';
import { resolveProfile, resolveModel } from './profiles.js';

// Our own wording. Appended (never prepended) so the provider's cached prefix
// — tools + the agent's own system prompt — stays identical.
export const TERSE_PROMPT = [
  'Output style: terse.',
  'Lead with the answer or the action. No preamble, no restating the request, no closing recap or offers unless asked.',
  'Short sentences or fragments over paragraphs. Skip explanations the user did not ask for.',
  'Never shorten code, commands, file paths, identifiers, numbers or error messages: keep those exact.',
  'Be complete where correctness depends on it.',
].join(' ');

export const MODES = ['passthrough', 'compress', 'terse', 'full'];

export function modeFlags(mode) {
  return {
    compress: mode === 'compress' || mode === 'full',
    terse: mode === 'terse' || mode === 'full',
  };
}

function newStats() {
  // list: one entry per compressed block, in request order (type + chars before/after).
  // model/effort/cacheTtl: what the profile rewrote them to. toolsDropped: tool definitions removed.
  return { blocks: 0, before: 0, after: 0, byType: {}, list: [], terse: false, model: null, effort: null, cacheTtl: null, toolsDropped: 0 };
}

function apply(text, stats, opts) {
  const r = compress(text, opts);
  if (!r.changed) return text;
  stats.blocks++;
  stats.before += r.before;
  stats.after += r.after;
  const t = (stats.byType[r.type] ||= { blocks: 0, before: 0, after: 0 });
  t.blocks++; t.before += r.before; t.after += r.after;
  stats.list.push({ type: r.type, before: r.before, after: r.after });
  return r.text;
}

// `profile` is a mode name ('full'), a profile name ('lookup'), a spec string
// or a profile object (see profiles.js). Pure function of (body, profile):
// the same request always becomes the same bytes.
export function transformRequest(provider, path, body, profile, opts = {}) {
  const stats = newStats();
  const f = typeof profile === 'string' && MODES.includes(profile) ? { ...modeFlags(profile), name: profile } : resolveProfile(profile);
  if (!body || typeof body !== 'object') return stats;
  if (f.model) { const id = resolveModel(f.model); if (id && body.model !== id) { body.model = id; stats.model = id; } }
  if (provider === 'anthropic') anthropic(body, f, stats, opts);
  else if (path.includes('/responses')) openaiResponses(body, f, stats, opts);
  else openaiChat(body, f, stats, opts);
  return stats;
}

function setTtl(block, ttl, stats) {
  if (block && block.cache_control && typeof block.cache_control === 'object') {
    const cur = block.cache_control.ttl || '5m';
    if (cur !== ttl) {
      if (ttl === '5m') delete block.cache_control.ttl; else block.cache_control.ttl = ttl;
      stats.cacheTtl = ttl;
    }
  }
}

function anthropic(body, f, stats, opts) {
  if (f.compress && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        if (typeof block.content === 'string') block.content = apply(block.content, stats, opts);
        else if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part.type === 'text' && typeof part.text === 'string') part.text = apply(part.text, stats, opts);
          }
        }
      }
    }
  }
  if (f.terse && Array.isArray(body.messages)) {
    if (typeof body.system === 'string') body.system = `${body.system}\n\n${TERSE_PROMPT}`;
    else if (Array.isArray(body.system)) body.system.push({ type: 'text', text: TERSE_PROMPT });
    else body.system = TERSE_PROMPT;
    stats.terse = true;
  }
  if (f.effort && Array.isArray(body.messages)) {
    if (body.output_config?.effort !== f.effort) { body.output_config = { ...(body.output_config || {}), effort: f.effort }; stats.effort = f.effort; }
    for (const m of body.messages) {
      if (m.output_config && m.output_config.effort !== f.effort) { m.output_config = { ...m.output_config, effort: f.effort }; stats.effort = f.effort; }
    }
    if (f.effort === 'low' && body.thinking) { delete body.thinking; stats.effort = f.effort; }
  }
  if (f.cacheTtl) {
    for (const b of Array.isArray(body.system) ? body.system : []) setTtl(b, f.cacheTtl, stats);
    for (const t of Array.isArray(body.tools) ? body.tools : []) setTtl(t, f.cacheTtl, stats);
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
      if (Array.isArray(m.content)) for (const c of m.content) setTtl(c, f.cacheTtl, stats);
    }
  }
  if (Array.isArray(f.tools) && Array.isArray(body.tools)) {
    const keep = new Set(f.tools);
    const before = body.tools.length;
    // Keep the agent's own order; never touch MCP/custom tools the agent may need to finish a tool_use.
    body.tools = body.tools.filter((t) => keep.has(t.name) || /^mcp__/.test(t.name || ''));
    stats.toolsDropped = before - body.tools.length;
    pruneAnthropicEnv(body, keep);
  }
}

// When the proxy drops tools like Agent/Skill/ToolSearch (as in --route),
// Claude Code's # Environment message still carries ~18 KB of agent/skill
// descriptions that `--tools` would have omitted at launch. Strip those
// sections deterministically so routed sessions get the same small prefix.
function pruneAnthropicEnv(body, keep) {
  if (!Array.isArray(body.messages)) return;
  for (const m of body.messages) {
    if (m.role !== 'system' || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== 'text' || typeof part.text !== 'string' || !part.text.startsWith('# Environment\n')) continue;
      part.text = part.text.split('\n\n').filter((p) => {
        if (!keep.has('ToolSearch') && p.startsWith('The following deferred tools are now available via ToolSearch.')) return false;
        if (!keep.has('Agent') && (p.startsWith('Available agent types for the Agent tool:') || p.startsWith('When you launch multiple agents for independent work,'))) return false;
        if (!keep.has('Skill') && (p.startsWith('The following skills are available for use with the Skill tool:') || p.startsWith('- dataviz:'))) return false;
        return true;
      }).join('\n\n');
    }
  }
}

function openaiChat(body, f, stats, opts) {
  if (!Array.isArray(body.messages)) return;
  if (f.compress) {
    for (const msg of body.messages) {
      if (msg.role !== 'tool') continue;
      if (typeof msg.content === 'string') msg.content = apply(msg.content, stats, opts);
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string') part.text = apply(part.text, stats, opts);
        }
      }
    }
  }
  if (f.terse) {
    const first = body.messages[0];
    if (first && (first.role === 'system' || first.role === 'developer') && typeof first.content === 'string') {
      first.content = `${first.content}\n\n${TERSE_PROMPT}`;
    } else {
      body.messages.unshift({ role: 'system', content: TERSE_PROMPT });
    }
    stats.terse = true;
  }
  if (f.effort && body.reasoning_effort !== f.effort) { body.reasoning_effort = f.effort; stats.effort = f.effort; }
  // Ask for usage on streams so we can measure it.
  if (body.stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };
}

function openaiResponses(body, f, stats, opts) {
  if (f.compress && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
      if (typeof item.output === 'string') {
        item.output = apply(item.output, stats, opts);
      } else if (Array.isArray(item.output)) {
        for (const part of item.output) {
          if (typeof part?.text === 'string') part.text = apply(part.text, stats, opts);
        }
      }
    }
  }
  if (f.terse) {
    const firstDev = Array.isArray(body.input) && body.input.find((i) => i.role === 'developer' && Array.isArray(i.content));
    if (body.instructions || !firstDev) {
      body.instructions = body.instructions ? `${body.instructions}\n\n${TERSE_PROMPT}` : TERSE_PROMPT;
    } else {
      firstDev.content.push({ type: 'input_text', text: `\n\n${TERSE_PROMPT}` });
    }
    stats.terse = true;
  }
  if (f.effort && body.reasoning?.effort !== f.effort) { body.reasoning = { ...(body.reasoning || {}), effort: f.effort }; stats.effort = f.effort; }
}
