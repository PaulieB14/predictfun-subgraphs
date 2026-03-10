#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Subgraph Endpoints ──────────────────────────────────────────────────────

const ENDPOINTS = {
  orderbook:
    "https://api.studio.thegraph.com/query/1717345/predictfun-orderbook/v0.0.2",
  positions:
    "https://api.studio.thegraph.com/query/1717345/predictfun-positions/v0.0.1",
  yield:
    "https://api.studio.thegraph.com/query/1717345/predictfun-yield/v0.0.1",
};

// ─── GraphQL Helper ──────────────────────────────────────────────────────────

async function query(
  endpoint: string,
  gql: string,
  allowErrors = false
): Promise<any> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
