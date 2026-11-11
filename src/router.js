// Session router: reads the user's first prompt and picks a cost profile.
//
// Backends:
//   jev    TypeSafe's Jev (System One model): one "choice" question, returns
//          calibrated probabilities. POST https://api.typesafe.ai/v1/systemone,
//          Authorization: Bearer $TYPESAFE_API_KEY. ~0.1-0.5 s, ~$0.04 per
//          million input tokens.
//   rules  regex heuristics, no network. Also the fallback when jev fails.
//
// Low confidence escalates one rung (see escalate), because a wrong cheap
// route costs a failed task plus a re-run.

const JEV_URL = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone';

export const SAFE_PROFILE = 'open';

// Cheapest to most expensive. A low-confidence answer is escalated to the
// higher of the two most probable rungs (not straight to the top), because
// the doubt is almost always between neighbours.
export const RUNGS = ['lookup', 'edit', 'build', 'open'];

export function escalate(probabilities, choice) {
  if (!probabilities) return SAFE_PROFILE;
  const top2 = Object.entries(probabilities).filter(([k]) => RUNGS.includes(k)).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  if (!top2.includes(choice)) top2[1] = choice;
  return top2.reduce((a, b) => (RUNGS.indexOf(b) > RUNGS.indexOf(a) ? b : a));
}

// Four rungs, each the cheapest model that handles that kind of request
// (see PROFILES: lookup=haiku, edit=sonnet, build=sonnet at high effort
// with all tools, open=the model the user launched with). The question
// asks for the rung, not for a model.
export const ROUTE_QUESTION = {
  type: 'choice',
  instructions: 'The text is a request to a coding agent that can read and edit files and run shell commands in a repository. Pick the smallest kind of work that fully covers the request.',
  criteria: {
    lookup: 'Trivial: answer a question, explain, find, summarize code, logs or data; run a command or the tests and report what happened; or produce something small and self-contained from scratch (a simple HTML page, a short script, a snippet, boilerplate) that needs no understanding of the existing code.',
    edit: 'A bounded change to existing code: fix a bug that a failing test or error message points at, add a small feature, rename, update tests or config, small refactor of one or two files, replace one thing with another in a few files.',
    build: 'A feature or component across several files that must fit the existing code: new module plus callers plus tests, CI or build setup, a rewrite or migration with a clear target. Needs reading the project and some design, but the goal is well defined.',
    open: 'Unknown or risky: debugging where nothing points at the cause, performance problems, intermittent failures, architecture or design decisions, security review, anything where the approach itself has to be figured out.',
  },
};

const UNKNOWN_RE = /\b(don'?t know|n[aã]o sei|n[aã]o achei|no idea|investigat\w*|investig\w*|find out|figure (it )?out|intermittent\w*|intermitente\w*|sometimes|[àa]s vezes|can'?t reproduce|slow|lent[oa]|design|architect\w*|arquitet\w*|estrutur\w*|review|revis\w*|security|seguran[çc]a|plan\w*|planej\w*|root cause|what'?s going on|flaky|weird|mess|bagun[çc]a|prod is down|should we|monorepo|memory (keeps|grows)|leak|desacopl\w*|decouple|pensa num jeito|faz funcionar|make it work)\b/i;
const BUILD_RE = /\b(set ?up|pipeline|\bci\b|github actions|deploy\w*|dockeri[sz]e|dockerfile|docker-compose(?!\.yml)|crud|dark mode|i18n|websocket|dashboard|worker|queue(?![.\w])|rate limit\w*|middleware|module|autentica\w*|authenticat\w*|passport|history|hist[óo]rico|support|suporte|spec\.md|fluxo de|flow|relat[óo]rio|report|page from|from the figma|typescript)\b|\b(com|with) testes?\b|\b(e|and) (testes|tests)\b/i;
const TRIVIAL_RE = /\b(simple|simples|one-?liner|one liner|snippet|boilerplate|script (that|que|\w+ que)|html page|p[áa]gina html|landing page|sql query|query sql|exemplo de|example of|readme b[áa]sico|basic readme|commit message|mensagem de commit|converte esse json|convert this json|roda os testes|run the tests|run tests|regex|s[óo] explica|just explain|me explica|como desfa[çc]o)\b|\.gitignore\b|(pure|ta certo|is this (right|correct)|o que .* faz)\?/i;
const EDIT_RE = /\b(fix(es|ed)?|repair|patch|add(s|ed|ing)?|implement(s|ed|ing)?|write|create|rename|refactor|change|update|modify|remove|delete|replace|extract|convert\w*|translate|allow|make|let|bump|set|should be|corrig\w*|consert\w*|arrum\w*|adicion\w*|cri[ae]\w*|renome\w*|refator\w*|mud[ae]\w*|atualiz\w*|remov\w*|apag\w*|troc\w*|deix[ae]\w*|faz|fa[çc]a|extra[ií]\w*|convert\w*|traduz\w*|permit\w*|sobe|escreve|gera)\b/i;
const OPEN_RE = /\b(design|architect\w*|plan|redesign|rewrite|migrat\w*|across|whole|entire|from scratch|investigate|arquitet\w*|planej\w*|reescrev\w*|investig\w*|do zero)\b|\ball (files|modules|the)\b|\btodo o (?!projeto\b)/i;
const LOOKUP_RE = /\b(what|which|why|how|where|when|is there|explain|describe|show|list|find|tell me|summari[sz]e|look at|read|check|o que|qual|quais|por ?que|pq|como|onde|tem algum|me d[áa]|me fala|me mostra|explic\w*|descrev\w*|mostr\w*|list\w*|encontr\w*|me diz|resum\w*|olh\w*|verific\w*)\b|\?\s*$/i;

// Order matters: trivial questions/snippets win over generic words (like
// docker-compose.yml or "faz?"), then unknown-cause / design (open), then
// large-but-defined work (build), then edit verbs, then questions.
export function classifyByRules(prompt) {
  const p = String(prompt || '').trim();
  let profile = 'open';
  if (!p) profile = 'open';
  else if (TRIVIAL_RE.test(p)) profile = 'lookup';
  else if (UNKNOWN_RE.test(p)) profile = 'open';
  else if (OPEN_RE.test(p) || BUILD_RE.test(p) || p.length > 600) profile = 'build';
  else if (EDIT_RE.test(p)) profile = 'edit';
  else if (LOOKUP_RE.test(p)) profile = 'lookup';
  return { profile, confidence: null, probabilities: null, backend: 'rules' };
}

export async function classifyByJev(prompt, { apiKey = process.env.TYPESAFE_API_KEY, timeoutMs = 4000, url = JEV_URL, model = 'jev-latest', fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state: String(prompt), questions: { kind: ROUTE_QUESTION } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const a = data.answers?.kind;
    if (!a || !(a.choice in ROUTE_QUESTION.criteria)) throw new Error(`jev: unexpected answer ${JSON.stringify(data).slice(0, 200)}`);
    return { profile: a.choice, confidence: a.confidence ?? null, probabilities: a.probabilities ?? null, backend: 'jev', model: data.model, usage: data.usage };
  } finally { clearTimeout(timer); }
}

// Picks a profile for a session. Never throws: on any backend error it falls
// back to rules and reports why in `error`; below minConfidence it escalates
// and keeps the backend's suggestion in `suggested`.
export async function route(prompt, { backend = 'jev', minConfidence = 0.75, ...opts } = {}) {
  const started = Date.now();
  let r;
  let error = null;
  if (backend === 'jev') {
    try { r = await classifyByJev(prompt, opts); } catch (err) { error = err.message; r = classifyByRules(prompt); }
  } else {
    r = classifyByRules(prompt);
  }
  const out = { ...r, requested: backend, error, ms: Date.now() - started };
  if (r.backend === 'jev' && r.confidence != null && r.confidence < minConfidence) {
    out.suggested = r.profile;
    out.profile = escalate(r.probabilities, r.profile);
    out.reason = `confidence ${r.confidence} < ${minConfidence}, escalated to ${out.profile}`;
  }
  return out;
}

// The first thing the user asked, without the agent's injected reminders.
export function firstUserPrompt(body) {
  const msgs = body?.messages || body?.input || [];
  const clean = [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    for (const p of parts) {
      if (p.type !== 'text' && p.type !== 'input_text') continue;
      const t = (p.text || '').replace(/<(system-reminder|recommended_plugins)>[\s\S]*?<\/\1>/g, '').trim();
      if (t) clean.push(t);
    }
    if (clean.length) break;
  }
  if (!clean.length) return typeof body?.prompt === 'string' ? body.prompt : '';
  return clean[clean.length - 1] || '';
}
