# Predict.fun Subgraphs

A suite of three subgraphs indexing [Predict.fun](https://predict.fun) — a prediction market protocol on BNB Chain (Polymarket fork) with $1.5B+ volume and novel yield-bearing mechanics via Venus Protocol.

## Subgraphs

### 1. predictfun-orderbook

Indexes orderbook activity across all CTF and NegRisk exchanges.

**Entities:** Markets, Orderbooks, OrderFilled/Matched/Cancelled events, Fee tracking, TradeData timeseries with hourly/daily aggregations

**Contracts:**
| Contract | Address |
|---|---|
| CTFExchange (Non-Yield) | `0x8B4b3a245d76e28B614Dc7f4D3129C5755004950` |
| CTFExchange (Yield) | `0x73046A1e0613b9eE4f794fA52D8d8C02A539A42d` |
| NegRiskCtfExchange (Non-Yield) | `0x0497E4c401D39aAEBBfB6d714D30D6A7E2992Ae6` |
| NegRiskCtfExchange (Yield) | `0x2Cd1338090C37AdFC01Af0e2E9a73fa0a40f6E2D` |
| NegRiskAdapter (Non-Yield) | `0xc3Cf7c252f65E0d8D88537dF96569AE94a7F1A6E` |
| NegRiskAdapter (Yield) | `0x41dCe1A4B8FB5e6327701750aF6231B7CD0B2A40` |
| + 4 Fee Module contracts | |

### 2. predictfun-positions

Indexes position lifecycle — splits, merges, redemptions, and open interest tracking.

**Entities:** Conditions, UserPositions, MarketOpenInterest, Split/Merge/Redemption events, NegRisk conversions, TransferSingle events

**Contracts:**
| Contract | Address |
|---|---|
| ConditionalTokens (Non-Yield) | `0x22DA1810B194ca018378464a58f6Ac2B10C9d244` |
| ConditionalTokens (Yield) | `0x9400F8Ad57e9e0F352345935d6D3175975eb1d9F` |
| NegRisk ConditionalTokens (Yield) | `0xF64b0b318AAf83BD9071110af24D24445719A07F` |
| NegRiskAdapter (Non-Yield) | `0xc3Cf7c252f65E0d8D88537dF96569AE94a7F1A6E` |
| NegRiskAdapter (Yield) | `0x41dCe1A4B8FB5e6327701750aF6231B7CD0B2A40` |
| NegRiskOperator (Yield) | `0xBB7250101e0e3611D7e136fFE73Bc24b98E3e175` |
| NegRiskOperator (Non-Yield) | `0x56020F5024641d577Cb54032aF70a23a986ECfFD` |

### 3. predictfun-yield

Indexes Predict.fun's novel yield-bearing mechanics — Venus Protocol integration, reward distributions, and UMA oracle resolution.

**Entities:** TokenMappings (underlying/vToken pairs), YieldClaims, VTokenMints, RewardRounds, OracleRequests/Proposals/Settlements

**Contracts:**
| Contract | Address |
|---|---|
| YieldBearingConditionalTokens | `0x9400F8Ad57e9e0F352345935d6D3175975eb1d9F` |
| RewardDistributor | `0x14e3a0a4aB4e4Fa60FC6b4aCce200afAD9233ecE` |
| UMA Optimistic Oracle | `0x76F4632032d3E16fE15e06DDB60b53C67BCE17a0` |

## Architecture

```
predict.fun (BNB Chain)
├── predictfun-orderbook    ── Fills, matches, fees, market registration
├── predictfun-positions    ── Splits, merges, redemptions, open interest
└── predictfun-yield        ── Venus yield, reward claims, oracle resolution
```

All subgraphs share:
- **Network:** BSC (BNB Smart Chain)
- **Collateral:** USDT (18 decimals)
- **Start Block:** 64,817,753
- **Spec Version:** 1.3.0

## Best Practices Applied

- `Bytes!` IDs everywhere (cheaper than `String!`)
- `@entity(immutable: true)` on all event logs
- `@derivedFrom` for reverse lookups (no redundant storage)
- No `eth_calls` (events only)
- `indexerHints: prune: auto` for storage efficiency
- `nonFatalErrors` feature enabled
- `concatI32(logIndex)` for unique event IDs

## MCP Server

An MCP (Model Context Protocol) server that gives AI agents structured access to all three subgraphs.

### Setup

1. Get a Graph API key from [Subgraph Studio](https://thegraph.com/studio/) ([docs](https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/))

2. Install and build:
```bash
cd mcp-server
npm install
npm run build
```

3. Add to your Claude Code config (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "predictfun": {
      "command": "node",
      "args": ["/path/to/predictfun-subgraphs/mcp-server/dist/index.js"],
      "env": {
        "GRAPH_API_KEY": "your-api-key-here",
        "PREDICTFUN_ORDERBOOK_ID": "your-orderbook-subgraph-id",
        "PREDICTFUN_POSITIONS_ID": "your-positions-subgraph-id",
        "PREDICTFUN_YIELD_ID": "your-yield-subgraph-id"
      }
    }
  }
}
```

All environment variables are **required**. The server will exit with an error if any are missing.

### Tools (10)

| Tool | Description |
|---|---|
| `get_platform_stats` | Full platform overview — volume, OI, yield, sync status |
| `get_top_markets` | Rank markets by volume, open interest, or trade count |
| `get_market_details` | Deep dive: OI, resolution, top holders, orderbook stats |
| `get_trader_profile` | Full P&L: trades, positions, payouts, yield rewards |
| `get_recent_activity` | Latest trades, splits, merges, redemptions, or yield claims |
| `get_yield_overview` | Venus Protocol deposits, redemptions, yield stats |
| `get_whale_positions` | Largest holders with % of market OI |
| `get_leaderboard` | Top traders by volume, payouts, or trade count |
| `get_resolved_markets` | Recently settled markets with outcomes |
| `query_subgraph` | Custom GraphQL against any subgraph |

### Prompts (7)

Pre-built workflows: `platform_overview`, `analyze_trader`, `market_deep_dive`, `yield_analysis`, `whale_alert`, `market_scanner`, `custom_query_examples`

## Subgraph Development

```bash
cd predictfun-<subgraph>
npm install
npx graph codegen
npx graph build
npx graph deploy predictfun-<subgraph> --version-label v0.0.1
```

## License

MIT
