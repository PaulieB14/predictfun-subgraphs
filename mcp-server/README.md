# predictfun-mcp

MCP (Model Context Protocol) server that gives AI agents structured access to [Predict.fun](https://predict.fun) — a prediction market protocol on BNB Chain with $1.5B+ volume and yield-bearing mechanics via Venus Protocol.

Indexes data from three subgraphs: orderbook activity, position lifecycle, and yield mechanics.

## Setup

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

That's it — subgraph IDs are built in. Queries go through [The Graph Gateway](https://thegraph.com/docs/en/querying/graphql-api/) and are billed to your API key.

## Tools (10)

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

## Prompts (7)

Pre-built workflows: `platform_overview`, `analyze_trader`, `market_deep_dive`, `yield_analysis`, `whale_alert`, `market_scanner`, `custom_query_examples`

## License

MIT
