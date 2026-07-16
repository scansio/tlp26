'use client'

import { useState } from 'react'
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

const confidenceBadgeVariant = (c: string) => {
  if (c === 'HIGH') return 'default'
  if (c === 'LOW') return 'destructive'
  return 'secondary'
}

export function SignalCard({ output }: Props) {
  const [status, setStatus] = useState<'idle' | 'executing' | 'done' | 'dismissed' | 'error'>('idle')
  const [resultMsg, setResultMsg] = useState('')

  const rrRatio =
    output.entryPrice && output.sl && output.tp
      ? Math.abs(output.tp - output.entryPrice) / Math.abs(output.entryPrice - output.sl)
      : null

  const execute = async () => {
    setStatus('executing')
    try {
      const res = await fetch(`/api/trade-signals/${output.signalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResultMsg(data.error ?? 'Execution failed')
        setStatus('error')
        return
      }
      setResultMsg(data.message ?? `Filled at $${data.fillPrice?.toFixed(2)} (${data.mode})`)
      setStatus('done')
    } catch {
      setResultMsg('Network error — try again')
      setStatus('error')
    }
  }

  const dismiss = async () => {
    try {
      await fetch(`/api/trade-signals/${output.signalId}`, { method: 'DELETE' })
    } catch {
      // best-effort dismiss
    }
    setStatus('dismissed')
  }

  const isLong = output.direction === 'LONG'

  return (
    <Card className="mt-3 border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            {isLong ? (
              <TrendingUp className="size-4 text-green-500" />
            ) : (
              <TrendingDown className="size-4 text-red-500" />
            )}
            {output.direction} {output.symbol}
          </CardTitle>
          <Badge variant={confidenceBadgeVariant(output.confidence)}>
            {output.confidence} confidence
          </Badge>
        </div>
      </CardHeader>

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
        {rrRatio != null && (
          <div className="col-span-3 flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">R/R Ratio</span>
            <span className="font-mono font-medium">{rrRatio.toFixed(2)}:1</span>
          </div>
        )}
      </CardContent>

      <Separator />

      <CardFooter className="pt-3 pb-3 flex flex-col gap-2">
        {status === 'idle' && (
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

        {status === 'executing' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Placing order…
          </div>
        )}

        {status === 'done' && (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <CheckCircle2 className="size-4" />
            {resultMsg}
          </div>
        )}

        {status === 'dismissed' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <XCircle className="size-4" />
            Signal dismissed
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col gap-2 w-full">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <XCircle className="size-4" />
              {resultMsg}
            </div>
            <Button size="sm" variant="outline" onClick={() => setStatus('idle')}>
              Try again
            </Button>
          </div>
        )}

        {status !== 'dismissed' && (
          <div className="flex gap-2 w-full pt-1">
            <Link href="/signals" className="flex-1">
              <Button variant="ghost" size="sm" className="w-full text-xs gap-1.5">
                Go to Signal
                <ArrowRight className="size-3" />
              </Button>
            </Link>
            {status === 'done' && (
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
    </Card>
  )
}
