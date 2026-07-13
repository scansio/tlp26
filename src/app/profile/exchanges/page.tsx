'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Trash2,
  CheckCircle,
  AlertCircle,
  WifiOff,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { NotificationsSection } from './_components/notifications-section';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectedExchange {
  id: string;
  exchangeName: string;
  status: string;
  connectedAt: string | null;
  openPositions: number;
}

interface ExchangesData {
  exchanges: ConnectedExchange[];
  webhookUrl: string;
  webhookToken: string;
}

// ---------------------------------------------------------------------------
// Exchange display helpers
// ---------------------------------------------------------------------------

const EXCHANGE_LABELS: Record<string, string> = {
  binance: 'Binance',
  bingx: 'BingX',
  bybit: 'Bybit',
};

function ExchangeInitials({ name }: { name: string }) {
  const label = EXCHANGE_LABELS[name] ?? name;
  const initials = label.slice(0, 2).toUpperCase();
  return (
    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary shrink-0">
      {initials}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <Badge variant="default" className="bg-green-100 text-green-700 border-green-200">
        <CheckCircle className="w-3 h-3 mr-1" />
        Active
      </Badge>
    );
  }
  if (status === 'invalid') {
    return (
      <Badge variant="destructive">
        <AlertCircle className="w-3 h-3 mr-1" />
        Invalid
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <WifiOff className="w-3 h-3 mr-1" />
      Disconnected
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ExchangesPage() {
  const [data, setData] = useState<ExchangesData | null>(null);
  const [loading, setLoading] = useState(true);

  // Add form
  const [addForm, setAddForm] = useState({
    exchangeName: '',
    apiKey: '',
    apiSecret: '',
    passphrase: '',
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [connectSuccess, setConnectSuccess] = useState(false);

  // Webhook section
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  // Remove exchange
  const [removeTarget, setRemoveTarget] = useState<ConnectedExchange | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/exchanges');
      if (res.ok) {
        const json: ExchangesData = await res.json();
        setData(json);
      }
    } catch {
      // silently ignore network errors on refresh
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ------------------------------------------------------------------
  // Add exchange
  // ------------------------------------------------------------------

  async function handleConnect() {
    setConnecting(true);
    setConnectError('');
    setConnectSuccess(false);

    try {
      const res = await fetch('/api/exchanges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchangeName: addForm.exchangeName,
          apiKey: addForm.apiKey,
          apiSecret: addForm.apiSecret,
          passphrase: addForm.passphrase || undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        setConnectError(json.error ?? 'Connection failed. Please try again.');
        return;
      }

      setConnectSuccess(true);
      setAddForm({ exchangeName: '', apiKey: '', apiSecret: '', passphrase: '' });
      setShowApiKey(false);
      setShowApiSecret(false);
      await fetchData();
      setTimeout(() => setConnectSuccess(false), 4000);
    } catch {
      setConnectError('Network error. Please try again.');
    } finally {
      setConnecting(false);
    }
  }

  // ------------------------------------------------------------------
  // Remove exchange
  // ------------------------------------------------------------------

  async function handleRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    setRemoveError('');

    try {
      const res = await fetch(`/api/exchanges/${removeTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json();
        setRemoveError(json.error ?? 'Failed to remove exchange.');
        return;
      }
      setRemoveTarget(null);
      await fetchData();
    } catch {
      setRemoveError('Network error. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  // ------------------------------------------------------------------
  // Webhook token helpers
  // ------------------------------------------------------------------

  async function handleCopyUrl() {
    if (!data) return;
    await navigator.clipboard.writeText(data.webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleCopyToken() {
    if (!data) return;
    await navigator.clipboard.writeText(data.webhookToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const res = await fetch('/api/exchanges/webhook', { method: 'POST' });
      if (res.ok) {
        const json = await res.json();
        setData((prev) =>
          prev ? { ...prev, webhookToken: json.webhookToken } : prev,
        );
      }
    } catch {
      // silently ignore
    } finally {
      setRegenerating(false);
      setRegenerateOpen(false);
    }
  }

  // ------------------------------------------------------------------
  // Derived state
  // ------------------------------------------------------------------

  const isPaperMode =
    data !== null && data.exchanges.length === 0;

  const tvPayloadExample = JSON.stringify(
    {
      token: '{{strategy.order.comment}}',
      ticker: '{{ticker}}',
      action: '{{strategy.order.action}}',
      contracts: '{{strategy.order.contracts}}',
      price: '{{close}}',
    },
    null,
    2,
  );

  // ------------------------------------------------------------------
  // Loading state
  // ------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Exchange Connections</h1>
        <p className="text-muted-foreground mt-1">
          Manage your exchange API keys, configure your TradingView webhook, and set up trade notifications.
        </p>
      </div>

      {/* Paper-trading notice */}
      {isPaperMode && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Connect an exchange to enable live trading.</span>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Connected exchanges list                                             */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Connected Exchanges</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your linked exchange accounts. API keys are encrypted at rest.
          </p>
        </div>

        {data?.exchanges.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No exchanges connected yet. Use the form below to add one.
          </p>
        ) : (
          <ul className="divide-y">
            {data?.exchanges.map((ex) => (
              <li key={ex.id} className="flex items-center gap-4 py-4">
                <ExchangeInitials name={ex.exchangeName} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">
                      {EXCHANGE_LABELS[ex.exchangeName] ?? ex.exchangeName}
                    </span>
                    <StatusBadge status={ex.status ?? 'active'} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Connected{' '}
                    {ex.connectedAt
                      ? new Date(ex.connectedAt).toLocaleDateString()
                      : 'unknown date'}
                  </p>
                </div>

                {/* Remove button with confirmation dialog */}
                <Dialog
                  open={removeTarget?.id === ex.id}
                  onOpenChange={(open) => {
                    if (!open) {
                      setRemoveTarget(null);
                      setRemoveError('');
                    }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => setRemoveTarget(ex)}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </DialogTrigger>

                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Remove {EXCHANGE_LABELS[ex.exchangeName] ?? ex.exchangeName}?</DialogTitle>
                      <DialogDescription>
                        This will permanently delete the API keys for this exchange.
                        {ex.openPositions > 0 && (
                          <span className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800 text-sm font-normal">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            Warning: you have {ex.openPositions} open{' '}
                            {ex.openPositions === 1 ? 'position' : 'positions'} on this exchange.
                            They will no longer be managed by the platform.
                          </span>
                        )}
                      </DialogDescription>
                    </DialogHeader>

                    {removeError && (
                      <p className="text-sm text-destructive">{removeError}</p>
                    )}

                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline" disabled={removing}>
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        disabled={removing}
                        onClick={handleRemove}
                      >
                        {removing ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Removing...
                          </>
                        ) : (
                          'Remove Exchange'
                        )}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Add exchange form                                                    */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Add Exchange</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Keys are validated against the exchange before saving.
          </p>
        </div>

        {/* Exchange selector */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Exchange</label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={addForm.exchangeName}
            onChange={(e) =>
              setAddForm((f) => ({ ...f, exchangeName: e.target.value }))
            }
          >
            <option value="">-- Select exchange --</option>
            <option value="binance">Binance</option>
            <option value="bingx">BingX</option>
            <option value="bybit">Bybit</option>
          </select>
        </div>

        {/* API Key */}
        <div className="space-y-2">
          <label className="text-sm font-medium">API Key</label>
          <div className="relative">
            <Input
              type={showApiKey ? 'text' : 'password'}
              placeholder="Your API key"
              value={addForm.apiKey}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, apiKey: e.target.value }))
              }
              className="pr-10"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowApiKey((v) => !v)}
              aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
            >
              {showApiKey ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* API Secret */}
        <div className="space-y-2">
          <label className="text-sm font-medium">API Secret</label>
          <div className="relative">
            <Input
              type={showApiSecret ? 'text' : 'password'}
              placeholder="Your API secret"
              value={addForm.apiSecret}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, apiSecret: e.target.value }))
              }
              className="pr-10"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowApiSecret((v) => !v)}
              aria-label={showApiSecret ? 'Hide API secret' : 'Show API secret'}
            >
              {showApiSecret ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Passphrase — always shown; labeled optional except BingX required */}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Passphrase
            {addForm.exchangeName === 'bingx' ? (
              <span className="ml-1 text-xs text-muted-foreground">(required for BingX)</span>
            ) : (
              <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
            )}
          </label>
          <Input
            type="password"
            placeholder={
              addForm.exchangeName === 'bingx'
                ? 'BingX passphrase'
                : 'Passphrase (if required by your exchange)'
            }
            value={addForm.passphrase}
            onChange={(e) =>
              setAddForm((f) => ({ ...f, passphrase: e.target.value }))
            }
          />
        </div>

        {/* Error / success feedback */}
        {connectError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {connectError}
          </div>
        )}
        {connectSuccess && (
          <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
            <CheckCircle className="h-4 w-4 shrink-0" />
            Exchange connected successfully.
          </div>
        )}

        <Button
          onClick={handleConnect}
          disabled={
            connecting ||
            !addForm.exchangeName ||
            !addForm.apiKey ||
            !addForm.apiSecret
          }
          className="w-full sm:w-auto"
        >
          {connecting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Validating...
            </>
          ) : (
            'Validate & Connect'
          )}
        </Button>
      </Card>

      <Separator />

      {/* ------------------------------------------------------------------ */}
      {/* TradingView Webhook section                                          */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">TradingView Webhook</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Use this URL and token in your TradingView alert to route signals to the platform.
          </p>
        </div>

        {/* Webhook URL */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Webhook URL</label>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={data?.webhookUrl ?? ''}
              className="font-mono text-xs bg-muted"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyUrl}
              aria-label="Copy webhook URL"
            >
              {copied ? <CheckCircle className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Secret token */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Secret Token</label>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              type={showToken ? 'text' : 'password'}
              value={data?.webhookToken ?? ''}
              className="font-mono text-xs bg-muted"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyToken}
              aria-label="Copy secret token"
            >
              {copied ? <CheckCircle className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Regenerate token */}
        <Dialog open={regenerateOpen} onOpenChange={setRegenerateOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <RefreshCw className="w-4 h-4 mr-2" />
              Regenerate Token
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Regenerate webhook token?</DialogTitle>
              <DialogDescription>
                This will immediately invalidate your current token. Any TradingView alerts
                still using the old token will stop working until you update them.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={regenerating}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={regenerating}
                onClick={handleRegenerate}
              >
                {regenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Regenerating...
                  </>
                ) : (
                  'Yes, Regenerate'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Separator />

        {/* JSON payload example */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Expected Alert Payload</p>
          <p className="text-xs text-muted-foreground">
            Configure your TradingView alert message body with this JSON. Replace
            the <code className="bg-muted px-1 rounded text-xs">token</code> field
            with your secret token above.
          </p>
          <pre className="rounded-md bg-muted p-4 text-xs font-mono overflow-x-auto whitespace-pre">
            {tvPayloadExample}
          </pre>
        </div>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Notifications section                                               */}
      {/* ------------------------------------------------------------------ */}
      <NotificationsSection />
    </div>
  );
}
