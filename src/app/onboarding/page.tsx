'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DefaultChatTransport, type ToolUIPart } from 'ai';
import { useChat } from '@ai-sdk/react';
import { TrendingUp } from 'lucide-react';
import { skipOnboarding } from './actions';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';

export default function OnboardingPage() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [done, setDone] = useState(false);

  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: '/api/setup' }),
  });

  // Load any previous setup messages (e.g. page refresh mid-onboarding)
  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setMessages(data))
      .catch(() => {});
  }, [setMessages]);

  const checkProfile = useCallback(async () => {
    const res = await fetch('/api/risk-profile');
    if (res.ok) setDone(true);
  }, []);

  // Check on mount — handles refresh after the profile was already saved
  useEffect(() => {
    void checkProfile();
  }, [checkProfile]);

  // Re-check after each agent response
  useEffect(() => {
    if (status === 'ready' && messages.length > 0) {
      void checkProfile();
    }
  }, [status, messages.length, checkProfile]);

  useEffect(() => {
    if (done) router.push('/dashboard');
  }, [done, router]);

  const handleSubmit = () => {
    if (!input.trim() || status !== 'ready') return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div className="relative flex h-screen w-full flex-col p-6">
      {/* Brand + skip */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <TrendingUp className="size-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Trading Hub</span>
            <span className="text-xs text-muted-foreground">Account setup</span>
          </div>
        </div>
        <form action={skipOnboarding}>
          <button
            type="submit"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Skip for now
          </button>
        </form>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <Conversation className="h-full">
          <ConversationContent>
            {messages.length === 0 && (
              <ConversationEmptyState
                icon={<TrendingUp className="size-8" />}
                title="Welcome to Trading Hub"
                description={
                  "Let's set up your risk profile. Describe your trading style and I'll configure everything for you. " +
                  "Try: 'SMC + technical indicators, 3 trades/day, 1% risk per trade, 3% max daily loss, manual approval, 4h and 1d timeframes, BTC and ETH only.'"
                }
              />
            )}
            {messages.map((message) =>
              message.parts?.map((part, i) => {
                if (part.type === 'text') {
                  return (
                    <Message key={`${message.id}-${i}`} from={message.role}>
                      <MessageContent>
                        <MessageResponse>{part.text}</MessageResponse>
                      </MessageContent>
                    </Message>
                  );
                }
                if (part.type?.startsWith('tool-')) {
                  return (
                    <Tool key={`${message.id}-${i}`}>
                      <ToolHeader
                        type={(part as ToolUIPart).type}
                        state={(part as ToolUIPart).state ?? 'output-available'}
                        className="cursor-pointer"
                      />
                      <ToolContent>
                        <ToolInput input={(part as ToolUIPart).input ?? {}} />
                        <ToolOutput
                          output={(part as ToolUIPart).output}
                          errorText={(part as ToolUIPart).errorText}
                        />
                      </ToolContent>
                    </Tool>
                  );
                }
                return null;
              })
            )}
            <ConversationScrollButton />
          </ConversationContent>
        </Conversation>

        <PromptInput onSubmit={handleSubmit} className="mt-6">
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe your trading style and preferences…"
              disabled={status !== 'ready' || done}
              className="md:leading-10"
            />
          </PromptInputBody>
        </PromptInput>
      </div>
    </div>
  );
}
