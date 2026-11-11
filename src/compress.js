// Deterministic compressors for tool outputs.
//
// Design rules:
// 1. Pure function of the input text. The same tool output always compresses to
//    the same bytes, no matter where it sits in the conversation. Anything else
//    breaks the provider's prompt cache and costs MORE than it saves.
// 2. Never touch code the agent may later edit (Claude Code's Read output).
// 3. Keep what answers depend on: errors, warnings, outliers, head and tail.
// 4. Every omission leaves a marker. The marker says what was kept (so the
//    model can answer from the summary) and asks it not to narrate the
//    condensation; it mentions how to narrow the output only as a last resort.
//    Measured: a marker that *invites* a re-run makes the model re-run the
//    command (one extra request, ~35k tokens) and explain the omission (2x
//    output), which costs more than the compression saves.

export const DEFAULTS = {
  minChars: 2000,      // below this, never compress
  minSavings: 0.15,    // skip if we save less than 15%
  maxLines: 300,       // generic text: line budget after collapsing
  head: 40,
  tail: 60,
  arrayMax: 24,        // JSON arrays / table rows above this get sampled
  maxString: 1500,     // long single-line strings inside JSON
};

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;
const LEVEL_RE = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/;
const TS_RE = /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const IMPORTANT_RE = /\b(error|errors|fatal|critical|panic|exception|traceback|fail|failed|failure|failing|warn|warning|denied|refused|timeout|timed out|assertion|unexpected|segfault|killed|oom|not ok)\b|✗|✖|✘/i;
const STACK_RE = /^\s+(at |File "|\.\.\. \d+ more)|^\s*Caused by:|^\s+\^/;
const SEARCH_RE = /^(?!\d{4}-\d{2}-\d{2})[\w@.\/\\-]*[A-Za-z][\w@.\/\\-]*:\d+[:-]/;
const READ_LINE_RE = /^\s*\d+(→|\t)/;
const NOTE = 'omitted parts are routine (no error, warning or outlier); answer from what is shown and do not mention this condensation unless an omitted item is needed, then narrow with grep/jq/sed -n';

const mark = (msg) => `[tokenladder: ${msg}]`;

// ---------------------------------------------------------------- detection

export function detect(text) {
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    try { return { type: 'json', value: JSON.parse(t) }; } catch { /* not json */ }
  }
  const lines = text.split('\n');
  const n = lines.length;
  // A compound shell command (e.g. `cat script.js; node script.js; echo exit=$?`)
  // often wraps a large JSON payload in a few lines of preamble/trailer.
  const jStart = lines.findIndex((l) => { const s = l.trim(); return s === '{' || s === '['; });
  if (jStart > 0 && jStart <= 25) {
    for (let jEnd = n - 1; jEnd > jStart && jEnd >= n - 10; jEnd--) {
      const s = lines[jEnd].trim();
      if (s === '}' || s === ']') {
        const body = lines.slice(jStart, jEnd + 1).join('\n');
        if (body.length > text.length * 0.7) {
          try {
            return {
              type: 'json',
              value: JSON.parse(body),
              prefix: lines.slice(0, jStart).join('\n'),
              suffix: lines.slice(jEnd + 1).join('\n'),
            };
          } catch { /* not valid json */ }
        }
        break;
      }
    }
  }
  if (n >= 5 && countWhere(lines, (l) => READ_LINE_RE.test(l)) > n * 0.8) return { type: 'code' };
  if (/^diff --git |^@@ -\d/m.test(text) && countWhere(lines, (l) => /^[-+@ ]|^diff |^index /.test(l)) > n * 0.7) {
    return { type: 'diff' };
  }
  if (n > 30 && countWhere(lines, (l) => SEARCH_RE.test(l)) > n * 0.5) return { type: 'search' };
  const levelled = countWhere(lines, (l) => LEVEL_RE.test(l)) > n * 0.4;
  const table = levelled ? null : detectTable(lines);
  if (table) return { type: 'table', ...table };
  if (n > 30 && (levelled || countWhere(lines, (l) => TS_RE.test(l)) > n * 0.4)) return { type: 'log' };
  return { type: 'text' };
}

function detectTable(lines) {
  const rows = lines.filter((l) => l.length > 0);
  if (rows.length < 30) return null;
  for (const sep of [',', '\t', ';', '|']) {
    const cols = splitRow(rows[0], sep).length;
    if (cols < 2) continue;
    const same = countWhere(rows, (r) => splitRow(r, sep).length === cols);
    if (same > rows.length * 0.9) return { sep, cols };
  }
  return null;
}

// ---------------------------------------------------------------- entry point

export function compress(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const result = { text, type: 'skip', before: text.length, after: text.length, changed: false };
  if (typeof text !== 'string' || text.length < o.minChars) return result;

  const d = detect(text);
  result.type = d.type;
  let out;
  switch (d.type) {
    case 'code': return result; // Read output: the agent edits against this, leave it exact
    case 'json': {
      const j = compressJson(d.value, o);
      out = [d.prefix, j, d.suffix].filter((s) => s !== undefined && s !== '').join('\n');
      break;
    }
    case 'table': out = compressTable(text, d.sep, o); break;
    case 'diff': out = compressDiff(text); break;
    case 'log': out = compressLines(text, { ...o, maxLines: 150, head: 25, tail: 50 }, true); break;
    case 'search': out = compressSearch(text, o); break;
    default: out = compressLines(text, o, false);
  }
  if (out.length > text.length * (1 - o.minSavings)) return result;
  return { text: out, type: d.type, before: text.length, after: out.length, changed: true };
}

// ---------------------------------------------------------------- generic lines / logs

function cleanup(text) {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() ?? '' : l))
    .map((l) => l.replace(/\s+$/, ''));
}

// Shape of a line with the volatile parts (numbers, hashes, ids) removed.
function shape(line) {
  return line
    .replace(/\b[0-9a-f]{7,}\b/gi, '#')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+(\.\d+)?/g, '#');
}

function collapseRuns(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const key = shape(lines[i]);
    let j = i + 1;
    while (j < lines.length && shape(lines[j]) === key) j++;
    const run = j - i;
    if (lines[i] === '' && run > 1) {
      out.push('');
    } else if (run === 1) {
      out.push(lines[i]);
    } else if (lines.slice(i, j).every((l) => l === lines[i])) {
      out.push(`${lines[i]}  ${mark(`line repeated ×${run}`)}`);
    } else if (run <= 5) {
      out.push(...lines.slice(i, j));
    } else {
      out.push(lines[i], lines[i + 1]);
      let kept = 0;
      for (let k = i + 2; k < j - 1; k++) {
        if (IMPORTANT_RE.test(lines[k])) { out.push(lines[k]); kept++; }
      }
      out.push(mark(`${run - 3 - kept} similar lines omitted; ${NOTE}`));
      out.push(lines[j - 1]);
    }
    i = j;
  }
  return out;
}

function compressLines(text, o, isLog) {
  let lines = collapseRuns(cleanup(text));
  if (lines.length <= o.maxLines) return lines.join('\n');

  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < Math.min(o.head, lines.length); i++) keep[i] = 1;
  for (let i = Math.max(0, lines.length - o.tail); i < lines.length; i++) keep[i] = 1;
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORTANT_RE.test(lines[i])) continue;
    for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep[k] = 1;
    // keep the stack trace that follows
    for (let k = i + 1; k < lines.length && k < i + 40 && STACK_RE.test(lines[k]); k++) keep[k] = 1;
  }

  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) { out.push(lines[i]); i++; continue; }
    let j = i;
    const levels = {};
    while (j < lines.length && !keep[j]) {
      if (isLog) {
        const m = lines[j].match(LEVEL_RE);
        const lv = m ? m[1].toUpperCase() : 'other';
        levels[lv] = (levels[lv] || 0) + 1;
      }
      j++;
    }
    const detail = isLog
      ? ` (${Object.entries(levels).map(([k, v]) => `${v} ${k}`).join(', ')})`
      : '';
    out.push(mark(`${j - i} lines omitted${detail}; none matched error/warn patterns; ${NOTE}`));
    i = j;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- diffs

function compressDiff(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const isContext = (l) => l.startsWith(' ') || l === '';
    if (!isContext(lines[i])) { out.push(lines[i]); i++; continue; }
    let j = i;
    while (j < lines.length && isContext(lines[j])) j++;
    const run = j - i;
    if (run > 6) {
      out.push(lines[i], lines[i + 1], mark(`${run - 4} unchanged context lines omitted`), lines[j - 2], lines[j - 1]);
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- grep-style results

function compressSearch(text, o) {
  const lines = cleanup(text);
  const perFile = new Map();
  const out = [];
  let omitted = 0;
  for (const line of lines) {
    const file = line.match(/^([^:]+):\d+[:-]/)?.[1];
    if (!file) { out.push(line); continue; }
    const seen = perFile.get(file) || 0;
    perFile.set(file, seen + 1);
    if (seen < 5 || IMPORTANT_RE.test(line)) out.push(line);
    else omitted++;
  }
  const heavy = [...perFile.entries()].filter(([, c]) => c > 5).map(([f, c]) => `${f} (${c})`);
  if (omitted) out.push(mark(`${omitted} more matches omitted in: ${heavy.join(', ')}; ${NOTE}`));
  return out.length > o.maxLines ? compressLines(out.join('\n'), o, false) : out.join('\n');
}

// ---------------------------------------------------------------- numeric outliers

// Robust z-score (median / MAD). Flags values far from the bulk without being
// fooled by the outlier itself, which a mean/stddev test would be.
function outlierIndexes(values, threshold = 3.5) {
  const idx = [];
  const nums = values.map((v, i) => [v, i]).filter(([v]) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 10) return idx;
  const sorted = nums.map(([v]) => v).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const dev = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)];
  for (const [v, i] of nums) {
    const z = mad === 0 ? (v === median ? 0 : Infinity) : (0.6745 * (v - median)) / mad;
    if (Math.abs(z) > threshold) idx.push(i);
  }
  // If "outliers" are a large share of the data, it is a distribution, not an anomaly.
  return idx.length > Math.max(3, values.length * 0.05) ? [] : idx;
}

function range(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const r = (x) => Math.round(x * 100) / 100;
  return `${r(sorted[0])}–${r(sorted[sorted.length - 1])} (median ${r(sorted[Math.floor(sorted.length / 2)])})`;
}

function sampleIndexes(n, flagged, o) {
  const keep = new Set();
  for (let i = 0; i < Math.min(5, n); i++) keep.add(i);
  for (let i = Math.max(0, n - 3); i < n; i++) keep.add(i);
  for (const i of flagged.slice(0, 40)) keep.add(i);
  return [...keep].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- tables (csv/tsv)

function splitRow(row, sep) {
  if (sep !== ',') return row.split(sep);
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of row) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function compressTable(text, sep, o) {
  const all = text.split('\n');
  const trailing = all[all.length - 1] === '' ? all.pop() : null;
  const header = all[0];
  const rows = all.slice(1);
  if (rows.length <= o.arrayMax) return text;

  const cells = rows.map((r) => splitRow(r, sep));
  const names = splitRow(header, sep).map((s) => s.replace(/^"|"$/g, '').trim());
  const flagged = new Set();
  const ranges = [];
  for (let c = 0; c < names.length; c++) {
    const col = cells.map((r) => {
      const v = r[c]?.replace(/^"|"$/g, '').trim();
      return v !== '' && v != null && !Number.isNaN(Number(v)) ? Number(v) : null;
    });
    if (countWhere(col, (v) => v !== null) < rows.length * 0.8) continue;
    for (const i of outlierIndexes(col)) flagged.add(i);
    ranges.push(`${names[c]} ${range(col)}`);
  }
  rows.forEach((r, i) => { if (IMPORTANT_RE.test(r)) flagged.add(i); });

  const keep = sampleIndexes(rows.length, [...flagged].sort((a, b) => a - b), o);
  const out = [mark(`table ${rows.length} rows × ${names.length} cols; showing ${keep.length} (head, tail, outliers, error rows). Numeric ranges over all rows: ${ranges.join('; ') || 'none'}. ${NOTE}`), header];
  let prev = -1;
  for (const i of keep) {
    if (i - prev > 1) out.push(mark(`${i - prev - 1} rows omitted`));
    out.push(rows[i]);
    prev = i;
  }
  if (rows.length - 1 - prev > 0) out.push(mark(`${rows.length - 1 - prev} rows omitted`));
  return out.join('\n') + (trailing !== null ? '\n' : '');
}

// ---------------------------------------------------------------- json

function compressJson(value, o) {
  return JSON.stringify(shrinkJson(value, o));
}

function shrinkJson(v, o) {
  if (Array.isArray(v)) return shrinkArray(v, o);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = shrinkJson(val, o);
    return out;
  }
  if (typeof v === 'string' && v.length > o.maxString) {
    if (v.includes('\n')) {
      const c = compress(v, o);
      if (c.changed) return c.text;
    }
    return `${v.slice(0, 600)}${mark(`${v.length - 900} chars omitted`)}${v.slice(-300)}`;
  }
  return v;
}

function shrinkArray(arr, o) {
  if (arr.length <= o.arrayMax) return arr.map((x) => shrinkJson(x, o));

  const flagged = new Set();
  const objects = arr.every((x) => x && typeof x === 'object' && !Array.isArray(x));
  let summary = '';
  if (objects) {
    const keyCount = new Map();
    for (const x of arr) {
      const k = Object.keys(x).sort().join(',');
      keyCount.set(k, (keyCount.get(k) || 0) + 1);
    }
    const dominant = [...keyCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const ranges = [];
    for (const key of dominant.split(',').filter(Boolean)) {
      const col = arr.map((x) => x[key]);
      if (countWhere(col, (v) => typeof v === 'number') < arr.length * 0.8) continue;
      for (const i of outlierIndexes(col)) flagged.add(i);
      ranges.push(`${key} ${range(col)}`);
    }
    arr.forEach((x, i) => {
      if (Object.keys(x).sort().join(',') !== dominant) flagged.add(i);
      else if (IMPORTANT_RE.test(JSON.stringify(x))) flagged.add(i);
    });
    summary = `items share keys {${dominant}}${ranges.length ? `; numeric ranges over all items: ${ranges.join('; ')}` : ''}`;
  } else if (arr.every((x) => typeof x === 'number')) {
    for (const i of outlierIndexes(arr)) flagged.add(i);
    summary = `numbers ${range(arr)}`;
  } else {
    arr.forEach((x, i) => { if (IMPORTANT_RE.test(JSON.stringify(x))) flagged.add(i); });
  }

  const keep = sampleIndexes(arr.length, [...flagged].sort((a, b) => a - b), o);
  const out = [];
  let prev = -1;
  for (const i of keep) {
    if (i - prev > 1) out.push(mark(`${i - prev - 1} items omitted`));
    out.push(shrinkJson(arr[i], o));
    prev = i;
  }
  if (arr.length - 1 - prev > 0) out.push(mark(`${arr.length - 1 - prev} items omitted`));
  out.unshift(mark(`array of ${arr.length}; showing ${keep.length} (head, tail, outliers, error items)${summary ? `; ${summary}` : ''}; ${NOTE}`));
  return out;
}

// ---------------------------------------------------------------- utils

function countWhere(arr, fn) {
  let n = 0;
  for (const x of arr) if (fn(x)) n++;
  return n;
}
