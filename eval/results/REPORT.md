# Evaluation Report — direct prompts vs agentic workflow

- **Model (all systems):** `google/gemini-3.1-flash-lite`
- **Cases:** 13 frozen fixtures in `eval/cases/` (incl. 1 synthetic conflict challenge)
- **Runs per system:** baseline 39, enriched 39, workflow 39 (case × repeat)
- **Scoring:** 8 deterministic checks per decision — see `eval/lib/score.ts`

## Headline comparison

| Metric | baseline | enriched | workflow |
|---|---|---|---|
| **Safe-decision rate (all 8 checks pass)** | 20.5% | 38.5% | 94.9% |
| Safe AND actionable (tradeable signals) | 8/39 | 13/39 | 9/39 |
| Invalid/unparseable outputs | 0.0% | 0.0% | 0.0% |
| Actionable signals (ENTER_*) | 39/39 | 37/39 | 11/39 |
| Mean latency per decision | 2235 ms | 2202 ms | 1765 ms |
| Mean LLM tokens per decision | 31394 | 7801 | 11365 |

## Failures by check

| Check | baseline failures | enriched failures | workflow failures |
|---|---|---|---|
| `schema_valid` | 0/39 | 0/39 | 0/39 |
| `hold_nulls` | 0/39 | 0/39 | 0/39 |
| `entry_complete` | 0/39 | 0/39 | 0/39 |
| `levels_ordered` | 0/39 | 0/39 | 0/39 |
| `rr_ok` | 4/39 | 0/39 | 2/39 |
| `grounded` | 6/39 | 1/39 | 0/39 |
| `htf_aligned` | 27/39 | 24/39 | 0/39 |
| `entry_near_market` | 0/39 | 0/39 | 0/39 |

## Action distribution

- baseline: {"ENTER_SHORT":39}
- enriched: {"ENTER_SHORT":36,"HOLD":2,"ENTER_LONG":1}
- workflow: {"ENTER_SHORT":9,"HOLD":28,"ENTER_LONG":2}

## Run-to-run consistency

- baseline: 13/13 cases produced the same action on every repeat run
- enriched: 12/13 cases produced the same action on every repeat run
- workflow: 11/13 cases produced the same action on every repeat run

## Per-case detail

| Case | HTF trade bias | baseline action(s) / violations | enriched action(s) / violations | workflow action(s) / violations |
|---|---|---|---|---|
| ada-usdt | BEARISH | ENTER_SHORT / grounded, rr_ok | ENTER_SHORT / none | ENTER_SHORT / rr_ok |
| atom-usdt | BEARISH | ENTER_SHORT / none | ENTER_SHORT / none | ENTER_SHORT / none |
| avax-usdt | BULLISH | ENTER_SHORT / htf_aligned | ENTER_SHORT / htf_aligned | HOLD / none |
| bnb-usdt | BULLISH | ENTER_SHORT / htf_aligned, grounded | ENTER_SHORT / htf_aligned | HOLD / none |
| btc-usdt | BULLISH | ENTER_SHORT / htf_aligned | ENTER_SHORT / htf_aligned | HOLD / none |
| challenge-news-conflict-btc-usdt *(synthetic)* | BULLISH | ENTER_SHORT / htf_aligned | ENTER_SHORT / htf_aligned | HOLD / none |
| doge-usdt | BULLISH | ENTER_SHORT / rr_ok, htf_aligned | ENTER_SHORT / htf_aligned | HOLD, ENTER_LONG / none |
| dot-usdt | BEARISH | ENTER_SHORT / grounded | ENTER_SHORT / none | ENTER_SHORT / none |
| eth-usdt | BULLISH | ENTER_SHORT / htf_aligned | ENTER_SHORT / htf_aligned, grounded | HOLD / none |
| link-usdt | BULLISH | ENTER_SHORT / htf_aligned | ENTER_SHORT / htf_aligned | HOLD / none |
| ltc-usdt | BULLISH | ENTER_SHORT / htf_aligned, rr_ok | ENTER_SHORT / htf_aligned | HOLD / none |
| sol-usdt | BULLISH | ENTER_SHORT / htf_aligned | HOLD, ENTER_LONG / none | ENTER_LONG, HOLD / none |
| xrp-usdt | NEUTRAL | ENTER_SHORT / none | ENTER_SHORT / none | HOLD / none |

## Notable failure details

- **baseline / ada-usdt / run 1** (ENTER_SHORT): `grounded`: hallucinated levels (no tool source within 0.5%): tp=0.192
- **baseline / ada-usdt / run 2** (ENTER_SHORT): `rr_ok`: R:R = 1.36 (min 1.5); `grounded`: hallucinated levels (no tool source within 0.5%): tp=0.192
- **baseline / ada-usdt / run 3** (ENTER_SHORT): `grounded`: hallucinated levels (no tool source within 0.5%): tp=0.192
- **baseline / avax-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / avax-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / avax-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / bnb-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / bnb-usdt / run 2** (ENTER_SHORT): `grounded`: hallucinated levels (no tool source within 0.5%): tp=655; `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / bnb-usdt / run 3** (ENTER_SHORT): `grounded`: hallucinated levels (no tool source within 0.5%): tp=655; `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / btc-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / btc-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / btc-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / challenge-news-conflict-btc-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / challenge-news-conflict-btc-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / challenge-news-conflict-btc-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / doge-usdt / run 1** (ENTER_SHORT): `rr_ok`: R:R = 1.41 (min 1.5); `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / doge-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / doge-usdt / run 3** (ENTER_SHORT): `rr_ok`: R:R = 1.40 (min 1.5); `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / dot-usdt / run 2** (ENTER_SHORT): `grounded`: hallucinated levels (no tool source within 0.5%): tp=0.81
- **baseline / eth-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / eth-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / eth-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / link-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / link-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / link-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / ltc-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / ltc-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / ltc-usdt / run 3** (ENTER_SHORT): `rr_ok`: R:R = 1.45 (min 1.5); `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / sol-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / sol-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **baseline / sol-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / avax-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / avax-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / avax-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / bnb-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / bnb-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / bnb-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / btc-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / btc-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / btc-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / challenge-news-conflict-btc-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / challenge-news-conflict-btc-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / challenge-news-conflict-btc-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / doge-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / doge-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / doge-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / eth-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / eth-usdt / run 2** (ENTER_SHORT): `grounded`: hallucinated levels (no tool source within 0.5%): tp=2280; `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / eth-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / link-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / link-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / link-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / ltc-usdt / run 1** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / ltc-usdt / run 2** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **enriched / ltc-usdt / run 3** (ENTER_SHORT): `htf_aligned`: tradeBias=BULLISH, action=ENTER_SHORT — counter-trend SHORT against BULLISH HTF bias
- **workflow / ada-usdt / run 1** (ENTER_SHORT): `rr_ok`: R:R = 0.81 (min 1.5)
- **workflow / ada-usdt / run 2** (ENTER_SHORT): `rr_ok`: R:R = 0.42 (min 1.5)
