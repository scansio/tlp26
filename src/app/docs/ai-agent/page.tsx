import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export const metadata = {
  title: 'AI Agent — Trading Hub Docs',
};

const PIPELINE_STEPS = [
  { n: 1, label: 'Market Data', detail: 'OHLCV candles (up to 500 bars) via CCXT for any pair and timeframe.' },
  { n: 2, label: 'Indicators', detail: 'RSI, EMA (9/21/50/200), MACD, Bollinger Bands, ADX — computed from the raw candle data.' },
  { n: 3, label: 'SMC Analysis', detail: 'Fair Value Gaps, Order Blocks, Break of Structure, Change of Character, and liquidity sweep detection.' },
  { n: 4, label: 'Chart Patterns', detail: 'Head & Shoulders, double tops/bottoms, triangles, flags, wedges — classical price action patterns.' },
  { n: 5, label: 'Order Book (L2)', detail: 'Real-time bid/ask imbalance and liquidity walls from the exchange order book.' },
  { n: 6, label: 'News Sentiment', detail: 'CryptoPanic + CoinGecko headlines scored for bullish/bearish sentiment weighted by recency.' },
  { n: 7, label: 'On-Chain Data', detail: 'Funding rates, open interest, liquidation clusters (Coinglass) and whale netflow (Santiment) — run in parallel with news.' },
  { n: 8, label: 'Decision', detail: 'The agent synthesizes all tool outputs and returns ENTER_LONG, ENTER_SHORT, or HOLD — with full reasoning.' },
  { n: 9, label: 'Risk Sizing', detail: 'Position size calculated from account balance, risk %, entry, and stop-loss, with fees and slippage modelled in.' },
];

const TOOLS = [
  {
    title: 'Market data + indicators',
    body: 'The agent always starts with raw price data — OHLCV candles sourced from CCXT (the same library used to execute orders). Indicators run on top of those candles. A minimum of 200 candles is fetched to ensure EMA-200 and ADX have enough history to be statistically valid.',
  },
  {
    title: 'SMC & chart patterns',
    body: 'Smart Money Concepts are structural signals — areas where large institutions likely accumulated or distributed. The SMC tool identifies key levels (Order Blocks, FVGs, sweep zones) and saves them to the database so they persist across analysis runs. The pattern tool layers classical formations on top.',
  },
  {
    title: 'Order book depth',
    body: 'L2 order book data reveals real-time buy and sell pressure. Large clusters of limit orders act as support or resistance walls. The agent uses this to confirm or invalidate levels found in SMC analysis.',
  },
  {
    title: 'News & on-chain',
    body: 'News sentiment and on-chain data are fetched in parallel to reduce latency. Elevated funding rates suggest an overleveraged market ripe for a squeeze. Liquidation clusters reveal where stop hunts are likely. Whale netflow signals capital moving into or out of an asset.',
  },
  {
    title: 'Honesty constraint',
    body: 'The agent is explicitly instructed to cite only data returned by its tools — it cannot invent price levels, funding rates, or sentiment scores. If a data source is unavailable, the agent notes this rather than fabricating a value.',
  },
];

export default function AiAgentPage() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-500 mb-2">AI Agent</p>
      <h1 className="text-3xl font-bold text-white mb-3">How the agent thinks</h1>
      <p className="text-zinc-400 text-lg mb-12">
        Every trade signal goes through a 9-step analysis pipeline before a decision is made. Here&apos;s exactly what happens — and why.
      </p>

      {/* Pipeline diagram */}
      <div className="mb-14">
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span className="w-1 h-5 rounded-full bg-emerald-500 inline-block" />
          The 9-step pipeline
        </h2>
        <div className="relative pl-6 border-l border-zinc-800 space-y-0">
          {PIPELINE_STEPS.map(({ n, label, detail }, i) => (
            <div key={n} className="relative pb-6 last:pb-0">
              <div className="absolute -left-[25px] w-6 h-6 rounded-full bg-zinc-900 border border-zinc-700 flex items-center justify-center">
                <span className="text-[10px] font-mono text-zinc-400">{n}</span>
              </div>
              <div className={`ml-4 rounded-lg border px-4 py-3 ${i === 5 || i === 6 ? 'border-emerald-800/50 bg-emerald-950/30' : 'border-zinc-800 bg-zinc-900/30'}`}>
                <p className="text-sm font-medium text-white mb-0.5">{label}</p>
                <p className="text-xs text-zinc-400">{detail}</p>
                {i === 5 && (
                  <span className="inline-block mt-1.5 text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">runs in parallel with step 7</span>
                )}
                {i === 6 && (
                  <span className="inline-block mt-1.5 text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">runs in parallel with step 6</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tool explanations */}
      <div className="mb-14">
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span className="w-1 h-5 rounded-full bg-emerald-500 inline-block" />
          What each tool contributes
        </h2>
        <div className="space-y-5">
          {TOOLS.map(({ title, body }) => (
            <div key={title} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
              <h3 className="text-sm font-semibold text-white mb-2">{title}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-zinc-900/60 border border-zinc-800 p-6 mb-16">
        <p className="text-sm text-zinc-400 mb-1">Output format</p>
        <p className="text-white text-sm leading-relaxed mb-3">
          Every decision returns one of three actions:
        </p>
        <div className="grid grid-cols-3 gap-3 text-center text-xs">
          <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/30 p-3">
            <p className="font-mono font-bold text-emerald-400">ENTER_LONG</p>
            <p className="text-zinc-400 mt-1">Bullish confluence — buy signal with TP/SL</p>
          </div>
          <div className="rounded-lg border border-red-800/50 bg-red-950/30 p-3">
            <p className="font-mono font-bold text-red-400">ENTER_SHORT</p>
            <p className="text-zinc-400 mt-1">Bearish confluence — sell signal with TP/SL</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-3">
            <p className="font-mono font-bold text-zinc-300">HOLD</p>
            <p className="text-zinc-400 mt-1">No clear edge — no trade placed</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-8 text-center">
        <p className="text-2xl font-bold text-white mb-2">See the agent in action</p>
        <p className="text-zinc-400 mb-6">Open AI Chat and ask it to analyse any coin — no setup needed to start.</p>
        <Link
          href="/sign-up"
          className="inline-flex items-center gap-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-8 py-3 transition-colors"
        >
          Try it free <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </article>
  );
}
