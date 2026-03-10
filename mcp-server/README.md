# predictfun-mcp

<a href="https://glama.ai/mcp/servers/PaulieB14/predictfun-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/PaulieB14/predictfun-mcp/badge" />
</a>

MCP (Model Context Protocol) server that gives AI agents structured access to [Predict.fun](https://predict.fun) — a prediction market protocol on BNB Chain with $1.7B+ volume and yield-bearing mechanics via Venus Protocol.

Indexes data from three subgraphs on [The Graph](https://thegraph.com): orderbook activity, position lifecycle, and yield mechanics.

## Install

### Claude Code

```bash
claude mcp add predictfun -- npx predictfun-mcp
```

Then set your Graph API key:

```bash
export GRAPH_API_KEY=your-key-here
```

### Claude Desktop / Manual Config

Add to your MCP config (`~/.claude/settings.json` or Claude Desktop settings):

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

### Docker

```bash
docker build -t predictfun-mcp .
docker run -e GRAPH_API_KEY=your-key-here predictfun-mcp
```

## Requirements

- **Graph API Key** — Get one free at [Subgraph Studio](https://thegraph.com/studio/) ([docs](https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/))

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

Pre-built workflows for common analysis:

| Prompt | Description |
|---|---|
| `platform_overview` | Full platform stats, top markets, whales, yield |
| `analyze_trader` | Deep dive on a specific trader's P&L and strategy |
| `market_deep_dive` | Full analysis of a specific prediction market |
| `yield_analysis` | Venus Protocol yield mechanics and APY |
| `whale_alert` | Find biggest players and their positions |
| `market_scanner` | Scan for interesting markets across all rankings |
| `custom_query_examples` | Example GraphQL queries for each subgraph |

## Architecture

```
User → AI Agent (Claude) → MCP Server → The Graph Gateway → Subgraphs → BNB Chain
```

Three subgraphs power the data:

- **predictfun-orderbook** — trades, orderbooks, market names (NegRisk + CTF)
- **predictfun-positions** — splits, merges, redemptions, open interest
- **predictfun-yield** — Venus Protocol deposits, vToken minting, yield claims

All markets include human-readable names decoded from UMA oracle ancillary data.

## Examples

Ask your AI agent:

- "What are the hottest prediction markets right now?"
- "Show me the top 10 traders by volume"
- "Who are the whales betting on the FIFA World Cup?"
- "What's the yield being generated through Venus?"
- "Find recently resolved markets and their outcomes"

## License

MIT
