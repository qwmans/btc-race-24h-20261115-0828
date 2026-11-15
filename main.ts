// Make.fun BTC Race Entry: Low-Turnover Dip/Rebound Mean Reversion (Rev 2)
// Speaks agent-fun/bars-replay/v1; Node 22 erasable TypeScript.
// Fully deterministic, no Math.random, strict fill/rejection reconciliation, cost-aware exits.

import { BPS, runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK_BARS = 30; // Rolling SMA window
const COOLDOWN_BARS = 15; // Cooldown bars after position flat
const MAX_HOLDING_BARS = 180; // Max holding period
const MAX_SLIPPAGE_BPS = 100; // 1% slippage cap

const STOP_LOSS_BPS = 140; // -1.40% stop loss
const TAKE_PROFIT_BPS = 60; // +0.60% take profit
const DIP_THRESHOLD_BPS = 90; // Price >= 0.90% below SMA
const CASH_ALLOCATION_PCT = 60n; // 60% cash sizing

const history: (bigint | null)[] = [];
let pendingBuyId: string | null = null;
let pendingSellId: string | null = null;
let fillBarSeq = -1;
let lastExitBarSeq = -999;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const close = state.close(SYMBOL);
    history.push(close);

    // 1. Process batch fills and rejections to reconcile pending states
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;

      if (fill.client_id === pendingBuyId) {
        if (fill.status === 'filled') {
          fillBarSeq = batch.seq;
        }
        pendingBuyId = null; // Clear pending whether filled or rejected
      }

      if (fill.client_id === pendingSellId) {
        if (fill.status === 'filled') {
          lastExitBarSeq = batch.seq;
          fillBarSeq = -1;
        }
        pendingSellId = null; // Clear pending whether filled or rejected
      }
    }

    if (state.warmingUp || close === null) {
      return [];
    }

    const hasPosition = state.positions.has(SYMBOL);
    const pos = state.positions.get(SYMBOL);

    // If position is closed externally or flattened, reset fillBarSeq
    if (!hasPosition) {
      fillBarSeq = -1;
    }

    // 2. Management of existing position (Exits)
    if (hasPosition && pos !== undefined && fillBarSeq !== -1) {
      if (pendingSellId !== null) {
        return []; // Already pending a sell order
      }

      const heldBars = batch.seq - fillBarSeq;
      let pnlBps = 0n;

      if (pos.cost > 0n && pos.qty > 0n) {
        const currentQuoteValue = state.value(SYMBOL, pos.qty, close);
        const diff = currentQuoteValue - pos.cost;
        pnlBps = (diff * BPS) / pos.cost;
      }

      const shouldExit =
        pnlBps <= -BigInt(STOP_LOSS_BPS) ||
        pnlBps >= BigInt(TAKE_PROFIT_BPS) ||
        heldBars >= MAX_HOLDING_BARS;

      if (shouldExit) {
        pendingSellId = `sell_${batch.seq}`;
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: pos.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
            client_id: pendingSellId,
          } as SellInput,
        ];
      }
      return [];
    }

    // 3. Entry logic (when flat)
    if (hasPosition || pendingBuyId !== null || pendingSellId !== null) {
      return [];
    }

    if (batch.seq - lastExitBarSeq < COOLDOWN_BARS) {
      return [];
    }

    if (history.length < LOOKBACK_BARS) {
      return [];
    }

    // Calculate rolling SMA
    let sum = 0n;
    let count = 0n;
    for (let i = history.length - LOOKBACK_BARS; i < history.length; i++) {
      const val = history[i];
      if (val !== null && val !== undefined) {
        sum += val;
        count += 1n;
      }
    }

    if (count < BigInt(LOOKBACK_BARS / 2)) {
      return [];
    }

    const sma = sum / count;
    const dipRequired = sma - (sma * BigInt(DIP_THRESHOLD_BPS)) / BPS;
    const isDipped = close <= dipRequired;

    // Single-close rebound confirmation: current close > previous close
    const prevClose = history.length >= 2 ? history[history.length - 2] : null;
    const isRebounding = prevClose !== null && close > prevClose;

    if (isDipped && isRebounding) {
      const { caps, fees } = state.hello;
      if (caps.max_open_positions <= 0 || caps.max_orders_per_bar <= 0) {
        return [];
      }

      const notional = (state.cash * CASH_ALLOCATION_PCT) / 100n;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      const slice = notional < byWeight ? notional : byWeight;
      const minNotional = BigInt(fees.min_notional_quote_units);

      if (slice < minNotional || slice <= 0n) {
        return [];
      }

      pendingBuyId = `buy_${batch.seq}`;

      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: slice,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
          client_id: pendingBuyId,
        } as BuyInput,
      ];
    }

    return [];
  },
});
