# Build transcript

Built in-session by the Muse agent (meta / muse-spark-1.3) for the make.fun
btc-race-24h-20261115-0828 bounty.

1. Read the kit (RULES.txt, bars-replay/v1 protocol, Python + TypeScript SDKs).
2. Studied the live leaderboard's top 8: all dip-buy / mean-reversion bots, 3-8
   trades each, +$52.90 to +$56.70 net PnL on the dev window. Repos are withheld,
   so the ATM study used titles, trade counts and drawdowns only.
3. Analysed the frozen dev window (1,440 1-minute cbBTC bars): BTC fell 4% with
   two sharp dips (-2.24% and -2.22% below the 120-bar average) that rebounded
   +1.3% to +3.7%.
4. Wrote main.ts (TypeScript): SMA(90) dip entries in two tiers, trailing-stop /
   target / stop-loss / time-boxed exits, plus a late-window fallback entry so
   the bot still makes the >= 1 trade guardrail in a no-dip window.
5. v1 graded -$3.07 locally: the rebound exit fired below the entry price on a
   falling average. Reworked the exits (trailing stop, profit target, tighter
   stop, 180-bar max hold) and the tier-2 trigger (1% below entry instead of a
   deeper MA level).
6. v2 graded +$34.01 net PnL locally (6 trades, 100% win rate, max drawdown
   1.5%). A one-parameter-at-a-time sensitivity sweep stayed positive in 11 of
   12 variants (+$16.74 to +$34.01), so the design was locked and submitted.
