'use client'

import { useState } from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SignalChart } from '@/components/trade/SignalChart'
import { buildTradingViewUrl } from '@/lib/tradingview-url'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import {
  TrendingUp,
  TrendingDown,
  X,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Target,
  TriangleAlert,
  ArrowRight,
  CircleX,
  Copy,
  Check,
  LineChart,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenPosition = {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  exchangeName: string
  marketType?: string | null
  mode: string
  entryPrice: number | null
  currentPrice: number | null
  positionSize: number | null
  leverage?: number | null
  unrealizedPnlUsd: number | null
  unrealizedPnlPct: number | null
  unrealizedPnlPctLeveraged?: number | null
  stopLoss: number | null
  takeProfit: number | null
  entryAt: string | null
  timeframe?: string | null
}

type ActionStatus = 'idle' | 'confirming' | 'loading' | 'success' | 'error'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPrice(v: number | null): string {
  if (v === null) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

function fmtPnl(v: number | null): string {
  if (v === null) return '—'
  const sign = v >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(v).toFixed(2)}`
}

function fmtPct(v: number | null): string {
  if (v === null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function fmtSize(v: number | null, symbol: string): string {
  if (v === null) return '—'
  const base = symbol.replace('/USDT', '').replace('/USDC', '').replace('/USD', '')
  return `${v.toFixed(4)} ${base}`
}

function fmtNotional(size: number | null, price: number | null): string | null {
  if (size === null || price === null) return null
  return `${(size * price).toFixed(2)} USDT`
}

function fmtMargin(size: number | null, price: number | null, leverage: number | null | undefined): string | null {
  if (size === null || price === null) return null
  const lev = leverage && leverage > 0 ? leverage : 1
  return `${((size * price) / lev).toFixed(2)} USDT`
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  accent,
  children,
}: {
  title: string
  accent?: 'red' | 'amber' | 'blue' | 'none'
  children: React.ReactNode
}) {
  const border = {
    red: 'border-red-500/20',
    amber: 'border-amber-500/20',
    blue: 'border-blue-500/20',
    none: 'border-border',
  }[accent ?? 'none']

  const dot = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    blue: 'bg-blue-500',
    none: 'bg-muted-foreground',
  }[accent ?? 'none']

  return (
    <div className={cn('rounded-xl border bg-card p-4 space-y-3', border)}>
      <div className="flex items-center gap-2">
        <span className={cn('size-1.5 rounded-full shrink-0', dot)} />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</span>
      </div>
      {children}
    </div>
  )
}

function CopyablePrice({
  label,
  value,
  raw,
  color,
}: {
  label: string
  value: string
  raw: number | null
  color: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (raw === null) return
    try {
      await navigator.clipboard.writeText(String(raw))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard unavailable — ignore
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={raw === null}
      title={raw !== null ? 'Click to copy price' : undefined}
      className="group relative w-full bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-card"
    >
      <p className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
        {label}
        {raw !== null && (
          copied
            ? <Check className="size-3 text-green-500 shrink-0" />
            : <Copy className="size-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
        )}
      </p>
      <p className={cn('text-sm font-mono font-semibold tabular-nums', color)}>
        {copied ? 'Copied!' : value}
      </p>
    </button>
  )
}

function Feedback({ status, msg, onRetry }: { status: ActionStatus; msg: string; onRetry: () => void }) {
  if (status === 'success') {
    return (
      <div className="flex items-center gap-2 text-sm text-green-500 bg-green-500/10 rounded-lg px-3 py-2">
        <CheckCircle2 className="size-4 shrink-0" />
        <span>{msg}</span>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="flex-1">{msg}</span>
        </div>
        <Button size="sm" variant="outline" className="w-full h-11 md:h-8" onClick={onRetry}>Try again</Button>
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// PositionDrawer
// ---------------------------------------------------------------------------

export function PositionDrawer({
  position,
  open,
  onClose,
  onAction,
}: {
  position: OpenPosition | null
  open: boolean
  onClose: () => void
  onAction?: () => void
}) {
  const [showChart, setShowChart] = useState(false)

  const [closeStatus, setCloseStatus] = useState<ActionStatus>('idle')
  const [closeMsg, setCloseMsg] = useState('')

  const [partialPct, setPartialPct] = useState<number | null>(null)
  const [partialStatus, setPartialStatus] = useState<ActionStatus>('idle')
  const [partialMsg, setPartialMsg] = useState('')

  const [beStatus, setBeStatus] = useState<ActionStatus>('idle')
  const [beMsg, setBeMsg] = useState('')

  const [adjustSl, setAdjustSl] = useState('')
  const [adjustTp, setAdjustTp] = useState('')
  const [adjustStatus, setAdjustStatus] = useState<ActionStatus>('idle')
  const [adjustMsg, setAdjustMsg] = useState('')

  const reset = () => {
    setShowChart(false)
    setCloseStatus('idle'); setCloseMsg('')
    setPartialPct(null); setPartialStatus('idle'); setPartialMsg('')
    setBeStatus('idle'); setBeMsg('')
    setAdjustSl(''); setAdjustTp(''); setAdjustStatus('idle'); setAdjustMsg('')
  }

  const handleClose = () => { reset(); onClose() }

  if (!position) return null

  const isLong = position.direction === 'LONG'
  const pnlPos = position.unrealizedPnlUsd !== null && position.unrealizedPnlUsd >= 0
  const isClosed = closeStatus === 'success'
  const anyLoading = closeStatus === 'loading' || partialStatus === 'loading' || beStatus === 'loading' || adjustStatus === 'loading'

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const doClose = async () => {
    setCloseStatus('loading')
    try {
      const res = await fetch(`/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      })
      const data = await res.json() as { message?: string; error?: string }
      if (!res.ok) { setCloseMsg(data.error ?? 'Close failed'); setCloseStatus('error'); return }
      setCloseMsg(data.message ?? 'Position closed')
      setCloseStatus('success')
      onAction?.()
    } catch {
      setCloseMsg('Network error'); setCloseStatus('error')
    }
  }

  const doPartial = async (pct: number) => {
    setPartialPct(pct); setPartialStatus('loading')
    try {
      const res = await fetch(`/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'partial_close', pct }),
      })
      const data = await res.json() as { message?: string; error?: string }
      if (!res.ok) { setPartialMsg(data.error ?? 'Failed'); setPartialStatus('error'); return }
      setPartialMsg(data.message ?? `Closed ${pct}%`)
      setPartialStatus('success')
      onAction?.()
    } catch {
      setPartialMsg('Network error'); setPartialStatus('error')
    }
  }

  const doBreakeven = async () => {
    setBeStatus('loading')
    try {
      const res = await fetch(`/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'breakeven' }),
      })
      const data = await res.json() as { message?: string; error?: string }
      if (!res.ok) { setBeMsg(data.error ?? 'Failed'); setBeStatus('error'); return }
      setBeMsg(data.message ?? 'SL moved to breakeven')
      setBeStatus('success')
      onAction?.()
    } catch {
      setBeMsg('Network error'); setBeStatus('error')
    }
  }

  const doAdjust = async () => {
    const sl = adjustSl ? parseFloat(adjustSl) : undefined
    const tp = adjustTp ? parseFloat(adjustTp) : undefined
    if (!sl && !tp) { setAdjustMsg('Enter at least one value'); setAdjustStatus('error'); return }
    setAdjustStatus('loading')
    try {
      const res = await fetch(`/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'adjust', sl, tp }),
      })
      const data = await res.json() as { message?: string; error?: string }
      if (!res.ok) { setAdjustMsg(data.error ?? 'Failed'); setAdjustStatus('error'); return }
      setAdjustMsg('Levels saved')
      setAdjustStatus('success')
      setAdjustSl(''); setAdjustTp('')
      onAction?.()
    } catch {
      setAdjustMsg('Network error'); setAdjustStatus('error')
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <>
    <Sheet open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <SheetContent className="w-full sm:max-w-[400px] p-0 flex flex-col overflow-hidden">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-2 p-4 md:p-5 pb-4 border-b border-border">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isLong
                ? <TrendingUp className="size-4 text-green-500 shrink-0" />
                : <TrendingDown className="size-4 text-red-500 shrink-0" />
              }
              <span className="text-base font-bold truncate">{position.symbol}</span>
              <Badge
                variant={isLong ? 'default' : 'destructive'}
                className="text-xs px-1.5 py-0"
              >
                {position.direction}
              </Badge>
              <Badge variant="outline" className="text-xs px-1.5 py-0 text-muted-foreground">
                {position.mode.toUpperCase()}
              </Badge>
            </div>
            {position.entryAt && (
              <p className="text-xs text-muted-foreground pl-6">
                Opened {new Date(position.entryAt).toLocaleString([], {
                  month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </p>
            )}
          </div>
          <button
            onClick={handleClose}
            className="rounded-md p-3.5 md:p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* ── Chart toggle ───────────────────────────────────────────── */}
        <div className="px-4 md:px-5 pt-3 flex justify-end">
          <button
            type="button"
            onClick={() => setShowChart((v) => !v)}
            className="inline-flex items-center justify-center gap-1 rounded-md border px-3 py-2.5 md:px-2 md:py-1 min-h-11 md:min-h-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Show position on TradingView chart"
          >
            <LineChart className="size-3" />
            {showChart ? 'Hide Chart' : 'Show on Chart'}
          </button>
        </div>

        {/* ── P&L hero ───────────────────────────────────────────────── */}
        <div className={cn(
          'mx-4 md:mx-5 mt-4 rounded-xl p-4',
          pnlPos
            ? 'bg-green-500/10 border border-green-500/20'
            : 'bg-red-500/10 border border-red-500/20'
        )}>
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Unrealized P&L</p>
              <p className={cn(
                'text-2xl md:text-3xl font-bold tabular-nums leading-none truncate',
                pnlPos ? 'text-green-500' : 'text-red-500'
              )}>
                {fmtPnl(position.unrealizedPnlUsd)}
              </p>
            </div>
            <div className="text-right shrink-0">
              {/* ROI on margin (price move % × leverage) — the headline
                  percentage exchanges show on an open position. */}
              <p className={cn(
                'text-lg font-semibold tabular-nums',
                pnlPos ? 'text-green-500/80' : 'text-red-500/80'
              )}>
                {fmtPct(position.unrealizedPnlPctLeveraged ?? position.unrealizedPnlPct)}
              </p>
              {position.unrealizedPnlPctLeveraged != null && (
                <p className="text-[10px] text-muted-foreground tabular-nums">
                  {fmtPct(position.unrealizedPnlPct)} of notional
                  {position.leverage ? ` · ${position.leverage}x` : ''}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Price stats ────────────────────────────────────────────── */}
        <div className="mx-4 md:mx-5 mt-3 grid grid-cols-2 gap-px rounded-xl overflow-hidden border border-border bg-border">
          {[
            { label: 'Entry', value: `$${fmtPrice(position.entryPrice)}`, raw: position.entryPrice, color: '' },
            { label: 'Current', value: `$${fmtPrice(position.currentPrice)}`, raw: position.currentPrice, color: '' },
            { label: 'Stop Loss', value: position.stopLoss ? `$${fmtPrice(position.stopLoss)}` : '—', raw: position.stopLoss, color: 'text-red-400' },
            { label: 'Take Profit', value: position.takeProfit ? `$${fmtPrice(position.takeProfit)}` : '—', raw: position.takeProfit, color: 'text-green-400' },
          ].map(({ label, value, raw, color }) => (
            <CopyablePrice key={label} label={label} value={value} raw={raw} color={color} />
          ))}
        </div>
        <p className="mx-4 md:mx-5 mt-1.5 text-xs text-muted-foreground tabular-nums">
          Size: {fmtNotional(position.positionSize, position.currentPrice ?? position.entryPrice) ?? fmtSize(position.positionSize, position.symbol)}
          <span className="mx-1.5 text-border">·</span>
          {fmtSize(position.positionSize, position.symbol)}
          <span className="mx-1.5 text-border">·</span>
          {position.exchangeName.toUpperCase()}
        </p>
        {fmtMargin(position.positionSize, position.currentPrice ?? position.entryPrice, position.leverage) && (
          <p className="mx-4 md:mx-5 mt-0.5 text-xs text-muted-foreground tabular-nums">
            Margin: {fmtMargin(position.positionSize, position.currentPrice ?? position.entryPrice, position.leverage)}
            <span className="mx-1.5 text-border">·</span>
            {position.leverage && position.leverage > 0 ? position.leverage : 1}x leverage
          </p>
        )}

        {/* ── Actions ────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-4 md:px-5 py-4 space-y-3">

          {/* Closed banner — replaces all actions */}
          {isClosed && (
            <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-5 text-center space-y-1">
              <CheckCircle2 className="size-8 text-green-500 mx-auto" />
              <p className="text-sm font-semibold text-green-500">{closeMsg}</p>
              <p className="text-xs text-muted-foreground">Position has been closed</p>
            </div>
          )}

          {!isClosed && (
            <>
              {/* EXIT POSITION ─────────────────────────── */}
              <SectionCard title="Exit Position" accent="red">
                {/* Full close */}
                {closeStatus === 'idle' && (
                  <Button
                    variant="destructive"
                    className="w-full gap-2 h-11 md:h-9"
                    disabled={anyLoading}
                    onClick={() => setCloseStatus('confirming')}
                  >
                    <CircleX className="size-4" />
                    Close at Market
                  </Button>
                )}
                {closeStatus === 'confirming' && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-3">
                    <p className="text-sm text-center font-medium">Confirm market close?</p>
                    <p className="text-xs text-muted-foreground text-center">
                      This will close your entire position at the current market price.
                    </p>
                    <div className="flex flex-col md:flex-row gap-2">
                      <Button variant="outline" size="sm" className="flex-1 h-11 md:h-8" onClick={() => setCloseStatus('idle')}>
                        Cancel
                      </Button>
                      <Button variant="destructive" size="sm" className="flex-1 h-11 md:h-8" onClick={doClose}>
                        Confirm Close
                      </Button>
                    </div>
                  </div>
                )}
                {closeStatus === 'loading' && (
                  <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Closing position…
                  </div>
                )}
                {(closeStatus === 'error') && (
                  <Feedback status={closeStatus} msg={closeMsg} onRetry={() => setCloseStatus('idle')} />
                )}

                {/* Partial close */}
                <div className="pt-1">
                  <p className="text-xs text-muted-foreground mb-2">Partial close</p>
                  {partialStatus === 'idle' || partialStatus === 'loading' ? (
                    <div className="grid grid-cols-4 gap-1.5">
                      {[25, 50, 75, 100].map((pct) => (
                        <button
                          key={pct}
                          disabled={anyLoading}
                          onClick={() => doPartial(pct)}
                          className={cn(
                            'rounded-lg py-2 min-h-11 md:min-h-0 text-xs font-semibold transition-colors border',
                            'border-border bg-muted/50 hover:bg-muted hover:border-muted-foreground/30',
                            'disabled:opacity-40 disabled:cursor-not-allowed',
                          )}
                        >
                          {partialStatus === 'loading' && partialPct === pct
                            ? <Loader2 className="size-3 animate-spin mx-auto" />
                            : `${pct}%`
                          }
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Feedback status={partialStatus} msg={partialMsg} onRetry={() => setPartialStatus('idle')} />
                  )}
                </div>
              </SectionCard>

              {/* RISK MANAGEMENT ───────────────────────── */}
              <SectionCard title="Risk Management" accent="amber">
                {/* Breakeven */}
                {beStatus === 'idle' || beStatus === 'loading' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 h-11 md:h-8 border-amber-500/30 hover:border-amber-500/50 hover:bg-amber-500/5"
                    disabled={anyLoading || !position.entryPrice}
                    onClick={doBreakeven}
                  >
                    {beStatus === 'loading'
                      ? <><Loader2 className="size-4 animate-spin" />Setting breakeven…</>
                      : <>
                          <ShieldAlert className="size-4 text-amber-500" />
                          Move SL to breakeven
                          {position.entryPrice && (
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                              ${fmtPrice(position.entryPrice)}
                            </span>
                          )}
                        </>
                    }
                  </Button>
                ) : (
                  <Feedback status={beStatus} msg={beMsg} onRetry={() => setBeStatus('idle')} />
                )}

                {/* Adjust SL / TP */}
                <div className="space-y-2 pt-1">
                  <div className="relative">
                    <ShieldAlert className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-red-400 pointer-events-none" />
                    <Input
                      placeholder={position.stopLoss ? `SL — current $${fmtPrice(position.stopLoss)}` : 'New stop-loss price'}
                      value={adjustSl}
                      onChange={(e) => { setAdjustSl(e.target.value); setAdjustStatus('idle') }}
                      type="number"
                      className="pl-8 h-11 md:h-9 text-sm"
                    />
                  </div>
                  <div className="relative">
                    <Target className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-green-400 pointer-events-none" />
                    <Input
                      placeholder={position.takeProfit ? `TP — current $${fmtPrice(position.takeProfit)}` : 'New take-profit price'}
                      value={adjustTp}
                      onChange={(e) => { setAdjustTp(e.target.value); setAdjustStatus('idle') }}
                      type="number"
                      className="pl-8 h-11 md:h-9 text-sm"
                    />
                  </div>
                </div>

                {adjustStatus !== 'idle' && adjustStatus !== 'loading' && (
                  <Feedback status={adjustStatus} msg={adjustMsg} onRetry={() => setAdjustStatus('idle')} />
                )}

                <Button
                  size="sm"
                  className="w-full gap-2 h-11 md:h-8"
                  variant="outline"
                  disabled={anyLoading || (!adjustSl && !adjustTp)}
                  onClick={doAdjust}
                >
                  {adjustStatus === 'loading'
                    ? <><Loader2 className="size-4 animate-spin" />Saving…</>
                    : <><ArrowRight className="size-4" />Save Levels</>
                  }
                </Button>
              </SectionCard>
            </>
          )}
        </div>

      </SheetContent>
    </Sheet>

    {/* Chart modal — true fullscreen via raw Radix primitive */}
    <Dialog open={showChart} onOpenChange={setShowChart}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-background)',
            outline: 'none',
          }}
        >
          {/* Title bar */}
          <div className="shrink-0 flex items-center justify-between gap-2 px-3 md:px-4 py-2 border-b bg-background">
            <div className="flex items-center gap-2 text-sm font-semibold min-w-0">
              <span className="truncate">{position.symbol}</span>
              <Badge variant={isLong ? 'default' : 'destructive'} className="text-xs px-1.5 py-0 shrink-0">
                {position.direction}
              </Badge>
              <span className="hidden md:inline text-muted-foreground font-normal text-xs truncate">
                Entry ${fmtPrice(position.entryPrice)} · SL ${fmtPrice(position.stopLoss)} · TP ${fmtPrice(position.takeProfit)}
              </span>
            </div>
            <div className="flex items-center gap-1 md:gap-2 shrink-0">
              <a
                href={buildTradingViewUrl(position.symbol, position.exchangeName, position.marketType)}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in TradingView"
                className="inline-flex items-center justify-center gap-1.5 rounded-md border p-2.5 md:px-2.5 md:py-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 md:h-3 md:w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <span className="hidden md:inline">TradingView</span>
              </a>
              <button
                type="button"
                onClick={() => setShowChart(false)}
                className="rounded-md p-2.5 md:p-1.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Close chart"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          {/* Mobile-only price line, wraps below the title row */}
          <div className="md:hidden shrink-0 px-3 py-1.5 border-b bg-background text-xs text-muted-foreground truncate">
            Entry ${fmtPrice(position.entryPrice)} · SL ${fmtPrice(position.stopLoss)} · TP ${fmtPrice(position.takeProfit)}
          </div>
          {/* Chart fills remaining height */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <SignalChart
              symbol={position.symbol}
              timeframe={position.timeframe ?? '1h'}
              entry={position.entryPrice}
              stopLoss={position.stopLoss}
              takeProfit={position.takeProfit}
              direction={position.direction}
              exchange={position.exchangeName}
              marketType={position.marketType}
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
    </>
  )
}
