# TradeIntel — AI Trading Intelligence Platform

AI-powered market analysis across crypto, stocks and futures: confluence-scored trade opportunities (fair value gaps, volume profile, order blocks, multi-timeframe trend), macro/economic-calendar-aware AI analysis, a trade-plan risk engine, and a TradingView Pine Script v6 indicator generator.

## Architecture

- **Deterministic strategy engine** (`src/lib/strategies/`) — computes FVGs, order blocks, volume profile (POC/VAH/VAL), swing structure, EMA/RSI/MACD/ATR, and multi-timeframe trend. Opportunities are scored by transparent weighted confluence factors.
- **AI layer** (`src/lib/ai/`) — Claude receives the engine's *structured* output plus the economic calendar and does synthesis only (thesis, bull/bear cases, macro context). It never invents price levels.
- **Market data** (`src/lib/market/`) — provider abstraction; Binance public API (free, real-time, all timeframes) powers crypto today. A Polygon.io adapter for stocks/futures activates automatically when `POLYGON_API_KEY` is set.
- **Risk engine** (`src/lib/risk/`) — position size / SL / TP math shared by the UI and the generated Pine Scripts.
- **Pine generator** (`src/lib/pine/`) — tested Pine Script v6 templates (EMA cross, RSI reversal, FVG signals, MACD momentum) with alerts and an on-chart position-size table.
- **Economic calendar** (`src/lib/calendar/`) — free weekly feed (Forex Factory data), cached 30 min; high-impact events penalize opportunity scores inside a 12-hour risk window.

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Command Center: tickers, AI daily briefing, top setups, upcoming macro events |
| `/scanner` | Confluence scanner across a symbol universe with filters |
| `/analyze/[symbol]` | Chart with structure overlays, scored setups, AI analysis, trade plan builder |
| `/indicators` | Indicator Studio: generate Pine Script v6 for TradingView |
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
