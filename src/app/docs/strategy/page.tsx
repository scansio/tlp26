import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export const metadata = {
  title: 'Strategy — Trading Hub Docs',
};

const SMC_CONCEPTS = [
  {
    term: 'Fair Value Gap (FVG)',
    definition: 'A three-candle pattern where the middle candle moves aggressively, leaving a price imbalance between the wicks of candles 1 and 3. Price frequently returns to fill this gap before continuing in the original direction. FVGs inside a bullish structure are potential long entries; FVGs inside a bearish structure are potential shorts.',
  },
  {
    term: 'Order Block (OB)',
    definition: 'The last bearish candle before a bullish impulse (bullish OB), or the last bullish candle before a bearish impulse (bearish OB). These represent zones where institutional accumulation or distribution occurred. The agent marks OBs as key entry or rejection zones.',
  },
  {
    term: 'Break of Structure (BOS)',
    definition: 'A BOS occurs when price closes beyond the most recent swing high (bullish BOS) or swing low (bearish BOS), continuing the prevailing trend. It confirms that the trend is intact. The agent uses BOS to stay aligned with the dominant market structure.',
  },
  {
    term: 'Change of Character (ChoCH)',
    definition: 'A ChoCH occurs when price breaks the opposite extreme to the current trend — a potential reversal signal. It does not confirm a trend change on its own, but it prompts the agent to look for confluence before acting against the prior trend.',
  },
  {
    term: 'Liquidity Sweep',
    definition: 'Smart money often drives price into clusters of stop-loss orders (equal highs/lows, previous swing points) before reversing. This is a sweep. When the agent detects a sweep of buy-side or sell-side liquidity followed by a reversal structure, it can flag a high-probability counter-move.',
  },
];

const INDICATORS = [
  {
    name: 'RSI (14)',
    role: 'Measures momentum. Readings above 70 are overbought; below 30 are oversold. The agent uses RSI divergence as a confirmation signal — not a standalone trigger.',
  },
  {
    name: 'EMA 9 / 21 / 50 / 200',
    role: 'Exponential Moving Averages show trend direction at different timeframes. The 200 EMA is treated as the long-term trend anchor. Cross of the 9 and 21 EMAs signals short-term momentum shifts.',
  },
  {
    name: 'MACD',
    role: 'Tracks the relationship between two EMAs to identify momentum shifts. Histogram above zero = bullish momentum; below = bearish. Signal line crosses are used as confluence, not entry triggers.',
  },
  {
    name: 'Bollinger Bands (20, 2σ)',
    role: 'Volatility envelope around a 20-period SMA. Price touching the outer bands in the direction of the trend can confirm continuation. Squeezes (narrow bands) often precede breakouts.',
  },
  {
    name: 'ADX (14)',
    role: 'Measures trend strength regardless of direction. ADX above 25 confirms a trending market where trend-following signals are more reliable. Below 20 suggests range conditions where mean-reversion is preferred.',
  },
];

export default function StrategyPage() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-500 mb-2">Strategy</p>
      <h1 className="text-3xl font-bold text-white mb-3">The edge behind the signals</h1>
      <p className="text-zinc-400 text-lg mb-4">
        Trading Hub&apos;s AI agent combines Smart Money Concepts (SMC) with classical technical indicators. Neither approach alone is sufficient — the agent looks for confluence between structural and momentum signals.
      </p>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4 mb-12 text-sm text-zinc-400 leading-relaxed">
        <strong className="text-white">Confluence first.</strong> The agent never enters on a single signal. A bullish FVG alone is not a trade. A bullish FVG at the level of a bullish Order Block, with RSI recovering from oversold, positive news sentiment, and a neutral-to-positive funding rate — that is a trade.
      </div>

      {/* SMC */}
      <div className="mb-14">
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span className="w-1 h-5 rounded-full bg-emerald-500 inline-block" />
          Smart Money Concepts
        </h2>
        <div className="space-y-5">
          {SMC_CONCEPTS.map(({ term, definition }) => (
            <div key={term} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
              <h3 className="text-sm font-semibold text-white mb-2">{term}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{definition}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Indicators */}
      <div className="mb-14">
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span className="w-1 h-5 rounded-full bg-emerald-500 inline-block" />
          Technical indicators
        </h2>
        <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 overflow-hidden">
          {INDICATORS.map(({ name, role }) => (
            <div key={name} className="px-5 py-4 bg-zinc-900/30">
              <p className="text-sm font-mono font-semibold text-emerald-400 mb-1">{name}</p>
              <p className="text-sm text-zinc-400 leading-relaxed">{role}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Risk */}
      <div className="mb-16">
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span className="w-1 h-5 rounded-full bg-emerald-500 inline-block" />
          Risk management
        </h2>
        <div className="space-y-4 text-sm text-zinc-400 leading-relaxed">
          <p>
            The agent never calculates a position size without a defined stop-loss. Every signal includes an entry, stop-loss, and take-profit level — the risk-to-reward ratio must be at least 1:1.5 for a trade to be routed.
          </p>
          <p>
            Position sizing uses the formula: <code className="text-emerald-400 bg-zinc-900 px-1.5 py-0.5 rounded text-xs">position_size = (account_balance × risk_%) / stop_distance</code>. Taker fees and slippage are subtracted from the expected P&amp;L before the trade is accepted.
          </p>
          <p>
            Circuit breakers run independently: the Kill Switch halts all new trades if your daily loss limit or max drawdown threshold is hit. These rules apply in both paper and live mode.
          </p>
        </div>
      </div>

      <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-8 text-center">
        <p className="text-2xl font-bold text-white mb-2">Validate before you risk capital</p>
        <p className="text-zinc-400 mb-6">Run the full SMC + indicator pipeline on live data in paper mode — free, no credit card.</p>
        <Link
          href="/sign-up"
          className="inline-flex items-center gap-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-8 py-3 transition-colors"
        >
          Start paper trading <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </article>
  );
}
