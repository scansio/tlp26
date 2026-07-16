'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Activity, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PositionDrawer, type OpenPosition } from '@/components/trade/position-drawer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(v: number | null): string {
  if (v === null) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })
}

function fmtPnl(v: number | null): string {
  if (v === null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}$${Math.abs(v).toFixed(2)}`
}

function fmtPct(v: number | null): string {
  if (v === null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const POLL_MS = 15_000

export default function OpenPositionsPage() {
  const [positions, setPositions] = useState<OpenPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<OpenPosition | null>(null)

  const fetchPositions = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      const res = await fetch('/api/positions')
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json() as { positions: OpenPosition[] }
      setPositions(data.positions)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load positions')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void fetchPositions()
    const id = setInterval(() => void fetchPositions(), POLL_MS)
    return () => clearInterval(id)
  }, [fetchPositions])

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Open Positions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Click a position to manage it
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void fetchPositions(true)}
          disabled={refreshing}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : positions.length === 0 ? (
        <Card>
          <CardContent className="p-16 text-center">
            <Activity className="size-8 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No open positions</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Executed trades will appear here
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  {['Symbol', 'Side', 'Entry', 'Current', 'P&L ($)', 'P&L (%)', 'SL', 'TP', 'Mode'].map((h) => (
                    <th
                      key={h}
                      className="py-3 px-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => {
                  const isLong = pos.direction === 'LONG'
                  const pnlPos = pos.unrealizedPnlUsd !== null && pos.unrealizedPnlUsd >= 0
                  return (
                    <tr
                      key={pos.id}
                      className="border-b last:border-0 hover:bg-accent/50 transition-colors cursor-pointer"
                      onClick={() => setSelected(pos)}
                    >
                      <td className="py-3 px-4 font-semibold">
                        <span className="flex items-center gap-1.5">
                          {isLong
                            ? <TrendingUp className="size-3.5 text-green-500" />
                            : <TrendingDown className="size-3.5 text-red-500" />
                          }
                          {pos.symbol}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant={isLong ? 'default' : 'destructive'} className="text-xs">
                          {pos.direction}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 tabular-nums text-muted-foreground">${fmt(pos.entryPrice)}</td>
                      <td className="py-3 px-4 tabular-nums">
                        {pos.currentPrice !== null ? `$${fmt(pos.currentPrice)}` : '—'}
                      </td>
                      <td className={cn('py-3 px-4 tabular-nums font-medium', pos.unrealizedPnlUsd === null ? 'text-muted-foreground' : pnlPos ? 'text-green-500' : 'text-red-500')}>
                        {fmtPnl(pos.unrealizedPnlUsd)}
                      </td>
                      <td className={cn('py-3 px-4 tabular-nums', pos.unrealizedPnlPct === null ? 'text-muted-foreground' : pnlPos ? 'text-green-500' : 'text-red-500')}>
                        {fmtPct(pos.unrealizedPnlPct)}
                      </td>
                      <td className="py-3 px-4 tabular-nums text-red-400 text-muted-foreground">
                        {pos.stopLoss ? `$${fmt(pos.stopLoss)}` : '—'}
                      </td>
                      <td className="py-3 px-4 tabular-nums text-green-400 text-muted-foreground">
                        {pos.takeProfit ? `$${fmt(pos.takeProfit)}` : '—'}
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant="outline" className="text-xs">{pos.mode.toUpperCase()}</Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <PositionDrawer
        position={selected}
        open={selected !== null}
        onClose={() => setSelected(null)}
        onAction={() => {
          void fetchPositions()
          setSelected(null)
        }}
      />
    </div>
  )
}
