'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

type Props = {
  tvSymbol: string   // e.g. "BTCUSDT"
  tvExchange: string // e.g. "BINANCE"
  tvInterval: string // TradingView interval: 1, 5, 15, 60, 240, D, W
  height?: number | string
}

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => void
    }
  }
}

export function TradingViewWidget({ tvSymbol, tvExchange, tvInterval, height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const reactId = useId()
  const idRef = useRef(`tv_${reactId.replace(/[^a-z0-9]/gi, '_')}`)
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    if (collapsed) return
    const containerId = idRef.current

    const init = () => {
      if (!window.TradingView || !containerRef.current) return
      containerRef.current.innerHTML = `<div id="${containerId}"></div>`
      new window.TradingView.widget({
        container_id: containerId,
        symbol: `${tvExchange}:${tvSymbol}`,
        interval: tvInterval,
        width: '100%',
        height,
        theme: 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: '#0f0f0f',
        enable_publishing: false,
        allow_symbol_change: true,
        save_image: false,
        hide_side_toolbar: false,
        withdateranges: true,
        hide_top_toolbar: false,
      })
    }

    if (window.TradingView) {
      init()
      return
    }

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/tv.js'
    script.async = true
    script.onload = init
    document.head.appendChild(script)

    return () => {
      if (!document.head.contains(script)) return
      script.remove()
    }
  }, [tvSymbol, tvExchange, tvInterval, height, collapsed])

  const isPercent = typeof height === 'string' && height.includes('%')
  const label = `${tvExchange}:${tvSymbol} · ${tvInterval}`

  return (
    <div className="w-full rounded-lg border border-border overflow-hidden my-2">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex w-full items-center gap-2 px-3 py-2 min-h-11 md:min-h-0 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        {collapsed
          ? <ChevronRight className="size-3.5 shrink-0" />
          : <ChevronDown className="size-3.5 shrink-0" />}
        <span className="font-medium">{label}</span>
      </button>
      {!collapsed && (
        <div
          ref={containerRef}
          className="w-full overflow-hidden"
          style={isPercent ? { height } : { minHeight: height }}
        />
      )}
    </div>
  )
}
