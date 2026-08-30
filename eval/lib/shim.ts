/**
 * Minimal Mastra shim for the eval harness.
 *
 * The phase functions in src/lib/analysis/market-analysis.ts only ever call
 * `mastra.getTool(name)` and `mastra.getAgent(name)`. By satisfying that
 * two-method contract directly we can run the full analysis pipeline with
 * ZERO infrastructure: no PostgreSQL, no Clerk, no Next.js server — just an
 * LLM API key. This is what makes the evaluation reproducible from a clean
 * environment.
 *
 * The real production tools and the real production trading agent are
 * imported unchanged, so the evaluated pipeline is byte-for-byte the same
 * code that runs in the product.
 */

import { marketDataTool } from '@/mastra/tools/market-data-tool';
import { indicatorsTool } from '@/mastra/tools/indicators-tool';
import { smcTool } from '@/mastra/tools/smc-tool';
import { patternTool } from '@/mastra/tools/pattern-tool';
import { orderbookTool } from '@/mastra/tools/orderbook-tool';
import { newsTool } from '@/mastra/tools/news-tool';
import { onchainTool } from '@/mastra/tools/onchain-tool';
import { tradingAgent } from '@/mastra/agents/trading-agent';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tools: Record<string, any> = {
  marketDataTool,
  indicatorsTool,
  smcTool,
  patternTool,
  orderbookTool,
  newsTool,
  onchainTool,
};

export interface AgentCallRecord {
  /** Messages sent to the agent (the exact synthesis prompt). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any;
  /** Raw text the model returned. */
  responseText: string;
  /** Wall-clock latency of the generate() call in ms. */
  latencyMs: number;
  /** Token usage as reported by the provider, when available. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usage: any;
}

/**
 * Build a `{ getTool, getAgent }` shim. When `onAgentCall` is provided, every
 * tradingAgent.generate() call is recorded (prompt, response, latency, usage)
 * so eval runs double as agent trajectories.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createEvalMastra(onAgentCall?: (rec: AgentCallRecord) => void): any {
  return {
    getTool: (name: string) => tools[name],
    getAgent: (name: string) => {
      if (name !== 'tradingAgent') return undefined;
      if (!onAgentCall) return tradingAgent;
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generate: async (messages: any) => {
          const started = Date.now();
          const res = await tradingAgent.generate(messages);
          onAgentCall({
            messages,
            responseText: typeof res.text === 'string' ? res.text : JSON.stringify(res.text ?? ''),
            latencyMs: Date.now() - started,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            usage: (res as any).usage ?? null,
          });
          return res;
        },
      };
    },
  };
}
