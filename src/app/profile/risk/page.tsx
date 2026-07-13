'use client';

import { useEffect, useState } from 'react';
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
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Alert } from '@/components/ui/alert';
import { CircuitBreakerPanel } from '@/components/circuit-breaker/circuit-breaker-panel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RiskProfile {
  id: string;
  strategies: string[];
  maxTradesPerDay: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  executionMode: 'auto' | 'manual';
  preferredTimeframes: string[];
  allowedSymbols: string[];
  paperMode: boolean;
  paperBalanceUsd: number;
  isActive: boolean;
  updatedAt: string | null;
}

interface FormState {
  strategies: string[];
  maxTradesPerDay: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  executionMode: 'auto' | 'manual';
  preferredTimeframes: string[];
  allowedSymbols: string[];
  paperBalanceUsd: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRATEGIES = [
  { value: 'SMC', label: 'SMC (Smart Money Concepts)' },
  { value: 'Chart Patterns', label: 'Chart Patterns' },
  { value: 'Technical Indicators', label: 'Technical Indicators' },
  { value: 'Trend Following', label: 'Trend Following' },
];

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];

const DEFAULT_FORM: FormState = {
  strategies: [],
  maxTradesPerDay: 5,
  riskPerTradePct: 2,
  maxDailyLossPct: 5,
  executionMode: 'manual',
  preferredTimeframes: [],
  allowedSymbols: [],
  paperBalanceUsd: 10_000,
};

// ---------------------------------------------------------------------------
// Tag-style symbol input
// ---------------------------------------------------------------------------

function SymbolTagInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [inputValue, setInputValue] = useState('');

  function addTag() {
    const tag = inputValue.trim().toUpperCase();
    if (tag && !value.includes(tag)) {
      onChange([...value, tag]);
    }
    setInputValue('');
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !inputValue && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border border-input bg-background px-3 py-2 min-h-[38px]">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-sm font-medium"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="text-muted-foreground hover:text-foreground leading-none"
            aria-label={`Remove ${tag}`}
          >
            &times;
          </button>
        </span>
      ))}
      <input
        type="text"
        className="flex-1 min-w-[100px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        placeholder={value.length === 0 ? 'e.g. BTC/USDT (empty = all)' : ''}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={addTag}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk warning banner
// ---------------------------------------------------------------------------

function RiskWarningBanner({ form }: { form: FormState }) {
  const warnings: string[] = [];
  if (form.riskPerTradePct > 5) {
    warnings.push(`Risk per trade is ${form.riskPerTradePct}% — above the 5% safety threshold.`);
  }
  if (form.maxDailyLossPct > 10) {
    warnings.push(`Max daily loss is ${form.maxDailyLossPct}% — above the 10% safety threshold.`);
  }
  if (warnings.length === 0) return null;
  return (
    <Alert className="bg-yellow-50 border-yellow-300 text-yellow-800 dark:bg-yellow-950 dark:border-yellow-700 dark:text-yellow-200">
      <strong className="block mb-1">High-Risk Settings Detected</strong>
      {warnings.map((w, i) => (
        <p key={i} className="text-sm">
          {w}
        </p>
      ))}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Fallback form
// ---------------------------------------------------------------------------

function FallbackForm({
  profile,
  onSaved,
}: {
  profile: RiskProfile | null;
  onSaved: (p: RiskProfile) => void;
}) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [isError, setIsError] = useState(false);

  // Pre-populate from profile when available
  useEffect(() => {
    if (profile) {
      setForm({
        strategies: profile.strategies ?? [],
        maxTradesPerDay: profile.maxTradesPerDay ?? 5,
        riskPerTradePct: profile.riskPerTradePct ?? 2,
        maxDailyLossPct: profile.maxDailyLossPct ?? 5,
        executionMode: profile.executionMode ?? 'manual',
        preferredTimeframes: profile.preferredTimeframes ?? [],
        allowedSymbols: profile.allowedSymbols ?? [],
        paperBalanceUsd: profile.paperBalanceUsd ?? 10_000,
      });
    }
  }, [profile]);

  function toggleStrategy(value: string) {
    setForm((f) => ({
      ...f,
      strategies: f.strategies.includes(value)
        ? f.strategies.filter((s) => s !== value)
        : [...f.strategies, value],
    }));
    setSaveMessage('');
  }

  function toggleTimeframe(value: string) {
    setForm((f) => ({
      ...f,
      preferredTimeframes: f.preferredTimeframes.includes(value)
        ? f.preferredTimeframes.filter((t) => t !== value)
        : [...f.preferredTimeframes, value],
    }));
    setSaveMessage('');
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage('');
    setIsError(false);

    const body = {
      strategies: form.strategies.length > 0 ? form.strategies : ['Technical Indicators'],
      maxTradesPerDay: form.maxTradesPerDay,
      riskPerTradePct: form.riskPerTradePct,
      maxDailyLossPct: form.maxDailyLossPct,
      executionMode: form.executionMode,
      preferredTimeframes: form.preferredTimeframes,
      allowedSymbols: form.allowedSymbols,
      paperBalanceUsd: form.paperBalanceUsd,
    };

    try {
      const res = await fetch('/api/risk-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const saved: RiskProfile = await res.json();
        setSaveMessage('Risk profile saved successfully.');
        setIsError(false);
        onSaved(saved);
      } else {
        const err = await res.json().catch(() => ({}));
        setSaveMessage((err as Record<string, string>)?.error ?? 'Failed to save. Please try again.');
        setIsError(true);
      }
    } catch {
      setSaveMessage('Network error. Please try again.');
      setIsError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <RiskWarningBanner form={form} />

      {/* Strategies */}
      <div className="space-y-3">
        <label className="text-sm font-medium">Trading Strategies</label>
        <div className="grid grid-cols-2 gap-2">
          {STRATEGIES.map(({ value, label }) => (
            <label
              key={value}
              className="flex items-center gap-2 rounded-md border border-input px-3 py-2 cursor-pointer hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={form.strategies.includes(value)}
                onChange={() => toggleStrategy(value)}
                className="accent-primary"
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </div>
      </div>

      <Separator />

      {/* Max trades per day */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Max Trades / Day</label>
          <span className="text-sm font-semibold tabular-nums">{form.maxTradesPerDay}</span>
        </div>
        <input
          type="range"
          min={1}
          max={20}
          step={1}
          value={form.maxTradesPerDay}
          onChange={(e) => {
            setForm((f) => ({ ...f, maxTradesPerDay: Number(e.target.value) }));
            setSaveMessage('');
          }}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>1</span>
          <span>20</span>
        </div>
      </div>

      <Separator />

      {/* Risk per trade */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Risk per Trade</label>
          <span className="text-sm font-semibold tabular-nums">{form.riskPerTradePct}%</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.5}
          value={form.riskPerTradePct}
          onChange={(e) => {
            setForm((f) => ({ ...f, riskPerTradePct: Number(e.target.value) }));
            setSaveMessage('');
          }}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>0.5%</span>
          <span>10%</span>
        </div>
      </div>

      <Separator />

      {/* Max daily loss */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Max Daily Loss</label>
          <span className="text-sm font-semibold tabular-nums">{form.maxDailyLossPct}%</span>
        </div>
        <input
          type="range"
          min={1}
          max={20}
          step={0.5}
          value={form.maxDailyLossPct}
          onChange={(e) => {
            setForm((f) => ({ ...f, maxDailyLossPct: Number(e.target.value) }));
            setSaveMessage('');
          }}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>1%</span>
          <span>20%</span>
        </div>
      </div>

      <Separator />

      {/* Execution mode */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Execution Mode</label>
        <div className="flex gap-3">
          {(['manual', 'auto'] as const).map((mode) => (
            <label
              key={mode}
              className={`flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 cursor-pointer ${
                form.executionMode === mode
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'border-input hover:bg-accent'
              }`}
            >
              <input
                type="radio"
                name="executionMode"
                value={mode}
                checked={form.executionMode === mode}
                onChange={() => {
                  setForm((f) => ({ ...f, executionMode: mode }));
                  setSaveMessage('');
                }}
                className="accent-primary"
              />
              <span className="text-sm capitalize">{mode}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {form.executionMode === 'manual'
            ? 'The AI suggests trades — you approve each one before it executes.'
            : 'The AI places trades automatically within your risk limits.'}
        </p>
      </div>

      <Separator />

      {/* Preferred timeframes */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Preferred Timeframes</label>
        <div className="flex gap-2 flex-wrap">
          {TIMEFRAMES.map((tf) => (
            <label
              key={tf}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm cursor-pointer ${
                form.preferredTimeframes.includes(tf)
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'border-input hover:bg-accent'
              }`}
            >
              <input
                type="checkbox"
                checked={form.preferredTimeframes.includes(tf)}
                onChange={() => toggleTimeframe(tf)}
                className="accent-primary"
              />
              {tf}
            </label>
          ))}
        </div>
      </div>

      <Separator />

      {/* Allowed symbols */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Allowed Symbols</label>
        <p className="text-xs text-muted-foreground">
          Leave empty to allow all symbols. Press Enter or comma to add.
        </p>
        <SymbolTagInput
          value={form.allowedSymbols}
          onChange={(v) => {
            setForm((f) => ({ ...f, allowedSymbols: v }));
            setSaveMessage('');
          }}
        />
      </div>

      <Separator />

      {/* Paper trading balance */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Paper Trading Balance (USD)</label>
        <p className="text-xs text-muted-foreground">
          Virtual starting balance for simulated paper trades.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={100}
            max={10_000_000}
            step={100}
            value={form.paperBalanceUsd}
            onChange={(e) => {
              const val = Math.max(100, Math.min(10_000_000, Number(e.target.value)));
              setForm((f) => ({ ...f, paperBalanceUsd: val }));
              setSaveMessage('');
            }}
            className="w-40 rounded-md border border-input bg-background px-3 py-1.5 text-sm tabular-nums"
          />
          <span className="text-sm text-muted-foreground">
            ${form.paperBalanceUsd.toLocaleString('en-US')}
          </span>
        </div>
      </div>

      <Separator />

      {/* Save */}
      <div className="flex items-center gap-4 pt-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Risk Profile'}
        </Button>
        {saveMessage && (
          <span className={`text-sm ${isError ? 'text-red-600' : 'text-green-600'}`}>
            {saveMessage}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat interface
// ---------------------------------------------------------------------------

function SetupChat({ onSaved }: { onSaved: (p: RiskProfile) => void }) {
  const [input, setInput] = useState('');
  const savedRef = useState(() => new Set<string>())[0];

  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/setup',
    }),
  });

  // Watch messages for save_profile JSON from the agent (fallback for non-tool saves)
  useEffect(() => {
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const part of message.parts ?? []) {
        if (part.type !== 'text') continue;
        const jsonMatch = part.text.match(/```json\s*([\s\S]*?)\s*```/);
        if (!jsonMatch) continue;
        try {
          const parsed = JSON.parse(jsonMatch[1]) as { action?: string; profile?: unknown };
          if (parsed.action === 'save_profile' && parsed.profile && !savedRef.has(message.id)) {
            savedRef.add(message.id);
            fetch('/api/risk-profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(parsed.profile),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((saved) => {
                if (saved) onSaved(saved as RiskProfile);
              })
              .catch(console.error);
          }
        } catch {
          // Not valid JSON — ignore
        }
      }
    }
  }, [messages, onSaved, savedRef]);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((data) => setMessages([...(data as any[])]))
      .catch(() => {});
  }, [setMessages]);

  const handleSubmit = async () => {
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div className="relative flex h-[600px] flex-col rounded-lg border bg-background">
      <Conversation className="flex-1 overflow-hidden">
        <ConversationContent>
          {messages.length === 0 && status === 'ready' && (
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
            placeholder="Describe your trading preferences…"
            disabled={status !== 'ready'}
          />
        </PromptInputBody>
      </PromptInput>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trading Mode Toggle Panel (Paper ↔ Live)
// ---------------------------------------------------------------------------

function TradingModePanel({
  profile,
  onModeChanged,
}: {
  profile: RiskProfile | null;
  onModeChanged: (isPaper: boolean) => void;
}) {
  const isPaper = profile?.paperMode ?? true;
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  async function switchMode(targetMode: 'paper' | 'live') {
    setSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch('/api/trading-mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: targetMode, confirmed: targetMode === 'live' ? true : undefined }),
      });
      if (res.ok) {
        onModeChanged(targetMode === 'paper');
        setShowLiveConfirm(false);
        setConfirmed(false);
      } else {
        const err = await res.json().catch(() => ({})) as Record<string, string>;
        setSwitchError(err?.error ?? 'Failed to switch mode. Please try again.');
      }
    } catch {
      setSwitchError('Network error. Please try again.');
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Trading Mode</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isPaper
              ? 'Paper mode — all trades are simulated. No real funds at risk.'
              : 'Live mode — trades execute on your connected exchange with real funds.'}
          </p>
        </div>
        <div className={`px-3 py-1 rounded-full text-xs font-semibold ${
          isPaper
            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
            : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200'
        }`}>
          {isPaper ? 'PAPER' : 'LIVE'}
        </div>
      </div>

      {/* Switch buttons */}
      {!showLiveConfirm && (
        <div className="flex gap-3">
          {isPaper ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowLiveConfirm(true)}
              disabled={switching}
            >
              Switch to Live Trading
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void switchMode('paper')}
              disabled={switching}
            >
              {switching ? 'Switching…' : 'Switch to Paper Mode'}
            </Button>
          )}
        </div>
      )}

      {/* Live confirmation panel */}
      {showLiveConfirm && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-700 p-4 space-y-3">
          <p className="text-sm font-semibold text-red-800 dark:text-red-200">
            Switch to Live Trading
          </p>
          <p className="text-sm text-red-700 dark:text-red-300">
            Live trading executes real orders on your connected exchange using real funds.
            Losses are real. Make sure you have tested your strategy in paper mode first.
          </p>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 accent-red-600"
            />
            <span className="text-sm text-red-800 dark:text-red-200 font-medium">
              I understand I am switching to live trading with real funds
            </span>
          </label>
          {switchError && (
            <p className="text-sm text-red-700 dark:text-red-300">{switchError}</p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={!confirmed || switching}
              onClick={() => void switchMode('live')}
            >
              {switching ? 'Switching…' : 'Confirm — Switch to Live'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowLiveConfirm(false);
                setConfirmed(false);
                setSwitchError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Paper balance info */}
      {isPaper && profile && (
        <p className="text-xs text-muted-foreground">
          Virtual balance: ${(profile.paperBalanceUsd ?? 10_000).toLocaleString('en-US')} USD
          &mdash; configurable in the form below.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function RiskProfilePage() {
  const [mode, setMode] = useState<'chat' | 'form'>('chat');
  const [profile, setProfile] = useState<RiskProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Load existing profile on mount
  useEffect(() => {
    fetch('/api/risk-profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: RiskProfile | null) => setProfile(data))
      .catch(() => setProfile(null))
      .finally(() => setLoading(false));
  }, []);

  function handleSaved(saved: RiskProfile) {
    setProfile(saved);
  }

  function handleModeChanged(isPaper: boolean) {
    setProfile((prev) => prev ? { ...prev, paperMode: isPaper } : prev);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading&hellip;</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold">Risk Profile Setup</h1>
        <p className="text-muted-foreground mt-1">
          Configure your trading risk parameters. The AI always operates within these limits.
        </p>
      </div>

      {/* Profile metadata */}
      {profile?.updatedAt && (
        <p className="text-xs text-muted-foreground">
          Last updated:{' '}
          {new Date(profile.updatedAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </p>
      )}

      {/* Trading mode toggle */}
      {profile && (
        <TradingModePanel profile={profile} onModeChanged={handleModeChanged} />
      )}

      {/* Mode toggle */}
      <div className="flex items-center gap-4">
        <div className="flex rounded-lg border border-input overflow-hidden text-sm">
          <button
            className={`px-4 py-1.5 transition-colors ${
              mode === 'chat' ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-accent'
            }`}
            onClick={() => setMode('chat')}
          >
            Chat Setup
          </button>
          <button
            className={`px-4 py-1.5 transition-colors ${
              mode === 'form' ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-accent'
            }`}
            onClick={() => setMode('form')}
          >
            Prefer a form?
          </button>
        </div>
      </div>

      {/* Current profile summary (if set, shown in chat mode) */}
      {profile && mode === 'chat' && (
        <Card className="p-4 bg-muted/40">
          <p className="text-sm font-medium mb-2">Current profile</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>Strategies:</span>
            <span className="font-medium text-foreground">
              {profile.strategies?.join(', ') || '—'}
            </span>
            <span>Max trades/day:</span>
            <span className="font-medium text-foreground">{profile.maxTradesPerDay}</span>
            <span>Risk per trade:</span>
            <span className="font-medium text-foreground">{profile.riskPerTradePct}%</span>
            <span>Max daily loss:</span>
            <span className="font-medium text-foreground">{profile.maxDailyLossPct}%</span>
            <span>Execution mode:</span>
            <span className="font-medium text-foreground capitalize">{profile.executionMode}</span>
            <span>Timeframes:</span>
            <span className="font-medium text-foreground">
              {profile.preferredTimeframes?.join(', ') || 'All'}
            </span>
            <span>Symbols:</span>
            <span className="font-medium text-foreground">
              {profile.allowedSymbols?.length > 0 ? profile.allowedSymbols.join(', ') : 'All'}
            </span>
            <span>Paper balance:</span>
            <span className="font-medium text-foreground">
              ${(profile.paperBalanceUsd ?? 10_000).toLocaleString('en-US')}
            </span>
          </div>
          {(profile.riskPerTradePct > 5 || profile.maxDailyLossPct > 10) && (
            <div className="mt-3 rounded-md bg-yellow-50 border border-yellow-300 px-3 py-2 text-sm text-yellow-800 dark:bg-yellow-950 dark:border-yellow-700 dark:text-yellow-200">
              <strong>Warning:</strong>{' '}
              {profile.riskPerTradePct > 5 && `Risk per trade (${profile.riskPerTradePct}%) exceeds 5%. `}
              {profile.maxDailyLossPct > 10 && `Max daily loss (${profile.maxDailyLossPct}%) exceeds 10%.`}
            </div>
          )}
        </Card>
      )}

      {/* Circuit Breaker */}
      <CircuitBreakerPanel />

      {/* Main content */}
      <Card className="p-6">
        {mode === 'chat' ? (
          <SetupChat onSaved={handleSaved} />
        ) : (
          <FallbackForm profile={profile} onSaved={handleSaved} />
        )}
      </Card>
    </div>
  );
}
