'use client'

import '@/app/globals.css'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { DefaultChatTransport, FileUIPart, ToolUIPart } from 'ai'
import { useChat } from '@ai-sdk/react'

import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  PromptInputSubmit,
  PromptInputHeader,
  usePromptInputAttachments,
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
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
  AttachmentRemove,
} from '@/components/ai-elements/attachments'
import { Button } from '@/components/ui/button'
import { AlertCircle, MessageSquarePlus, Menu, RefreshCw, Trash2, X } from 'lucide-react'
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
    <div key={key} className="min-w-0 max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto">
      <Tool defaultOpen={isError}>
        <ToolHeader type={part.type} state={part.state || 'output-available'} className="cursor-pointer" />
        <ToolContent>
          <ToolInput input={part.input || {}} />
          <ToolOutput output={part.output} errorText={part.errorText} />
        </ToolContent>
      </Tool>
    </div>
  )
}

function renderFilePart(part: FileUIPart, key: string) {
  if (part.mediaType?.startsWith('image/')) {
    return (
      <img
        key={key}
        src={part.url}
        alt={part.filename ?? 'Image'}
        className="max-w-full sm:max-w-xs rounded-lg border border-border object-cover"
      />
    )
  }
  return (
    <Attachments key={key} variant="inline">
      <Attachment data={{ ...part, id: key }}>
        <AttachmentPreview />
        <AttachmentInfo />
      </Attachment>
    </Attachments>
  )
}

// ---------------------------------------------------------------------------
// AttachmentPreviewArea — renders pending attachments inside PromptInput
// ---------------------------------------------------------------------------

function AttachmentPreviewArea() {
  const { files, remove } = usePromptInputAttachments()
  if (files.length === 0) return null
  return (
    <Attachments variant="inline" className="flex-wrap px-3 pt-2">
      {files.map(f => (
        <Attachment key={f.id} data={f} onRemove={() => remove(f.id)}>
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  )
}

// ---------------------------------------------------------------------------
// ChatInterface — remounts per session via key={threadId}
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB

function ChatInterface({
  threadId,
  onTitleSet,
  onOpenSessions,
}: {
  threadId: string
  onTitleSet: (title: string) => void
  onOpenSessions?: () => void
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

  const handleSubmit = useCallback(async ({ text, files }: { text: string; files?: FileUIPart[] }) => {
    if (!text.trim() && (!files || files.length === 0)) return

    // Auto-title on first message
    if (!titleSetRef.current && messages.length === 0) {
      titleSetRef.current = true
      const title = text.slice(0, 60)
      fetch(`/api/chat/sessions/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }).then(() => onTitleSet(title))
    }

    sendMessage({ text, files })
    setInput('')
  }, [messages.length, threadId, onTitleSet, sendMessage])

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden p-2 sm:p-4 md:p-6">
      <div className="mb-2 flex items-center gap-2 md:hidden">
        <Button
          variant="outline"
          size="icon"
          className="h-11 w-11 shrink-0"
          onClick={onOpenSessions}
          aria-label="Open chat sessions"
        >
          <Menu className="size-4" />
        </Button>
      </div>
      <Conversation className="h-full min-w-0">
        <ConversationContent>
          {messages.map(message => {
            const parts = message.parts ?? []
            const hasChartTool = parts.some(
              p => (p.type === 'tool-chartTool' || p.type === 'tool-chart-tool') && (p as ToolUIPart).state === 'output-available'
            )
            let autoChartRendered = false

            // Group consecutive file parts from user messages so they render together
            const fileParts = message.role === 'user'
              ? parts.filter(p => p.type === 'file') as FileUIPart[]
              : []
            const filePartsRendered = new Set<number>()

            return (
              <div key={message.id}>
                {/* Render user-attached files above the text bubble */}
                {fileParts.length > 0 && (
                  <Message from={message.role}>
                    <MessageContent className="gap-1">
                      {fileParts.map((fp, fi) => {
                        const idx = parts.indexOf(fp)
                        filePartsRendered.add(idx)
                        return renderFilePart(fp, `${message.id}-file-${fi}`)
                      })}
                    </MessageContent>
                  </Message>
                )}

                {parts.map((part, i) => {
                  if (filePartsRendered.has(i)) return null
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
                      const inp = toolPart.input as { symbol?: string; exchange?: string; timeframe?: string; marketType?: string } | undefined
                      if (inp?.symbol) {
                        return (
                          <Fragment key={partKey}>
                            {renderToolPart(toolPart, `${partKey}-t`)}
                            <TradingViewWidget
                              tvSymbol={inp.symbol.replace('/', '').toUpperCase() + (inp.marketType === 'swap' ? '.P' : '')}
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
            <div className="flex flex-col items-stretch gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive sm:flex-row sm:items-start">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-medium">Request failed</span>
                  <span className="text-xs opacity-80">{friendlyError(error)}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-11 w-full shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 sm:h-8 sm:w-auto"
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

      <PromptInput
        onSubmit={handleSubmit}
        className="mt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:mt-20 md:pb-0"
        accept="image/*,text/*,application/pdf"
        multiple
        maxFileSize={MAX_FILE_SIZE}
        onError={e => console.warn('Attachment error:', e.message)}
      >
        <PromptInputHeader>
          <AttachmentPreviewArea />
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea
            onChange={e => setInput(e.target.value)}
            className="md:leading-10"
            value={input}
            placeholder="Ask about any market, e.g. 'analyze BTC on 4h' or 'enter a long on ETH'"
            disabled={status !== 'ready' && status !== 'error'}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger tooltip="Attach file" />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments label="Attach image or file" />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          <PromptInputSubmit
            status={status}
            disabled={status !== 'ready' && status !== 'error'}
          />
        </PromptInputFooter>
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
  className,
}: {
  sessions: Session[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string, e: React.MouseEvent) => void
  className?: string
}) {
  return (
    <div className={cn('flex w-full shrink-0 flex-col border-border bg-muted/30 md:w-56 md:border-r', className)}>
      <div className="p-3">
        <Button
          variant="outline"
          size="sm"
          className="h-11 w-full justify-start gap-2 text-xs md:h-8"
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
          <div
            key={session.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(session.id)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(session.id)
              }
            }}
            className={cn(
              'group relative flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2.5 text-left text-xs transition-colors hover:bg-accent md:py-2',
              activeId === session.id && 'bg-accent'
            )}
          >
            <span className="truncate pr-9 font-medium leading-tight md:pr-5">
              {session.title || 'New Chat'}
            </span>
            <span className="text-muted-foreground">
              {formatDate(session.updatedAt || session.createdAt)}
            </span>
            <button
              onClick={e => onDelete(session.id, e)}
              aria-label="Delete session"
              className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded opacity-100 transition-opacity hover:text-destructive md:size-6 md:opacity-0 md:group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
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
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false)

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
    setMobileSessionsOpen(false)
  }

  const handleSelectSession = (id: string) => {
    setActiveThreadId(id)
    setMobileSessionsOpen(false)
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
    <div className="relative flex h-full w-full overflow-hidden">
      <SessionSidebar
        className="hidden md:flex"
        sessions={sessions}
        activeId={activeThreadId}
        onSelect={setActiveThreadId}
        onNew={handleNewChat}
        onDelete={handleDelete}
      />

      {mobileSessionsOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button
            aria-label="Close sessions"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileSessionsOpen(false)}
          />
          <div className="relative flex h-full w-72 max-w-[80vw] flex-col bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border p-2">
              <span className="px-2 text-sm font-medium">Chats</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                onClick={() => setMobileSessionsOpen(false)}
                aria-label="Close sessions"
              >
                <X className="size-4" />
              </Button>
            </div>
            <SessionSidebar
              className="flex h-full w-full border-r-0"
              sessions={sessions}
              activeId={activeThreadId}
              onSelect={handleSelectSession}
              onNew={handleNewChat}
              onDelete={handleDelete}
            />
          </div>
        </div>
      )}

      {activeThreadId ? (
        <ChatInterface
          key={activeThreadId}
          threadId={activeThreadId}
          onTitleSet={title => handleTitleSet(activeThreadId, title)}
          onOpenSessions={() => setMobileSessionsOpen(true)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground">
          <MessageSquarePlus className="size-8 opacity-40" />
          <p className="text-sm">Start a new chat to begin</p>
          <Button size="sm" className="h-11 md:h-8" onClick={handleNewChat}>New Chat</Button>
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:hidden"
            onClick={() => setMobileSessionsOpen(true)}
          >
            View chat history
          </Button>
        </div>
      )}
    </div>
  )
}
