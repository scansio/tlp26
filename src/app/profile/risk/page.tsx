'use client';

import { useState } from 'react';
import { DefaultChatTransport, ToolUIPart } from 'ai';
import { useChat } from '@ai-sdk/react';

import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';

import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';

import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';

// ---------------------------------------------------------------------------
// AI-assisted setup chat
// ---------------------------------------------------------------------------
function SetupChat() {
  const [input, setInput] = useState('');

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: '/api/setup' }),
  });

  const handleSubmit = () => {
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div className="relative flex h-[600px] flex-col rounded-lg border bg-background">
      <Conversation className="flex-1 overflow-hidden">
        <ConversationContent>
          {messages.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">
              Describe your trading preferences in plain English. For example:{' '}
              <em>
                &quot;Trade BTC and ETH only, max 3 trades a day, 2% risk, SMC plus RSI,
                manual approval.&quot;
              </em>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id}>
              {message.parts?.map((part, i) => {
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
                  );
                }

                return null;
              })}
            </div>
          ))}
          <ConversationScrollButton />
        </ConversationContent>
      </Conversation>

      <PromptInput onSubmit={handleSubmit} className="border-t">
        <PromptInputBody>
          <PromptInputTextarea
            onChange={(e) => setInput(e.target.value)}
            value={input}
            placeholder="Describe your trading preferences..."
            disabled={status !== 'ready'}
          />
        </PromptInputBody>
      </PromptInput>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual form fallback (AC8)
// ---------------------------------------------------------------------------
type FormState = {
  strategies: string[];
  maxTradesPerDay: string;
  riskPerTradePct: string;
  maxDailyLossPct: string;
  executionMode: 'auto' | 'manual';
  preferredTimeframes: string;
  allowedSymbols: string;
};

const STRATEGY_OPTIONS = [
  'SMC',
  'Chart Patterns',
  'Technical Indicators',
  'Trend Following',
] as const;

function ManualForm() {
  const [form, setForm] = useState<FormState>({
    strategies: [],
    maxTradesPerDay: '5',
    riskPerTradePct: '1',
    maxDailyLossPct: '3',
    executionMode: 'manual',
    preferredTimeframes: '',
    allowedSymbols: '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleStrategy = (s: string) => {
    setForm((prev) => ({
      ...prev,
      strategies: prev.strategies.includes(s)
        ? prev.strategies.filter((x) => x !== s)
        : [...prev.strategies, s],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const body = {
      strategies: form.strategies,
      maxTradesPerDay: parseInt(form.maxTradesPerDay, 10),
      riskPerTradePct: parseFloat(form.riskPerTradePct),
      maxDailyLossPct: parseFloat(form.maxDailyLossPct),
      executionMode: form.executionMode,
      preferredTimeframes: form.preferredTimeframes
        ? form.preferredTimeframes.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      allowedSymbols: form.allowedSymbols
        ? form.allowedSymbols.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    };

    try {
      const res = await fetch('/api/risk-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }

      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 rounded-lg border bg-background p-6">
      <div>
        <label className="mb-2 block text-sm font-medium">Strategies</label>
        <div className="flex flex-wrap gap-2">
          {STRATEGY_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggleStrategy(s)}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                form.strategies.includes(s)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-foreground hover:bg-muted'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="maxTrades">
            Max trades / day (1–20)
          </label>
          <input
            id="maxTrades"
            type="number"
            min={1}
            max={20}
            required
            value={form.maxTradesPerDay}
            onChange={(e) => setForm((p) => ({ ...p, maxTradesPerDay: e.target.value }))}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="riskPct">
            Risk per trade % (0.5–10)
          </label>
          <input
            id="riskPct"
            type="number"
            min={0.5}
            max={10}
            step={0.1}
            required
            value={form.riskPerTradePct}
            onChange={(e) => setForm((p) => ({ ...p, riskPerTradePct: e.target.value }))}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="dailyLoss">
            Max daily loss % (1–20)
          </label>
          <input
            id="dailyLoss"
            type="number"
            min={1}
            max={20}
            step={0.1}
            required
            value={form.maxDailyLossPct}
            onChange={(e) => setForm((p) => ({ ...p, maxDailyLossPct: e.target.value }))}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Execution mode</label>
        <div className="flex gap-4">
          {(['auto', 'manual'] as const).map((mode) => (
            <label key={mode} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="executionMode"
                value={mode}
                checked={form.executionMode === mode}
                onChange={() => setForm((p) => ({ ...p, executionMode: mode }))}
              />
              {mode === 'auto' ? 'Auto (agent executes automatically)' : 'Manual (I approve each trade)'}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="timeframes">
            Preferred timeframes (comma-separated, optional)
          </label>
          <input
            id="timeframes"
            type="text"
            placeholder="e.g. 1h, 4h, 1d"
            value={form.preferredTimeframes}
            onChange={(e) => setForm((p) => ({ ...p, preferredTimeframes: e.target.value }))}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="symbols">
            Allowed symbols (comma-separated, optional)
          </label>
          <input
            id="symbols"
            type="text"
            placeholder="e.g. BTC/USDT, ETH/USDT"
            value={form.allowedSymbols}
            onChange={(e) => setForm((p) => ({ ...p, allowedSymbols: e.target.value }))}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && (
        <p className="text-sm text-green-600">
          Risk profile saved successfully.
        </p>
      )}

      <button
        type="submit"
        disabled={saving || form.strategies.length === 0}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save risk profile'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Page — tabbed: AI setup | Manual form
// ---------------------------------------------------------------------------
export default function RiskProfilePage() {
  const [tab, setTab] = useState<'ai' | 'manual'>('ai');

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-2 text-2xl font-semibold">Risk Profile Setup</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Describe your trading preferences in plain English, or fill in the manual form below.
      </p>

      <div className="mb-6 flex gap-2">
        <button
          onClick={() => setTab('ai')}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'ai'
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-background text-foreground hover:bg-muted'
          }`}
        >
          AI-assisted setup
        </button>
        <button
          onClick={() => setTab('manual')}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'manual'
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-background text-foreground hover:bg-muted'
          }`}
        >
          Manual form
        </button>
      </div>

      {tab === 'ai' ? <SetupChat /> : <ManualForm />}
    </div>
  );
}
