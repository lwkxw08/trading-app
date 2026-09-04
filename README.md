# TradeIntel — AI Trading Intelligence Platform

AI-powered market analysis across crypto, stocks and futures: confluence-scored trade opportunities (fair value gaps, volume profile, order blocks, multi-timeframe trend), macro/economic-calendar-aware AI analysis, a trade-plan risk engine, and a TradingView Pine Script v6 indicator generator.

## Architecture

- **Deterministic strategy engine** (`src/lib/strategies/`) — computes FVGs, order blocks, volume profile (POC/VAH/VAL), swing structure, liquidity sweeps, BOS/CHoCH structure breaks, anchored VWAP, Asia/London/NY session levels, EMA/RSI/MACD/ATR, and multi-timeframe trend. Opportunities are scored by transparent weighted confluence factors.
- **Custom strategies** (`src/lib/strategies/custom.ts`) — compose your own strategy from the deterministic condition library with per-condition weights, evaluate it live against any symbol, or describe it in plain English and let Claude map it onto supported conditions (AI never invents calculations).
- **AI layer** (`src/lib/ai/`) — Claude receives the engine's *structured* output plus the economic calendar and does synthesis only (thesis, bull/bear cases, macro context). It never invents price levels.
- **Market data** (`src/lib/market/`) — provider abstraction; Binance public API (free, real-time, all timeframes) powers crypto today. A Polygon.io adapter for stocks/futures activates automatically when `POLYGON_API_KEY` is set.
- **Risk engine** (`src/lib/risk/`) — position size / SL / TP math shared by the UI and the generated Pine Scripts.
- **Pine generator** (`src/lib/pine/`) — tested Pine Script v6 templates (EMA cross, RSI reversal, FVG signals, MACD momentum) plus generated indicators for custom strategies (weighted condition scoring), all with alerts and an on-chart position-size table.
- **Backtester** (`src/lib/backtest/`) — bar-by-bar historical replay (no lookahead) of the built-in confluence engine or any custom strategy against a chosen instrument/timeframe, using the exact live entry/SL/TP logic; up to 3000 bars via paginated history, optional fee/slippage modeling, a min-score parameter sweep, and saved/comparable runs. Reports win rate, expectancy, total R, profit factor, max drawdown, equity curve and the full trade list. The macro-event penalty is not modeled (no historical calendar), and fees/slippage apply only when set above zero.
- **Alerts** (`src/lib/alerts/`) — price-level and setup-formed alert rules with cooldowns, checked client-side while the app tab is open (server-side scheduled monitoring arrives with Cloudflare deployment); delivery via browser notifications, webhooks, and Telegram (server-side `TELEGRAM_BOT_TOKEN`).
- **Signal tracking** (`src/lib/signals/`) — scanner setups are auto-logged (browser localStorage) and later resolved against subsequent candles (target hit, stop hit, or timeout), building evidence-based hit-rate and R stats per strategy, direction, timeframe, symbol and confluence factor. Historical hit rates never guarantee future results.
- **Trade journal** (`src/lib/journal/`) — log entries/exits with the engine's confluence score & factors snapshotted at entry (stored in browser localStorage), per-factor/per-strategy edge stats (win rate, avg R, profit factor), and an AI coach that reviews the journal and suggests concrete strategy refinements limited to supported conditions.
- **Economic calendar** (`src/lib/calendar/`) — free weekly feed (Forex Factory data), cached 30 min; high-impact events penalize opportunity scores inside a 12-hour risk window.

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Command Center: tickers, AI daily briefing, top setups, upcoming macro events |
| `/scanner` | Confluence scanner across a symbol universe with filters |
| `/analyze/[symbol]` | Chart with structure overlays, scored setups, AI analysis, trade plan builder |
| `/strategies` | Strategy Lab: build custom strategies, AI composition, live evaluation, Pine export + starter Pine templates |
| `/backtest` | Backtest built-in or custom strategies bar-by-bar, with fees/slippage, sweeps and saved runs |
| `/signals` | Signal Tracking: auto-logged scanner setups resolved against later price action |
| `/alerts` | Alerts: price-level and setup rules with browser/webhook/Telegram delivery |
| `/journal` | Trade Journal: log trades with confluence snapshots, edge stats, AI coaching review |
| `/calendar` | Full economic calendar with impact filters |

## Development

```bash
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev
```

All API routes use the edge runtime, so the app deploys cleanly to Cloudflare Pages (via `@cloudflare/next-on-pages`) or any Node host.

## Disclaimer

TradeIntel provides market analysis for educational purposes only and is not financial advice.
