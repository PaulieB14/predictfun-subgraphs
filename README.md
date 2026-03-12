# Predict.fun Subgraphs

<a href="https://glama.ai/mcp/servers/PaulieB14/predictfun-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/PaulieB14/predictfun-mcp/badge" />
</a>

A suite of three subgraphs indexing [Predict.fun](https://predict.fun) — a prediction market protocol on BNB Chain (Polymarket fork) with $1.7B+ volume and novel yield-bearing mechanics via Venus Protocol.

## Subgraphs

### 1. predictfun-orderbook

Indexes orderbook activity across all CTF and NegRisk exchanges.

**Entities:** Markets, Orderbooks, OrderFilled/Matched/Cancelled events, Fee tracking, Account stats, NegRisk markets, TradeData timeseries with hourly/daily aggregations

**Contracts:**
| Contract | Address |
|---|---|
| CTFExchange (Non-Yield) | `0x8BC070BEdAB741406F4B1Eb65A72bee27894B689` |
| CTFExchange (Yield) | `0x6bEb5a40C032AFc305961162d8204CDA16DECFa5` |
| NegRiskCtfExchange (Non-Yield) | `0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A` |
| NegRiskCtfExchange (Yield) | `0x8A289d458f5a134bA40015085A8F50Ffb681B41d` |
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

2. Add to your Claude Code config (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "predictfun": {
      "command": "npx",
      "args": ["predictfun-mcp"],
      "env": {
        "GRAPH_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Subgraph IDs are built in. Queries go through [The Graph Gateway](https://thegraph.com/docs/en/querying/graphql-api/) and are billed to your API key.

### OpenClaw / Remote Agents (SSE)

```bash
# Dual transport — stdio + SSE on port 3850
GRAPH_API_KEY=your-key npx predictfun-mcp --http

# SSE only (for remote/server deployments)
GRAPH_API_KEY=your-key npx predictfun-mcp --http-only

# Custom port
MCP_HTTP_PORT=4000 GRAPH_API_KEY=your-key npx predictfun-mcp --http
```

Point your agent at: `http://localhost:3850/sse`

| Invocation | Transports | Use case |
|---|---|---|
| `npx predictfun-mcp` | stdio | Claude Desktop, Cursor, Claude Code |
| `npx predictfun-mcp --http` | stdio + SSE :3850 | Dual — local + remote agents |
| `npx predictfun-mcp --http-only` | SSE :3850 | OpenClaw, remote deployments |

### Tools (14)

#### Data Tools
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

#### Meta-Tools (agent reasoning layer)
| Tool | Description |
|---|---|
| `find_trader_persona` | Classify a trader into archetypes: whale accumulator, yield farmer, arbitrageur, early mover, resolution sniper |
| `scan_trader_personas` | Find traders matching a specific behavioral archetype across the platform |
| `tag_market_structure` | Tag a market by resolution latency, liquidity profile, oracle type, and tail-risk indicators |
| `scan_markets_by_structure` | Find markets by structural filter: resolution speed, liquidity depth, oracle type, OI concentration, tail risk |

Meta-tools return structured JSON so agents can reason programmatically over trader behavior and market quality — not just raw volume and OI.

### Prompts (9)

Pre-built workflows: `platform_overview`, `analyze_trader`, `market_deep_dive`, `yield_analysis`, `whale_alert`, `market_scanner`, `custom_query_examples`, `trader_persona_analysis`, `market_quality_scan`

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
