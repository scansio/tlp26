'use client';

import { useEffect, useState } from 'react';
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
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
}

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NotificationsSection() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const [form, setForm] = useState<FormState>({
    telegramBotToken: '',
    telegramChatId: '',
    discordWebhookUrl: '',
    quietHoursStart: '',
    quietHoursEnd: '',
    timezone: 'UTC',
  });

  const [testState, setTestState] = useState<{
    telegram: 'idle' | 'loading' | 'ok' | 'error';
    telegramError?: string;
    discord: 'idle' | 'loading' | 'ok' | 'error';
    discordError?: string;
  }>({ telegram: 'idle', discord: 'idle' });

  // Load existing config on mount
  useEffect(() => {
    fetch('/api/notifications')
      .then((r) => r.json())
      .then((data: NotificationConfig | null) => {
        setConfig(data);
        if (data) {
          setForm((f) => ({
            ...f,
            telegramChatId: data.telegramChatId ?? '',
            quietHoursStart: data.quietHoursStart != null ? String(data.quietHoursStart) : '',
            quietHoursEnd: data.quietHoursEnd != null ? String(data.quietHoursEnd) : '',
            timezone: data.timezone ?? 'UTC',
          }));
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaveMessage('');
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage('');

    const body: Record<string, unknown> = {
      telegramChatId: form.telegramChatId || null,
      discordWebhookUrl: form.discordWebhookUrl || null,
      quietHoursStart: form.quietHoursStart !== '' ? parseInt(form.quietHoursStart, 10) : null,
      quietHoursEnd: form.quietHoursEnd !== '' ? parseInt(form.quietHoursEnd, 10) : null,
      timezone: form.timezone || 'UTC',
    };

    // Only send token if user typed something new (don't overwrite with empty)
    if (form.telegramBotToken) {
      body.telegramBotToken = form.telegramBotToken;
    }

    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaveMessage('Settings saved successfully.');
        // Refresh config
        const updated = await fetch('/api/notifications').then((r) => r.json());
        setConfig(updated);
        setForm((f) => ({ ...f, telegramBotToken: '' })); // clear token field after save
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
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Loading notification settings...</p>
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Receive instant alerts for signals, executions, stop-losses, and risk events.
        </p>
      </div>

      {/* Telegram */}
      <div className="space-y-3">
        <h3 className="font-medium">Telegram</h3>
        {config?.hasTelegramToken && (
          <p className="text-xs text-green-600">Bot token is saved (hidden for security).</p>
        )}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Bot Token{config?.hasTelegramToken ? ' (leave blank to keep current)' : ''}
          </label>
          <Input
            type="password"
            placeholder={config?.hasTelegramToken ? '••••••••' : 'Enter bot token from @BotFather'}
            value={form.telegramBotToken}
            onChange={(e) => setField('telegramBotToken', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Chat ID</label>
          <Input
            placeholder="e.g. -1001234567890"
            value={form.telegramChatId}
            onChange={(e) => setField('telegramChatId', e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={testState.telegram === 'loading'}
            onClick={() => handleTest('telegram')}
          >
            {testState.telegram === 'loading' ? 'Sending...' : 'Send Test Message'}
          </Button>
          {testState.telegram === 'ok' && (
            <span className="text-sm text-green-600">Test sent successfully!</span>
          )}
          {testState.telegram === 'error' && (
            <span className="text-sm text-red-600">{testState.telegramError}</span>
          )}
        </div>
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
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={testState.discord === 'loading'}
            onClick={() => handleTest('discord')}
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

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Quiet from</label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
      <div className="flex items-center gap-4 pt-2">
        <Button onClick={handleSave} disabled={saving}>
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
