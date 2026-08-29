# memecoin-sniper

A low-latency Solana launch sniper built around one idea: **the trade is won or
lost in the first few hundred milliseconds, and survived or not in the next few
minutes.** Everything here serves one of those two windows.

It is not a generic "swap bot with a UI". There is no strategy marketplace, no
copy-trading, no dashboard to click. It does one thing: watch new pump.fun
bonding curves, decide within a hard time budget whether a launch is worth
capital, size the trade against explicit risk limits, and then manage the exit
without further input.

> **This project is unaffiliated with pump.fun, Raydium, Jito or Solana Labs.**
> It reimplements public on-chain interfaces from their observable behaviour.

---

## Why it is shaped this way

Three constraints drive every design decision.

**1. Latency is the strategy.** By the time a public RPC surfaces a new mint,
several hundred milliseconds of the opportunity are gone. So: the create event
is decoded straight out of the log stream (no transaction fetch), the blockhash
and fee estimate are kept hot in memory, PDAs are derived locally, the token
account is created idempotently in the same transaction, and the signed bytes
are fired at every endpoint at once. The only unavoidable network step in the
entry path is the broadcast itself.

**2. Information has a price, and the price is time.** A thorough rug check
takes seconds; a snipe has a hundred milliseconds. The filter is therefore split
in two. A **hot** stage runs before the trade under a hard budget and spends at
most one raced multi-account read. A **cold** stage runs continuously *after*
entry, where seconds are affordable, and its findings drive exits. Blowing the
hot budget aborts the trade rather than entering blind — a late entry with less
information is the worst of both worlds.

**3. The exit is the edge.** Anyone can buy a new mint. The difference between
a profitable run and a blown account is entirely in what happens over the next
three minutes: scaling out on the way up, trailing only once genuinely ahead,
and dumping instantly when the creator starts selling.

---

## Architecture

```
   RPC #1 ─┐
   RPC #2 ─┼─▶ detectors ──▶ dispatcher ──▶ hot filter ──▶ scorer ──▶ risk engine
   RPC #3 ─┘   (log subs)     (dedup,        (≤120ms,      (0..1,     (size, caps,
                               first wins)    ≤1 read)     vetoes)     halts)
                                                                          │
                                        ┌─────────────────────────────────┘
                                        ▼
                                    executor ──▶ sender ──▶ [ RPC fan-out + Jito ]
                                        │        (re-broadcast until confirmed)
                                        ▼
                              position manager ◀── cold auditor
                              (ladder, trailing,   (dev sells, migration,
                               stops, timeouts)     holder concentration)
```

| Module | Responsibility |
| --- | --- |
| `chain/rpcPool` | Health-scored endpoint pool. `call()` fails over, `race()` fans out. |
| `chain/blockhash` | Keeps a blockhash hot so the entry is built from memory. |
| `chain/fees` | Tracks network priority fees; escalates them per exit retry. |
| `chain/sender` | Fires signed bytes at every route, re-broadcasts until confirmed. |
| `chain/jito` | Bundle submission with the tip in the same transaction as the swap. |
| `detect/pumpfun` | Decodes `CreateEvent` from logs — mint, curve and creator, no fetch. |
| `detect/raydium` | Watches AMM v4 `initialize2` for migrations. |
| `detect/dispatcher` | Deduplicates across nodes; measures the provider edge. |
| `analysis/hotFilter` | Pre-trade checks under a hard time budget. |
| `analysis/scorer` | Weighted signals → 0..1 score, with disqualifying vetoes. |
| `analysis/coldAudit` | Post-entry surveillance: dev selling, migration, concentration. |
| `analysis/reputation` | Persistent creator history; blacklists repeat ruggers. |
| `risk/riskEngine` | Sizing, exposure cap, daily loss limit, loss-streak cooldown. |
| `position/manager` | The exit policy. `decide()` is pure and fully unit-tested. |
| `position/store` | Crash-durable book — a restart resumes management, not amnesia. |

---

## What it actually checks before buying

Nothing here costs more than one raced RPC read.

**Disqualifying (veto — the score is not even computed):**

- freeze authority retained → the holder can freeze your token account
- mint authority held by anyone but the bonding curve → unlimited supply
- the creator wallet has rugged before (persistent local history)
- the event's bonding curve does not match the locally derived PDA
- the curve is already complete, or does not exist yet
- price impact ≥ 35% for the configured size → no exit liquidity
- zero-width or bidi control characters in the name → ticker impersonation
- the event is stale, or the on-chain read blew the time budget

**Scored (weighted, safety signals outweigh cosmetic ones):**

- how much of the curve was already bought — untouched is the whole point
- price impact for the configured clip size
- detection freshness in milliseconds
- creator reputation and launch-spam rate
- metadata plausibility

The score then sets the position size: a launch that barely clears the threshold
gets 40% of the base clip, a high-conviction one gets 100%. Sizing on conviction
is what turns a positive-expectancy filter into a positive-expectancy account.

## What it does after buying

Rules run in priority order; the most aggressive one that fires wins.

1. **Rug signal** — creator dumping, curve vanished, migration → full exit, max urgency.
2. **Hard stop** — down past `HARD_STOP_PCT` → full exit.
3. **Trailing stop** — arms only above `TRAILING_ARM_MULTIPLE`, so a normal
   first-minute wick cannot stop out a good entry.
4. **Take-profit ladder** — scales out at each rung; a violent candle through
   several levels takes the *highest* one cleared, not the lowest.
5. **Stagnation / max hold** — flat capital is capital unavailable for the next
   launch, which is the real cost in this game.

Failed exits escalate: each retry raises the priority fee, and from urgency 3
the minimum output drops to zero because at that point the only thing that
matters is that the sell lands. Six consecutive failures halt the bot.

---

## Setup

```bash
cd memecoin-sniper
npm install
cp .env.example .env      # then edit it
npm run doctor            # verifies RPC, program layout, wallet, fee conditions
npm run dev               # paper mode
```

Commands:

| Command | What it does |
| --- | --- |
| `npm run doctor` | Pre-flight: RPC latency, program layout, discriminators, wallet, fees. |
| `npm run watch` | Detects and scores real launches, prints `WOULD ENTER`. Never trades. |
| `npm run dev` | Full loop. Paper unless `MODE=live`. |
| `npm test` | Unit tests for the curve math, scorer, risk engine and exit policy. |
| `npm run build` | Compile to `dist/`. |

Start with `watch` for a few hours. It costs nothing and tells you whether
`MIN_SCORE` is set anywhere near sanely for current conditions.

### The one setting that matters most

`RPC_HTTP`. A public endpoint is not competitive — not "slightly worse",
not competitive. The bot subscribes to every endpoint listed and acts on
whichever reports a launch first, and the dashboard prints `rpc edge`, the
measured gap between your fastest and slowest provider. If that number is large,
your slow providers are costing you every contested trade.

---

## Verify before going live

Two things in this codebase are reverse-engineered from a deployed program and
can be invalidated by a redeploy at any time, with no warning:

- **The buy/sell account ordering.** pump.fun changed it when creator fee vaults
  were introduced. Both orderings are implemented (`v1` and `creator-vault`) and
  `doctor` probes a live launch to report which is in force — the bonding curve
  account grew by 32 bytes, which is an unambiguous fingerprint. If the wrong
  one is selected, *every* transaction reverts, and it looks like bad luck
  rather than a bug.
- **Instruction discriminators.** These are derived at runtime from
  `sha256("global:<name>")` rather than hardcoded, and `doctor` cross-checks
  them against the committed constants.

`doctor` must pass before `MODE=live`. It is not a formality; it is the
difference between a bot that trades and a bot that burns fees on reverts.

---

## Honest limitations

- **Raydium launches are detected but not traded natively.** The fast path is
  pump.fun bonding curves only. A Raydium swap needs the full Serum market
  account set, which is a meaningful amount of additional state; migrations are
  reported and logged, not entered.
- **Realised PnL is marked at the last observed price**, not parsed from the
  transaction's token balance deltas. It is accurate enough to drive stops and
  the daily loss limit, and it is *not* an accounting record. Reconcile against
  the wallet.
- **The paper executor models frictions it cannot know exactly.** It assumes
  0.3–2.5 SOL of competing flow lands ahead of every entry, and charges priority
  fees, protocol fees and urgency slippage. Real fills will differ. Paper results
  are for tuning filters, never for projecting returns.
- **No Geyser/gRPC ingestion.** Websocket log subscriptions are the floor for
  this kind of bot, not the ceiling; a Yellowstone gRPC feed would be the next
  meaningful latency win.
- **Single wallet.** No rotation, so entries are trivially attributable and
  copy-tradeable on-chain.

---

## Risk

Sniping new memecoin launches is among the highest-variance activities in
crypto. The overwhelming majority of new tokens go to zero, many are designed
from the outset to take your money, and the filters here reduce that exposure —
they do not remove it. A hostile launch can pass every check in this repository.

The defaults reflect that: `MODE=paper`, a small clip, a hard daily loss limit,
and a cooldown after consecutive losses. Fund a dedicated wallet with an amount
you are fully prepared to lose, and keep the reserve setting high enough to pay
for your own exits. Nothing here is financial advice.
