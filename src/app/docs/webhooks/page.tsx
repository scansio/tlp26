import Link from 'next/link';
import { ArrowRight, RefreshCw, Lock, AlertTriangle } from 'lucide-react';

export const metadata = {
  title: 'TradingView Webhooks — Trading Hub Docs',
};

const PAYLOAD_EXAMPLE = `{
  "token": "your-webhook-token",
  "symbol": "BTCUSDT",
  "action": "BUY",
  "price": 67100,
  "sl": 65800,
  "tp": 69500
}`;

const PINE_EXAMPLE = `//@version=6
strategy("Trading Hub Signal", overlay=true)

longCondition = ta.crossover(ta.sma(close, 9), ta.sma(close, 21))
shortCondition = ta.crossunder(ta.sma(close, 9), ta.sma(close, 21))

if longCondition
    strategy.entry("Long", strategy.long)
    msg = '{"token":"YOUR_TOKEN","symbol":"' + syminfo.ticker + '","action":"BUY","price":' + str.tostring(close) + '}'
    alert(msg, alert.freq_once_per_bar_close)

if shortCondition
    strategy.entry("Short", strategy.short)
    msg = '{"token":"YOUR_TOKEN","symbol":"' + syminfo.ticker + '","action":"SELL","price":' + str.tostring(close) + '}'
    alert(msg, alert.freq_once_per_bar_close)`;

const FIELDS = [
  { field: 'token', type: 'string', required: true, desc: 'Your personal webhook token from Profile → Exchanges.' },
  { field: 'symbol', type: 'string', required: true, desc: 'Trading pair. Accepts BTCUSDT or BTC/USDT format — normalised internally.' },
  { field: 'action', type: '"BUY" | "SELL"', required: true, desc: 'Signal direction. BUY maps to LONG; SELL maps to SHORT.' },
  { field: 'price', type: 'number', required: false, desc: 'Entry price. If omitted, the signal is saved without a specific entry.' },
  { field: 'sl', type: 'number', required: false, desc: 'Stop-loss price.' },
  { field: 'tp', type: 'number', required: false, desc: 'Take-profit price.' },
];

export default function WebhooksPage() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-500 mb-2">TradingView</p>
      <h1 className="text-3xl font-bold text-white mb-3">Send signals from TradingView</h1>
      <p className="text-zinc-400 text-lg mb-12">
        Trading Hub accepts inbound webhooks from TradingView Pine Script alerts. Any strategy or indicator that fires an alert can route a signal directly into your account.
      </p>

      {/* Step 1 — Get your URL */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-500">01</span>
          Find your webhook URL and token
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Go to{' '}
          <Link href="/profile/exchanges" className="text-emerald-400 hover:underline">
            Profile → Exchanges
          </Link>{' '}
          and scroll to the <strong className="text-white">TradingView Webhook</strong> section. You&apos;ll see your unique webhook URL and token. Copy both — you&apos;ll need them in TradingView.
        </p>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-4 flex items-center gap-3 text-sm">
          <Lock className="h-4 w-4 text-zinc-500 shrink-0" />
          <p className="text-zinc-400">
            The <code className="text-emerald-400 text-xs">token</code> in the payload authenticates the request — treat it like a password. It is never sent in headers or query strings.
          </p>
        </div>
      </section>

      {/* Step 2 — Regenerate */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-500">02</span>
          Regenerating your token
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          If you suspect your token has been compromised, click <strong className="text-white">Regenerate</strong> in the Exchanges settings. The old token is immediately invalidated — any existing TradingView alerts using it will start returning 401 errors until you update them with the new token.
        </p>
        <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 px-5 py-4 flex items-center gap-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
          <p className="text-amber-200/70">
            After regenerating, update the <code className="text-xs">token</code> field in every TradingView alert that sends to this endpoint.
          </p>
        </div>
      </section>

      {/* Payload schema */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-500">03</span>
          Payload format
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-5">
          Send a <code className="text-emerald-400 text-xs">POST</code> request with a JSON body to your webhook URL. The <code className="text-emerald-400 text-xs">Content-Type</code> header must be <code className="text-emerald-400 text-xs">application/json</code>.
        </p>

        {/* Field reference */}
        <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 overflow-hidden mb-6">
          <div className="grid grid-cols-[120px_140px_70px_1fr] gap-3 px-4 py-2.5 bg-zinc-800/60 text-xs font-medium text-zinc-400">
            <span>Field</span>
            <span>Type</span>
            <span>Required</span>
            <span>Description</span>
          </div>
          {FIELDS.map(({ field, type, required, desc }) => (
            <div key={field} className="grid grid-cols-[120px_140px_70px_1fr] gap-3 px-4 py-3 bg-zinc-900/30 text-xs items-start">
              <code className="text-emerald-400">{field}</code>
              <code className="text-zinc-300">{type}</code>
              <span className={required ? 'text-white font-medium' : 'text-zinc-500'}>
                {required ? 'Yes' : 'No'}
              </span>
              <span className="text-zinc-400">{desc}</span>
            </div>
          ))}
        </div>

        {/* Example payload */}
        <p className="text-xs text-zinc-500 mb-2 font-mono uppercase tracking-widest">Example payload</p>
        <pre className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-5 py-4 text-xs text-zinc-300 leading-relaxed overflow-x-auto">
          <code>{PAYLOAD_EXAMPLE}</code>
        </pre>
      </section>

      {/* Pine Script example */}
      <section className="mb-16">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-500">04</span>
          TradingView Pine Script example
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-5">
          Add an alert to your Pine Script strategy using <code className="text-emerald-400 text-xs">alert()</code>. Paste the JSON payload as the alert message and set the webhook URL in TradingView&apos;s alert settings.
        </p>
        <pre className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-5 py-4 text-xs text-zinc-300 leading-relaxed overflow-x-auto">
          <code>{PINE_EXAMPLE}</code>
        </pre>
        <p className="text-xs text-zinc-500 mt-3">
          Replace <code className="text-emerald-400">YOUR_TOKEN</code> with the token from Profile → Exchanges.
        </p>
      </section>

      {/* Paper vs live note */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4 mb-16 text-sm text-zinc-400 leading-relaxed flex gap-3">
        <RefreshCw className="h-4 w-4 text-zinc-500 shrink-0 mt-0.5" />
        <p>
          Webhook signals respect your current trading mode. In <strong className="text-white">Paper Mode</strong>, the signal is logged and tracked but no real order is placed. Switch to <strong className="text-white">Live Mode</strong> in your risk profile when you&apos;re ready to execute.
        </p>
      </div>

      <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-8 text-center">
        <p className="text-2xl font-bold text-white mb-2">Connect TradingView in minutes</p>
        <p className="text-zinc-400 mb-6">Sign up, grab your webhook URL from the Exchanges page, and wire up your first alert.</p>
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
