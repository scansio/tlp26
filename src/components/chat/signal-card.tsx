'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  TrendingUp,
  TrendingDown,
  Target,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowRight,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'

type SignalOutput = {
  signalId: string
  symbol: string
  direction: string
  entryPrice: number | null
  sl: number | null
  tp: number | null
  confidence: string
  status: string
  message: string
}

type Props = {
  output: SignalOutput
}

// Terminal DB statuses that trigger auto-collapse
const TERMINAL = new Set(['executed', 'cancelled', 'rejected', 'expired'])

const confidenceBadgeVariant = (c: string) => {
  if (c === 'HIGH') return 'default'
  if (c === 'LOW') return 'destructive'
  return 'secondary'
}

const DB_STATUS_LABEL: Record<string, string> = {
  executed: 'Executed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired',
  pending: 'Pending',
  approved: 'Approved',
}

export function SignalCard({ output }: Props) {
  const [localStatus, setLocalStatus] = useState<'idle' | 'executing' | 'done' | 'dismissed' | 'error'>('idle')
  const [resultMsg, setResultMsg] = useState('')
  const [dbStatus, setDbStatus] = useState<string>(output.status ?? 'pending')
  const [collapsed, setCollapsed] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isTerminal = TERMINAL.has(dbStatus)

  // Fetch live DB status and auto-collapse when terminal
  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/trade-signals/${output.signalId}`)
      if (!res.ok) return
      const data = await res.json() as { status: string }
      setDbStatus(data.status)
      if (TERMINAL.has(data.status)) {
        setCollapsed(true)
        if (pollingRef.current) {
          clearInterval(pollingRef.current)
          pollingRef.current = null
        }
      }
    } catch {
      // best-effort
    }
  }

  useEffect(() => {
    fetchStatus()
    // Only poll while non-terminal
    if (!TERMINAL.has(output.status)) {
      pollingRef.current = setInterval(fetchStatus, 5000)
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output.signalId])

  const execute = async () => {
    setLocalStatus('executing')
    try {
      const res = await fetch(`/api/trade-signals/${output.signalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResultMsg(data.error ?? 'Execution failed')
        setLocalStatus('error')
        return
      }
      setResultMsg(data.message ?? `Filled at $${data.fillPrice?.toFixed(2)} (${data.mode})`)
      setLocalStatus('done')
      setDbStatus('executed')
      setCollapsed(true)
    } catch {
      setResultMsg('Network error — try again')
      setLocalStatus('error')
    }
  }

  const dismiss = async () => {
    try {
      await fetch(`/api/trade-signals/${output.signalId}`, { method: 'DELETE' })
    } catch {
      // best-effort dismiss
    }
    setLocalStatus('dismissed')
    setDbStatus('cancelled')
    setCollapsed(true)
  }

  const isLong = output.direction === 'LONG'

  return (
    <Card className="mt-3 border-border bg-card overflow-hidden">
      {/* Collapsible header — always visible */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2 font-semibold">
          {collapsed
            ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
          {isLong
            ? <TrendingUp className="size-4 text-green-500" />
            : <TrendingDown className="size-4 text-red-500" />}
          {output.direction} {output.symbol}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={confidenceBadgeVariant(output.confidence)}>
            {output.confidence}
          </Badge>
          {isTerminal && (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              {DB_STATUS_LABEL[dbStatus] ?? dbStatus}
            </Badge>
          )}
        </div>
      </button>

      {!collapsed && (
        <>
          <Separator />

          <CardContent className="pt-3 pb-2 grid grid-cols-3 gap-3 text-sm">
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground text-xs">Entry</span>
              <span className="font-mono font-medium">
                {output.entryPrice != null ? `$${output.entryPrice.toLocaleString()}` : '—'}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground text-xs flex items-center gap-1">
                <ShieldAlert className="size-3" /> Stop Loss
              </span>
              <span className="font-mono font-medium text-red-400">
                {output.sl != null ? `$${output.sl.toLocaleString()}` : '—'}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground text-xs flex items-center gap-1">
                <Target className="size-3" /> Take Profit
              </span>
              <span className="font-mono font-medium text-green-400">
                {output.tp != null ? `$${output.tp.toLocaleString()}` : '—'}
              </span>
            </div>
            {output.entryPrice && output.sl && output.tp && (
              <div className="col-span-3 flex flex-col gap-0.5">
                <span className="text-muted-foreground text-xs">R/R Ratio</span>
                <span className="font-mono font-medium">
                  {(Math.abs(output.tp - output.entryPrice) / Math.abs(output.entryPrice - output.sl)).toFixed(2)}:1
                </span>
              </div>
            )}
          </CardContent>

          <Separator />

          <CardFooter className="pt-3 pb-3 flex flex-col gap-2">
            {!isTerminal && localStatus === 'idle' && (
              <div className="flex gap-2 w-full">
                <Button
                  className="flex-1"
                  size="sm"
                  variant={isLong ? 'default' : 'destructive'}
                  onClick={execute}
                >
                  {isLong ? 'Execute Long' : 'Execute Short'}
                </Button>
                <Button className="flex-1" size="sm" variant="outline" onClick={dismiss}>
                  Dismiss
                </Button>
              </div>
            )}

            {localStatus === 'executing' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Placing order…
              </div>
            )}

            {localStatus === 'done' && (
              <div className="flex items-center gap-2 text-sm text-green-400">
                <CheckCircle2 className="size-4" />
                {resultMsg}
              </div>
            )}

            {(localStatus === 'dismissed' || (isTerminal && localStatus === 'idle')) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <XCircle className="size-4" />
                {dbStatus === 'executed' ? 'Signal executed' : `Signal ${DB_STATUS_LABEL[dbStatus]?.toLowerCase() ?? dbStatus}`}
              </div>
            )}

            {localStatus === 'error' && (
              <div className="flex flex-col gap-2 w-full">
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <XCircle className="size-4" />
                  {resultMsg}
                </div>
                <Button size="sm" variant="outline" onClick={() => setLocalStatus('idle')}>
                  Try again
                </Button>
              </div>
            )}

            {localStatus !== 'dismissed' && !isTerminal && (
              <div className="flex gap-2 w-full pt-1">
                <Link href="/signals" className="flex-1">
                  <Button variant="ghost" size="sm" className="w-full text-xs gap-1.5">
                    Go to Signal
                    <ArrowRight className="size-3" />
                  </Button>
                </Link>
                {localStatus === 'done' && (
                  <Link href="/trade/history" className="flex-1">
                    <Button variant="outline" size="sm" className="w-full text-xs gap-1.5">
                      Go to Trade
                      <ArrowRight className="size-3" />
                    </Button>
                  </Link>
                )}
              </div>
            )}
          </CardFooter>
        </>
      )}
    </Card>
  )
}
