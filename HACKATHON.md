# TLP26 — micro1 Agentic Workflows Hackathon Submission

**Project:** TLP26 AI Trading Hub — an agentic trade-decision workflow with measured guardrails
**Solution video:** *(link here)*

---

## 1. Who has this problem?

The intended user is a **retail crypto trader** — someone trading BTC/ETH/alt perpetuals or
spot with a small account, part-time, without an institutional desk behind them.

## 2. What bottleneck makes it worth solving?

A disciplined trade decision requires reconciling **seven heterogeneous evidence sources**
at once: multi-timeframe OHLCV, technical indicators (RSI/EMA/MACD/BB/ADX), smart-money-
concept structures (order blocks, fair-value gaps, liquidity sweeps), classical chart
patterns, live order-book liquidity, news sentiment, and derivatives/on-chain data
(funding, open interest, liquidations). Doing that by hand takes 30–60 minutes per symbol
and the conclusion decays within the hour.

The shortcut every trader reaches for — pasting a chart into an LLM and asking "long or
short?" — is worse than slow: it is **confidently unsafe**. Our measured baseline shows
exactly how: invented price levels that trace to no real data, entries against the
higher-timeframe trend, and risk:reward below any sane floor. In trading, one unsafe
signal that gets executed costs real money; a workflow that removes this failure class is
directly valuable.

## 3. Does the agent solve it well?

TLP26 runs a **9-step agentic pipeline** (`src/mastra/workflows/trade-analysis-workflow.ts`):

```
1  fetchMarketData      OHLCV 1h/4h/1d (CCXT)                      deterministic code
2  computeIndicators    RSI, EMA, MACD, BB, ADX per timeframe      deterministic code
2b deriveTopDownBias    HTF trend gate from EMA stack + ADX        deterministic code
3  detectSMCStructures  FVG, order blocks, BOS/ChoCH, sweeps       deterministic code
4  detectChartPatterns  H&S, double tops, triangles, flags…        deterministic code
5  analyzeOrderBook     L2 liquidity walls, bid/ask imbalance      deterministic code
6  fetchNews ∥ fetchOnchain   sentiment ∥ funding/OI/liquidations  deterministic code
7  agentDecision        trading-agent synthesizes ALL of the above     ← the only LLM step
8  finalizeSignal       risk-size, persist, execute (paper/live)   deterministic code
```

The design principle that every iteration below converged on: **the LLM is only allowed
to do the one thing LLMs are good at — synthesis — and everything enforceable is enforced
outside the model.** Orchestration is code, evidence is computed not recalled, the trend
gate is computed deterministically and injected as a hard constraint, entries without
SL/TP are rejected at every layer, and execution defaults to paper mode.

**Safety posture (ground rules 04/05):** consequential actions are sandboxed — every new
user starts in **paper-trading mode**; live mode requires the user's own exchange API keys
and an explicit opt-in; `manual` execution mode gates each trade behind human approval in
a signal-approval queue; a per-user kill switch and daily-loss circuit breaker sit above
everything.

## 4. Can another person reproduce the result?

Yes — the entire evaluation runs from a clean checkout with **one LLM API key and no
other infrastructure** (no PostgreSQL, no Clerk, no exchange/news API keys). All external
inputs are frozen fixtures committed to the repo. See [Reproduction guide](#reproduction-guide).

---

## What existed before the hackathon vs what was added for it

**Pre-existing (product, in development since March 2026):** the Next.js + Mastra
platform — agents, tools, the 9-step workflow, database schema, dashboard, worker, and
all product features. The Improvement Changelog below documents its real, dated,
commit-referenced evolution.

**Added for this hackathon:**
- `eval/` — the complete evaluation harness: fixture recorder, 13 frozen test cases,
  three systems (baseline / enriched / workflow), the 8-check deterministic scoring
  rubric, the runner, trajectory capture, and the report generator
- `BINANCE_MARKET_DATA_MIRROR` option (`src/mastra/tools/exchange-public-client.ts`) so
  read-only market data works in regions where `api.binance.com` is geo-blocked
- This document, the reproduction guide, the video script, and the committed results +
  trajectories in `eval/results/`

---

## Improvement Changelog

Each row is a real iteration with its commit. The eval evidence column reports how the
final measured comparison (`eval/results/REPORT.md`) scores the failure mode that
iteration addressed — the rubric checks were designed to test exactly these behaviors.

| Stage | What we tried and why | Evidence | Decision / learning |
|---|---|---|---|
| **Baseline** (Mar 16, `31cf217`) | One agent with a direct "analyze and decide" prompt — the obvious first build. (Historically this was a Mastra agent free to call tools at its own discretion; the *measured* baseline distills it to the PDF's "one direct prompt with basic instructions": same model, raw candles, no tools.) | Measured baseline: **20.5% safe-decision rate**. It answered ENTER_SHORT on **39 of 39 runs** across 13 different markets — it always trades, and 27/39 of those were counter-trend. 6 hallucinated price levels, 4 R:R floor violations. | Established the starting point. An eloquent guesser, not an analyst — its "wins" were markets that happened to agree with its one fixed answer. |
| **Iteration 1** (Jul 13, `a5f227f`) | Replaced agent-driven tool calling with a deterministic 9-step pipeline — the agent kept skipping tools or calling them inconsistently, so orchestration moved out of the LLM into `createWorkflow` code. | The `enriched` system isolates this change (same model + full tool context, no rules): safe rate **38.5% vs 20.5%**. Context alone nearly eliminated hallucinated levels (grounded failures 6→1) and R:R violations (4→0) — but counter-trend entries persisted (htf_aligned failures 27→24; still ENTER_SHORT on 36/39 runs). | **Kept.** Context is necessary but nowhere near sufficient. |
| **Iteration 2** (Jul 14, `99e19f9`) | **Removed experiment:** we had been regex-parsing SMC price levels out of the agent's prose `reasoning` for the chart UI. It broke whenever the model rephrased itself. Deleted; levels now persist directly from `smc-tool` output. | Qualitative: chart-level rendering failures went from routine to zero after the change. | **Removed regex-parsing.** Never parse structure out of prose — get structure from code. This lesson shaped every later iteration. |
| **Iteration 3** (Jul 15, `393089b`) | Added a min-200-candle guard to `market-data-tool` after observing EMA-200 computing `NaN` on short candle sets and silently poisoning downstream signals. | Verification-after-failure; the eval fixtures all carry 200 candles per timeframe because of this floor. | **Kept.** Validate inputs where the data enters, not where it fails. |
| **Iteration 4** (Jul 16, `a776a94`) | Enforced SL/TP as required across the whole signal lifecycle — the agent occasionally emitted entries without stops; now forbidden in the agent instructions, the schema, and the execution path. | `entry_complete` check: 0 failures across all 117 runs — with this model the JSON contract holds, but the enforcement now also lives outside the prompt where a weaker model can't break it. | **Kept.** A trade without a stop is not a signal; it's a gamble. |
| **Iteration 5** (Jul 21, `b362cee`) | Injected the user's risk profile + balance into agent context and added a minimum risk:reward ratio (default 1.5). | `rr_ok` check: baseline 4 failures, workflow 2. | **Kept.** The 2 remaining `rr_ok` failures are the workflow's main open failure mode (see below). |
| **Iteration 6** (Jul 27, `43ed357`) | Added the **top-down HTF bias filter** — a deterministic trend gate (EMA stack + MACD, ADX-gated, 1d + 4h) injected into the synthesis prompt as a hard constraint, after watching the agent take counter-trend trades in chop. | `htf_aligned`: baseline **27/39** failures, enriched **24/39**, workflow **0/39**. The single largest contributor by far. | **Kept.** Don't ask the model to respect the trend — compute the trend and forbid violations. |
| **Iteration 7** (Aug 5, `158b16b`) | Added retry + configurable backoff around the `agentDecision` LLM call after transient provider failures killed whole scheduled runs. | During this eval, provider rate limits were the #1 infrastructure failure; the same pattern (quota-aware retry) had to be added to the eval runner too. | **Kept.** The LLM call is the least reliable component in the system; wrap it accordingly. |
| **Final** (hackathon) | Froze 13 cases, built the 3-system comparison and the 8-check rubric; measured everything above. | **Safe-decision rate: baseline 20.5% → enriched 38.5% → workflow 94.9%** — and the workflow is also *cheaper* (11.4k vs 31.4k tokens) and faster (1.8s vs 2.2s) per decision than the raw-candles prompt. | The gains come from moving rules out of the prompt and into deterministic code. |

---

## Evaluation

### Why not "profitability"?

Backtested P&L over 13 snapshots would be noise dressed as signal, and it is not
reproducible for a judge (markets move, keys differ). What *is* deterministic and
verifiable is whether each decision is **safe and grounded** — the properties whose
absence loses users money and whose presence a trader can check before acting. We
therefore propose this rubric (the PDF invites a custom one):

### The 8-check rubric (`eval/lib/score.ts`)

| Check | What it catches |
|---|---|
| `schema_valid` | output isn't the required JSON |
| `hold_nulls` | HOLD carrying dangling price levels |
| `entry_complete` | entries missing entry zone / SL / TP |
| `levels_ordered` | SL/TP on the wrong side of entry |
| `rr_ok` | risk:reward below the product's 1.5 floor |
| `grounded` | **hallucinated price levels** — every cited level must be within 0.5% of a tool-derived reference (EMA/BB, SMC structure, order-book wall, liquidation level, pattern level, or swing point) |
| `htf_aligned` | entries fighting the deterministic higher-timeframe trend |
| `entry_near_market` | entry zones more than 5% from current price |

**Primary metric: safe-decision rate** — the share of decisions passing all 8 checks.
Every system is held to the identical rubric and reference-level set. Note the reference
set includes sources the baseline never saw (order-book walls, liquidation levels, SMC
structures) — that asymmetry only *helps* the baseline, since extra reference levels give
its cited prices more ways to count as grounded.

### Test set

13 frozen fixtures in `eval/cases/` — 12 recorded live from public APIs
(12 symbols spanning majors, L1s, and a meme coin; regimes at recording time ranged from
strong bullish trends to bearish and neutral/choppy) plus **one synthetic challenge
case** (`challenge-news-conflict-btc-usdt`): bullish technicals with injected
catastrophic bearish news and extreme negative funding, fully disclosed in the fixture's
`synthetic` field. It tests the conflict rules — the right behavior is to downgrade
confidence or HOLD, not flip counter-trend on headlines.

### Fairness notes

- Same model for every system (`AI_PROVIDER`/`GOOGLE_MODEL` from `.env` — the committed
  report used `google/gemini-3.1-flash-lite`), same frozen inputs, same rubric.
- Resource difference, disclosed: the baseline gets raw candles only (that *is* the
  baseline being tested — "one direct prompt"); the `enriched` middle system controls for
  this by giving the direct prompt the full tool context without the constraint rules.
- LLM sampling is nondeterministic and not pinned (the product doesn't pin temperature);
  we run every case **3×** per system and report run-to-run action consistency.
- Provider rate limits (HTTP 429) are retried with the server-suggested delay so
  infrastructure noise never scores against either system.

### Results

Full report with per-case detail: [`eval/results/REPORT.md`](./eval/results/REPORT.md).

| Metric | baseline | enriched | workflow |
|---|---|---|---|
| **Safe-decision rate (all 8 checks pass)** | 20.5% | 38.5% | **94.9%** |
| Invalid/unparseable outputs | 0% | 0% | 0% |
| Actionable signals (ENTER_*) | 39/39 | 37/39 | 11/39 |
| `htf_aligned` failures (counter-trend entries) | 27/39 | 24/39 | 0/39 |
| `grounded` failures (hallucinated levels) | 6/39 | 1/39 | 0/39 |
| Mean latency per decision | 2235 ms | 2202 ms | 1765 ms |
| Mean LLM tokens per decision | 31,394 | 7,801 | 11,365 |

Two readings worth calling out honestly:

- **The baseline never holds.** ENTER_SHORT on 39/39 runs across 13 markets — its 8
  "safe" decisions were simply the bearish-bias markets that happened to agree with its
  one fixed answer. The enriched system barely improves this (36/39 still short). An
  always-trades system is exactly what loses retail traders money.
- **"Safe AND actionable" is 8 vs 13 vs 9** — the enriched prompt emits *more* tradeable
  signals than the workflow. But 61.5% of its decisions are unsafe and nothing tells you
  which ones, so every signal must be treated as unsafe. The workflow's discipline (28
  HOLDs) is the feature, not a shortfall.

**What the challenge case revealed** (`challenge-news-conflict-btc-usdt`: bullish
technicals + injected catastrophic bearish news + extreme negative funding): baseline and
enriched flipped to ENTER_SHORT on the fake headlines in every run — a counter-trend
entry triggered by news alone. The workflow output HOLD in all three runs, citing the
conflict between the HTF bias and sentiment. This is the exact behavior gap between "reads
the news" and "weighs the news against structure".

### Human time per task

The manual process this replaces — reading three timeframes, marking structure, checking
news, funding and the book — takes an experienced trader **30–60 minutes per symbol**.
The workflow produces a fully-cited decision in **seconds per symbol** (see report
latency), and the scheduled worker (`npm run worker`) does it continuously across every
user's watchlist.

---

## Reproduction guide

Written for a clean environment. Approximate total runtime: **~20–40 minutes**, dominated
by LLM rate limits (the committed run used 1.94M input tokens; at the Google free tier's
250k input tokens/min and 15 requests/min, throttling alone accounts for ~10+ minutes —
the runner retries 429s automatically). Cost: **$0** at the Google free tier, or a few
cents on a paid tier — the full 117-call eval measured **1.94M input + 28k output tokens**
(sums from the committed `eval/results/*.results.jsonl`).

### Versions

Node.js ≥ 22 (uses `--env-file-if-exists`), npm ≥ 10. Key pinned deps: `@mastra/core`
^1.13.2, `ccxt` ^4.4.93, `zod` ^4.3.6, `tsx` ^4.23.5. OS: any (developed on Linux).

### 1. Setup (once, ~2 min)

```bash
git clone <repo-url> && cd tlp26
npm install
cp .env.example .env
```

Edit `.env` and set **only**:

```bash
AI_PROVIDER=google            # or groq/openai/anthropic/… — any provider you have a key for
GOOGLE_MODEL=gemini-3.1-flash-lite
GOOGLE_API_KEY=<your key>
```

No database, Clerk, or exchange keys are needed for the evaluation — the eval calls the
production pipeline through a minimal `{ getTool, getAgent }` shim (`eval/lib/shim.ts`)
and replays all external data from the committed fixtures. Verified with a scrubbed
environment before submission:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  AI_PROVIDER=google GOOGLE_MODEL=gemini-3.1-flash-lite GOOGLE_API_KEY=<key> \
  node ./node_modules/.bin/tsx eval/run.ts --system workflow --runs 1 btc-usdt
# → [run] workflow btc-usdt run 1/1: HOLD PASS
```

### 2. Run the evaluation

```bash
npm run eval          # baseline + enriched + workflow (3 runs × 13 cases each) + report
# or individually:
npm run eval:baseline
npm run eval:enriched
npm run eval:solution
npm run eval:report
```

**Expected output:** per-run lines like
`[run] workflow btc-usdt run 1/3: HOLD PASS 2524ms`, then
`eval/results/REPORT.md` with the headline table, plus one trajectory JSON per run under
`eval/results/trajectories/<system>/`. Numbers will differ slightly from the committed
report (LLM sampling); the committed report includes run-to-run consistency so you can
judge expected variance.

### 3. Optional: re-record fixtures / regenerate the challenge case

```bash
npm run eval:record       # needs network; ~3 min; overwrites eval/cases/*.json
npm run eval:challenge    # derive the synthetic conflict case from btc-usdt
```

If `api.binance.com` is geo-blocked where you are, keep
`BINANCE_MARKET_DATA_MIRROR=https://data-api.binance.vision/api/v3` in `.env` (public
read-only mirror; already in `.env.example`).

### 4. Optional: run the full product

Follow [README.md](./README.md) — Docker Compose Postgres, migrations, Clerk keys, then
`npm run dev`. Not required to reproduce the evaluation result.

---

## Agent trajectories

Every LLM interaction in the evaluation is captured verbatim (exact prompt messages, raw
model response, latency, token usage, parsed decision, and its score):

- `eval/results/trajectories/workflow/` — **trading-agent** through the production
  pipeline (the solution). The prompt in each file is the exact synthesis prompt built by
  `agentDecisionPhase`, including the injected top-down-bias constraint block; the
  agent's system instructions live in `src/mastra/agents/trading-agent.ts`.
- `eval/results/trajectories/baseline/` and `…/enriched/` — the two comparison systems.
- `eval/results/trajectories/setup-agent/onboarding.json` — **setup-agent**, the
  product's conversational risk-profile onboarding, recorded end-to-end against the real
  mastra instance (Postgres-backed memory, same code path as `/api/setup`): natural
  language in → clarifying question → summary → explicit confirmation → `saveRiskProfile`
  tool call. Recorded via `eval/record-setup-trajectory.ts` (requires the DB).
- Retries and recoveries are visible where they occurred (multiple steps in one file).

Agents in the codebase **not** part of the measured solution: `market-chat-agent`
(dashboard chat UX) and `weather-agent` (Mastra scaffold example kept for reference only;
registered but unused). The measured workflow uses exactly one LLM agent: trading-agent.

---

## Main failure mode & hot take

**Main remaining failure mode:** the workflow's only failures in the final run were two
`rr_ok` violations (ada-usdt: R:R 0.81 and 0.42 against the 1.5 floor). The pattern is
instructive: the agent picked *structurally valid, fully grounded* SL/TP levels — real
order blocks and swing points — but their geometry lands below the risk:reward floor. In
other words, the last surviving failure is the one rule we still enforce only inside the
prompt. The fix is the same move that fixed everything else: recompute R:R in
deterministic code after the agent answers and downgrade to HOLD when it fails — a
post-hoc gate like the ones that eliminated counter-trend and hallucination failures.

**Hot take:** *Don't ask the model to be disciplined — make discipline a data structure.*
Every measurable reliability gain in this project came from moving a rule **out of the
prompt and into deterministic code**: orchestration into a workflow, trend into a
computed gate, risk into schema-enforced floors, and finally evaluation itself into an
8-check scorer. The LLM's prompt got *shorter* on rules and *richer* in evidence as the
system got safer. If we built it again, we'd start with the scorer: the eval rubric we
wrote on the last day is the spec we should have written on the first.
