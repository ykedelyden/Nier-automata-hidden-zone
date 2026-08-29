# Operating guide

How to actually run this thing, in the order you should do it, and what every
number on screen is telling you.

Read [`README.md`](../README.md) first for what the bot does. This document is
about running it without losing money to your own configuration.

---

## 1. The four phases

Do not skip a phase. Each one answers a question the next one depends on.

| Phase | Command | Duration | Question it answers |
| --- | --- | --- | --- |
| 1. Pre-flight | `npm run doctor` | 2 min | Is my infrastructure even viable? |
| 2. Observation | `npm run watch` | 4–24 h | Is my filter calibrated for current conditions? |
| 3. Paper | `npm run dev` (`MODE=paper`) | 2–5 days | What does the trade distribution actually look like? |
| 4. Micro-live | `npm run dev` (`MODE=live`) | 2 weeks | Do real fills match the paper assumptions? |

### Phase 1 — `doctor`

Must be fully green before anything else. What each check is protecting you from:

- **rpc latency** — anything over ~200ms means you are not in the race. Under
  80ms is competitive.
- **instruction discriminators** — a mismatch means the program was redeployed
  with different instruction names. Stop; the code needs updating.
- **account layout** — probes a live launch to fingerprint which buy/sell
  account ordering is in force. **If this is wrong, every single transaction
  reverts and it looks like bad luck rather than a bug.**
- **priority fees** — compares your configured floor to the network's current
  p75. If yours is lower, you lose every contested block.
- **wallet** — balance must cover the reserve plus at least one clip.

### Phase 2 — `watch`

Detects and scores real launches, prints `WOULD ENTER`, never sends an order.
It costs nothing but RPC calls. You are looking for two things:

- **Entry rate.** Roughly 1–5 `WOULD ENTER` per hour is a healthy filter. Zero
  means `MIN_SCORE` is too high or the budget is too tight. Dozens per hour
  means the filter is decorative and you are about to buy everything.
- **`filterMs`.** If p90 is near `HOT_FILTER_BUDGET_MS`, your RPC is too slow
  and you are aborting trades on timeout — check `filter.hot.timeout`.

Run this overnight before touching paper mode.

### Phase 3 — paper

Real chain state, real prices, imaginary money. What you are measuring is the
**shape of the outcome distribution**, not the PnL — the PnL is fiction because
the fill model is an assumption (see §5).

The number that decides everything: **what fraction of positions hit the hard
stop.** Above ~50%, the strategy is negative no matter how good the winners
are. Below ~43%, it turns positive. That single ratio is the whole game.

### Phase 4 — micro-live

Start at `BUY_LAMPORTS=5000000` (0.005 SOL) regardless of what you plan to
trade. You are not trying to make money in this phase; you are checking that
real fills resemble paper fills. Compare, over at least 30 trades:

- realised entry price vs. the paper model's assumed entry
- `send.land.buy` p50 — how long a buy actually takes to confirm
- the count of `position.entry_failed` — reverts, timeouts, empty fills

If live entries are systematically worse than paper by more than ~30%, your
frontrun assumption is too optimistic and the expectancy model is wrong.
Scale size only after this matches.

---

## 2. Infrastructure: the decisive factor

Everything else in this document is a rounding error next to your RPC.

A fresh pump.fun curve starts at 30 virtual SOL. Because price scales with the
square of the SOL side, the flow that lands *ahead of you* sets your basis:

| SOL that landed first | Your entry price vs. the floor |
| --- | --- |
| 2 SOL | 1.14x |
| 5 SOL | 1.36x |
| 15 SOL | 2.25x |
| 25 SOL | 3.36x |
| 50 SOL | 7.11x |

A bot on a dedicated endpoint enters at ~400ms with maybe 3–8 SOL ahead of it
(1.2–1.6x basis). The same bot on a public endpoint enters 1–2 seconds later,
by which time a hot launch has taken 20–40 SOL (2.8–5.4x basis). **Same code,
same filter, three to four times worse entry** — and since the exit price is
identical either way, that is a three-to-four-fold difference in return.

Practical rules:

- List **several** endpoints in `RPC_HTTP`. The bot subscribes to all of them
  and acts on whichever reports first; you get the minimum latency, not the
  average.
- Put dedicated/staked senders in `SEND_RPC_HTTP` if you have them.
- Watch the `rpc edge` line on the dashboard. It is the measured gap between
  your fastest and slowest provider. A large number means your slow providers
  are dead weight — but keep them, they cost you nothing and occasionally win.
- A public endpoint is not "slightly worse". It is not competitive. Do not run
  phase 4 on one.

---

## 3. Reading the dashboard

The status block prints every 20 seconds.

```
──── STATUS ───────────────────────────────────────
  day=2026-08-29  realised=0.0412 SOL  trades=17 wins=4  exposure=0.0400 SOL
  launches=1284 (dupes 3891)  skipped=1271  entered=13  entryFail=2
──── LATENCY (ms) ─────────────────────────────────
  filter   p50=61 p90=94 p99=118 n=1284
  buy land p50=812 p90=1640 p99=2900 n=13
  rpc edge p50=180 p90=410  (gap between fastest and slowest provider)
  fees     p50=180000 p75=420000 p95=1900000 µlamports/CU (n=142)
  rpc      helius:44  triton:51  mainnet-beta:288(rested)
```

| Line | What it means | What to do about it |
| --- | --- | --- |
| `realised` | Closed PnL for the UTC day. Drives the daily loss halt. | If it approaches `DAILY_LOSS_LIMIT_LAMPORTS`, the bot stops itself. |
| `dupes` | Same launch reported by more than one node. **High is good** — it means redundancy is working. | If dupes ≈ 0 you effectively have one feed. |
| `skipped` | Launches the filter rejected. Should be >90% of launches. | Below 90%, `MIN_SCORE` is too low. |
| `entryFail` | Confirmed sends that produced no tokens, or reverts. | More than ~10% of entries: suspect the wrong account layout. Re-run `doctor`. |
| `filter p90` | Pre-trade analysis time. | Near the budget → RPC too slow, you are timing out into vetoes. |
| `buy land p50` | Detection to confirmed entry. | Over ~1500ms you are consistently late; raise priority fees or improve RPC. |
| `rpc edge` | Provider spread. | Large → your fast provider is carrying the whole operation. |
| `fees p95` | Network priority fee spikes. | If p95 exceeds `PRIORITY_FEE_MAX_MICROLAMPORTS`, your exits will fail during congestion. Raise the cap. |
| `(rested)` | A node failed repeatedly and is benched for 15s. | Persistent → drop that endpoint. |

The `OPEN` block shows live positions with current multiple, peak multiple, and
which ladder rungs have been taken.

---

## 4. Tuning: symptom → knob

| Symptom | Cause | Fix |
| --- | --- | --- |
| Zero entries over hours | Filter too strict, or timing out | Lower `MIN_SCORE` by 0.05 steps; check `filter.hot.timeout` |
| Entering dozens per hour | Filter decorative | Raise `MIN_SCORE` to 0.6–0.7 |
| Most positions hit the hard stop | Entering too late, or too loose | Fix RPC first, then raise `MIN_SCORE`. Do not widen the stop |
| Stopped out then it runs | Trailing armed too early | Raise `TRAILING_ARM_MULTIPLE` to 1.6–1.8 |
| Winners give back their gains | Ladder too back-loaded | Move weight to the 1.6x rung |
| Exits repeatedly fail | Fee cap too low | Raise `PRIORITY_FEE_MAX_MICROLAMPORTS` |
| Entries revert immediately | Wrong account layout | Re-run `doctor` — this is the one that looks like bad luck |
| `filterMs` p90 at the budget | RPC too slow | Better endpoint. Raising the budget makes you lose the race instead |

**Do not widen `HARD_STOP_PCT` to reduce the stop-out rate.** The stop-out rate
is a measurement of entry quality; loosening the stop hides the problem and
makes each loss bigger. Fix the entry.

### On `JITO_ENABLED`

The default tip of 200,000 lamports is **1% of a 0.02 SOL clip** — comparable
to the entire protocol fee. Jito only makes economic sense once your clip is
large enough that the tip is a small fraction of it, or on launches contested
enough that you would otherwise not land at all. At small size, leave it off.

---

## 5. The expectancy model

Per-trade expectancy under the default ladder (1.6x:35%, 2.5x:30%, 5x:20%,
10x:15%), a 28% trailing stop armed at 1.4x, a −45% hard stop, and ~4% round-trip
fee drag:

| Scenario | Hard stops | Flat | Small run | Good run | Big run | EV / trade |
| --- | --- | --- | --- | --- | --- | --- |
| Public RPC, late fills | 62% | 22% | 10% | 5% | 1% | **−18.3%** |
| Paid RPC, filter working | 52% | 24% | 15% | 7% | 2% | **−6.9%** |
| Fast RPC + good filter | 45% | 22% | 19% | 10% | 4% | **+6.9%** |

**Breakeven sits at roughly a 43% hard-stop rate.** Everything else — the ladder
weights, the trailing distance, the scoring — moves this by a few points. The
hard-stop rate moves it by tens of points, and the hard-stop rate is set almost
entirely by how fast you enter.

These probabilities are illustrative, not measured. Phases 2 and 3 exist to
replace them with your own numbers. Re-run the model with your observed
distribution before scaling size.

Round-trip fee drag on a 0.02 SOL clip, for reference:

| Component | Cost | % of clip |
| --- | --- | --- |
| Protocol fee (1% each way) | 0.000400 SOL | 2.00% |
| Priority fee, buy | 0.000060 SOL | 0.30% |
| Priority fees, 4 ladder sells | 0.000280 SOL | 1.40% |
| Base transaction fees | 0.000025 SOL | 0.12% |
| **Total without Jito** | **0.000765 SOL** | **3.82%** |
| Jito tip, if enabled | 0.000200 SOL | 1.00% |

---

## 6. Failure modes and what they look like

| In the logs | Meaning | Action |
| --- | --- | --- |
| `no RPC endpoint answered` at startup | No connectivity | Check endpoints; the bot refuses to run blind by design |
| `blockhash stale by …` | Blockhash cache cold | Entries abort rather than sending a dead transaction. Check RPC health |
| `chain-read-timeout` vetoes | Filter blowing its budget | RPC too slow — this is a veto, not a warning |
| `entry confirmed but the token account is empty` | Landed but filled nothing | Usually a curve that completed mid-flight |
| `cannot exit … after 6 attempts` | Structural exit failure | Bot halts itself. Investigate manually before resuming |
| `TRADING HALTED daily-loss-limit` | Loss limit hit | Intentional. Clears at UTC midnight |
| `recovered open positions from a previous run` | Restarted holding a bag | Management resumed automatically |
| `abandoned in-flight entry after restart` | Died mid-entry | **Reconcile manually** — the bot cannot know if it filled |

---

## 7. Operational hygiene

- **Dedicated wallet, funded with what you can lose entirely.** Not your main
  wallet, not a hardware wallet, not one holding anything else.
- **Keep `MIN_WALLET_RESERVE_LAMPORTS` generous.** It pays for your exits. A
  wallet that cannot afford priority fees during a dump cannot sell.
- **Ctrl+C does not liquidate.** This is deliberate: the position book is
  durable and management resumes on restart. Dumping a bag because you pressed
  Ctrl+C is its own kind of loss. To flatten, let the exits run.
- **`state/` is your history.** `reputation.json` (creator blacklist) gets more
  valuable the longer it runs — it is the one asset here that compounds. Back
  it up; do not delete it between runs.
- **The daily loss limit is a floor, not a target.** If you hit it more than
  once a week, the problem is upstream of the limit.
- **Re-run `doctor` after any period of downtime.** Programs get redeployed.

---

## 8. What this bot cannot see

It has **no social input at all**. Whether a memecoin runs is largely decided by
Twitter attention, a KOL mention, or a community forming in the first minutes —
and none of that is on chain. Every signal here is structural (authorities,
curve state, creator history, price impact).

That is a real and permanent blind spot, not a missing feature. It means the bot
wins on *execution* and is blind on *selection*. A human watching the right
feeds has information this bot cannot access, and no amount of latency
optimisation substitutes for it.
