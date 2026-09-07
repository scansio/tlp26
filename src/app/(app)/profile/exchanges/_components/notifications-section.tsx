'use client';

import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationConfig {
  hasTelegramToken: boolean;
  hasTelegramChatId: boolean;
  telegramChatId: string | null;
  hasDiscordWebhook: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string | null;
  updatedAt: string | null;
}

interface FormState {
  discordWebhookUrl: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
}

type TelegramConnectState = 'idle' | 'connecting' | 'error';

// ---------------------------------------------------------------------------
// Common IANA timezone options (representative subset)
// ---------------------------------------------------------------------------

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function hourLabel(h: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:00`;
}

const TELEGRAM_POLL_INTERVAL_MS = 2000;
const TELEGRAM_POLL_TIMEOUT_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NotificationsSection() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const [form, setForm] = useState<FormState>({
    discordWebhookUrl: '',
    quietHoursStart: '',
    quietHoursEnd: '',
    timezone: 'UTC',
  });

  const [telegramState, setTelegramState] = useState<TelegramConnectState>('idle');
  const [telegramError, setTelegramError] = useState('');
  const [telegramConnectUrl, setTelegramConnectUrl] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  const [testState, setTestState] = useState<{
    telegram: 'idle' | 'loading' | 'ok' | 'error';
    telegramError?: string;
    discord: 'idle' | 'loading' | 'ok' | 'error';
    discordError?: string;
  }>({ telegram: 'idle', discord: 'idle' });

  async function refreshConfig() {
    const data: NotificationConfig | null = await fetch('/api/notifications').then((r) => r.json());
    setConfig(data);
    return data;
  }

  // Load existing config on mount
  useEffect(() => {
    refreshConfig()
      .then((data) => {
        if (data) {
          setForm((f) => ({
            ...f,
            quietHoursStart: data.quietHoursStart != null ? String(data.quietHoursStart) : '',
            quietHoursEnd: data.quietHoursEnd != null ? String(data.quietHoursEnd) : '',
            timezone: data.timezone ?? 'UTC',
          }));
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    return () => stopPolling();
     
  }, []);

  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  async function handleConnectTelegram() {
    setTelegramState('connecting');
    setTelegramError('');

    try {
      const res = await fetch('/api/notifications/telegram/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setTelegramState('error');
        setTelegramError(data.error ?? 'Could not start Telegram connect.');
        return;
      }

      const popup = window.open(data.url, '_blank', 'noopener,noreferrer');
      setTelegramConnectUrl(popup ? '' : data.url);

      pollDeadlineRef.current = Date.now() + TELEGRAM_POLL_TIMEOUT_MS;
      stopPolling();
      pollTimerRef.current = setInterval(async () => {
        const updated = await refreshConfig().catch(() => null);
        if (updated?.hasTelegramChatId) {
          stopPolling();
          setTelegramState('idle');
          setTelegramConnectUrl('');
        } else if (Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setTelegramState('error');
          setTelegramError('Timed out waiting for Telegram confirmation. Try again.');
          setTelegramConnectUrl('');
        }
      }, TELEGRAM_POLL_INTERVAL_MS);
    } catch {
      setTelegramState('error');
      setTelegramError('Network error. Please try again.');
    }
  }

  async function handleDisconnectTelegram() {
    stopPolling();
    setTelegramState('idle');
    setTelegramError('');
    await fetch('/api/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramChatId: null }),
    });
    await refreshConfig();
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaveMessage('');
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage('');

    const body: Record<string, unknown> = {
      discordWebhookUrl: form.discordWebhookUrl || null,
      quietHoursStart: form.quietHoursStart !== '' ? parseInt(form.quietHoursStart, 10) : null,
      quietHoursEnd: form.quietHoursEnd !== '' ? parseInt(form.quietHoursEnd, 10) : null,
      timezone: form.timezone || 'UTC',
    };

    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaveMessage('Settings saved successfully.');
        await refreshConfig();
      } else {
        setSaveMessage('Failed to save settings.');
      }
    } catch {
      setSaveMessage('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(channel: 'telegram' | 'discord') {
    setTestState((s) => ({
      ...s,
      [channel]: 'loading',
      [`${channel}Error`]: undefined,
    }));

    try {
      const res = await fetch('/api/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestState((s) => ({ ...s, [channel]: 'ok' }));
        setTimeout(() => setTestState((s) => ({ ...s, [channel]: 'idle' })), 3000);
      } else {
        setTestState((s) => ({
          ...s,
          [channel]: 'error',
          [`${channel}Error`]: data.error ?? 'Test failed',
        }));
      }
    } catch {
      setTestState((s) => ({
        ...s,
        [channel]: 'error',
        [`${channel}Error`]: 'Network error',
      }));
    }
  }

  if (loading) {
    return (
      <Card className="p-4 md:p-6">
        <p className="text-sm text-muted-foreground">Loading notification settings...</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 md:p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Receive instant alerts for signals, executions, stop-losses, and risk events.
        </p>
      </div>

      {/* Telegram */}
      <div className="space-y-3">
        <h3 className="font-medium">Telegram</h3>

        {config?.hasTelegramChatId ? (
          <div className="space-y-3">
            <p className="text-sm text-green-600">✅ Telegram is connected.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={testState.telegram === 'loading'}
                onClick={() => handleTest('telegram')}
                className="h-11 sm:h-8"
              >
                {testState.telegram === 'loading' ? 'Sending...' : 'Send Test Message'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDisconnectTelegram} className="h-11 sm:h-8">
                Disconnect
              </Button>
              {testState.telegram === 'ok' && (
                <span className="text-sm text-green-600">Test sent successfully!</span>
              )}
              {testState.telegram === 'error' && (
                <span className="text-sm text-red-600">{testState.telegramError}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connect your Telegram account to get instant trade alerts — no bot setup required.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={handleConnectTelegram}
                disabled={telegramState === 'connecting'}
                className="w-full sm:w-auto h-11 sm:h-9"
              >
                {telegramState === 'connecting' ? 'Waiting for confirmation…' : 'Connect Telegram'}
              </Button>
              {telegramState === 'connecting' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    stopPolling();
                    setTelegramState('idle');
                    setTelegramConnectUrl('');
                  }}
                  className="h-11 sm:h-8"
                >
                  Cancel
                </Button>
              )}
            </div>
            {telegramState === 'connecting' && telegramConnectUrl && (
              <p className="text-xs text-muted-foreground">
                Your browser blocked the popup —{' '}
                <a
                  href={telegramConnectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  open Telegram
                </a>{' '}
                to finish connecting.
              </p>
            )}
            {telegramState === 'connecting' && !telegramConnectUrl && (
              <p className="text-xs text-muted-foreground">
                A Telegram chat opened in a new tab — tap &ldquo;Start&rdquo; there to finish connecting.
              </p>
            )}
            {telegramState === 'error' && (
              <p className="text-sm text-red-600">{telegramError}</p>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Discord */}
      <div className="space-y-3">
        <h3 className="font-medium">Discord</h3>
        {config?.hasDiscordWebhook && (
          <p className="text-xs text-green-600">Discord webhook is saved (hidden for security).</p>
        )}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Webhook URL{config?.hasDiscordWebhook ? ' (leave blank to keep current)' : ''}
          </label>
          <Input
            type="password"
            placeholder={
              config?.hasDiscordWebhook
                ? '••••••••'
                : 'https://discord.com/api/webhooks/...'
            }
            value={form.discordWebhookUrl}
            onChange={(e) => setField('discordWebhookUrl', e.target.value)}
            className="h-11 sm:h-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={testState.discord === 'loading'}
            onClick={() => handleTest('discord')}
            className="h-11 sm:h-8"
          >
            {testState.discord === 'loading' ? 'Sending...' : 'Send Test Message'}
          </Button>
          {testState.discord === 'ok' && (
            <span className="text-sm text-green-600">Test sent successfully!</span>
          )}
          {testState.discord === 'error' && (
            <span className="text-sm text-red-600">{testState.discordError}</span>
          )}
        </div>
      </div>

      <Separator />

      {/* Quiet Hours */}
      <div className="space-y-3">
        <div>
          <h3 className="font-medium">Do-Not-Disturb Window</h3>
          <p className="text-sm text-muted-foreground">
            Non-critical alerts are suppressed during these hours. Critical events (stop-loss, kill switch, circuit breaker) are always delivered.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Quiet from</label>
            <select
              className="flex h-11 sm:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={form.quietHoursStart}
              onChange={(e) => setField('quietHoursStart', e.target.value)}
            >
              <option value="">-- disabled --</option>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Quiet until</label>
            <select
              className="flex h-11 sm:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={form.quietHoursEnd}
              onChange={(e) => setField('quietHoursEnd', e.target.value)}
            >
              <option value="">-- disabled --</option>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Your timezone</label>
          <select
            className="flex h-11 sm:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={form.timezone}
            onChange={(e) => setField('timezone', e.target.value)}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Save */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 pt-2">
        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto h-11 sm:h-9">
          {saving ? 'Saving...' : 'Save Notification Settings'}
        </Button>
        {saveMessage && (
          <span
            className={`text-sm ${
              saveMessage.includes('success') ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {saveMessage}
          </span>
        )}
      </div>
    </Card>
  );
}
