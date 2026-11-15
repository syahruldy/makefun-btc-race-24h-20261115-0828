// Tiered dip-reversion bot for the make.fun btc-race-24h bounty.
//
// Idea (adapted from the public leaderboard's top rows, all dip buyers, and from
// classic mean-reversion practice): cbBTC mean-reverts after sharp drops, so buy
// significant dips below a medium-term average and sell the rebound. The thresholds,
// the averaging window and the exits are my own choices, tuned on the dev window
// with the kit's local grader, not a copy of any other entry.
//
//   - Indicator: SMA(90) of the 1-minute closes of CBBTC (a gap adds nothing).
//   - Entry, in two tiers, on a bar's close (filled at the next bar's open):
//       tier 1: close <= MA90 * 0.985  -> buy 50% of equity
//       tier 2: close <= 1% below the tier-1 entry close -> buy the remaining cash
//     A direct plunge to tier 2's MA level buys everything in one order. After a
//     full exit the tiers reset, so a later dip re-enters.
//   - Exit, the whole position, on the first of:
//       stop:     position worth <= 98% of its cost (falling-knife guard)
//       trail:    once the position has peaked >= 101% of cost, a 0.8% giveback
//                 from the peak (lets a real rebound run, banks a small one)
//       target:   position worth >= 103% of its cost
//       stale:    held 180 bars without an exit (capital back for the next dip)
//       end:      batch seq >= 1430 (flatten before the window closes)
//     Note: there is deliberately no "price crossed back above the average" exit:
//     on a falling average that fires below the entry price (v1 lost $3.07 that
//     way). Every exit here is measured against the position's own cost.
//   - Fallback: if no trade has happened by bar 1100 (a window with no real dip),
//     a mild dip (close <= MA90 * 0.992) buys 50%, with a tighter target (+1%) and
//     stop (-1.5%), so the entry still makes the >= 1 trade guardrail.
//   - Every order caps slippage at 150 bps past the close it was decided on, so a
//     buy into a gap-up open is refused (and re-decided next bar) rather than filled
//     at a price that has already rebounded.
//   - Deterministic: float64 arithmetic on the closes alone, no clock, no env, no
//     randomness, so the two graded runs produce byte-identical action logs.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MA_BARS = 90;
const TIER1_DIP = 0.985; // close at or below 98.5% of MA90
const TIER2_MA = 0.975; // direct plunge: close at or below 97.5% of MA90 buys all
const TIER2_BELOW_ENTRY = 0.99; // average down: close 1% below the tier-1 entry close
const TARGET = 1.03; // position worth >= 103% of cost
const STOP = 0.98; // position worth <= 98% of cost
const TRAIL_ACTIVATE = 1.01; // trail starts once the position peaks >= 101% of cost
const TRAIL_GIVEBACK = 0.992; // sell on a 0.8% fall from the peak ratio
const MAX_HOLD_BARS = 180;
const END_FLATTEN_SEQ = 1430;
const FALLBACK_BAR = 1100; // no trade yet by this bar: allow a mild dip entry
const FALLBACK_DIP = 0.992;
const FALLBACK_TARGET = 1.01;
const FALLBACK_STOP = 0.985;
const FALLBACK_MAX_HOLD = 120;
const MAX_SLIPPAGE_BPS = 150;

const closes: number[] = [];
let tier = 0; // 0 = flat, 1 = tier-1 filled, 2 = fully invested
let entryBar = -1; // bar index where the current position first appeared
let entryClose = 0; // close of the bar the tier-1 buy was decided on
let peakRatio = 0; // best value/cost seen while holding
let everHeld = false;
let fallbackMode = false;

function ma90(): number | null {
  if (closes.length < MA_BARS) return null;
  let sum = 0;
  for (let i = closes.length - MA_BARS; i < closes.length; i++) sum += closes[i];
  return sum / MA_BARS;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];

    const ma = ma90();
    if (ma === null) return [];
    const close = closes[closes.length - 1];
    const barIndex = closes.length - 1;
    const held = state.positions.get(SYMBOL);

    // A position that appeared since the last batch marks the entry. The tier is
    // derived from the actual account, so a rejected tier-2 buy is retried: tier 2
    // means fully invested (under 20% of equity left in cash), tier 1 means holding
    // with room to add. entryClose is the close of the bar the tier-1 buy was
    // decided on (the bar before the fill appeared).
    if (held !== undefined) {
      everHeld = true;
      if (entryBar < 0) {
        entryBar = barIndex;
        entryClose = barIndex > 0 ? closes[barIndex - 1] : close;
        peakRatio = 0;
      }
      tier = state.cash * 5n < state.equity ? 2 : 1;
    } else {
      tier = 0;
      entryBar = -1;
      entryClose = 0;
      peakRatio = 0;
      fallbackMode = false;
    }

    // --- exits first: the whole position, on the first trigger ---
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const ratio = Number(value) / Number(held.cost);
      if (ratio > peakRatio) peakRatio = ratio;
      const heldBars = barIndex - entryBar;
      const target = fallbackMode ? FALLBACK_TARGET : TARGET;
      const stop = fallbackMode ? FALLBACK_STOP : STOP;
      const maxHold = fallbackMode ? FALLBACK_MAX_HOLD : MAX_HOLD_BARS;
      const hitStop = ratio <= stop;
      const hitTarget = ratio >= target;
      const hitTrail = peakRatio >= TRAIL_ACTIVATE && ratio <= peakRatio * TRAIL_GIVEBACK;
      const stale = heldBars >= maxHold;
      const end = state.seq >= END_FLATTEN_SEQ;
      if (hitStop || hitTarget || hitTrail || stale || end) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      // --- tier 2: still holding tier 1 and the dip deepened 1% below entry ---
      if (tier === 1 && close <= entryClose * TIER2_BELOW_ENTRY) {
        const cash = state.cash;
        const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
        if (cash >= minNotional) {
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [buy];
        }
      }
      return [];
    }

    // --- entries (flat) ---
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const halfEquity = (state.equity * 5000n) / BPS;
    if (close <= ma * TIER2_MA) {
      // Direct plunge: buy everything at once.
      const cash = state.cash;
      if (cash >= minNotional) {
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    } else if (close <= ma * TIER1_DIP) {
      if (halfEquity >= minNotional && state.cash >= halfEquity) {
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: halfEquity, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    } else if (!everHeld && barIndex >= FALLBACK_BAR && close <= ma * FALLBACK_DIP) {
      if (halfEquity >= minNotional && state.cash >= halfEquity) {
        fallbackMode = true;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: halfEquity, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }
    return [];
  },
});
