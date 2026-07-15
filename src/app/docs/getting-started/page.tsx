import Link from 'next/link';
import { PlugZap, SlidersHorizontal, BotMessageSquare, ArrowRight } from 'lucide-react';

export const metadata = {
  title: 'Getting Started — Trading Hub Docs',
};

const STEPS = [
  {
    n: '01',
    icon: PlugZap,
    title: 'Connect your exchange',
    body: (
      <>
        Go to{' '}
        <Link href="/profile/exchanges" className="text-emerald-400 hover:underline">
          Profile → Exchanges
        </Link>{' '}
        and paste your API key and secret for BingX, Binance, or Bybit. Keys are encrypted with AES-256-GCM and never stored in plaintext. We recommend creating a key with <strong>trading permissions only</strong> — no withdrawal rights needed.
      </>
    ),
  },
  {
    n: '02',
    icon: SlidersHorizontal,
    title: 'Configure your risk profile',
    body: (
      <>
        Visit{' '}
        <Link href="/profile/risk" className="text-emerald-400 hover:underline">
          Profile → Risk
        </Link>{' '}
        to set your strategy (Scalping, Day Trading, Swing Trading, or Position Trading), max position size, daily loss limit, and max drawdown. You can also describe your preferences in plain English and let the setup agent parse them into fields.
      </>
    ),
  },
  {
    n: '03',
    icon: BotMessageSquare,
    title: 'Let the AI agent run — or ask it directly',
    body: (
      <>
        Once configured, the agent runs the 9-step analysis pipeline automatically. Signals appear in{' '}
        <Link href="/signals" className="text-emerald-400 hover:underline">
          Signals
        </Link>
        . For on-demand analysis of any coin, open{' '}
        <Link href="/chat" className="text-emerald-400 hover:underline">
          AI Chat
        </Link>{' '}
        and ask in plain English — e.g. &quot;Analyse BTCUSDT on 4H and give me a trade setup.&quot;
      </>
    ),
  },
];

export default function GettingStartedPage() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-500 mb-2">Getting Started</p>
      <h1 className="text-3xl font-bold text-white mb-3">Up and running in minutes</h1>
      <p className="text-zinc-400 text-lg mb-12">
        Trading Hub is ready to analyze markets and generate signals within minutes of signing up. Follow these three steps.
      </p>

      <div className="space-y-10">
        {STEPS.map(({ n, icon: Icon, title, body }) => (
          <div key={n} className="flex gap-5">
            <div className="shrink-0 flex flex-col items-center">
              <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                <Icon className="h-5 w-5 text-emerald-400" />
              </div>
              <div className="flex-1 w-px bg-zinc-800 mt-3" />
            </div>
            <div className="pb-10">
              <p className="text-xs text-zinc-500 font-mono mb-1">{n}</p>
              <h2 className="text-lg font-semibold text-white mb-2">{title}</h2>
              <p className="text-zinc-400 leading-relaxed">{body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-xl bg-zinc-900/60 border border-zinc-800 p-6">
        <p className="text-sm text-zinc-400 mb-1">Tip — start with paper mode</p>
        <p className="text-white text-sm leading-relaxed">
          Paper Trading Mode runs the full AI pipeline on live market data without placing real orders. It&apos;s the safest way to validate the agent&apos;s performance before risking capital. You can switch modes at any time in your risk profile.
        </p>
      </div>

      <div className="mt-16 rounded-2xl bg-zinc-900/60 border border-zinc-800 p-8 text-center">
        <p className="text-2xl font-bold text-white mb-2">Ready to start?</p>
        <p className="text-zinc-400 mb-6">Paper trading is completely free — no credit card required.</p>
        <Link
          href="/sign-up"
          className="inline-flex items-center gap-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-8 py-3 transition-colors"
        >
          Create your account <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </article>
  );
}
