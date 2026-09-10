'use client';

import { useEffect, useState } from 'react';
import { CheckCircle, AlertCircle, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EligibleModel {
  providerId: string;
  providerName: string;
  modelId: string;
  modelIdentifier: string;
  contextMax: number | null;
}

interface KeyStatus {
  connected: boolean;
  providerId?: string;
  providerName?: string;
  modelId?: string;
  modelIdentifier?: string;
  modelStatus?: string;
  connectedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LlmKeySection() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [models, setModels] = useState<EligibleModel[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedModelId, setSelectedModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [connectSuccess, setConnectSuccess] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function fetchStatus() {
    try {
      const res = await fetch('/api/user-llm-keys');
      if (res.ok) {
        const json: KeyStatus = await res.json();
        setStatus(json);
      }
    } catch {
      // silently ignore network errors on refresh
    }
  }

  useEffect(() => {
    Promise.all([
      fetchStatus(),
      fetch('/api/user-llm-keys/eligible-models')
        .then((res) => (res.ok ? res.json() : { models: [] }))
        .then((json) => setModels(json.models ?? []))
        .catch(() => setModels([])),
    ]).finally(() => setLoading(false));
  }, []);

  const selectedModel = models.find((m) => m.modelId === selectedModelId);

  async function handleConnect() {
    if (!selectedModel) return;
    setConnecting(true);
    setConnectError('');
    setConnectSuccess(false);

    try {
      const res = await fetch('/api/user-llm-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedModel.providerId,
          modelId: selectedModel.modelId,
          apiKey,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        setConnectError(json.error ?? 'Connection failed. Please try again.');
        return;
      }

      setConnectSuccess(true);
      setApiKey('');
      setSelectedModelId('');
      setShowApiKey(false);
      await fetchStatus();
      setTimeout(() => setConnectSuccess(false), 4000);
    } catch {
      setConnectError('Network error. Please try again.');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await fetch('/api/user-llm-keys', { method: 'DELETE' });
      await fetchStatus();
    } catch {
      // silently ignore
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <Card className="p-4 md:p-6">
        <p className="text-sm text-muted-foreground">Loading BYOK settings...</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 md:p-6 space-y-5">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-5 w-5 text-muted-foreground shrink-0" />
        <div>
          <h2 className="text-lg font-semibold">Bring Your Own Model Key (BYOK)</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Optional. Connect your own LLM API key to use your own model/provider for the chat
            assistant. If you don&apos;t connect a key, the platform&apos;s default model is used —
            nothing changes for you.
          </p>
        </div>
      </div>

      {status?.connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default" className="bg-green-100 text-green-700 border-green-200">
              <CheckCircle className="w-3 h-3 mr-1" />
              Connected
            </Badge>
            <span className="text-sm font-medium">
              {status.providerName} — {status.modelIdentifier}
            </span>
            {status.modelStatus && status.modelStatus !== 'active' && (
              <Badge variant="destructive">Model no longer active</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Your key is encrypted at rest and only decrypted when a chat request needs it.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={disconnecting}
            onClick={handleDisconnect}
            className="h-11 sm:h-8"
          >
            {disconnecting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Disconnecting...
              </>
            ) : (
              'Disconnect'
            )}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {models.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No BYOK-eligible models are configured on the platform right now.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Provider / Model</label>
                <select
                  className="flex h-11 sm:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                >
                  <option value="">-- Select provider/model --</option>
                  {models.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.providerName} — {m.modelIdentifier}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">API Key</label>
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    placeholder="Your API key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="pr-10 h-11 sm:h-9"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-3.5 sm:p-0"
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {connectError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  {connectError}
                </div>
              )}
              {connectSuccess && (
                <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  Key connected successfully.
                </div>
              )}

              <Button
                onClick={handleConnect}
                disabled={connecting || !selectedModelId || !apiKey}
                className="w-full sm:w-auto h-11 sm:h-9"
              >
                {connecting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect Key'
                )}
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
