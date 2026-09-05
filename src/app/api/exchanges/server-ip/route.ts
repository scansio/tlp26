import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/exchanges/server-ip — this server's outbound public IP, for users
// whose exchange (e.g. Binance, Bybit) requires IP-whitelisting an API key.
// Cached in-memory since egress IP on a fixed host essentially never changes.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { ip: string; fetchedAt: number } | null = null;

async function fetchOutboundIp(): Promise<string> {
  const sources = ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip'];

  for (const url of sources) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeout);
      if (!res.ok) continue;

      if (url.includes('ipify')) {
        const json = await res.json();
        if (typeof json.ip === 'string') return json.ip;
      } else {
        const text = (await res.text()).trim();
        if (text) return text;
      }
    } catch {
      // try next source
    }
  }

  throw new Error('Unable to determine outbound IP from any source');
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ ip: cache.ip });
  }

  try {
    const ip = await fetchOutboundIp();
    cache = { ip, fetchedAt: Date.now() };
    return NextResponse.json({ ip });
  } catch {
    return NextResponse.json({ error: 'Unable to determine server IP' }, { status: 502 });
  }
}
