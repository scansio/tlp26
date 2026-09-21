/**
 * Canonical symbol form is plain human "BASE/QUOTE" (e.g. "BTC/USDT") — see
 * src/mastra/tools/market-symbol.ts. Any array of raw user-entered symbols
 * (typed, pasted, or produced by the setup-agent LLM) may contain an element
 * that is itself a comma/whitespace-joined list rather than one symbol per
 * element, so this always re-splits before trusting the input.
 */
export function normalizeSymbolList(raw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of raw) {
    for (const token of entry.split(/[,\s]+/)) {
      const trimmed = token.trim().toUpperCase();
      if (!trimmed) continue;
      const symbol = trimmed.includes('/') ? trimmed : `${trimmed}/USDT`;
      if (!seen.has(symbol)) {
        seen.add(symbol);
        result.push(symbol);
      }
    }
  }

  return result;
}
