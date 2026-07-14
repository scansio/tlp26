'use client'

import '@/app/globals.css'
import { useEffect, useState } from 'react'
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
import { SignalCard } from '@/components/chat/signal-card'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Button } from '@/components/ui/button'
import { AlertCircle, RefreshCw } from 'lucide-react'

function friendlyError(err: Error | undefined): string {
  const msg = err?.message ?? ''
  if (/quota|billing|rate.?limit|429|too many/i.test(msg)) return 'API quota reached. Please wait a moment and retry.'
  if (/token|context.?length|too large|13[0-9]{3,}/i.test(msg)) return 'Response too large for the current model. Try a shorter question.'
  if (/network|fetch|ECONNREFUSED|timeout/i.test(msg)) return 'Network error. Check your connection and retry.'
  if (/api.?key|unauthorized|401|403/i.test(msg)) return 'AI service authentication failed. Check your API key.'
  return 'Something went wrong. Please retry.'
}

type ChartOutput = {
  tvSymbol: string
  tvExchange: string
  tvInterval: string
  widgetType: 'tradingview'
}

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

function renderToolPart(part: ToolUIPart, key: string) {
  // Live TradingView chart
  if (
    part.type === 'tool-chart-tool' &&
    part.state === 'output-available' &&
    part.output
  ) {
    const out = part.output as ChartOutput
    if (out.widgetType === 'tradingview') {
      return (
        <TradingViewWidget
          key={key}
          tvSymbol={out.tvSymbol}
          tvExchange={out.tvExchange}
          tvInterval={out.tvInterval}
        />
      )
    }
  }

  // Signal confirmation card
  if (
    part.type === 'tool-create-signal-tool' &&
    part.state === 'output-available' &&
    part.output
  ) {
    return <SignalCard key={key} output={part.output as SignalOutput} />
  }

  // Default collapsible tool display for all other tools
  return (
    <Tool key={key}>
      <ToolHeader
        type={(part as ToolUIPart).type}
        state={(part as ToolUIPart).state || 'output-available'}
        className="cursor-pointer"
      />
      <ToolContent>
        <ToolInput input={(part as ToolUIPart).input || {}} />
        <ToolOutput
          output={(part as ToolUIPart).output}
          errorText={(part as ToolUIPart).errorText}
        />
      </ToolContent>
    </Tool>
  )
}

function Chat() {
  const [input, setInput] = useState<string>('')

  const { messages, setMessages, sendMessage, regenerate, error, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  })

  useEffect(() => {
    const fetchMessages = async () => {
      const res = await fetch('/api/chat')
      const data = await res.json()
      setMessages([...data])
    }
    fetchMessages()
  }, [setMessages])

  const handleSubmit = async () => {
    if (!input.trim()) return
    sendMessage({ text: input })
    setInput('')
  }

  return (
    <div className="relative size-full h-screen w-full p-6">
      <div className="flex h-full flex-col">
        <Conversation className="h-full">
          <ConversationContent>
            {messages.map(message => (
              <div key={message.id}>
                {message.parts?.map((part, i) => {
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
                    return renderToolPart(part as ToolUIPart, partKey)
                  }

                  return null
                })}
              </div>
            ))}
            {(status === 'submitted' || status === 'streaming') && (
              <div className="flex items-center gap-2 px-1 py-2">
                <div className="flex gap-1">
                  <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                  <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                  <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
                </div>
                {status === 'submitted' && (
                  <Shimmer className="text-xs">Analyzing markets…</Shimmer>
                )}
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
    </div>
  )
}

export default Chat
