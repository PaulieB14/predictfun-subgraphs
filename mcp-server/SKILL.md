# Predict.fun MCP

Structured access to Predict.fun prediction market data on BNB Chain — platform stats, market analysis, trader profiling, yield mechanics, and behavioral meta-tools.

## Tools

- **get_platform_stats** — Full platform overview: volume, OI, yield, sync status
- **get_top_markets** — Rank markets by volume, open interest, or trade count
- **get_market_details** — Deep dive: OI, resolution, top holders, orderbook stats
- **get_trader_profile** — Full P&L: trades, positions, payouts, yield rewards
- **get_recent_activity** — Latest trades, splits, merges, redemptions, or yield claims
- **get_yield_overview** — Venus Protocol deposits, redemptions, yield stats
- **get_whale_positions** — Largest holders with % of market OI
- **get_leaderboard** — Top traders by volume, payouts, or trade count
- **get_resolved_markets** — Recently settled markets with outcomes
- **query_subgraph** — Custom GraphQL against any of the three subgraphs
- **find_trader_persona** — Classify a trader: whale, yield farmer, arbitrageur, early mover, sniper
- **scan_trader_personas** — Find traders matching a behavioral archetype
- **tag_market_structure** — Tag a market by resolution latency, liquidity, oracle type, tail risk
- **scan_markets_by_structure** — Find markets by structural filter

## Install

```bash
npx predictfun-mcp
```

## Use Cases

- Get real-time platform stats and market rankings on Predict.fun
- Profile traders by P&L, volume, and behavioral archetypes
- Analyze market quality: liquidity depth, OI concentration, resolution speed
- Track yield mechanics via Venus Protocol integration
- Run custom GraphQL queries against orderbook, positions, and yield subgraphs
