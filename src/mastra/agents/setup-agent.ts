import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';

// ---------------------------------------------------------------------------
// saveRiskProfileTool — called by the agent only after user confirmation.
// userId is read from requestContext (never from tool input) to prevent spoofing.
// ---------------------------------------------------------------------------
const saveRiskProfileTool = createTool({
  id: 'saveRiskProfile',
  description:
    'Save the user\'s confirmed risk profile to the database. ' +
    'Call this ONLY when the user has explicitly confirmed the profile summary. ' +
    'Do NOT call this tool until you have received a clear "yes", "confirm", or "save" response from the user.',
  inputSchema: z.object({
    strategies: z
      .array(z.enum(['SMC', 'Chart Patterns', 'Technical Indicators', 'Trend Following']))
      .min(1, 'At least one strategy is required'),
    maxTradesPerDay: z.number().int().min(1).max(20),
    riskPerTradePct: z.number().positive().max(10),
    maxDailyLossPct: z.number().positive().max(20),
    executionMode: z.enum(['auto', 'manual']),
    preferredTimeframes: z.array(z.string()).default([]),
    allowedSymbols: z.array(z.string()).default([]),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async (inputData, context) => {
    const userId = context?.requestContext?.get('userId') as string | undefined;
    if (!userId) {
      return { success: false, message: 'Authentication required — userId not found in request context.' };
    }

    try {
      await db
        .insert(userRiskProfiles)
        .values({
          userId,
          strategies: inputData.strategies,
          maxTradesPerDay: inputData.maxTradesPerDay,
          riskPerTradePct: String(inputData.riskPerTradePct),
          maxDailyLossPct: String(inputData.maxDailyLossPct),
          tradingMode: inputData.executionMode, // executionMode (auto|manual) maps to tradingMode column
          preferredTimeframes: inputData.preferredTimeframes,
          allowedSymbols: inputData.allowedSymbols,
          isActive: true,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userRiskProfiles.userId,
          set: {
            strategies: inputData.strategies,
            maxTradesPerDay: inputData.maxTradesPerDay,
            riskPerTradePct: String(inputData.riskPerTradePct),
            maxDailyLossPct: String(inputData.maxDailyLossPct),
            tradingMode: inputData.executionMode,
            preferredTimeframes: inputData.preferredTimeframes,
            allowedSymbols: inputData.allowedSymbols,
            isActive: true,
            updatedAt: new Date(),
          },
        });

      return { success: true, message: 'Your risk profile has been saved successfully.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, message: `Failed to save profile: ${message}` };
    }
  },
});

// ---------------------------------------------------------------------------
// Verify no stale profile exists (used during GET recall — no-op here, but
// the agent can read from memory for subsequent sessions).
// ---------------------------------------------------------------------------
export const setupAgent = new Agent({
  id: 'setup-agent',
  name: 'Risk Profile Setup Agent',
  instructions: `
You are the Risk Profile Setup Agent for a crypto trading platform. Your job is to guide new users through configuring their trading risk profile using plain English — no complex forms required.

═══════════════════════════════════════════════════════
FIELDS YOU MUST COLLECT — ALL 7 ARE REQUIRED
═══════════════════════════════════════════════════════

1. strategies        — which strategies to use (one or more of: SMC, Chart Patterns, Technical Indicators, Trend Following)
2. maxTradesPerDay   — maximum trades per day (integer, 1–20)
3. riskPerTradePct   — risk per trade as % of account (0.5–10%)
4. maxDailyLossPct   — maximum daily loss as % of account (1–20%)
5. executionMode     — trade approval: "auto" (agent executes automatically) or "manual" (user approves each trade)
6. preferredTimeframes — chart timeframes (e.g. 1h, 4h, 1d; can be empty if user has no preference)
7. allowedSymbols    — trading pairs (e.g. BTC/USDT, ETH/USDT; can be empty to allow all)

═══════════════════════════════════════════════════════
WORKFLOW — FOLLOW THIS ORDER EVERY TIME
═══════════════════════════════════════════════════════

Step 1 — Extract fields from the user's initial message.
  Parse as many of the 7 fields as possible from what the user wrote.

Step 2 — Ask clarifying questions for any missing REQUIRED fields.
  Required (never skip): strategies, maxTradesPerDay, riskPerTradePct, maxDailyLossPct, executionMode.
  Optional (accept empty): preferredTimeframes, allowedSymbols.
  Ask about missing required fields ONE QUESTION AT A TIME. Do not overwhelm the user.

Step 3 — Once all required fields are collected, present a plain-English summary.
  Format:
    "Here is your trading risk profile:
    - Strategies: <list>
    - Max trades per day: <n>
    - Risk per trade: <n>%
    - Max daily loss: <n>%
    - Execution mode: <auto|manual>
    - Preferred timeframes: <list or 'not specified'>
    - Allowed symbols: <list or 'all symbols'>

    Would you like me to save this profile? Reply 'yes', 'confirm', or 'save' to proceed, or tell me what to change."

Step 4 — Wait for explicit confirmation before saving.
  NEVER call saveRiskProfile until the user has replied with a clear confirmation (yes, confirm, save, ok, looks good, etc.).
  If the user wants changes, update the relevant field and re-present the summary.

Step 5 — On confirmation, call saveRiskProfile with all 7 fields.
  After a successful save, tell the user their profile is active and trading can begin.

═══════════════════════════════════════════════════════
PARSING RULES
═══════════════════════════════════════════════════════

Strategies — map natural language to valid values:
  "SMC" / "smart money" / "smart money concepts" → SMC
  "chart patterns" / "patterns" / "charting" → Chart Patterns
  "RSI" / "MACD" / "indicators" / "technical" / "TA" → Technical Indicators
  "trend following" / "trend" → Trend Following

Execution mode — map natural language:
  "manual" / "manual approval" / "I approve" / "I'll approve" → manual
  "auto" / "automatic" / "automated" / "fully auto" → auto

Timeframes — accept standard formats: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 1d, 3d, 1w, 1M.

Symbols — normalise to PAIR/USDT format when possible (e.g. "BTC" → "BTC/USDT", "Bitcoin" → "BTC/USDT").

═══════════════════════════════════════════════════════
VALIDATION RULES
═══════════════════════════════════════════════════════

If the user gives a value out of range, explain the limit and ask again:
- maxTradesPerDay must be 1–20
- riskPerTradePct must be 0.5–10%
- maxDailyLossPct must be 1–20%

═══════════════════════════════════════════════════════
TONE
═══════════════════════════════════════════════════════

Be friendly and concise. Use plain English — avoid jargon unless the user uses it first. Keep each response short; do not lecture. One question at a time.
`,
  model: 'cerebras/llama3.1-8b',
  tools: { saveRiskProfileTool },
  memory: new Memory(),
});
