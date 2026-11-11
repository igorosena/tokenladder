# Benchmark results

Run on 2026-10-27 with Claude Code 2.1.310. Seven coding tasks, three runs each, in three arms:

- **passthrough**: everything on the top model (Fable 5.1), proxy only measures. This is what you pay when you pick the expensive model and send it everything.
- **direct**: the router picks the rung and only the model is switched. This is "picking the cheap model by hand".
- **route**: the full tokenladder: router plus compression, short-answer instruction, cache TTL and tool list.

Every arm solved every task (18/18; `explain` has no automatic check). Quality was graded by an LLM judge (Sonnet), blind and pairwise against the passthrough run of the same number, seeing the final answer and the files the agent wrote. Treat gaps under half a point as a tie.

The raw report follows, as the benchmark printed it. Reproduce with:

```
tokenladder bench --model fable --variants passthrough,direct,route --runs 3 --fresh-output --judge
```

It spends real money (about $3 at list price for this configuration).

---


agent: claude · model: fable · runs per cell: 3 · numbers are means per run (min–max over runs in brackets), as reported by the provider

**context** = input + cache write + cache read: every prompt token the model saw, summed over the run's requests. It does not depend on whether the provider's cache hit, so it is the metric to compare variants on. Lower context means the proxy sent less.
**output** = tokens generated. **reqs** = API requests per run (more requests = more context, even with no compression).

```
task               variant  solved  reqs  context      ctx min–max  Δ context  output   out min–max  Δ output  tool output cut
-------------  -----------  ------  ----  -------  ---------------  ---------  ------  ------------  --------  ---------------
fix-bug        passthrough     3/3   4.3  108,063   93,866–121,918   baseline     924     814–1,025  baseline                —
fix-bug             direct     3/3   3.7   85,469    68,743–94,725     -20.9%     637       556–688    -31.1%                —
fix-bug              route     3/3   4.3   60,632    55,179–71,300     -43.9%     527       449–643    -42.9%                —
log-needle     passthrough     3/3   3.0   67,817    67,555–67,981   baseline     808       640–937  baseline                —
log-needle          direct     3/3   3.7   91,197   71,738–103,525     +34.5%   2,592   2,073–2,897   +220.6%                —
log-needle           route     3/3   3.7   51,104    39,170–57,926     -24.6%   1,715   1,162–2,142   +112.1%                —
metrics-json   passthrough     3/3   2.7   73,518    52,678–84,168   baseline     451       268–644  baseline                —
metrics-json        direct     3/3   2.0   52,910    52,833–53,002     -28.0%     922     864–1,018   +104.5%                —
metrics-json         route     3/3   2.0   22,750           22,750     -69.1%     584       378–913    +29.6%    93% of 18,500
csv-outlier    passthrough     3/3   2.3   67,974    56,406–91,107   baseline     234       162–363  baseline                —
csv-outlier         direct     3/3   2.3   68,192    56,381–91,688      +0.3%   1,061     927–1,284   +352.8%                —
csv-outlier          route     3/3   2.7   32,666    22,484–37,767     -51.9%     838       781–872   +257.6%    96% of 38,100
explain        passthrough     n/a   4.0  105,780  105,308–106,418   baseline   1,718   1,566–1,822  baseline                —
explain             direct     n/a   5.0  147,815   97,181–196,364     +39.7%   8,203   6,567–9,831   +377.4%                —
explain              route     n/a   4.3   67,967    22,509–92,923     -35.7%   2,939   1,609–4,008    +71.1%    89% of 22,257
html-page      passthrough     3/3   3.0   72,494   46,325–123,870   baseline   4,217   2,620–6,421  baseline                —
html-page           direct     3/3   6.7  196,177  127,553–324,473    +170.6%  10,490  7,680–12,046   +148.8%                —
html-page            route     3/3   3.3   45,668    39,491–57,549     -37.0%   3,700   3,240–4,133    -12.2%                —
order-history  passthrough     3/3   4.7  141,680  119,039–155,678   baseline   8,365   7,947–8,926  baseline                —
order-history       direct     3/3   6.0  168,174  126,744–218,333     +18.7%   6,484   5,312–7,640    -22.5%                —
order-history        route     3/3   5.7  147,104  126,328–161,214      +3.8%   6,319   5,746–7,347    -24.5%    85% of 48,658
```

## Cache and cost (depends on the provider's cache state; noisy between identical runs)

cost = list-price USD per run, each request priced at the model that answered it (Claude Code's own total_cost_usd prices everything at the launch model, so it is wrong when the proxy switches models). On a Pro/Max plan it is notional: usage counts against your limits.
units = input + 1.25×cache write (2× for the 1h-TTL part) + 0.1×cache read + 5×output: token-weighted, model-blind. Compare models with "cost", compare prompt sizes with "context". ±sd = sample standard deviation over runs · fresh tool output per run (tool outputs are cache writes, as in a real session)

```
task               variant            model (profile)  input  cache w  cache w min–max  cache r     cost    Δ cost   units      ±sd   Δ units
-------------  -----------  -------------------------  -----  -------  ---------------  -------  -------  --------  ------  -------  --------
fix-bug        passthrough                  fable-5-1    112   13,315     2,831–27,046   94,636  $0.3373  baseline  40,826  ±25,502  baseline
fix-bug             direct   sonnet-5-5 (edit:direct)     90    2,529      1,603–3,910   82,850  $0.0249    -92.6%  16,616   ±3,836    -59.3%
fix-bug              route          sonnet-5-5 (edit)    111    2,291      2,206–2,366   58,230  $0.0170    -94.9%  11,434   ±1,526    -72.0%
log-needle     passthrough                  fable-5-1     68    1,722      1,505–1,865   66,026  $0.0920  baseline  14,157   ±1,147  baseline
log-needle          direct  haiku-5-5 (lookup:direct)     90    6,680      5,556–8,182   84,428  $0.0035    -96.2%  34,850   ±6,075   +146.2%
log-needle           route         haiku-5-5 (lookup)     90   10,316     9,522–11,465   40,698  $0.0026    -97.2%  25,629   ±4,565    +81.0%
metrics-json   passthrough                  fable-5-1     57    9,023      8,683–9,320   64,438  $0.2197  baseline  26,801   ±3,266  baseline
metrics-json        direct  haiku-5-5 (lookup:direct)     35    9,023      8,946–9,115   43,852  $0.0027    -98.8%  27,078     ±585     +1.0%
metrics-json         route         haiku-5-5 (lookup)     35    2,921        604–7,556   19,794  $0.0009    -99.6%   8,588   ±6,043    -68.0%
csv-outlier    passthrough                  fable-5-1     46   12,517    12,405–12,633   55,411  $0.2764  baseline  31,793   ±2,772  baseline
csv-outlier         direct  haiku-5-5 (lookup:direct)     46   12,790    12,404–13,348   55,356  $0.0036    -98.7%  36,467   ±3,949    +14.7%
csv-outlier          route         haiku-5-5 (lookup)     57    5,393        392–7,903   27,216  $0.0014    -99.5%  13,710   ±6,126    -56.9%
explain        passthrough                  fable-5-1    101    8,928      8,598–9,337   96,751  $0.2897  baseline  36,224   ±1,383  baseline
explain             direct  haiku-5-5 (lookup:direct)    134   14,147     5,381–22,567  133,534  $0.0083    -97.1%  82,796  ±29,486   +128.6%
explain              route         haiku-5-5 (lookup)    112   10,427     5,067–18,861   57,428  $0.0034    -98.8%  33,585  ±16,082     -7.3%
html-page      passthrough                  fable-5-1     68    4,118      2,420–6,554   68,307  $0.3110  baseline  36,219  ±18,377  baseline
html-page           direct  haiku-5-5 (lookup:direct)    189   13,340     7,867–19,330  182,648  $0.0098    -96.9%  97,582  ±30,975   +169.4%
html-page            route         haiku-5-5 (lookup)     79    8,301     3,289–11,795   37,287  $0.0033    -98.9%  32,686   ±6,874     -9.8%
order-history  passthrough                  fable-5-1    123   15,226    14,583–15,885  126,330  $0.7556  baseline  85,035   ±3,823  baseline
order-history       direct  sonnet-5-5 (build:direct)    167   10,475     7,030–15,357  157,533  $0.1228    -83.7%  69,288  ±18,593    -18.5%
order-history        route         sonnet-5-5 (build)    156   11,602     7,084–18,499  135,346  $0.1060    -86.0%  59,787   ±8,345    -29.7%
```

## Totals (sum of per-task means)
```
variant      solved  context  Δ context  output  Δ output    units   Δ units     cost    Δ cost
-----------  ------  -------  ---------  ------  --------  -------  --------  -------  --------
passthrough   18/18  637,325   baseline  16,718  baseline  271,056  baseline  $2.2816  baseline
direct        18/18  809,934     +27.1%  30,388    +81.8%  364,677    +34.5%  $0.1756    -92.3%
route         18/18  427,892     -32.9%  16,623     -0.6%  185,419    -31.6%  $0.1345    -94.1%
```

A cheaper variant only counts if "solved" didn't drop. Negative Δ = less than passthrough. Δ context = how much less the model read; Δ cost = dollars at list price; Δ units ignores model prices.

## Quality (judge: sonnet, pairwise vs passthrough, blind order, 42 comparisons · judge cost $0.7237)

quality = mean score 1–5 given by the judge to the final answer plus the files the agent changed (correctness, completeness, follows the prompt; length is not a criterion). The passthrough score is its mean over the comparisons it took part in. W–T–L = how often the variant beat, tied or lost to the passthrough run of the same number. An LLM judge is noisy: treat gaps under half a point as a tie.

```
task               variant  quality  Δ quality  W–T–L                                                                                 judge notes
-------------  -----------  -------  ---------  -----  ------------------------------------------------------------------------------------------
fix-bug        passthrough     4.83   baseline      —  Says the discount-and-tax case came out at half the expected value because only the second
fix-bug             direct     5.00      +0.33  1–2–0                                                                                            
fix-bug              route     5.00      +0.00  0–3–0                                                                                            
log-needle     passthrough     4.50   baseline      —  Does not start the reply with the order id as a clear sentence in the same way (just '8821
log-needle          direct     3.33      -1.33  0–1–2  Does not start the reply with the order id; it begins with 'Order 88213 failed...'. Otherw
log-needle           route     3.33      -1.00  1–0–2  Does not start with the bare order id; begins with 'Order 88213', though the id is still e
metrics-json   passthrough     4.83   baseline      —  Claims every other host sits in 20 to 60 percent without verifying, since the script displ
metrics-json        direct     4.67      -0.33  0–2–1  Adds a staleness caveat about the snapshot date that the task did not ask for and that may
metrics-json         route     5.00      +0.33  1–2–0                                                                                            
csv-outlier    passthrough     4.83   baseline      —  Claims 'the CSV is printed above' and that every other request is within 20-199 ms, which 
csv-outlier         direct     5.00      +0.00  0–3–0                                                                                            
csv-outlier          route     4.67      +0.00  0–3–0  Discloses that the printed output was condensed to 9 of 700 rows, so it did not fully show
explain        passthrough     4.00   baseline      —  Claims two tests fail with specific output and mentions test/line.test.js, plus some dubio
explain             direct     4.67      +0.67  2–1–0  Did not run the test suite, and says the test 'should fail' without confirming; also menti
explain              route     4.00      +0.00  0–3–0  Opens with an odd leftover line, and claims discount 150 yields "-0", which is dubious; ot
html-page      passthrough     4.00   baseline      —  Page has more than three sections (menu, about, hours, contact) plus a hero, so it does no
html-page           direct     4.67      +0.67  2–0–1  Form posts to /contact, which has no handler, but this is disclosed. | Header contains a h
html-page            route     4.33      +0.33  1–2–0  Has hero plus four sections (About, Menu, Visit, Contact), which exceeds 'three sections';
order-history  passthrough     4.00   baseline      —  Imports lineTotal from src/cart.js, coupling to the module it was told not to touch, and s
order-history       direct     4.67      +0.67  2–1–0  The ORDERS_FILE env var is read at import time, and the data/orders.json file is not creat
order-history        route     5.00      +1.00  3–0–0                                                                                            
```
```
variant      quality  Δ quality   W–T–L
-----------  -------  ---------  ------
passthrough     4.43   baseline       —
direct          4.57      +0.10  7–10–4
route           4.48      +0.10  6–13–2
```