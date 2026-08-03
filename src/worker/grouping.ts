/**
 * Confluence-group bucketing: O(n) hash-map partition, no pairwise comparison.
 *
 * Grouping key = symbol alone, analyzed against one canonical reference
 * exchange. `strategies`/`preferredTimeframes` on user_risk_profiles don't
 * currently affect the analysis output at all (the agent prompt never
 * includes them), so they cannot fragment groups. `exchange` does change
 * order-book/market-data output, but grouping by each user's own connected
 * exchange would needlessly fragment a symbol into up to 3 sub-groups for no
 * analytical benefit — so analysis always runs against one reference
 * exchange, decoupled from each user's own execution exchange (which stays
 * per-user and is only consulted at finalize time).
 */

import type { EligibleUser, ExchangeName } from './eligibility';

export interface ConfluenceGroup {
  key: string;
  symbol: string;
  referenceExchange: ExchangeName;
  users: EligibleUser[];
}

export function buildConfluenceKey(params: { symbol: string; referenceExchange: string }): string {
  return `${params.symbol}::${params.referenceExchange}`;
}

export function groupIntoConfluenceGroups(
  users: EligibleUser[],
  referenceExchange: ExchangeName,
): ConfluenceGroup[] {
  const groups = new Map<string, ConfluenceGroup>();

  for (const user of users) {
    for (const symbol of user.symbols) {
      const key = buildConfluenceKey({ symbol, referenceExchange });
      let group = groups.get(key);
      if (!group) {
        group = { key, symbol, referenceExchange, users: [] };
        groups.set(key, group);
      }
      group.users.push(user);
    }
  }

  return [...groups.values()];
}
