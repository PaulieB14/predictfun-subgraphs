---
name: predictfun-mcp
description: Access Predict.fun prediction market data on BNB Chain — platform stats, market analysis, trader profiling, yield mechanics, and behavioral meta-tools via The Graph.
metadata:
  {"openclaw": {"requires": {"bins": ["node"], "env": ["GRAPH_API_KEY"]}, "primaryEnv": "GRAPH_API_KEY", "homepage": "https://github.com/PaulieB14/predictfun-subgraphs"}}
---

# Predict.fun MCP

Structured access to Predict.fun prediction market data on BNB Chain — platform stats, market analysis, trader profiling, yield mechanics, and behavioral meta-tools.

## Tools

- **get_platform_stats** — Full platform overview: volume, OI, yield, sync status
- **get_top_markets** — Rank markets by volume, open interest, or trade count. OI mode flags zombie OI on resolved markets
- **get_market_details** — Deep dive: OI, resolution, top holders (with contract/trader labels), orderbook stats, oracle contract identification, zombie OI detection with redemption context
- **get_trader_profile** — Full P&L: trades, positions, payouts, yield rewards. Warns if address is a known protocol contract
- **get_recent_activity** — Latest trades, splits, merges, redemptions, or yield claims
- **get_yield_overview** — Venus Protocol yield stats with context: on-chain claims are protocol-level settlements, per-user yield accrues via position value snapshots
- **get_whale_positions** — Largest human holders with % of market OI (protocol contracts filtered out)
- **get_leaderboard** — Top human traders by volume, payouts, or trade count (protocol contracts filtered out)
- **get_resolved_markets** — Recently settled markets with outcomes and condition IDs
- **query_subgraph** — Custom GraphQL against any of the three subgraphs
- **find_trader_persona** — Classify a trader: whale, yield farmer, arbitrageur, early mover, sniper
- **scan_trader_personas** — Find traders matching a behavioral archetype (protocol contracts excluded from whale scan)
- **tag_market_structure** — Tag a market by type (standard, neg_risk, ct_yield, bond), resolution latency, liquidity, oracle type with contract identification, tail risk with zombie OI flags
- **scan_markets_by_structure** — Find markets by structural filter

## Protocol Intelligence

The server includes a registry of known Predict.fun infrastructure contracts:

- **NegRiskAdapter** — Oracle for NEG_RISK_YIELD markets
- **CTFOracle** — Oracle for CT_NON_YIELD markets
- **YieldOracle** — Oracle for CT_YIELD markets
- **NegRiskOperator** — Prepares and manages NegRisk markets

These are automatically filtered from leaderboards and whale lists, labeled in market details, and flagged when profiled directly — preventing false positives like protocol adapters appearing as top whales or showing misleading P&L.

All table outputs use full condition IDs and wallet addresses (no truncation) to support agent tool chaining.

## Data Context

- **Yield mechanics:** Predict.fun routes user USDT collateral through Venus Protocol (~3-5% APY). On-chain yield claim events are protocol-level batch settlements — per-user yield accrues automatically via position value snapshots and is not individually claimable on-chain. The subgraph captures protocol settlements only.
- **Zombie OI:** Resolved markets with remaining open interest indicate winners who haven't manually redeemed via the UI. This is a UX friction issue, not a protocol bug.
- **Market types:** Markets are classified by source contract — standard (CT_NON_YIELD), neg_risk (NEG_RISK_YIELD), ct_yield (CT_YIELD), and bond (Bond Markets offering fixed-style returns on highly probable outcomes). Bond Markets may use different source identifiers.
- **Probable acquisition:** Predict.fun acquired Probable (>$1B volume in 36 days). Migrating Probable users may appear in recent activity data.

## Requirements

- **Runtime:** Node.js >= 18 (runs via `npx`)
- **Environment variables:**
  - `GRAPH_API_KEY` (required) — Free API key from [The Graph Studio](https://thegraph.com/studio/). Used to query three Predict.fun subgraphs via The Graph Gateway. Queries are billed to your key (free tier: 100K queries/month).

## Install

```bash
GRAPH_API_KEY=your-key npx predictfun-mcp
```

## Network & Data Behavior

- All tool calls make GraphQL requests to The Graph Gateway (`gateway.thegraph.com`) using your API key.
- Three subgraphs are queried: predictfun-orderbook, predictfun-positions, and predictfun-yield (subgraph IDs are built into the server).
- No local database or persistent storage is used.
- The SSE transport (`--http` / `--http-only`) starts a local HTTP server on port 3850 (configurable via `MCP_HTTP_PORT` env var).

## Use Cases

- Get real-time platform stats and market rankings on Predict.fun
- Profile traders by P&L, volume, and behavioral archetypes
- Analyze market quality: liquidity depth, OI concentration, resolution speed
- Detect zombie OI on resolved markets with redemption context
- Identify protocol contracts vs human traders in market data
- Track yield mechanics via Venus Protocol integration (with data context notes)
- Classify markets by type: standard, neg_risk, ct_yield, bond
- Run custom GraphQL queries against orderbook, positions, and yield subgraphs
