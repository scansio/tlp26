import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";

// ─── PLACEHOLDER DATA — replace with real metrics before launch ───────────────
const STATS = [
  { label: "Win Rate", value: "87.4%", note: "backtested 2022–2025" },
  { label: "Trades Analyzed", value: "124,500+", note: "paper + live combined" },
  { label: "Active Traders", value: "3,200+", note: "across all tiers" },
  { label: "Platform Uptime", value: "99.9%", note: "last 12 months" },
];

const FEATURES = [
  {
    icon: "◆",
    title: "SMC & Technical Analysis",
    desc: "Fair Value Gaps, Order Blocks, Break of Structure, and liquidity sweeps — the same edge pro traders use, fully automated.",
  },
  {
    icon: "◎",
    title: "Real-Time News Sentiment",
    desc: "CryptoPanic and CoinGecko feeds analyzed by AI to weight market-moving news before execution.",
  },
  {
    icon: "⬡",
    title: "On-Chain Intelligence",
    desc: "Funding rates, liquidation clusters, and whale netflow from Coinglass and Santiment — ingested live.",
  },
  {
    icon: "⊕",
    title: "Multi-Exchange Execution",
    desc: "BingX, Binance, or Bybit. API keys are AES-256-GCM encrypted. One click to switch exchanges.",
  },
  {
    icon: "◈",
    title: "Paper Trading Mode",
    desc: "Run the full AI pipeline on live market data with zero capital at risk. Validate before you commit real funds.",
  },
  {
    icon: "◐",
    title: "Risk Management Engine",
    desc: "Per-trade position sizing with fee and slippage modelling. Kill switch, daily loss limits, max drawdown rules.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Connect Your Exchange",
    desc: "Link BingX, Binance, or Bybit in under 2 minutes. Keys are encrypted and never stored in plaintext.",
  },
  {
    n: "02",
    title: "AI Analyzes the Market",
    desc: "9-step pipeline: OHLCV → indicators → SMC → patterns → order book → news + on-chain → decision.",
  },
  {
    n: "03",
    title: "Signals Execute Automatically",
    desc: "ENTER_LONG, ENTER_SHORT, or HOLD — with stop-loss, take-profit, and position size pre-calculated.",
  },
];

const TESTIMONIALS = [
  // TODO: replace with verified user testimonials
  {
    quote:
      "I've tried a dozen bots. This is the first one that explains WHY it's taking a trade. The on-chain + SMC combo is elite.",
    name: "Marcus T.",
    role: "Prop trader, 4 years",
    initials: "MT",
  },
  {
    quote:
      "Paper mode let me test for 6 weeks before going live. 34 trades, 29 winners. Went live last month and the results held.",
    name: "Priya S.",
    role: "Full-time crypto trader",
    initials: "PS",
  },
  {
    quote:
      "Setup took 8 minutes. The kill switch and daily loss limits are what sold me — finally a bot built for risk management first.",
    name: "Daniel K.",
    role: "Swing trader, 2 years",
    initials: "DK",
  },
];

const FAQS = [
  {
    q: "Are my API keys safe?",
    a: "All exchange API keys are encrypted using AES-256-GCM before storage. Keys are never logged or transmitted in plaintext. We recommend using API keys with trading permissions only — no withdrawal rights needed.",
  },
  {
    q: "What exchanges are supported?",
    a: "Currently BingX, Binance, and Bybit. We're expanding based on user demand.",
  },
  {
    q: "Can I test without real money?",
    a: "Yes. Paper Trading Mode runs the full AI pipeline on live market data without placing real orders. It's the recommended starting point for all new users.",
  },
  {
    q: "How does the AI decide to trade?",
    a: "The agent synthesizes 9 data sources: OHLCV candles, RSI/EMA/MACD/BB/ADX, SMC levels, chart patterns, L2 order book, crypto news sentiment, funding rates, liquidation clusters, and whale netflow. It cites only the data it has — never inventing price levels.",
  },
  {
    q: "Is this financial advice?",
    a: "No. Trading Hub is a tool, not a financial advisor. All signals are algorithmic and informational only. Crypto trading carries significant risk. Past performance does not guarantee future results.",
  },
  {
    q: "What does it cost?",
    a: "Paper trading is completely free — no credit card required. Live trading pricing is coming soon. Sign up now to lock in early-access rates.",
  },
];
// ──────────────────────────────────────────────────────────────────────────────

const SIGNAL_REASONS = [
  "BOS confirmed at $67,100 on 4H",
  "FVG filled on 1H — clean entry zone",
  "Funding rate: neutral (not overleveraged)",
  "CryptoPanic sentiment: bullish (score 0.74)",
  "Liquidation wall at $65,800 acting as support",
];

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white antialiased">
      {/* ── Nav ─────────────────────────────────────────────────────────────── */}
      <header className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 lg:px-12 py-4 border-b border-white/5 bg-black/80 backdrop-blur-md">
        <span className="text-base font-semibold tracking-tight">Trading Hub</span>
        <nav className="hidden md:flex items-center gap-6 text-sm text-zinc-400">
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#how-it-works" className="hover:text-white transition-colors">How it works</a>
          <a href="#testimonials" className="hover:text-white transition-colors">Testimonials</a>
          <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
        </nav>
        <div className="flex items-center gap-3">
          <SignedOut>
            <SignInButton>
              <button className="text-sm text-zinc-400 hover:text-white transition-colors px-4 py-1.5">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton>
              <button className="rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-sm px-5 py-2 transition-colors">
                Get started free
              </button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <Link
              href="/dashboard"
              className="rounded-full border border-zinc-700 px-4 py-1.5 text-sm hover:border-zinc-500 transition-colors"
            >
              Dashboard
            </Link>
            <UserButton />
          </SignedIn>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <section className="relative pt-32 pb-24 px-6 overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,_#ffffff08_1px,_transparent_1px),_linear-gradient(to_bottom,_#ffffff08_1px,_transparent_1px)] bg-[size:48px_48px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-emerald-500/8 rounded-full blur-3xl pointer-events-none" />

        <div className="relative max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <div className="flex flex-col items-start gap-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              AI Trading Agent — Now Live
            </div>

            <h1 className="text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
              Your AI trading{" "}
              <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
                edge
              </span>
              ,{" "}
              <br className="hidden lg:block" />
              on autopilot.
            </h1>

            <p className="text-lg text-zinc-400 max-w-md leading-relaxed">
              SMC analysis, on-chain signals, and real-time news — synthesized by AI and
              executed automatically on BingX, Binance, or Bybit.
            </p>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 pt-2">
              <SignedOut>
                <SignUpButton>
                  <button className="rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-8 py-3 text-base transition-colors">
                    Start trading free →
                  </button>
                </SignUpButton>
                <SignInButton>
                  <button className="text-sm text-zinc-400 hover:text-white underline underline-offset-4 transition-colors">
                    Already have an account?
                  </button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <Link
                  href="/dashboard"
                  className="rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-8 py-3 text-base transition-colors"
                >
                  Go to Dashboard →
                </Link>
              </SignedIn>
            </div>

            <p className="text-xs text-zinc-600">
              Paper mode included — no real funds required to get started.
            </p>
          </div>

          {/* Mock signal card */}
          <div className="hidden lg:block">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 backdrop-blur-sm p-6 font-mono text-sm shadow-2xl ring-1 ring-emerald-500/10">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-emerald-400 font-semibold text-xs uppercase tracking-wider">
                    Live Signal
                  </span>
                </div>
                <span className="text-xs text-zinc-500">BTC/USDT · 4H</span>
              </div>
              <div className="text-2xl font-bold text-emerald-400 mb-1">ENTER LONG</div>
              <div className="text-xs text-zinc-500 mb-5">Confidence: 89% · Generated just now</div>
              <div className="grid grid-cols-3 gap-3 mb-5">
                <div className="rounded-lg bg-zinc-800 p-3">
                  <div className="text-xs text-zinc-500 mb-1">Entry</div>
                  <div className="text-white font-semibold">$67,240</div>
                </div>
                <div className="rounded-lg bg-zinc-800 p-3">
                  <div className="text-xs text-zinc-500 mb-1">Take Profit</div>
                  <div className="text-emerald-400 font-semibold">$69,800</div>
                  <div className="text-xs text-zinc-500">+3.8%</div>
                </div>
                <div className="rounded-lg bg-zinc-800 p-3">
                  <div className="text-xs text-zinc-500 mb-1">Stop Loss</div>
                  <div className="text-red-400 font-semibold">$65,900</div>
                  <div className="text-xs text-zinc-500">−2.0%</div>
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
                  Signal reasoning
                </div>
                <div className="space-y-2">
                  {SIGNAL_REASONS.map((r) => (
                    <div key={r} className="flex items-start gap-2 text-xs text-zinc-400">
                      <span className="text-emerald-400 mt-0.5 shrink-0">✓</span>
                      {r}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Exchange trust bar ───────────────────────────────────────────────── */}
      <section className="border-y border-white/5 py-8 px-6">
        <div className="max-w-6xl mx-auto">
          <p className="text-center text-xs text-zinc-600 uppercase tracking-widest mb-6">
            Supported exchanges
          </p>
          <div className="flex items-center justify-center gap-12 flex-wrap">
            {["BingX", "Binance", "Bybit"].map((ex) => (
              <span
                key={ex}
                className="text-xl font-bold text-zinc-600 hover:text-zinc-400 transition-colors tracking-tight"
              >
                {ex}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stats ───────────────────────────────────────────────────────────── */}
      <section className="py-16 px-6">
        <div className="max-w-6xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-8">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-4xl font-bold text-white mb-1">{s.value}</div>
              <div className="text-sm font-medium text-zinc-300 mb-1">{s.label}</div>
              <div className="text-xs text-zinc-600">{s.note}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Problem / Solution ──────────────────────────────────────────────── */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl lg:text-4xl font-bold mb-6 leading-tight">
            Most traders lose not from bad instincts —{" "}
            <span className="text-zinc-500">but from missing data.</span>
          </h2>
          <p className="text-zinc-400 text-lg leading-relaxed">
            Manually tracking OHLCV candles, on-chain flows, news sentiment, SMC levels, and
            order book walls simultaneously is impossible. Trading Hub synthesizes all of it into
            a single, reasoned signal — in seconds.
          </p>
        </div>
      </section>

      {/* ── Features ────────────────────────────────────────────────────────── */}
      <section id="features" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl lg:text-4xl font-bold mb-4">
              Everything the market throws at you. Handled.
            </h2>
            <p className="text-zinc-400 text-lg max-w-xl mx-auto">
              9 data sources. One AI agent. Decisions in seconds.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 hover:border-zinc-700 transition-colors"
              >
                <div className="text-2xl mb-4 text-emerald-400">{f.icon}</div>
                <h3 className="font-semibold text-white mb-2">{f.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl lg:text-4xl font-bold mb-4">Up and running in minutes.</h2>
            <p className="text-zinc-400 text-lg">No quant background required.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-12">
            {STEPS.map((s, i) => (
              <div key={s.n} className="relative">
                {i < STEPS.length - 1 && (
                  <div className="hidden md:block absolute top-8 left-full w-full h-px bg-gradient-to-r from-zinc-700 to-transparent" />
                )}
                <div className="text-5xl font-black text-zinc-800 mb-4">{s.n}</div>
                <h3 className="text-xl font-semibold text-white mb-3">{s.title}</h3>
                <p className="text-zinc-400 text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Testimonials ────────────────────────────────────────────────────── */}
      <section id="testimonials" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl lg:text-4xl font-bold mb-4">Traders who made the switch.</h2>
            <p className="text-zinc-400 text-lg">Real results from real users.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            {TESTIMONIALS.map((t) => (
              <div
                key={t.name}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 flex flex-col"
              >
                <div className="text-emerald-400 text-3xl mb-4 leading-none">&ldquo;</div>
                <p className="text-zinc-300 text-sm leading-relaxed mb-6 flex-1">{t.quote}</p>
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-xs font-bold text-emerald-400 shrink-0">
                    {t.initials}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">{t.name}</div>
                    <div className="text-xs text-zinc-500">{t.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA banner ──────────────────────────────────────────────────────── */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <div className="rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-zinc-900 to-black p-12 text-center">
            <h2 className="text-4xl lg:text-5xl font-bold mb-4">Start for free today.</h2>
            <p className="text-zinc-400 text-lg mb-8 max-w-md mx-auto">
              Paper trading mode is free — no credit card, no risk. Connect an exchange when
              you&apos;re ready to go live.
            </p>
            <SignedOut>
              <SignUpButton>
                <button className="rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-10 py-4 text-lg transition-colors">
                  Create your free account →
                </button>
              </SignUpButton>
            </SignedOut>
            <SignedIn>
              <Link
                href="/dashboard"
                className="inline-block rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-10 py-4 text-lg transition-colors"
              >
                Go to Dashboard →
              </Link>
            </SignedIn>
          </div>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────────────────────────── */}
      <section id="faq" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl lg:text-4xl font-bold mb-4">Common questions.</h2>
          </div>
          <div className="divide-y divide-zinc-800">
            {FAQS.map((faq) => (
              <details key={faq.q} className="group py-5">
                <summary className="flex items-center justify-between cursor-pointer list-none text-white font-medium hover:text-zinc-300 transition-colors">
                  {faq.q}
                  <span className="ml-4 text-zinc-500 group-open:rotate-45 transition-transform text-xl leading-none shrink-0">
                    +
                  </span>
                </summary>
                <p className="mt-4 text-zinc-400 text-sm leading-relaxed">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/5 py-12 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8 mb-8">
            <div>
              <span className="text-base font-semibold">Trading Hub</span>
              <p className="text-xs text-zinc-600 mt-1 max-w-xs">
                AI-powered crypto trading signals and automated execution.
              </p>
            </div>
            <nav className="flex flex-wrap gap-6 text-sm text-zinc-500">
              <a href="#features" className="hover:text-zinc-300 transition-colors">Features</a>
              <a href="#how-it-works" className="hover:text-zinc-300 transition-colors">How it works</a>
              <a href="#faq" className="hover:text-zinc-300 transition-colors">FAQ</a>
              <SignedOut>
                <SignUpButton>
                  <button className="hover:text-zinc-300 transition-colors">Sign up</button>
                </SignUpButton>
              </SignedOut>
            </nav>
          </div>
          <div className="border-t border-white/5 pt-8">
            <p className="text-xs text-zinc-600 leading-relaxed max-w-3xl">
              <strong className="text-zinc-500">Risk disclaimer:</strong> Trading Hub is a
              software tool and does not constitute financial advice. Crypto and digital asset
              markets are highly volatile. Trading carries significant risk of capital loss. Past
              performance — including backtested or simulated results — does not guarantee future
              returns. Use Paper Trading Mode to evaluate signals before committing real capital.
            </p>
            <p className="text-xs text-zinc-700 mt-4">
              © {new Date().getFullYear()} Trading Hub. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
