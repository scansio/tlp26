/**
 * Record a representative trajectory for the setup-agent (conversational risk
 * profile onboarding). This exercises the same code path as the product's
 * /api/setup route: the full mastra instance (Postgres-backed memory), a
 * RequestContext carrying the userId (so the save tool can't be spoofed), and
 * a per-user memory thread.
 *
 * Requires: Postgres running (docker compose up -d) + migrations applied,
 * plus the LLM key. Output: eval/results/trajectories/setup-agent/onboarding.json
 *
 * Usage:
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local \
 *     ./node_modules/.bin/tsx eval/record-setup-trajectory.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { mastra } from '@/mastra';

const USER_ID = 'demo-judge-user';
const THREAD_ID = `setup-${USER_ID}`;
const RESOURCE_ID = `setup-${USER_ID}`;

const TURNS = [
  'Hi! I want to trade using smart money concepts and chart patterns. Max 3 trades a day, risk 1% per trade, and stop me out if I lose 5% in a day. I want to approve every trade myself. Mostly 1h and 4h charts on BTC and ETH.',
  "1.5 sounds good, let's use that.",
  'Yes, save it.',
];

async function main(): Promise<void> {
  const agent = mastra.getAgent('setupAgent');
  const requestContext = new RequestContext<{ userId: string }>();
  requestContext.set('userId', USER_ID);

  const steps: { userMessage: string; responseText: string; latencyMs: number; toolCalls: unknown }[] = [];

  for (const userMessage of TURNS) {
    console.log(`\n[setup-trajectory] user: ${userMessage}`);
    const started = Date.now();
    const res = await agent.generate([{ role: 'user', content: userMessage }], {
      memory: { thread: THREAD_ID, resource: RESOURCE_ID },
      requestContext,
    });
    const responseText = typeof res.text === 'string' ? res.text : JSON.stringify(res.text ?? '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCalls = (res as any).toolCalls ?? (res as any).toolResults ?? null;
    steps.push({ userMessage, responseText, latencyMs: Date.now() - started, toolCalls });
    console.log(`[setup-trajectory] agent (${Date.now() - started}ms): ${responseText.slice(0, 300)}`);
  }

  const outDir = join(process.cwd(), 'eval', 'results', 'trajectories', 'setup-agent');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'onboarding.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        agent: 'setup-agent (conversational risk-profile onboarding)',
        note:
          'Recorded against the real mastra instance with Postgres-backed memory, same code path as /api/setup. ' +
          'userId travels via RequestContext, never via tool input. The final turn triggers the saveRiskProfile tool.',
        userId: USER_ID,
        threadId: THREAD_ID,
        steps,
      },
      null,
      1,
    ),
  );
  console.log(`\n[setup-trajectory] saved → ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[setup-trajectory] fatal:', err);
  process.exit(1);
});
