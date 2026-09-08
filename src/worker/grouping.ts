/**
 * Confluence-group bucketing: O(n) hash-map partition, no pairwise comparison.
 *
 * Grouping key = symbol + the group's users' own connected exchange +
 * marketType, so analysis runs against the exchange/market each user
 * actually trades on rather than a hardcoded default that may not even list
 * their symbol. A spot BTC/USDT candle series is materially different from
 * a swap/perpetual one, so two users on the same symbol+exchange but
 * different marketType must not be merged into one group.
 * `strategies`/`preferredTimeframes` on user_risk_profiles don't currently
 * affect the analysis output at all (the agent prompt never includes them),
 * so they cannot fragment groups.
 */

import type { EligibleUser, ExchangeName } from './eligibility';
import type { MarketType } from '@/lib/user-trading-context';

export interface ConfluenceGroup {
  key: string;
  symbol: string;
  referenceExchange: ExchangeName;
  referenceMarketType: MarketType;
  users: EligibleUser[];
}

export function buildConfluenceKey(params: {
  symbol: string;
  referenceExchange: string;
  referenceMarketType: string;
}): string {
  return `${params.symbol}::${params.referenceExchange}::${params.referenceMarketType}`;
}

export function groupIntoConfluenceGroups(users: EligibleUser[]): ConfluenceGroup[] {
  const groups = new Map<string, ConfluenceGroup>();

  for (const user of users) {
    for (const symbol of user.symbols) {
      const referenceExchange = user.exchange;
      const referenceMarketType = user.marketType;
      const key = buildConfluenceKey({ symbol, referenceExchange, referenceMarketType });
      let group = groups.get(key);
      if (!group) {
        group = { key, symbol, referenceExchange, referenceMarketType, users: [] };
        groups.set(key, group);
      }
      group.users.push(user);
    }
  }

  return [...groups.values()];
}
