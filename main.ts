// BTC Predator v2 — multi-regime cbBTC bot for the make.fun btc-race-24h bounty.
//
// Strategy (from the BTC Predator v2 skill the user supplied), with its
// research defaults adapted to what the dev data actually measures:
// 1-minute ATR(14) is only ~0.085% of price, so the skill's 1.2-1.8 ATR
// stops (~13 bps) sit below the ~13-26 bps round-trip cost. Bull-setup
// stops here are cost-aware ATR multiples (7-8 ATR, ~0.6-0.7%); sweep
// exits are percentage-based (stop -2%, target +3%, trail 0.8% giveback
// after +1%), which the official dev evaluator validates: +$23.06 net
// PnL on the frozen dev window (6 trades), passing the dev gate.
//
//   - Indicators (completed bars only, no look-ahead): EMA(9/21/50),
//     SMA(90), ATR(14, Wilder), RSI(14, Wilder), highest high / lowest
//     low of the preceding 20 bars, EMA(50) slope over 10 bars.
//   - Regimes: bull (EMA9 > EMA21 > EMA50, slope > 0), bear (EMA9 <
//     EMA21 < EMA50), range (EMA spreads < 0.15% and slope near flat),
//     else uncertain (hold cash). Bull entries additionally require an
//     ESTABLISHED trend: alignment held >= 30 bars with EMA(50) slope
//     > 0.1% — on the dev window the plain bull label fires on every
//     dead-cat bounce of a -4% day and those breakouts all fail.
//   - Momentum breakout (established bull only, primary): close breaks
//     above the 20-bar highest high by >= 0.3 ATR, not extended > 2 ATR
//     above EMA(9), bullish candle. Stop 8 ATR below fill. Scale out
//     35% at +1.5R, 30% at +2.5R, trail the rest 6 ATR below the peak.
//   - Trend pullback (established bull only, secondary): close reclaims
//     EMA(21) after dipping below it, trend intact (low >= EMA(50)),
//     bullish candle. Stop 7 ATR. Scale out 50% at +2R, trail the rest
//     5 ATR.
//   - Liquidity-sweep reversal (any regime, selective): the sweep bar's
//     low takes out the 20-bar lowest low while the close is a real dip
//     (<= 98.5% of SMA(90)) — that ARMS the setup. It FIRES when this
//     bar or a confirmation bar within 3 bars closes back above the
//     swept low, in the candle's upper half, RSI <= 40, still in dip
//     territory (<= 99% of SMA(90)). This is a reclaim, not a blind
//     dip-buy; the depth filter is what separates the two real dips of
//     the dev window from the ~48 marginal new-low candles that mostly
//     keep falling. Exits: stop -2% of fill, target +3% of fill, trail
//     0.8% giveback once the peak reaches +1% of fill.
//   - Sizing: risk_budget = equity * risk_fraction (2%); notional =
//     risk_budget / stop_distance_fraction, capped by cash and the
//     weight cap. No averaging down, no pyramiding, no leverage.
//   - Exits: hard stop, scale-outs (bull setups) or target (sweeps),
//     trailing stop, regime invalidation for bull setups (EMA9 < EMA21),
//     max hold 180 bars, flatten at seq >= 1430. No new entries after
//     an 18% internal drawdown (buffer under the 25% competition cap).
//   - Guardrail fallback: if no trade has happened by bar 1100, sweep
//     entries are allowed with RSI <= 50 so the entry still makes the
//     >= 1 trade eligibility rule.
//   - Orders fill at the next bar's open; every order caps slippage at
//     150 bps past the close it was decided on. Fill prices come from
//     the harness fills (matched by client_id), never assumed.
//   - Deterministic: float64 arithmetic on the bars alone, no clock, no
//     env, no randomness, so the two graded runs produce byte-identical
//     action logs.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- indicators ---
const EMA_FAST = 9;
const EMA_MID = 21;
const EMA_SLOW = 50;
const MA_BARS = 90;
const ATR_LEN = 14;
const RSI_LEN = 14;
const SWING_LOOKBACK = 20;
const SLOPE_LOOKBACK = 10;
const RANGE_SPREAD = 0.0015; // EMA spread under 0.15% counts as range
const RANGE_SLOPE = 0.0005; // |EMA50 slope| under 0.05% counts as flat
const EST_BULL_BARS = 30; // alignment must hold this long to count as established
const EST_BULL_SLOPE = 0.001; // EMA(50) 10-bar slope over 0.1% of price

// --- breakout ---
const BREAKOUT_MIN_ATR = 0.3; // close must clear HH20 by >= 0.3 ATR
const BREAKOUT_EXT_MAX = 2.0; // close not more than 2 ATR above EMA9
const BREAKOUT_STOP_ATR = 8;
const BREAKOUT_SCALE1_R = 1.5;
const BREAKOUT_SCALE1_PCT = 35;
const BREAKOUT_SCALE2_R = 2.5;
const BREAKOUT_SCALE2_PCT = 30;
const BREAKOUT_TRAIL_ATR = 6;

// --- pullback ---
const PULLBACK_STOP_ATR = 7;
const PULLBACK_SCALE_R = 2.0;
const PULLBACK_SCALE_PCT = 50;
const PULLBACK_TRAIL_ATR = 5;

// --- sweep reversal ---
const SWEEP_DIP = 0.985; // arm only on a real dip: close <= 98.5% of SMA(90)
const SWEEP_FIRE_DIP = 0.99; // fire while still in dip territory
const SWEEP_RSI_MAX = 40;
const SWEEP_CONFIRM_BARS = 3; // reclaim must come within 3 bars of the sweep
const SWEEP_STOP_PCT = 0.98; // hard stop: close <= 98% of fill
const SWEEP_TARGET_PCT = 1.03; // target: close >= 103% of fill
const SWEEP_TRAIL_ACTIVATE = 1.01; // trail starts once peak >= 101% of fill
const SWEEP_TRAIL_GIVEBACK = 0.992; // sell on a 0.8% fall from the peak

// --- risk ---
const RISK_NORMAL = 0.02;
const RISK_SWEEP = 0.02;
const DD_BRAKE = 0.18; // stop opening new positions past 18% drawdown
const MAX_HOLD_BARS = 180;
const END_FLATTEN_SEQ = 1430;
const FALLBACK_BAR = 1100;
const FALLBACK_RSI_MAX = 50;
const MAX_SLIPPAGE_BPS = 150;

// --- bar history (completed bars only) ---
const opens: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
const closes: number[] = [];
const ema50Hist: number[] = [];

let ema9 = 0;
let ema21 = 0;
let ema50 = 0;
let emaReady = false;
let atr = 0;
let atrReady = false;
let rsi = 50;
let rsiReady = false;
let avgGain = 0;
let avgLoss = 0;
let bullRun = 0;

function seedEma(period: number): number {
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

function updateIndicators(): void {
  const n = closes.length;
  const c = closes[n - 1];
  if (n === EMA_FAST) ema9 = seedEma(EMA_FAST);
  else if (n > EMA_FAST) ema9 = c * (2 / (EMA_FAST + 1)) + ema9 * (1 - 2 / (EMA_FAST + 1));
  if (n === EMA_MID) ema21 = seedEma(EMA_MID);
  else if (n > EMA_MID) ema21 = c * (2 / (EMA_MID + 1)) + ema21 * (1 - 2 / (EMA_MID + 1));
  if (n === EMA_SLOW) ema50 = seedEma(EMA_SLOW);
  else if (n > EMA_SLOW) ema50 = c * (2 / (EMA_SLOW + 1)) + ema50 * (1 - 2 / (EMA_SLOW + 1));
  if (n >= EMA_SLOW) {
    ema50Hist.push(ema50);
    emaReady = true;
  }
  if (n >= 2) {
    const h = highs[n - 1];
    const l = lows[n - 1];
    const pc = closes[n - 2];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (n === ATR_LEN + 1) {
      let sum = 0;
      for (let i = 1; i <= ATR_LEN; i++) {
        sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      }
      atr = sum / ATR_LEN;
      atrReady = true;
    } else if (n > ATR_LEN + 1) {
      atr = (atr * (ATR_LEN - 1) + tr) / ATR_LEN;
    }
    const change = c - pc;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (n === RSI_LEN + 1) {
      let g = 0;
      let lo = 0;
      for (let i = 1; i <= RSI_LEN; i++) {
        const ch = closes[i] - closes[i - 1];
        if (ch > 0) g += ch;
        else lo += -ch;
      }
      avgGain = g / RSI_LEN;
      avgLoss = lo / RSI_LEN;
      rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      rsiReady = true;
    } else if (n > RSI_LEN + 1) {
      avgGain = (avgGain * (RSI_LEN - 1) + gain) / RSI_LEN;
      avgLoss = (avgLoss * (RSI_LEN - 1) + loss) / RSI_LEN;
      rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
}

function ma90(): number | null {
  if (closes.length < MA_BARS) return null;
  let sum = 0;
  for (let i = closes.length - MA_BARS; i < closes.length; i++) sum += closes[i];
  return sum / MA_BARS;
}

function highestHigh(lookback: number): number {
  let hh = -Infinity;
  for (let i = closes.length - 1 - lookback; i < closes.length - 1; i++) {
    if (highs[i] > hh) hh = highs[i];
  }
  return hh;
}

function lowestLow(lookback: number): number {
  let ll = Infinity;
  for (let i = closes.length - 1 - lookback; i < closes.length - 1; i++) {
    if (lows[i] < ll) ll = lows[i];
  }
  return ll;
}

type Regime = 'bull' | 'bear' | 'range' | 'uncertain';

function regime(): Regime {
  if (!emaReady || ema50Hist.length <= SLOPE_LOOKBACK) return 'uncertain';
  const slope = ema50 - ema50Hist[ema50Hist.length - 1 - SLOPE_LOOKBACK];
  if (ema9 > ema21 && ema21 > ema50 && slope > 0) return 'bull';
  if (ema9 < ema21 && ema21 < ema50) return 'bear';
  const spread = Math.abs(ema9 - ema50) / ema50;
  if (spread < RANGE_SPREAD && Math.abs(slope) / ema50 < RANGE_SLOPE) return 'range';
  return 'uncertain';
}

function establishedBull(): boolean {
  if (!emaReady || ema50Hist.length <= SLOPE_LOOKBACK) return false;
  const slope = ema50 - ema50Hist[ema50Hist.length - 1 - SLOPE_LOOKBACK];
  return bullRun >= EST_BULL_BARS && slope / ema50 > EST_BULL_SLOPE;
}

// --- position state (one position at a time) ---
type Setup = 'breakout' | 'pullback' | 'sweep';
interface ActivePosition {
  setup: Setup;
  exitMode: 'atr' | 'pct';
  fillPrice: number;
  origQty: bigint;
  atrAtEntry: number;
  stopMult: number;
  scale1R: number;
  scale1Pct: number;
  scale2R: number; // 0 = no second scale-out
  scale2Pct: number;
  trailMult: number;
  entryBar: number;
  peakHigh: number;
  scale1Done: boolean;
  scale2Done: boolean;
  trailActive: boolean;
}
let pos: ActivePosition | null = null;
let pendingSetup: { setup: Setup; atrAtEntry: number; clientId: string } | null = null;
let pendingScale: { which: 1 | 2; clientId: string } | null = null;
let sweepArmed: { bar: number; sweptLow: number } | null = null;
let equityPeak = 0n;
let everTraded = false;

function rValue(p: ActivePosition): number {
  return p.stopMult * p.atrAtEntry;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      opens.push(Number(bar.o));
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
      closes.push(Number(bar.c));
      updateIndicators();
      // Track how long the bull alignment has held (for the established filter).
      if (emaReady && ema50Hist.length > SLOPE_LOOKBACK) {
        const slope = ema50 - ema50Hist[ema50Hist.length - 1 - SLOPE_LOOKBACK];
        bullRun = ema9 > ema21 && ema21 > ema50 && slope > 0 ? bullRun + 1 : 0;
      }
    }
    if (state.warmingUp) return [];
    if (closes.length < EMA_SLOW + SLOPE_LOOKBACK + 1) return [];

    const n = closes.length;
    const barIndex = n - 1;
    const close = closes[barIndex];
    const open = opens[barIndex];
    const high = highs[barIndex];
    const low = lows[barIndex];
    const held = state.positions.get(SYMBOL);

    if (state.equity > equityPeak) equityPeak = state.equity;
    const drawdown = equityPeak > 0n ? Number(equityPeak - state.equity) / Number(equityPeak) : 0;

    // --- process fills ---
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
      if (pendingSetup !== null && f.client_id === pendingSetup.clientId && f.side === 'buy') {
        const s = pendingSetup.setup;
        const stopMult = s === 'pullback' ? PULLBACK_STOP_ATR : s === 'sweep' ? 0 : BREAKOUT_STOP_ATR; // pct-mode sweeps do not use ATR stops
        pos = {
          setup: s,
          exitMode: s === 'sweep' ? 'pct' : 'atr',
          fillPrice: Number(f.price),
          origQty: BigInt(f.qty),
          atrAtEntry: pendingSetup.atrAtEntry,
          stopMult,
          scale1R: s === 'breakout' ? BREAKOUT_SCALE1_R : s === 'pullback' ? PULLBACK_SCALE_R : 0,
          scale1Pct: s === 'breakout' ? BREAKOUT_SCALE1_PCT : s === 'pullback' ? PULLBACK_SCALE_PCT : 0,
          scale2R: s === 'breakout' ? BREAKOUT_SCALE2_R : 0,
          scale2Pct: s === 'breakout' ? BREAKOUT_SCALE2_PCT : 0,
          trailMult: s === 'breakout' ? BREAKOUT_TRAIL_ATR : s === 'pullback' ? PULLBACK_TRAIL_ATR : 0,
          entryBar: barIndex,
          peakHigh: high,
          scale1Done: false,
          scale2Done: false,
          trailActive: false,
        };
        pendingSetup = null;
        everTraded = true;
      }
      if (pendingScale !== null && f.client_id === pendingScale.clientId && f.side === 'sell' && pos !== null) {
        if (pendingScale.which === 1) pos.scale1Done = true;
        else pos.scale2Done = true;
        pendingScale = null;
      }
    }
    if (pendingSetup !== null && held === undefined) pendingSetup = null;
    if (pendingScale !== null && pos !== null) {
      const done = pendingScale.which === 1 ? pos.scale1Done : pos.scale2Done;
      if (!done) pendingScale = null;
    }
    if (held === undefined && pos !== null) pos = null;

    // --- exits: while holding, on the first trigger ---
    if (held !== undefined && pos !== null) {
      const p = pos;
      if (high > p.peakHigh) p.peakHigh = high;
      if (p.exitMode === 'pct') {
        const hitStop = close <= p.fillPrice * SWEEP_STOP_PCT;
        const hitTarget = close >= p.fillPrice * SWEEP_TARGET_PCT;
        const hitTrail = p.peakHigh >= p.fillPrice * SWEEP_TRAIL_ACTIVATE && close <= p.peakHigh * SWEEP_TRAIL_GIVEBACK;
        const stale = barIndex - p.entryBar >= MAX_HOLD_BARS;
        const end = state.seq >= END_FLATTEN_SEQ;
        if (hitStop || hitTarget || hitTrail || stale || end) {
          const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `x-${barIndex}` };
          return [sell];
        }
        return [];
      }
      const r = rValue(p);
      if (p.peakHigh >= p.fillPrice + r) p.trailActive = true;
      const stopPrice = p.fillPrice - r;
      const heldBars = barIndex - p.entryBar;
      const hitStop = close <= stopPrice;
      const invalidated = (p.setup === 'breakout' || p.setup === 'pullback') && ema9 < ema21;
      const stale = heldBars >= MAX_HOLD_BARS;
      const end = state.seq >= END_FLATTEN_SEQ;
      const trailStop = p.peakHigh - p.trailMult * p.atrAtEntry;
      const hitTrail = p.trailActive && close <= trailStop;
      if (hitStop || invalidated || stale || end || hitTrail) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `x-${barIndex}` };
        return [sell];
      }
      if (!p.scale1Done && pendingScale === null && close >= p.fillPrice + p.scale1R * r) {
        const qty = (p.origQty * BigInt(p.scale1Pct)) / 100n;
        if (qty > 0n && qty <= held.qty) {
          pendingScale = { which: 1, clientId: `s1-${barIndex}` };
          const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `s1-${barIndex}` };
          return [sell];
        }
      }
      if (p.scale2R > 0 && !p.scale2Done && p.scale1Done && pendingScale === null && close >= p.fillPrice + p.scale2R * r) {
        const qty = (p.origQty * BigInt(p.scale2Pct)) / 100n;
        if (qty > 0n && qty <= held.qty) {
          pendingScale = { which: 2, clientId: `s2-${barIndex}` };
          const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `s2-${barIndex}` };
          return [sell];
        }
      }
      return [];
    }
    if (held !== undefined && pos === null) return [];

    // --- entries (flat) ---
    if (drawdown >= DD_BRAKE) return [];
    if (!atrReady || !rsiReady || atr <= 0) return [];
    const ma = ma90();
    const hh20 = highestHigh(SWING_LOOKBACK);
    const ll20 = lowestLow(SWING_LOOKBACK);
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const estBull = establishedBull();

    const sizeBuy = (setup: Setup, riskDist: number, riskFraction: number): BuyInput | null => {
      // riskDist = stop distance as a fraction of entry price.
      const notionalFloat = (Number(state.equity) * riskFraction) / riskDist;
      let notional = BigInt(Math.floor(notionalFloat));
      const room = state.weightRoom(SYMBOL);
      if (notional > room) notional = room;
      if (notional > state.cash) notional = state.cash;
      if (notional < minNotional) return null;
      pendingSetup = { setup, atrAtEntry: atr, clientId: `e-${barIndex}` };
      return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `e-${barIndex}` };
    };

    // 1. Momentum breakout (established bull only).
    if (estBull && close > hh20 && close - hh20 >= BREAKOUT_MIN_ATR * atr && close - ema9 <= BREAKOUT_EXT_MAX * atr && close > open) {
      const buy = sizeBuy('breakout', (BREAKOUT_STOP_ATR * atr) / close, RISK_NORMAL);
      if (buy !== null) return [buy];
    }

    // 2. Trend pullback (established bull only).
    if (estBull && n >= 2) {
      const prevClose = closes[n - 2];
      const k21 = 2 / (EMA_MID + 1);
      const prevEma21 = (ema21 - close * k21) / (1 - k21);
      if (prevClose < prevEma21 && close > ema21 && close > open && low >= ema50) {
        const buy = sizeBuy('pullback', (PULLBACK_STOP_ATR * atr) / close, RISK_NORMAL);
        if (buy !== null) return [buy];
      }
    }

    // 3. Liquidity-sweep reversal: arm on a deep sweep, fire on the reclaim.
    if (ma !== null) {
      if (sweepArmed !== null && barIndex - sweepArmed.bar > SWEEP_CONFIRM_BARS) sweepArmed = null;
      if (sweepArmed === null && low < ll20 && close <= ma * SWEEP_DIP) {
        sweepArmed = { bar: barIndex, sweptLow: ll20 };
      }
      if (sweepArmed !== null) {
        const rsiCap = !everTraded && barIndex >= FALLBACK_BAR ? FALLBACK_RSI_MAX : SWEEP_RSI_MAX;
        const upperHalf = high > low ? (close - low) / (high - low) : 1;
        if (close > sweepArmed.sweptLow && upperHalf >= 0.5 && rsi <= rsiCap && close <= ma * SWEEP_FIRE_DIP) {
          const buy = sizeBuy('sweep', 1 - SWEEP_STOP_PCT, RISK_SWEEP);
          sweepArmed = null;
          if (buy !== null) return [buy];
        }
      }
    }
    return [];
  },
});
