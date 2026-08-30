/**
 * Aggregate results from all evaluated systems into eval/results/REPORT.md.
 *
 * Systems (each optional — reported if its results file exists):
 *   baseline — one direct prompt, raw candles only
 *   enriched — direct prompt + pipeline tool data, no constraint rules
 *   workflow — full production pipeline (the solution)
 *
 * Usage:
 *   node ./node_modules/.bin/tsx eval/report.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_DIR = join(process.cwd(), 'eval', 'results');
const SYSTEMS = ['baseline', 'enriched', 'workflow'] as const;
type SystemName = (typeof SYSTEMS)[number];

interface ResultRecord {
  system: SystemName;
  model: string;
  caseId: string;
  symbol: string;
  synthetic: { derivedFrom: string; mutation: string } | null;
  run: number;
  action: string | null;
  confidence: string | null;
  score: { checks: { name: string; pass: boolean; detail: string }[]; violations: number; pass: boolean; actionable: boolean };
  tradeBias: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  error: string | null;
}

function load(system: SystemName): ResultRecord[] {
  const file = join(RESULTS_DIR, `${system}.results.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ResultRecord);
}

const CHECK_NAMES = [
  'schema_valid',
  'hold_nulls',
  'entry_complete',
  'levels_ordered',
  'rr_ok',
  'grounded',
  'htf_aligned',
  'entry_near_market',
];

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

function summarize(records: ResultRecord[]) {
  const n = records.length;
  const safe = records.filter((r) => r.score.pass).length;
  const actionable = records.filter((r) => r.score.actionable).length;
  const safeActionable = records.filter((r) => r.score.pass && r.score.actionable).length;
  const invalid = records.filter((r) => r.action === null).length;
  const checkFails: Record<string, number> = {};
  for (const name of CHECK_NAMES) {
    checkFails[name] = records.filter((r) => r.score.checks.some((c) => c.name === name && !c.pass)).length;
  }
  const meanLatency = n ? Math.round(records.reduce((a, r) => a + r.latencyMs, 0) / n) : 0;
  const meanTokens = n ? Math.round(records.reduce((a, r) => a + (r.usage?.totalTokens ?? 0), 0) / n) : 0;
  const actions: Record<string, number> = {};
  for (const r of records) {
    const a = r.action ?? 'INVALID';
    actions[a] = (actions[a] ?? 0) + 1;
  }
  return { n, safe, actionable, safeActionable, invalid, checkFails, meanLatency, meanTokens, actions };
}

/** Per-case action consistency across repeated runs. */
function consistency(records: ResultRecord[]): string {
  const byCase = new Map<string, Set<string>>();
  for (const r of records) {
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, new Set());
    byCase.get(r.caseId)!.add(r.action ?? 'INVALID');
  }
  const stable = [...byCase.values()].filter((s) => s.size === 1).length;
  return `${stable}/${byCase.size} cases produced the same action on every repeat run`;
}

function main(): void {
  const data = new Map<SystemName, ResultRecord[]>();
  for (const s of SYSTEMS) {
    const recs = load(s);
    if (recs.length > 0) data.set(s, recs);
  }
  if (data.size === 0) {
    throw new Error('No results found — run `npm run eval:baseline` / `eval:solution` first.');
  }
  const present = [...data.keys()];
  const all = present.flatMap((s) => data.get(s)!);
  const sums = new Map(present.map((s) => [s, summarize(data.get(s)!)]));
  const model = all[0].model;
  const caseCount = new Set(all.map((r) => r.caseId)).size;

  const lines: string[] = [];
  lines.push('# Evaluation Report — direct prompts vs agentic workflow');
  lines.push('');
  lines.push(`- **Model (all systems):** \`${model}\``);
  lines.push(`- **Cases:** ${caseCount} frozen fixtures in \`eval/cases/\` (incl. 1 synthetic conflict challenge)`);
  lines.push(`- **Runs per system:** ${present.map((s) => `${s} ${sums.get(s)!.n}`).join(', ')} (case × repeat)`);
  lines.push('- **Scoring:** 8 deterministic checks per decision — see `eval/lib/score.ts`');
  lines.push('');
  lines.push('## Headline comparison');
  lines.push('');
  lines.push(`| Metric | ${present.join(' | ')} |`);
  lines.push(`|---|${present.map(() => '---').join('|')}|`);
  const row = (label: string, f: (s: ReturnType<typeof summarize>) => string) =>
    lines.push(`| ${label} | ${present.map((s) => f(sums.get(s)!)).join(' | ')} |`);
  row('**Safe-decision rate (all 8 checks pass)**', (s) => pct(s.safe, s.n));
  row('Safe AND actionable (tradeable signals)', (s) => `${s.safeActionable}/${s.n}`);
  row('Invalid/unparseable outputs', (s) => pct(s.invalid, s.n));
  row('Actionable signals (ENTER_*)', (s) => `${s.actionable}/${s.n}`);
  row('Mean latency per decision', (s) => `${s.meanLatency} ms`);
  row('Mean LLM tokens per decision', (s) => `${s.meanTokens}`);
  lines.push('');
  lines.push('## Failures by check');
  lines.push('');
  lines.push(`| Check | ${present.map((s) => `${s} failures`).join(' | ')} |`);
  lines.push(`|---|${present.map(() => '---').join('|')}|`);
  for (const name of CHECK_NAMES) {
    lines.push(`| \`${name}\` | ${present.map((s) => `${sums.get(s)!.checkFails[name]}/${sums.get(s)!.n}`).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Action distribution');
  lines.push('');
  for (const s of present) lines.push(`- ${s}: ${JSON.stringify(sums.get(s)!.actions)}`);
  lines.push('');
  lines.push('## Run-to-run consistency');
  lines.push('');
  for (const s of present) lines.push(`- ${s}: ${consistency(data.get(s)!)}`);
  lines.push('');
  lines.push('## Per-case detail');
  lines.push('');
  lines.push(`| Case | HTF trade bias | ${present.map((s) => `${s} action(s) / violations`).join(' | ')} |`);
  lines.push(`|---|---|${present.map(() => '---').join('|')}|`);
  const caseIds = [...new Set(all.map((r) => r.caseId))].sort();
  for (const caseId of caseIds) {
    const perSystem = present.map((s) => data.get(s)!.filter((r) => r.caseId === caseId));
    const anyRec = perSystem.flat()[0];
    const bias = anyRec?.tradeBias ?? '?';
    const syn = anyRec?.synthetic ? ' *(synthetic)*' : '';
    const cell = (recs: ResultRecord[]) => {
      if (recs.length === 0) return '—';
      const actions = [...new Set(recs.map((r) => r.action ?? 'INVALID'))].join(', ');
      const names = new Set<string>();
      for (const r of recs) for (const c of r.score.checks) if (!c.pass) names.add(c.name);
      return `${actions} / ${names.size ? [...names].join(', ') : 'none'}`;
    };
    lines.push(`| ${caseId}${syn} | ${bias} | ${perSystem.map(cell).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Notable failure details');
  lines.push('');
  const failures = all.filter((r) => !r.score.pass);
  if (failures.length === 0) lines.push('- none');
  for (const r of failures) {
    const fails = r.score.checks.filter((c) => !c.pass).map((c) => `\`${c.name}\`: ${c.detail}`);
    lines.push(`- **${r.system} / ${r.caseId} / run ${r.run}** (${r.action ?? 'INVALID'}): ${fails.join('; ')}`);
  }
  lines.push('');

  const out = join(RESULTS_DIR, 'REPORT.md');
  writeFileSync(out, lines.join('\n'));
  console.log(`[report] written → ${out}`);
  for (const s of present) {
    const sum = sums.get(s)!;
    console.log(`[report] ${s}: safe-decision rate ${pct(sum.safe, sum.n)} (${sum.safe}/${sum.n})`);
  }
}

main();
