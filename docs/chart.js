// Builds docs/cost.svg from the 2026-10-27 benchmark (bench-results/2026-10-27T12-21-52-079Z).
// node docs/chart.js
import fs from 'node:fs';

const rows = [
  // task, rung model, top model alone (USD/run), tokenladder (USD/run)
  ['fix-bug', 'Sonnet', 0.3373, 0.0170],
  ['log-needle', 'Haiku', 0.0920, 0.0026],
  ['metrics-json', 'Haiku', 0.2197, 0.0009],
  ['csv-outlier', 'Haiku', 0.2764, 0.0014],
  ['explain', 'Haiku', 0.2897, 0.0034],
  ['html-page', 'Haiku', 0.3110, 0.0033],
  ['order-history', 'Sonnet', 0.7556, 0.1060],
];
const total = [2.2816, 0.1345];

const W = 860, padL = 190, padR = 70, top = 196, bar = 14, gap = 2, group = 2 * bar + gap + 22;
const H = top + rows.length * group + 64;
const max = 0.8, x = (v) => padL + (v / max) * (W - padL - padR);
const usd = (v) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
// bar with 4px rounded data end, square at the baseline
const rect = (x0, y, w, cls) => {
  const r = Math.min(4, w / 2, bar / 2);
  return `<path class="${cls}" d="M${x0},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${bar - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z"/>`;
};

let s = '';
for (let t = 0; t <= max + 1e-9; t += 0.2) {
  s += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 8}" y2="${top + rows.length * group - 14}"/>`;
  s += `<text class="muted" x="${x(t)}" y="${top + rows.length * group + 4}" text-anchor="middle">$${t.toFixed(1)}</text>`;
}
rows.forEach(([task, model, a, b], i) => {
  const y = top + i * group;
  s += `<text class="primary" x="${padL - 12}" y="${y + bar}" text-anchor="end">${task}</text>`;
  s += `<text class="muted" x="${padL - 12}" y="${y + 2 * bar + gap + 2}" text-anchor="end">routed to ${model}</text>`;
  s += rect(padL, y, x(a) - padL, 'top');
  s += `<text class="secondary" x="${x(a) + 6}" y="${y + bar - 3}">${usd(a)}</text>`;
  s += rect(padL, y + bar + gap, Math.max(x(b) - padL, 2), 'ladder');
  s += `<text class="secondary" x="${x(b) + 6}" y="${y + 2 * bar + gap - 3}">${usd(b)}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" role="img" aria-labelledby="t d">
<title id="t">Cost per task: everything on the top model vs tokenladder</title>
<desc id="d">Seven coding tasks, mean list-price cost per run. Top model alone: ${usd(total[0])} total. tokenladder: ${usd(total[1])} total, 94% less. All tasks solved in both.</desc>
<style>
  .bg{fill:#fcfcfb}.primary{fill:#0b0b0b;font-size:14px}.secondary{fill:#52514e;font-size:12px}.muted{fill:#6f6e69;font-size:11px}
  .hero{fill:#0b0b0b;font-size:34px;font-weight:600}.label{fill:#52514e;font-size:13px}
  .top{fill:#eb6834}.ladder{fill:#2a78d6}.grid{stroke:#e6e5e1;stroke-width:1}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19}.primary,.hero{fill:#f0efec}.secondary,.label{fill:#c3c2b7}.muted{fill:#9c9b93}
    .top{fill:#d95926}.ladder{fill:#3987e5}.grid{stroke:#33332f}
  }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text class="label" x="32" y="40">Everything on the top model (Fable 5.1)</text>
<text class="hero" x="32" y="80">${usd(total[0])}</text>
<text class="label" x="330" y="40">Same tasks through tokenladder</text>
<text class="hero" x="330" y="80">${usd(total[1])}</text>
<text class="label" x="620" y="40">Saved</text>
<text class="hero" x="620" y="80">−94%</text>
<text class="muted" x="32" y="106">Sum of mean cost per run over 7 tasks · 3 runs each · 18/18 solved in both · judge quality 4.43 vs 4.48 (1–5)</text>
<rect class="top" x="32" y="136" width="12" height="12" rx="2"/><text class="secondary" x="50" y="146">Top model alone</text>
<rect class="ladder" x="170" y="136" width="12" height="12" rx="2"/><text class="secondary" x="188" y="146">tokenladder</text>
<text class="muted" x="${W - padR}" y="146" text-anchor="end">USD per run, list price</text>
${s}
<text class="muted" x="32" y="${H - 18}">Claude Code 2.1.310, 2026-10-27. Each request priced at the model that answered it. Full report: docs/results.md</text>
</svg>
`;
fs.writeFileSync(new URL('./cost.svg', import.meta.url), svg);
console.log('wrote docs/cost.svg', W, 'x', H);
