# makefun-btc-race-24h-20261115-0828

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/syahruldy/makefun-btc-race-24h-20261115-0828/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/syahruldy/makefun-btc-race-24h-20261115-0828/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

BTC Predator v2 — a multi-regime bot that trades Coinbase Wrapped BTC (cbBTC) minute by minute on 1-minute on-chain bars. A regime detector (EMA 9/21/50, ATR, RSI, 20-bar swings) picks between three signal families: momentum breakout and trend pullback in established bull trends (ATR stops with scale-outs and trailing), and a liquidity-sweep reversal that arms on a deep dip below the 20-bar low and fires only on a confirmed reclaim (stop -2%, target +3%, trailing). Risk-based sizing at 2% per trade, one position at a time, no averaging down. Local dev grade: +$23.06 net PnL on the frozen 24h dev window (6 trades), passing the dev gate.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=j1vfvrf6&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
