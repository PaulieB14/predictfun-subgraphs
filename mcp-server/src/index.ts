#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Configuration ───────────────────────────────────────────────────────────

// The Graph Gateway API key (required)
const API_KEY = process.env.GRAPH_API_KEY;
if (!API_KEY) {
  console.error(
    "Error: GRAPH_API_KEY environment variable is required.\n" +
    "Get your API key at https://thegraph.com/studio/apikeys/\n" +
    "See: https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/"
  );
  process.exit(1);
}

// Subgraph IDs on The Graph Network (required)
const SUBGRAPH_IDS: Record<string, string> = {
  orderbook: process.env.PREDICTFUN_ORDERBOOK_ID || "",
  positions: process.env.PREDICTFUN_POSITIONS_ID || "",
  yield: process.env.PREDICTFUN_YIELD_ID || "",
};

const missingIds = Object.entries(SUBGRAPH_IDS)
  .filter(([, v]) => !v)
  .map(([k]) => `PREDICTFUN_${k.toUpperCase()}_ID`);
if (missingIds.length > 0) {
  console.error(
    `Error: Missing required environment variables: ${missingIds.join(", ")}\n` +
    "Set these to the published subgraph IDs from Subgraph Studio."
  );
  process.exit(1);
}

function getEndpoint(subgraph: string): string {
  return `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_IDS[subgraph]}`;
}

const ENDPOINTS = {
  get orderbook() { return getEndpoint("orderbook"); },
  get positions() { return getEndpoint("positions"); },
  get yield() { return getEndpoint("yield"); },
};

// ─── GraphQL Helper ──────────────────────────────────────────────────────────

async function query(
  endpoint: string,
  gql: string,
  allowErrors = false
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: gql }),
  });
  const json = await res.json();
  if (json.errors && !allowErrors && !json.data) {
    throw new Error(json.errors.map((e: any) => e.message).join("; "));
  }
  return json.data;
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function fmtUsd(val: string): string {
  const n = parseFloat(val);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(timestamp: string): string {
  return new Date(parseInt(timestamp) * 1000).toISOString().slice(0, 19) + "Z";
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "predictfun-mcp",
  version: "0.1.0",
});

// ─── Tool: Platform Overview ─────────────────────────────────────────────────

server.tool(
  "get_platform_stats",
  "Get Predict.fun platform-wide stats: total volume, trades, open interest, yield, and active markets",
  {},
  async () => {
    const [ob, pos, yld] = await Promise.all([
      query(
        ENDPOINTS.orderbook,
        `{ globals(subgraphError: allow) { totalTrades totalVolume totalFees uniqueTraders activeMarkets tradingPaused } _meta { block { number } hasIndexingErrors } }`,
        true
      ),
      query(
        ENDPOINTS.positions,
        `{ globals { totalSplits totalMerges totalRedemptions totalSplitVolume totalMergeVolume totalPayouts totalOpenInterest activeConditions } _meta { block { number } hasIndexingErrors } }`
      ),
      query(
        ENDPOINTS.yield,
        `{ yieldGlobals { totalYieldClaimed totalVTokenMinted totalUnderlyingRedeemed totalRewardsClaimed yieldClaimCount rewardClaimCount } _meta { block { number } hasIndexingErrors } }`
      ),
    ]);

    const obGlobal = ob?.globals?.[0];
    const posGlobal = pos.globals[0];
    const yldGlobal = yld.yieldGlobals[0];

    const netInVenus =
      parseFloat(yldGlobal.totalVTokenMinted) -
      parseFloat(yldGlobal.totalUnderlyingRedeemed);

    const lines = [
      "# Predict.fun Platform Overview",
      "",
      "## Trading",
      `- Total Trades: ${parseInt(obGlobal?.totalTrades || "0").toLocaleString()}`,
      `- Total Volume: ${fmtUsd(obGlobal?.totalVolume || "0")}`,
      `- Total Fees: ${fmtUsd(obGlobal?.totalFees || "0")}`,
      `- Unique Traders: ${parseInt(obGlobal?.uniqueTraders || "0").toLocaleString()}`,
      `- Active Markets: ${obGlobal?.activeMarkets || "N/A"}`,
      `- Trading Paused: ${obGlobal?.tradingPaused || false}`,
      "",
      "## Positions & Open Interest",
      `- Total Open Interest: ${fmtUsd(posGlobal.totalOpenInterest)}`,
      `- Active Conditions: ${posGlobal.activeConditions}`,
      `- Total Splits: ${parseInt(posGlobal.totalSplits).toLocaleString()} (${fmtUsd(posGlobal.totalSplitVolume)})`,
      `- Total Merges: ${parseInt(posGlobal.totalMerges).toLocaleString()} (${fmtUsd(posGlobal.totalMergeVolume)})`,
      `- Total Redemptions: ${parseInt(posGlobal.totalRedemptions).toLocaleString()} (${fmtUsd(posGlobal.totalPayouts)})`,
      "",
      "## Yield (Venus Protocol)",
      `- Deposited into Venus: ${fmtUsd(yldGlobal.totalVTokenMinted)}`,
      `- Redeemed from Venus: ${fmtUsd(yldGlobal.totalUnderlyingRedeemed)}`,
      `- Net Currently in Venus: ${fmtUsd(netInVenus.toString())}`,
      `- Total Yield Claimed: ${fmtUsd(yldGlobal.totalYieldClaimed)}`,
      `- Yield Claims: ${yldGlobal.yieldClaimCount}`,
      "",
      "## Sync Status",
      `- Orderbook: block ${ob?._meta?.block?.number || "N/A"} ${ob?._meta?.hasIndexingErrors ? "(has errors)" : "(healthy)"}`,
      `- Positions: block ${pos._meta.block.number} ${pos._meta.hasIndexingErrors ? "(has errors)" : "(healthy)"}`,
      `- Yield: block ${yld._meta.block.number} ${yld._meta.hasIndexingErrors ? "(has errors)" : "(healthy)"}`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Top Markets ───────────────────────────────────────────────────────

server.tool(
  "get_top_markets",
  "Get the top prediction markets ranked by volume, open interest, or trade count",
  {
    rank_by: z
      .enum(["volume", "open_interest", "trades"])
      .default("volume")
      .describe("How to rank markets"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe("Number of markets to return"),
  },
  async ({ rank_by, limit }) => {
    let lines: string[] = [];

    if (rank_by === "open_interest") {
      const data = await query(
        ENDPOINTS.positions,
        `{ conditions(first: ${limit}, orderBy: openInterest, orderDirection: desc, where: { openInterest_gt: "0" }) { id openInterest splitCount mergeCount resolved source outcomeSlotCount } }`
      );
      lines.push(`# Top ${limit} Markets by Open Interest\n`);
      lines.push("| # | Condition ID | Open Interest | Splits | Merges | Resolved | Source |");
      lines.push("|---|---|---|---|---|---|---|");
      data.conditions.forEach((c: any, i: number) => {
        lines.push(
          `| ${i + 1} | ${fmtAddr(c.id)} | ${fmtUsd(c.openInterest)} | ${c.splitCount} | ${c.mergeCount} | ${c.resolved ? "Yes" : "No"} | ${c.source} |`
        );
      });
    } else {
      const orderBy = rank_by === "trades" ? "tradeCount" : "volume";
      const data = await query(
        ENDPOINTS.orderbook,
        `{ markets(first: ${limit}, orderBy: ${orderBy}, orderDirection: desc, subgraphError: allow) { id volume tradeCount fees exchange } }`,
        true
      );
      const label = rank_by === "trades" ? "Trade Count" : "Volume";
      lines.push(`# Top ${limit} Markets by ${label}\n`);
      lines.push("| # | Condition ID | Volume | Trades | Fees | Exchange |");
      lines.push("|---|---|---|---|---|---|");
      (data?.markets || []).forEach((m: any, i: number) => {
        lines.push(
          `| ${i + 1} | ${fmtAddr(m.id)} | ${fmtUsd(m.volume)} | ${parseInt(m.tradeCount).toLocaleString()} | ${fmtUsd(m.fees)} | ${m.exchange} |`
        );
      });
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Market Details ────────────────────────────────────────────────────

server.tool(
  "get_market_details",
  "Get full details for a specific market/condition: volume, OI, resolution status, recent trades, top holders",
  {
    condition_id: z
      .string()
      .describe("The conditionId (0x hex string) of the market"),
  },
  async ({ condition_id }) => {
    const id = condition_id.toLowerCase();

    const [posData, obData] = await Promise.all([
      query(
        ENDPOINTS.positions,
        `{ condition(id: "${id}") { id oracle questionId outcomeSlotCount resolved payoutNumerators openInterest splitCount mergeCount createdAt resolvedAt source } marketOpenInterest(id: "${id}") { amount splitCount mergeCount lastUpdated } userPositions(first: 5, orderBy: netQuantity, orderDirection: desc, where: { condition: "${id}", netQuantity_gt: "0" }) { id user { id } netQuantity totalSplit totalMerged } }`
      ),
      query(
        ENDPOINTS.orderbook,
        `{ market(id: "${id}", subgraphError: allow) { id volume tradeCount fees exchange createdAt lastTradeAt } }`,
        true
      ),
    ]);

    const cond = posData.condition;
    const market = obData?.market;
    const oi = posData.marketOpenInterest;

    const lines: string[] = [];

    if (!cond && !market) {
      return {
        content: [
          { type: "text", text: `No market found for conditionId: ${condition_id}` },
        ],
      };
    }

    lines.push(`# Market ${fmtAddr(condition_id)}\n`);

    if (cond) {
      lines.push("## Condition");
      lines.push(`- Status: ${cond.resolved ? "**Resolved**" : "**Active**"}`);
      lines.push(`- Outcomes: ${cond.outcomeSlotCount}`);
      lines.push(`- Source: ${cond.source}`);
      lines.push(`- Oracle: ${fmtAddr(cond.oracle)}`);
      lines.push(`- Created: ${fmtDate(cond.createdAt)}`);
      if (cond.resolved) {
        lines.push(`- Resolved: ${fmtDate(cond.resolvedAt)}`);
        lines.push(`- Payouts: [${cond.payoutNumerators.join(", ")}]`);
      }
      lines.push(`- Open Interest: ${fmtUsd(cond.openInterest)}`);
      lines.push(`- Splits: ${cond.splitCount} | Merges: ${cond.mergeCount}`);
    }

    if (market) {
      lines.push("\n## Orderbook");
      lines.push(`- Volume: ${fmtUsd(market.volume)}`);
      lines.push(`- Trades: ${parseInt(market.tradeCount).toLocaleString()}`);
      lines.push(`- Fees: ${fmtUsd(market.fees)}`);
      lines.push(`- Exchange: ${market.exchange}`);
      lines.push(`- Last Trade: ${fmtDate(market.lastTradeAt)}`);
    }

    if (posData.userPositions.length > 0) {
      lines.push("\n## Top Holders");
      lines.push("| Address | Net Position | Total Split | Total Merged |");
      lines.push("|---|---|---|---|");
      posData.userPositions.forEach((p: any) => {
        lines.push(
          `| ${fmtAddr(p.user.id)} | ${fmtUsd(p.netQuantity)} | ${fmtUsd(p.totalSplit)} | ${fmtUsd(p.totalMerged)} |`
        );
      });
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Trader Profile ────────────────────────────────────────────────────

server.tool(
  "get_trader_profile",
  "Get a trader's full profile: trading history, positions, P&L, and reward claims",
  {
    address: z
      .string()
      .describe("Trader wallet address (0x...)"),
  },
  async ({ address }) => {
    const addr = address.toLowerCase();

    const [obData, posData, yldData] = await Promise.all([
      query(
        ENDPOINTS.orderbook,
        `{ account(id: "${addr}", subgraphError: allow) { id totalTrades totalVolume totalFees makerTrades takerTrades makerVolume takerVolume firstTradeAt lastTradeAt } }`,
        true
      ),
      query(
        ENDPOINTS.positions,
        `{ account(id: "${addr}") { id splitCount mergeCount redeemCount totalSplitVolume totalMergeVolume totalPayouts firstSeenAt lastActiveAt } userPositions(first: 10, orderBy: netQuantity, orderDirection: desc, where: { user: "${addr}", netQuantity_gt: "0" }) { id netQuantity totalSplit totalMerged realizedPayout condition { id openInterest resolved } } }`
      ),
      query(
        ENDPOINTS.yield,
        `{ yieldAccount(id: "${addr}") { id totalRewardsClaimed rewardClaimCount firstSeenAt lastActiveAt } }`
      ),
    ]);

    const obAcct = obData?.account;
    const posAcct = posData.account;
    const yldAcct = yldData.yieldAccount;

    if (!obAcct && !posAcct && !yldAcct) {
      return {
        content: [
          { type: "text", text: `No activity found for address: ${address}` },
        ],
      };
    }

    const lines: string[] = [`# Trader ${fmtAddr(address)}\n`];

    if (obAcct) {
      const netPnl =
        parseFloat(posAcct?.totalPayouts || "0") -
        parseFloat(posAcct?.totalSplitVolume || "0") +
        parseFloat(posAcct?.totalMergeVolume || "0");

      lines.push("## Trading Activity");
      lines.push(`- Total Trades: ${parseInt(obAcct.totalTrades).toLocaleString()}`);
      lines.push(`- Total Volume: ${fmtUsd(obAcct.totalVolume)}`);
      lines.push(`- Fees Paid: ${fmtUsd(obAcct.totalFees)}`);
      lines.push(`- Maker: ${parseInt(obAcct.makerTrades).toLocaleString()} trades (${fmtUsd(obAcct.makerVolume)})`);
      lines.push(`- Taker: ${parseInt(obAcct.takerTrades).toLocaleString()} trades (${fmtUsd(obAcct.takerVolume)})`);
      lines.push(`- First Trade: ${fmtDate(obAcct.firstTradeAt)}`);
      lines.push(`- Last Trade: ${fmtDate(obAcct.lastTradeAt)}`);

      if (posAcct) {
        lines.push(`\n## P&L Summary`);
        lines.push(`- Total Split (bought): ${fmtUsd(posAcct.totalSplitVolume)}`);
        lines.push(`- Total Merged (sold back): ${fmtUsd(posAcct.totalMergeVolume)}`);
        lines.push(`- Realized Payouts: ${fmtUsd(posAcct.totalPayouts)}`);
        lines.push(`- Estimated Net P&L: ${fmtUsd(netPnl.toString())}`);
      }
    }

    if (posData.userPositions.length > 0) {
      lines.push("\n## Active Positions");
      lines.push("| Market | Net Position | Invested | Merged | Resolved |");
      lines.push("|---|---|---|---|---|");
      posData.userPositions.forEach((p: any) => {
        lines.push(
          `| ${fmtAddr(p.condition.id)} | ${fmtUsd(p.netQuantity)} | ${fmtUsd(p.totalSplit)} | ${fmtUsd(p.totalMerged)} | ${p.condition.resolved ? "Yes" : "No"} |`
        );
      });
    }

    if (yldAcct) {
      lines.push("\n## Yield Rewards");
      lines.push(`- Total Rewards Claimed: ${fmtUsd(yldAcct.totalRewardsClaimed)}`);
      lines.push(`- Claim Count: ${yldAcct.rewardClaimCount}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Recent Activity ──────────────────────────────────────────────────

server.tool(
  "get_recent_activity",
  "Get recent activity on Predict.fun: latest trades, splits, merges, redemptions, or yield events",
  {
    event_type: z
      .enum(["trades", "splits", "merges", "redemptions", "yield_claims"])
      .describe("Type of activity to fetch"),
    limit: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of events"),
  },
  async ({ event_type, limit }) => {
    const lines: string[] = [];

    switch (event_type) {
      case "trades": {
        const data = await query(
          ENDPOINTS.orderbook,
          `{ orderFilledEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc, subgraphError: allow) { id maker { id } taker { id } makerAmountFilled takerAmountFilled fee price side exchange timestamp transactionHash } }`,
          true
        );
        lines.push(`# Recent ${limit} Trades\n`);
        lines.push("| Time | Side | Price | Maker Amt | Taker Amt | Fee | Exchange |");
        lines.push("|---|---|---|---|---|---|---|");
        (data?.orderFilledEvents || []).forEach((e: any) => {
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${e.side} | $${parseFloat(e.price).toFixed(4)} | ${fmtUsd(e.makerAmountFilled)} | ${fmtUsd(e.takerAmountFilled)} | ${fmtUsd(e.fee)} | ${e.exchange} |`
          );
        });
        break;
      }

      case "splits": {
        const data = await query(
          ENDPOINTS.positions,
          `{ splitEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc) { id stakeholder amount source timestamp condition { id resolved } } }`
        );
        lines.push(`# Recent ${limit} Position Splits\n`);
        lines.push("| Time | User | Amount | Source | Market | Resolved |");
        lines.push("|---|---|---|---|---|---|");
        data.splitEvents.forEach((e: any) => {
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${fmtAddr(e.stakeholder)} | ${fmtUsd(e.amount)} | ${e.source} | ${fmtAddr(e.condition.id)} | ${e.condition.resolved ? "Yes" : "No"} |`
          );
        });
        break;
      }

      case "merges": {
        const data = await query(
          ENDPOINTS.positions,
          `{ mergeEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc) { id stakeholder amount source timestamp condition { id resolved } } }`
        );
        lines.push(`# Recent ${limit} Position Merges\n`);
        lines.push("| Time | User | Amount | Source | Market | Resolved |");
        lines.push("|---|---|---|---|---|---|");
        data.mergeEvents.forEach((e: any) => {
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${fmtAddr(e.stakeholder)} | ${fmtUsd(e.amount)} | ${e.source} | ${fmtAddr(e.condition.id)} | ${e.condition.resolved ? "Yes" : "No"} |`
          );
        });
        break;
      }

      case "redemptions": {
        const data = await query(
          ENDPOINTS.positions,
          `{ redemptionEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc) { id redeemer payout source timestamp condition { id payoutNumerators } } }`
        );
        lines.push(`# Recent ${limit} Redemptions\n`);
        lines.push("| Time | Redeemer | Payout | Source | Market | Winning Outcome |");
        lines.push("|---|---|---|---|---|---|");
        data.redemptionEvents.forEach((e: any) => {
          const winner = e.condition.payoutNumerators
            ? e.condition.payoutNumerators.indexOf("1") === 0
              ? "Yes"
              : "No"
            : "N/A";
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${fmtAddr(e.redeemer)} | ${fmtUsd(e.payout)} | ${e.source} | ${fmtAddr(e.condition.id)} | ${winner} |`
          );
        });
        break;
      }

      case "yield_claims": {
        const data = await query(
          ENDPOINTS.yield,
          `{ yieldClaimEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc) { id underlying vToken vTokenAmount underlyingAmount timestamp transactionHash } }`
        );
        lines.push(`# Recent ${limit} Yield Claims\n`);
        lines.push("| Time | Underlying Amount | vToken Amount | Tx |");
        lines.push("|---|---|---|---|");
        data.yieldClaimEvents.forEach((e: any) => {
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${fmtUsd(e.underlyingAmount)} | ${e.vTokenAmount} | ${fmtAddr(e.transactionHash)} |`
          );
        });
        break;
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Yield Overview ────────────────────────────────────────────────────

server.tool(
  "get_yield_overview",
  "Get Venus Protocol yield stats: deposits, redemptions, net balance, yield claims, and token mappings",
  {},
  async () => {
    const data = await query(
      ENDPOINTS.yield,
      `{ yieldGlobals { totalYieldClaimed totalVTokenMinted totalUnderlyingRedeemed totalRewardsClaimed yieldClaimCount rewardClaimCount totalOracleRequests totalOracleSettlements } tokenMappings(first: 10) { underlying vToken enabled totalDeposited totalYieldClaimed totalVTokenMinted totalRedeemed } yieldClaimEvents(first: 5, orderBy: timestamp, orderDirection: desc) { underlyingAmount timestamp transactionHash } }`
    );

    const g = data.yieldGlobals[0];
    const net =
      parseFloat(g.totalVTokenMinted) -
      parseFloat(g.totalUnderlyingRedeemed);

    const lines = [
      "# Predict.fun Yield Overview (Venus Protocol)\n",
      "## Global Stats",
      `- Total Deposited to Venus: ${fmtUsd(g.totalVTokenMinted)}`,
      `- Total Redeemed: ${fmtUsd(g.totalUnderlyingRedeemed)}`,
      `- **Net in Venus: ${fmtUsd(net.toString())}**`,
      `- Total Yield Claimed: ${fmtUsd(g.totalYieldClaimed)}`,
      `- Yield Claim Events: ${g.yieldClaimCount}`,
      `- Reward Claims: ${g.rewardClaimCount} (${fmtUsd(g.totalRewardsClaimed)})`,
      `- Oracle Requests: ${g.totalOracleRequests}`,
      `- Oracle Settlements: ${g.totalOracleSettlements}`,
    ];

    if (data.tokenMappings.length > 0) {
      lines.push("\n## Token Mappings");
      data.tokenMappings.forEach((tm: any) => {
        lines.push(`\n### ${fmtAddr(tm.underlying)} → ${fmtAddr(tm.vToken)}`);
        lines.push(`- Enabled: ${tm.enabled}`);
        lines.push(`- Total Minted: ${fmtUsd(tm.totalVTokenMinted)}`);
        lines.push(`- Total Redeemed: ${fmtUsd(tm.totalRedeemed)}`);
        lines.push(`- Yield Claimed: ${fmtUsd(tm.totalYieldClaimed)}`);
      });
    }

    if (data.yieldClaimEvents.length > 0) {
      lines.push("\n## Recent Yield Claims");
      lines.push("| Time | Amount | Tx |");
      lines.push("|---|---|---|");
      data.yieldClaimEvents.forEach((e: any) => {
        lines.push(
          `| ${fmtDate(e.timestamp)} | ${fmtUsd(e.underlyingAmount)} | ${fmtAddr(e.transactionHash)} |`
        );
      });
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Whale Watch ──────────────────────────────────────────────────────

server.tool(
  "get_whale_positions",
  "Find the largest position holders across all Predict.fun markets",
  {
    limit: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of positions to return"),
    min_position: z
      .number()
      .default(1000)
      .describe("Minimum position size in USD"),
  },
  async ({ limit, min_position }) => {
    const data = await query(
      ENDPOINTS.positions,
      `{ userPositions(first: ${limit}, orderBy: netQuantity, orderDirection: desc, where: { netQuantity_gt: "${min_position}" }) { id user { id totalSplitVolume totalPayouts } netQuantity totalSplit totalMerged realizedPayout condition { id openInterest resolved source } } }`
    );

    const lines = [
      `# Whale Positions (min ${fmtUsd(min_position.toString())})\n`,
      "| # | Trader | Position | Market | Market OI | Resolved | % of OI |",
      "|---|---|---|---|---|---|---|",
    ];

    data.userPositions.forEach((p: any, i: number) => {
      const pctOi =
        parseFloat(p.condition.openInterest) > 0
          ? (
              (parseFloat(p.netQuantity) /
                parseFloat(p.condition.openInterest)) *
              100
            ).toFixed(1)
          : "N/A";
      lines.push(
        `| ${i + 1} | ${fmtAddr(p.user.id)} | ${fmtUsd(p.netQuantity)} | ${fmtAddr(p.condition.id)} | ${fmtUsd(p.condition.openInterest)} | ${p.condition.resolved ? "Yes" : "No"} | ${pctOi}% |`
      );
    });

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Market Leaderboard ────────────────────────────────────────────────

server.tool(
  "get_leaderboard",
  "Get the top traders on Predict.fun by volume, P&L, or trade count",
  {
    rank_by: z
      .enum(["volume", "payouts", "trades"])
      .default("volume")
      .describe("How to rank traders"),
    limit: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of traders"),
  },
  async ({ rank_by, limit }) => {
    const lines: string[] = [];

    if (rank_by === "payouts") {
      const data = await query(
        ENDPOINTS.positions,
        `{ accounts(first: ${limit}, orderBy: totalPayouts, orderDirection: desc, where: { totalPayouts_gt: "0" }) { id splitCount mergeCount redeemCount totalSplitVolume totalMergeVolume totalPayouts } }`
      );
      lines.push(`# Top ${limit} Traders by Payouts\n`);
      lines.push("| # | Trader | Payouts | Invested | Merged | Redemptions | Est. P&L |");
      lines.push("|---|---|---|---|---|---|---|");
      data.accounts.forEach((a: any, i: number) => {
        const pnl =
          parseFloat(a.totalPayouts) +
          parseFloat(a.totalMergeVolume) -
          parseFloat(a.totalSplitVolume);
        lines.push(
          `| ${i + 1} | ${fmtAddr(a.id)} | ${fmtUsd(a.totalPayouts)} | ${fmtUsd(a.totalSplitVolume)} | ${fmtUsd(a.totalMergeVolume)} | ${a.redeemCount} | ${fmtUsd(pnl.toString())} |`
        );
      });
    } else {
      const orderBy = rank_by === "trades" ? "totalTrades" : "totalVolume";
      const data = await query(
        ENDPOINTS.orderbook,
        `{ accounts(first: ${limit}, orderBy: ${orderBy}, orderDirection: desc, subgraphError: allow) { id totalTrades totalVolume totalFees makerTrades takerTrades } }`,
        true
      );
      const label = rank_by === "trades" ? "Trades" : "Volume";
      lines.push(`# Top ${limit} Traders by ${label}\n`);
      lines.push("| # | Trader | Volume | Trades | Fees | Maker | Taker |");
      lines.push("|---|---|---|---|---|---|---|");
      (data?.accounts || []).forEach((a: any, i: number) => {
        lines.push(
          `| ${i + 1} | ${fmtAddr(a.id)} | ${fmtUsd(a.totalVolume)} | ${parseInt(a.totalTrades).toLocaleString()} | ${fmtUsd(a.totalFees)} | ${parseInt(a.makerTrades).toLocaleString()} | ${parseInt(a.takerTrades).toLocaleString()} |`
        );
      });
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Resolved Markets ─────────────────────────────────────────────────

server.tool(
  "get_resolved_markets",
  "Get recently resolved markets with their outcomes and payout info",
  {
    limit: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of resolved markets"),
  },
  async ({ limit }) => {
    const data = await query(
      ENDPOINTS.positions,
      `{ conditions(first: ${limit}, orderBy: resolvedAt, orderDirection: desc, where: { resolved: true }) { id outcomeSlotCount payoutNumerators openInterest splitCount mergeCount createdAt resolvedAt source } }`
    );

    const lines = [
      `# Recently Resolved Markets\n`,
      "| # | Market | Winning | OI at Resolution | Splits | Resolved At | Source |",
      "|---|---|---|---|---|---|---|",
    ];

    data.conditions.forEach((c: any, i: number) => {
      const winIdx = c.payoutNumerators.indexOf("1");
      const winner =
        winIdx === 0 ? "Outcome A (Yes)" : winIdx === 1 ? "Outcome B (No)" : `Outcome ${winIdx}`;
      lines.push(
        `| ${i + 1} | ${fmtAddr(c.id)} | ${winner} | ${fmtUsd(c.openInterest)} | ${c.splitCount} | ${fmtDate(c.resolvedAt)} | ${c.source} |`
      );
    });

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Custom Query ──────────────────────────────────────────────────────

server.tool(
  "query_subgraph",
  "Run a custom GraphQL query against any Predict.fun subgraph. Use this for advanced queries not covered by other tools.",
  {
    subgraph: z
      .enum(["orderbook", "positions", "yield"])
      .describe("Which subgraph to query"),
    graphql_query: z
      .string()
      .describe("The GraphQL query string"),
  },
  async ({ subgraph, graphql_query }) => {
    const endpoint = ENDPOINTS[subgraph];
    const allowErrors = subgraph === "orderbook";
    const data = await query(endpoint, graphql_query, allowErrors);
    return {
      content: [
        { type: "text", text: JSON.stringify(data, null, 2) },
      ],
    };
  }
);

// ─── Prompts ─────────────────────────────────────────────────────────────────

server.prompt(
  "platform_overview",
  "Get a full overview of the Predict.fun platform",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "Give me a full overview of Predict.fun — platform stats, top markets, biggest whales, and yield status. Use get_platform_stats, get_top_markets, get_whale_positions, and get_yield_overview.",
        },
      },
    ],
  })
);

server.prompt(
  "analyze_trader",
  "Analyze a specific trader's activity and P&L",
  { address: z.string().describe("Trader wallet address (0x...)") },
  ({ address }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Analyze trader ${address} on Predict.fun. Use get_trader_profile to get their full trading history, positions, and P&L. Then check if they appear on the leaderboard with get_leaderboard. Summarize whether they're profitable, what markets they're active in, and their trading style (maker vs taker).`,
        },
      },
    ],
  })
);

server.prompt(
  "market_deep_dive",
  "Deep dive into a specific prediction market",
  { condition_id: z.string().describe("Market conditionId (0x...)") },
  ({ condition_id }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Do a deep dive on Predict.fun market ${condition_id}. Use get_market_details for the full picture — volume, open interest, resolution status, and top holders. Then use get_recent_activity with type "trades" to see latest activity. Analyze: Is this market active? Who are the biggest participants? Is the OI growing or shrinking?`,
        },
      },
    ],
  })
);

server.prompt(
  "yield_analysis",
  "Analyze Predict.fun's Venus Protocol yield mechanics",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "Analyze Predict.fun's yield-bearing mechanics. Use get_yield_overview to see Venus Protocol deposits, redemptions, and yield claims. Also use get_platform_stats for context on total OI vs yield deposits. Calculate the yield APY based on the claim data. How much of the platform's collateral is earning yield?",
        },
      },
    ],
  })
);

server.prompt(
  "whale_alert",
  "Find the biggest players and their market positions",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "Show me the whales on Predict.fun. Use get_whale_positions with a minimum of $10,000. Then use get_leaderboard ranked by payouts to find the most profitable traders. For the top 3 whales, use get_trader_profile to understand their strategies. Are they concentrated in specific markets or diversified?",
        },
      },
    ],
  })
);

server.prompt(
  "market_scanner",
  "Scan for interesting markets — highest volume, most OI, recently resolved",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "Scan the Predict.fun markets for me. Use get_top_markets ranked by volume (top 10), then by open_interest (top 10), then by trades (top 10). Also use get_resolved_markets to see the 5 most recently resolved markets and their outcomes. Which markets are the most active right now? Any with unusually high OI relative to volume?",
        },
      },
    ],
  })
);

server.prompt(
  "custom_query_examples",
  "Show example GraphQL queries for each Predict.fun subgraph",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Show me example custom GraphQL queries I can run with query_subgraph. Here are some useful ones:

**Orderbook** — Recent large trades (>$1000):
\`\`\`graphql
{ orderFilledEvents(first: 10, orderBy: timestamp, orderDirection: desc, where: { makerAmountFilled_gt: "1000" }, subgraphError: allow) { maker { id } taker { id } makerAmountFilled price side exchange timestamp } }
\`\`\`

**Positions** — All positions for a specific market:
\`\`\`graphql
{ userPositions(first: 50, where: { condition: "0x1141...", netQuantity_gt: "0" }, orderBy: netQuantity, orderDirection: desc) { user { id } netQuantity totalSplit totalMerged } }
\`\`\`

**Positions** — Markets created in the last 24 hours:
\`\`\`graphql
{ conditions(first: 20, orderBy: createdAt, orderDirection: desc, where: { createdAt_gt: "UNIX_TIMESTAMP" }) { id outcomeSlotCount openInterest source createdAt } }
\`\`\`

**Yield** — Token mapping details:
\`\`\`graphql
{ tokenMappings { underlying vToken enabled totalVTokenMinted totalRedeemed totalYieldClaimed } }
\`\`\`

**Positions** — NegRisk conversion events:
\`\`\`graphql
{ negRiskConversionEvents(first: 10, orderBy: timestamp, orderDirection: desc) { stakeholder marketId indexSet amount source timestamp } }
\`\`\`

Run any of these with the query_subgraph tool, specifying the subgraph name and the query.`,
        },
      },
    ],
  })
);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
