'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Publisher {
  id: string;
  displayName: string | null;
  strategyDescription: string | null;
  totalSignals: number | null;
  winRate: string | null;
  sharpeRatio: string | null;
  avgRR: string | null;
  feePercent: string | null;
  subscriberCount: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Publisher card
// ---------------------------------------------------------------------------

function PublisherCard({ publisher }: { publisher: Publisher }) {
  return (
    <Card className="p-4 md:p-5 space-y-3 hover:border-primary/60 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold break-words">
            {publisher.displayName ?? 'Anonymous Publisher'}
          </h3>
          {publisher.strategyDescription && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {publisher.strategyDescription}
            </p>
          )}
        </div>
        {publisher.feePercent && Number(publisher.feePercent) > 0 && (
          <Badge variant="outline" className="text-xs shrink-0">
            {Number(publisher.feePercent).toFixed(1)}% fee
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 gap-x-2 text-sm pt-2 border-t border-border">
        <div className="text-center">
          <p className="font-semibold">
            {publisher.winRate != null
              ? `${Number(publisher.winRate).toFixed(1)}%`
              : '—'}
          </p>
          <p className="text-xs text-muted-foreground">Win Rate</p>
        </div>
        <div className="text-center">
          <p className="font-semibold">{publisher.totalSignals ?? '—'}</p>
          <p className="text-xs text-muted-foreground">Signals</p>
        </div>
        <div className="text-center">
          <p className="font-semibold">
            {publisher.avgRR != null ? Number(publisher.avgRR).toFixed(2) : '—'}
          </p>
          <p className="text-xs text-muted-foreground">Avg R:R</p>
        </div>
        <div className="text-center">
          <p className="font-semibold">{publisher.subscriberCount ?? 0}</p>
          <p className="text-xs text-muted-foreground">Followers</p>
        </div>
      </div>

      <Link href={`/copy/${publisher.id}`} className="block">
        <Button variant="outline" size="sm" className="w-full mt-1 h-11 md:h-9">
          View Profile &amp; Subscribe
        </Button>
      </Link>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Publishers directory page
// ---------------------------------------------------------------------------

export default function CopyTradingPage() {
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    fetch('/api/copy/publishers')
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? 'Failed to load publishers');
        }
        return res.json();
      })
      .then((data: { publishers: Publisher[] }) => setPublishers(data.publishers))
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-red-600">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto w-full py-6 md:py-10 px-4 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Signal Publishers</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Follow expert traders and auto-copy their signals to your account.
          </p>
        </div>
        <Link href="/copy/subscriptions" className="block">
          <Button variant="outline" size="sm" className="w-full sm:w-auto h-11 md:h-9">
            My Subscriptions
          </Button>
        </Link>
      </div>

      {publishers.length === 0 ? (
        <Card className="p-6 md:p-8 text-center">
          <p className="text-muted-foreground">
            No public signal publishers available yet.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {publishers.map((pub) => (
            <PublisherCard key={pub.id} publisher={pub} />
          ))}
        </div>
      )}
    </div>
  );
}
