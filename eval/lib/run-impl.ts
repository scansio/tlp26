/**
 * Eval runner implementation — runs one system (baseline or workflow) over
 * every frozen case and writes:
 *
 *   eval/results/<system>.results.jsonl        one scored record per case×run
 *   eval/results/trajectories/<system>/…json   full agent trajectory per run
 *
 * The two systems:
 *
 *   baseline  — the PDF's "one direct prompt with basic instructions": the
 *               SAME model gets the SAME raw OHLCV candles and must return
 *               the same JSON decision. No tools, no pipeline, no HTF filter.
 *   enriched  — changelog middle rung: same direct-prompt agent, but given
 *               the pipeline's computed tool data (indicators, SMC, patterns,
 *               order book, news, on-chain). Better context, still no
 *               constraint rules. Isolates "context" from "discipline".
 *   workflow  — the production pipeline, unchanged: indicators → top-down
 *               bias → SMC → patterns → (frozen order book / news / on-chain)
 *               → trading-agent synthesis. Network phases are replayed from
 *               the fixture; everything else is the real production code.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { defaultModel } from '@/mastra/model';
import {
  computeIndicatorsPhase,
  deriveTopDownBiasPhase,
  detectSMCStructuresPhase,
  detectChartPatternsPhase,
  agentDecisionPhase,
} from '@/lib/analysis/market-analysis';
import { createEvalMastra, type AgentCallRecord } from './shim';
import { evalCaseSchema, decisionSchema, type EvalCase, type Decision } from './case-types';
import { buildScoringContext, scoreDecision, type ScoringContext } from './score';

const CASES_DIR = join(process.cwd(), 'eval', 'cases');
const RESULTS_DIR = join(process.cwd(), 'eval', 'results');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

type SystemName = 'baseline' | 'enriched' | 'workflow';

function parseArgs(): { system: SystemName; runs: number; caseIds: string[] } {
  const argv = process.argv.slice(2);
  let system: SystemName | null = null;
  let runs = 1;
  const caseIds: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--system') {
      const v = argv[++i];
      if (v !== 'baseline' && v !== 'enriched' && v !== 'workflow')
        throw new Error(`--system must be baseline|enriched|workflow, got: ${v}`);
      system = v;
    } else if (argv[i] === '--runs') {
      runs = Number(argv[++i]);
      if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
    } else {
      caseIds.push(argv[i]);
    }
  }
  if (!system) throw new Error('Missing required --system baseline|workflow');
  return { system, runs, caseIds };
}

// ---------------------------------------------------------------------------
// Case loading + shared derivation (deterministic, LLM-free)
// ---------------------------------------------------------------------------

function loadCases(caseIds: string[]): EvalCase[] {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
  const cases = files.map((f) => evalCaseSchema.parse(JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8'))));
  if (caseIds.length === 0) return cases;
  const wanted = new Set(caseIds);
  return cases.filter((c) => wanted.has(c.id));
}

interface DerivedContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipelineInput: any;
  scoringCtx: ScoringContext;
}

/** Recompute the deterministic pipeline stages (identical for scoring both systems). */
async function deriveContext(evalCase: EvalCase): Promise<DerivedContext> {
  const shim = createEvalMastra();
  const base = {
    symbol: evalCase.symbol,
    exchange: evalCase.exchange,
    candles1h: evalCase.candles1h,
    candles4h: evalCase.candles4h,
    candles1d: evalCase.candles1d,
  };
  const s2 = await computeIndicatorsPhase(base, shim);
  const s2b = deriveTopDownBiasPhase(s2);
  const s3 = await detectSMCStructuresPhase(s2b, shim);
  const s4 = await detectChartPatternsPhase(s3, shim);

  const pipelineInput = {
    ...s4,
    orderBook: evalCase.orderBook,
    news: evalCase.news,
    onchain: evalCase.onchain,
  };

  const scoringCtx = buildScoringContext(evalCase, {
    indicators1h: s4.indicators1h,
    indicators4h: s4.indicators4h,
    indicators1d: s4.indicators1d,
    topDownBias: s4.topDownBias,
    smcStructures: s4.smcStructures,
    chartPatterns: s4.chartPatterns,
  });

  return { pipelineInput, scoringCtx };
}

// ---------------------------------------------------------------------------
// Baseline system — one direct prompt, same model, raw candles only
// ---------------------------------------------------------------------------

const baselineAgent = new Agent({
  id: 'baseline-agent',
  name: 'Baseline Trading Prompt',
  instructions:
    'You are a crypto trading assistant. Analyze the market data the user provides and recommend a trade decision in the exact JSON format requested. Use technical analysis.',
  model: defaultModel,
});

function candlesToCsv(candles: EvalCase['candles1h']): string {
  const rows = candles.map(
    (c) => `${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.volume}`,
  );
  return `timestamp,open,high,low,close,volume\n${rows.join('\n')}`;
}

function baselinePrompt(evalCase: EvalCase): string {
  return `Analyze the market for ${evalCase.symbol} and decide whether to enter a trade right now.

Here is the recent OHLCV candle data.

## 1h candles
${candlesToCsv(evalCase.candles1h)}

## 4h candles
${candlesToCsv(evalCase.candles4h)}

## 1d candles
${candlesToCsv(evalCase.candles1d)}

Return ONLY a valid JSON object with no prose, in exactly this structure:
{
  "bias": "BULLISH|BEARISH|NEUTRAL",
  "action": "ENTER_LONG|ENTER_SHORT|HOLD",
  "entryZone": { "low": <number|null>, "high": <number|null> },
  "sl": <number|null>,
  "tp": <number|null>,
  "confidence": "LOW|MEDIUM|HIGH",
  "primarySignalSource": "<string>",
  "strategiesTriggered": ["<string>"],
  "reasoning": "<string>"
}

If action is HOLD, set entryZone.low, entryZone.high, sl, and tp to null. For ENTER_LONG or ENTER_SHORT, provide entry zone, stop-loss (sl), and take-profit (tp) price levels.`;
}

/**
 * Enriched prompt: the same data sections the production synthesis prompt
 * carries (indicators, SMC, patterns, order book, news, on-chain) but with
 * NO top-down-bias constraint and NO anti-hallucination/conflict rules.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enrichedPrompt(evalCase: EvalCase, pipelineInput: any): string {
  return `Analyze the market for ${evalCase.symbol} and decide whether to enter a trade right now.

## Technical Indicators
### 1h
${JSON.stringify(pipelineInput.indicators1h, null, 2)}

### 4h
${JSON.stringify(pipelineInput.indicators4h, null, 2)}

### 1d
${JSON.stringify(pipelineInput.indicators1d, null, 2)}

## SMC Structures
${JSON.stringify(pipelineInput.smcStructures, null, 2)}

## Chart Patterns
${JSON.stringify(pipelineInput.chartPatterns, null, 2)}

## Order Book
${JSON.stringify(pipelineInput.orderBook, null, 2)}

## News Sentiment
Overall: ${evalCase.news.overallSentiment}
${evalCase.news.items.slice(0, 5).map((n) => `- [${n.sentiment}] ${n.title}`).join('\n')}

## On-Chain / Derivatives
${JSON.stringify(evalCase.onchain, null, 2)}

Return ONLY a valid JSON object with no prose, in exactly this structure:
{
  "bias": "BULLISH|BEARISH|NEUTRAL",
  "action": "ENTER_LONG|ENTER_SHORT|HOLD",
  "entryZone": { "low": <number|null>, "high": <number|null> },
  "sl": <number|null>,
  "tp": <number|null>,
  "confidence": "LOW|MEDIUM|HIGH",
  "primarySignalSource": "<string>",
  "strategiesTriggered": ["<string>"],
  "reasoning": "<string>"
}

If action is HOLD, set entryZone.low, entryZone.high, sl, and tp to null. For ENTER_LONG or ENTER_SHORT, provide entry zone, stop-loss (sl), and take-profit (tp) price levels.`;
}

// ---------------------------------------------------------------------------
// Decision extraction + validation (same regex as production agentDecision)
// ---------------------------------------------------------------------------

function extractDecision(rawText: string): Decision | null {
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = decisionSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RunOutcome {
  decision: Decision | null;
  rawText: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trajectory: { messages: any; responseText: string; latencyMs: number; usage: any }[];
  latencyMs: number;
  error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Provider rate limits (e.g. Google free tier: 15 requests/min, 250k input
 * tokens/min) are infrastructure noise, not model behavior — counting a 429
 * against either system would make the comparison unfair. Retry with the
 * server-suggested delay when the error carries one, else back off 30s.
 */
async function withQuotaRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = /quota|rate.?limit|429|resource.?exhausted|overloaded|503/i.test(msg);
      if (!isRateLimit || attempt >= attempts) throw err;
      const suggested = msg.match(/retry in ([\d.]+)\s*s/i);
      const waitMs = suggested ? Math.ceil(parseFloat(suggested[1]) * 1000) + 2000 : 30_000;
      console.warn(`[run] ${label}: rate-limited, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${attempts})`);
      await sleep(waitMs);
    }
  }
}

async function runDirectPrompt(prompt: string): Promise<RunOutcome> {
  const started = Date.now();
  let attemptStarted = started;
  try {
    const res = await withQuotaRetry('direct-prompt', () => {
      attemptStarted = Date.now();
      return baselineAgent.generate([{ role: 'user', content: prompt }]);
    });
    const rawText = typeof res.text === 'string' ? res.text : JSON.stringify(res.text ?? '');
    const latencyMs = Date.now() - attemptStarted;
    return {
      decision: extractDecision(rawText),
      rawText,
      trajectory: [
        {
          messages: [{ role: 'user', content: prompt }],
          responseText: rawText,
          latencyMs,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          usage: (res as any).usage ?? null,
        },
      ],
      latencyMs,
      error: null,
    };
  } catch (err) {
    return {
      decision: null,
      rawText: '',
      trajectory: [{ messages: [{ role: 'user', content: prompt }], responseText: '', latencyMs: Date.now() - started, usage: null }],
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runWorkflow(pipelineInput: any): Promise<RunOutcome> {
  const trajectory: RunOutcome['trajectory'] = [];
  const shim = createEvalMastra((rec: AgentCallRecord) =>
    trajectory.push({ messages: rec.messages, responseText: rec.responseText, latencyMs: rec.latencyMs, usage: rec.usage }),
  );
  const started = Date.now();
  try {
    const result = await withQuotaRetry('workflow-agent-decision', () => agentDecisionPhase(pipelineInput, shim));
    const decision = decisionSchema.safeParse({
      bias: result.bias,
      action: result.action,
      entryZone: result.entryZone,
      sl: result.sl,
      tp: result.tp,
      confidence: result.confidence,
      primarySignalSource: result.primarySignalSource,
      strategiesTriggered: result.strategiesTriggered,
      reasoning: result.reasoning,
    });
    return {
      decision: decision.success ? decision.data : null,
      rawText: trajectory[trajectory.length - 1]?.responseText ?? '',
      trajectory,
      // Latency of the successful LLM call, not retry/backoff wall-clock.
      latencyMs: trajectory[trajectory.length - 1]?.latencyMs ?? Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      decision: null,
      rawText: trajectory[trajectory.length - 1]?.responseText ?? '',
      trajectory,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const { system, runs, caseIds } = parseArgs();
  const cases = loadCases(caseIds);
  if (cases.length === 0) throw new Error(`No cases found in ${CASES_DIR} — run \`npm run eval:record\` first.`);

  const trajDir = join(RESULTS_DIR, 'trajectories', system);
  mkdirSync(trajDir, { recursive: true });
  const resultsFile = join(RESULTS_DIR, `${system}.results.jsonl`);
  if (existsSync(resultsFile)) rmSync(resultsFile);

  console.log(`[run] system=${system} model=${defaultModel} cases=${cases.length} runs=${runs}`);

  for (const evalCase of cases) {
    const { pipelineInput, scoringCtx } = await deriveContext(evalCase);

    for (let run = 1; run <= runs; run++) {
      const outcome =
        system === 'workflow'
          ? await runWorkflow(pipelineInput)
          : await runDirectPrompt(system === 'baseline' ? baselinePrompt(evalCase) : enrichedPrompt(evalCase, pipelineInput));
      const score = scoreDecision(outcome.decision, scoringCtx);

      const record = {
        system,
        model: defaultModel,
        caseId: evalCase.id,
        symbol: evalCase.symbol,
        synthetic: evalCase.synthetic ?? null,
        run,
        action: outcome.decision?.action ?? null,
        bias: outcome.decision?.bias ?? null,
        confidence: outcome.decision?.confidence ?? null,
        decision: outcome.decision,
        score,
        tradeBias: scoringCtx.topDownBias.tradeBias,
        currentPrice: scoringCtx.currentPrice,
        latencyMs: outcome.latencyMs,
        usage: outcome.trajectory.reduce(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (acc: any, t) => {
            if (t.usage?.inputTokens) acc.inputTokens += t.usage.inputTokens;
            if (t.usage?.outputTokens) acc.outputTokens += t.usage.outputTokens;
            if (t.usage?.totalTokens) acc.totalTokens += t.usage.totalTokens;
            return acc;
          },
          { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        ),
        error: outcome.error,
      };
      appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);

      const trajFile = join(trajDir, `${evalCase.id}.run${run}.json`);
      writeFileSync(
        trajFile,
        JSON.stringify(
          {
            system,
            model: defaultModel,
            caseId: evalCase.id,
            run,
            agent:
              system === 'baseline'
                ? 'baseline-agent (direct prompt, raw candles only)'
                : system === 'enriched'
                  ? 'baseline-agent (direct prompt + pipeline tool data, no constraint rules)'
                  : 'trading-agent via production pipeline',
            steps: outcome.trajectory,
            parsedDecision: outcome.decision,
            score,
            error: outcome.error,
          },
          null,
          1,
        ),
      );

      const status = score.pass ? 'PASS' : `FAIL(${score.violations})`;
      console.log(
        `[run] ${system} ${evalCase.id} run ${run}/${runs}: ${outcome.decision?.action ?? 'INVALID'} ${status} ${outcome.latencyMs}ms${outcome.error ? ` error=${outcome.error}` : ''}`,
      );
    }
  }

  console.log(`[run] done → ${resultsFile}`);
}

main().catch((err) => {
  console.error('[run] fatal:', err);
  process.exit(1);
});
