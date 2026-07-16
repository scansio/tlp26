'use client'

import { useEffect, useId, useRef } from 'react'

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

  useEffect(() => {
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
  }, [tvSymbol, tvExchange, tvInterval, height])

  const isPercent = typeof height === 'string' && height.includes('%')

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden py-4"
      style={isPercent ? { height } : { minHeight: height }}
    />
  )
}
