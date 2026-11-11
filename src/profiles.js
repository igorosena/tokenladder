// Cost profiles: everything the proxy can change about a session, in one
// object. A profile is chosen once per session (by name, or by the router on
// the first request) and then applied identically to every request, so the
// provider's prompt cache keeps working.
//
//   model     alias or full id; rewrites body.model
//   effort    'low' | 'medium' | 'high'; thinking tokens are billed as output
//   compress  shrink large tool outputs (see compress.js)
//   terse     append the short-answers instruction to the system prompt
//   cacheTtl  '5m' | '1h'; Claude Code asks for 1h, whose cache write costs 2x
//             the 5m one (1.25x); 5m is cheaper for continuous sessions
//   tools     keep only these tool definitions in the request (by name);
//             every tool definition is re-read from cache on every request
//   agentArgs extra CLI args for the agent, added by the bench and by
//             `tokenladder claude --profile` (e.g. --tools, which also
//             shrinks Claude Code's own environment message)

export const MODEL_IDS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

export const resolveModel = (m) => (m ? MODEL_IDS[m] || m : undefined);

// Tools a coding task needs on nearly every turn.
export const BASIC_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'];

export const PROFILES = {
  // The four historical proxy modes, as profiles.
  passthrough: { compress: false, terse: false },
  compress: { compress: true, terse: false },
  terse: { compress: false, terse: true },
  full: { compress: true, terse: true },

  // Router targets. The names are the router's choices (see router.js).
  // lookup: answer a question, read/explain/summarize; nothing is edited.
  lookup: { model: 'haiku', effort: 'low', compress: true, terse: true, cacheTtl: '5m', tools: BASIC_TOOLS, agentArgs: ['--tools', BASIC_TOOLS.join(',')] },
  // edit: a bounded change in a known place (bug fix, small feature, rename).
  edit: { model: 'sonnet', effort: 'medium', compress: true, terse: true, cacheTtl: '5m', tools: BASIC_TOOLS, agentArgs: ['--tools', BASIC_TOOLS.join(',')] },
  // build: a well-defined feature across several files. Sonnet at high
  // effort, all tools, no terse (it has to explain what it built), tool
  // outputs compressed. The bench showed Sonnet solving this rung as often
  // as Opus (order-history, 3/3) at a quarter of the cost; Opus stays
  // reachable through 'open' when the user launched the agent on it.
  build: { model: 'sonnet', effort: 'high', compress: true, terse: false, cacheTtl: '5m' },
  // open: unknown-cause debugging, design, anything risky. The model the
  // user launched with, agent defaults; the proxy only compresses tool outputs.
  open: { compress: true, terse: false },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

// Accepts a name, a profile object, or a spec string like
// "model=haiku+effort=low+compress+terse+ttl=5m+tools=basic" (parts joined
// with "+", so a spec can be one item of a comma-separated --variants list;
// a tool list uses "/": tools=Bash/Read/Edit).
export function resolveProfile(p) {
  if (!p) return { name: 'full', ...PROFILES.full };
  if (typeof p === 'object') return { name: p.name || 'custom', ...p };
  if (PROFILES[p]) return { name: p, ...PROFILES[p] };
  if (!p.includes('=') && !p.includes('+')) throw new Error(`unknown profile "${p}" (use: ${PROFILE_NAMES.join(', ')}, or a spec like model=haiku+effort=low+compress+terse)`);
  const out = { name: p, compress: false, terse: false };
  for (const part of p.split('+')) {
    const [k, v] = part.split('=');
    if (k === 'compress' || k === 'terse') out[k] = v === undefined ? true : v !== 'false';
    else if (k === 'model') out.model = v;
    else if (k === 'effort') out.effort = v;
    else if (k === 'ttl' || k === 'cacheTtl') out.cacheTtl = v;
    else if (k === 'tools') { out.tools = v === 'basic' ? BASIC_TOOLS : v.split('/'); out.agentArgs = ['--tools', out.tools.join(',')]; }
    else throw new Error(`unknown profile key "${k}" in "${p}"`);
  }
  return out;
}
