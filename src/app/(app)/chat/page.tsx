'use client'

import '@/app/globals.css'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { DefaultChatTransport, ToolUIPart } from 'ai'
import { useChat } from '@ai-sdk/react'

import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input'

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'

import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { TradingViewWidget } from '@/components/chat/tradingview-widget'
import { TV_INTERVAL_MAP } from '@/mastra/tools/chart-tool'
import { SignalCard } from '@/components/chat/signal-card'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Button } from '@/components/ui/button'
import { AlertCircle, MessageSquarePlus, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Session = { id: string; title: string; createdAt: string; updatedAt: string }

type ChartOutput = {
  tvSymbol: string; tvExchange: string; tvInterval: string; widgetType: 'tradingview'
}

type SignalOutput = {
  signalId: string; symbol: string; direction: string
  entryPrice: number | null; sl: number | null; tp: number | null
  confidence: string; status: string; message: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function friendlyError(err: Error | undefined): string {
  const msg = err?.message ?? ''
  if (/quota|billing|rate.?limit|429|too many/i.test(msg)) return 'API quota reached. Please wait a moment and retry.'
  if (/token|context.?length|too large|13[0-9]{3,}/i.test(msg)) return 'Response too large for the current model. Try a shorter question.'
  if (/network|fetch|ECONNREFUSED|timeout/i.test(msg)) return 'Network error. Check your connection and retry.'
  if (/api.?key|unauthorized|401|403/i.test(msg)) return 'AI service authentication failed. Check your API key.'
  return 'Something went wrong. Please retry.'
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function renderToolPart(part: ToolUIPart, key: string) {
  if ((part.type === 'tool-chartTool' || part.type === 'tool-chart-tool') && part.state === 'output-available' && part.output) {
    const out = part.output as ChartOutput
    if (out.widgetType === 'tradingview') {
      return <TradingViewWidget key={key} tvSymbol={out.tvSymbol} tvExchange={out.tvExchange} tvInterval={out.tvInterval} />
    }
  }
  if ((part.type === 'tool-createSignalTool' || part.type === 'tool-create-signal-tool') && part.state === 'output-available' && part.output) {
    return <SignalCard key={key} output={part.output as SignalOutput} />
  }
  const isError = part.state === 'output-error'
  return (
    <Tool key={key} defaultOpen={isError}>
      <ToolHeader type={part.type} state={part.state || 'output-available'} className="cursor-pointer" />
      <ToolContent>
        <ToolInput input={part.input || {}} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  )
}

// ---------------------------------------------------------------------------
// ChatInterface — remounts per session via key={threadId}
// ---------------------------------------------------------------------------

function ChatInterface({
  threadId,
  onTitleSet,
}: {
  threadId: string
  onTitleSet: (title: string) => void
}) {
  const [input, setInput] = useState('')
  const titleSetRef = useRef(false)

  // Static body is fine — this component remounts when threadId changes
  const transport = useRef(
    new DefaultChatTransport({ api: '/api/chat', body: { threadId } })
  )

  const { messages, setMessages, sendMessage, regenerate, error, status } = useChat({
    transport: transport.current,
  })

  useEffect(() => {
    fetch(`/api/chat?threadId=${encodeURIComponent(threadId)}`)
      .then(r => r.json())
      .then(data => setMessages(data))
      .catch(() => {/* no prior messages */})
  }, [threadId, setMessages])

  const handleSubmit = useCallback(async () => {
    if (!input.trim()) return

    // Auto-title on first message
    if (!titleSetRef.current && messages.length === 0) {
      titleSetRef.current = true
      const title = input.slice(0, 60)
      fetch(`/api/chat/sessions/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }).then(() => onTitleSet(title))
    }

    sendMessage({ text: input })
    setInput('')
  }, [input, messages.length, threadId, onTitleSet, sendMessage])

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden p-6">
      <Conversation className="h-full">
        <ConversationContent>
          {messages.map(message => {
            const parts = message.parts ?? []
            const hasChartTool = parts.some(
              p => (p.type === 'tool-chartTool' || p.type === 'tool-chart-tool') && (p as ToolUIPart).state === 'output-available'
            )
            let autoChartRendered = false

            return (
              <div key={message.id}>
                {parts.map((part, i) => {
                  const partKey = `${message.id}-${i}`
                  if (part.type === 'text') {
                    return (
                      <Message key={partKey} from={message.role}>
                        <MessageContent>
                          <MessageResponse>{part.text}</MessageResponse>
                        </MessageContent>
                      </Message>
                    )
                  }
                  if (part.type?.startsWith('tool-')) {
                    const toolPart = part as ToolUIPart
                    // Auto-render chart from first market-data-tool when chart-tool was skipped
                    if (!hasChartTool && !autoChartRendered &&
                        (toolPart.type === 'tool-marketDataTool' || toolPart.type === 'tool-market-data-tool') &&
                        toolPart.state === 'output-available') {
                      autoChartRendered = true
                      const inp = toolPart.input as { symbol?: string; exchange?: string; timeframe?: string } | undefined
                      if (inp?.symbol) {
                        return (
                          <Fragment key={partKey}>
                            {renderToolPart(toolPart, `${partKey}-t`)}
                            <TradingViewWidget
                              tvSymbol={inp.symbol.replace('/', '').toUpperCase()}
                              tvExchange={(inp.exchange ?? 'binance').toUpperCase()}
                              tvInterval={TV_INTERVAL_MAP[inp.timeframe ?? '1h'] ?? '60'}
                            />
                          </Fragment>
                        )
                      }
                    }
                    return renderToolPart(toolPart, partKey)
                  }
                  return null
                })}
              </div>
            )
          })}

          {(status === 'submitted' || status === 'streaming') && (
            <div className="flex items-center gap-2 px-1 py-2">
              <div className="flex gap-1">
                <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
              </div>
              {status === 'submitted' && <Shimmer className="text-xs">Analyzing markets…</Shimmer>}
            </div>
          )}

          {status === 'error' && (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-medium">Request failed</span>
                <span className="text-xs opacity-80">{friendlyError(error)}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => regenerate()}
              >
                <RefreshCw className="mr-1.5 size-3" />
                Retry
              </Button>
            </div>
          )}

          <ConversationScrollButton />
        </ConversationContent>
      </Conversation>

      <PromptInput onSubmit={handleSubmit} className="mt-20">
        <PromptInputBody>
          <PromptInputTextarea
            onChange={e => setInput(e.target.value)}
            className="md:leading-10"
            value={input}
            placeholder="Ask about any market, e.g. 'analyze BTC on 4h' or 'enter a long on ETH'"
            disabled={status !== 'ready' && status !== 'error'}
          />
        </PromptInputBody>
      </PromptInput>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session sidebar
// ---------------------------------------------------------------------------

function SessionSidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: Session[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string, e: React.MouseEvent) => void
}) {
  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border bg-muted/30">
      <div className="p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 text-xs"
          onClick={onNew}
        >
          <MessageSquarePlus className="size-3.5" />
          New Chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</p>
        )}
        {sessions.map(session => (
          <button
            key={session.id}
            onClick={() => onSelect(session.id)}
            className={cn(
              'group relative flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent',
              activeId === session.id && 'bg-accent'
            )}
          >
            <span className="truncate pr-5 font-medium leading-tight">
              {session.title || 'New Chat'}
            </span>
            <span className="text-muted-foreground">
              {formatDate(session.updatedAt || session.createdAt)}
            </span>
            <button
              onClick={e => onDelete(session.id, e)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            >
              <Trash2 className="size-3" />
            </button>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root Chat page
// ---------------------------------------------------------------------------

export default function Chat() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/chat/sessions')
      .then(r => r.json())
      .then((data: Session[]) => {
        setSessions(data)
        if (data.length > 0) setActiveThreadId(data[0].id)
      })
      .catch(() => {/* no sessions yet */})
  }, [])

  const handleNewChat = async () => {
    const res = await fetch('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) return
    const { id, title, createdAt } = await res.json()
    const session: Session = { id, title, createdAt, updatedAt: createdAt }
    setSessions(prev => [session, ...prev])
    setActiveThreadId(id)
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (activeThreadId === id) {
        setActiveThreadId(next.length > 0 ? next[0].id : null)
      }
      return next
    })
  }

  const handleTitleSet = (id: string, title: string) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s))
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <SessionSidebar
        sessions={sessions}
        activeId={activeThreadId}
        onSelect={setActiveThreadId}
        onNew={handleNewChat}
        onDelete={handleDelete}
      />

      {activeThreadId ? (
        <ChatInterface
          key={activeThreadId}
          threadId={activeThreadId}
          onTitleSet={title => handleTitleSet(activeThreadId, title)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <MessageSquarePlus className="size-8 opacity-40" />
          <p className="text-sm">Start a new chat to begin</p>
          <Button size="sm" onClick={handleNewChat}>New Chat</Button>
        </div>
      )}
    </div>
  )
}
