#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

// ─── Configuration ───────────────────────────────────────────────────────────

// The Graph Gateway API key (required — pay per query)
const API_KEY = process.env.GRAPH_API_KEY;
if (!API_KEY) {
  console.error(
    "Error: GRAPH_API_KEY environment variable is required.\n" +
    "Get your API key at https://thegraph.com/studio/apikeys/\n" +
    "See: https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/"
  );
  process.exit(1);
}

// Predict.fun REST API key — bundled default enables market name hydration out of the box.
// Override with PREDICT_API_KEY env var to use your own key (higher rate limits).
const PREDICT_API_KEY = process.env.PREDICT_API_KEY || "cdec6be2-15aa-4dfb-8086-16f4a462e2a3";
const PREDICT_API_BASE = "https://api.predict.fun";

// Published subgraph IDs on The Graph Network
const SUBGRAPH_IDS = {
  orderbook: "89T2Z1tzwRB7obJZ8Mpo8N6eiBnsG1hM69VCMkfccEAZ",
  positions: "CC7fzcAvcDr1Wt2SGJzj8aYsVYbN5sr7v42ysiqLPzhd",
  yield: "96B2b2LtkgcurXTEnrSAUN5jr4T1BrfV3s5sPXNdnER8",
} as const;

const ENDPOINTS = {
  orderbook: `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_IDS.orderbook}`,
  positions: `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_IDS.positions}`,
  yield: `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_IDS.yield}`,
};

// ─── BNB Chain RPC ──────────────────────────────────────────────────────────

const BSC_RPC = "https://bsc-dataseed.binance.org/";

async function isContract(address: string): Promise<number> {
  try {
    const res = await fetch(BSC_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getCode",
        params: [address.toLowerCase(), "latest"],
        id: 1,
      }),
    });
    const json = await res.json();
    const code: string = json.result || "0x";
    const byteLen = (code.length - 2) / 2;
    return byteLen;
  } catch {
    return 0;
  }
}

// Address types: "protocol" | "user" (smart wallet) | "bot" (large contract) | "eoa"
type AddrType = "protocol" | "user" | "bot" | "eoa";

// Privy/ERC-1967 smart wallets are ~61 bytes (minimal proxy).
// Real bots/vaults/strategies have much larger bytecode.
const SMART_WALLET_MAX_BYTES = 200;

async function classifyAddresses(addresses: string[]): Promise<Map<string, AddrType>> {
  const results = new Map<string, AddrType>();
  const unknown: string[] = [];
  for (const addr of addresses) {
    const lower = addr.toLowerCase();
    if (lower in KNOWN_CONTRACTS) {
      results.set(lower, "protocol");
    } else {
      unknown.push(lower);
    }
  }
  const batch = unknown.slice(0, 10);
  const checks = await Promise.all(batch.map((a) => isContract(a)));
  batch.forEach((addr, i) => {
    const byteLen = checks[i];
    if (byteLen === 0) results.set(addr, "eoa");
    else if (byteLen <= SMART_WALLET_MAX_BYTES) results.set(addr, "user");
    else results.set(addr, "bot");
  });
  return results;
}

function addrTypeLabel(t: AddrType | undefined): string {
  switch (t) {
    case "protocol": return "Protocol";
    case "user": return "User";
    case "bot": return "Bot";
    case "eoa": return "EOA";
    default: return "Unknown";
  }
}

// ─── GraphQL Helper ──────────────────────────────────────────────────────────

async function query(endpoint: string, gql: string): Promise<any> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });
  const json = await res.json();
  if (json.errors && !json.data) {
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

// ─── Predict.fun API Helper ──────────────────────────────────────────────────
// Centralized fetch for predict.fun REST API with auth and rate limit tracking

async function predictApiFetch(
  path: string,
  params: Record<string, string> = {}
): Promise<{ ok: boolean; data: any; rateLimitRemaining: number | null }> {
  if (!PREDICT_API_KEY) return { ok: false, data: null, rateLimitRemaining: null };

  const url = new URL(`${PREDICT_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString(), {
      headers: { "x-api-key": PREDICT_API_KEY, "Content-Type": "application/json" },
    });

    const remaining = res.headers.get("ratelimit-remaining");
    const reset = res.headers.get("ratelimit-reset");
    const rateLimitRemaining = remaining !== null ? parseInt(remaining) : null;

    if (rateLimitRemaining !== null && rateLimitRemaining < 20) {
      console.error(`[predict.fun] Rate limit low: ${rateLimitRemaining} remaining, resets ${reset}`);
    }

    if (!res.ok) return { ok: false, data: null, rateLimitRemaining };
    const data = await res.json();
    return { ok: true, data, rateLimitRemaining };
  } catch {
    return { ok: false, data: null, rateLimitRemaining: null };
  }
}

// ─── Predict.fun API market name cache ──────────────────────────────────────
// Maps conditionId → title/question from the REST API
const marketNameCache = new Map<string, string>();
const marketIdCache = new Map<string, number>(); // conditionId → numeric API id
let marketCacheLoaded = false;
let marketCacheLoadedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function loadMarketNamesFromAPI(): Promise<void> {
  const now = Date.now();
  if (marketCacheLoaded && now - marketCacheLoadedAt < CACHE_TTL_MS) return;
  if (!PREDICT_API_KEY) return;

  try {
    let cursor: string | null = null;
    let pages = 0;
    const maxPages = 20;

    do {
      const params: Record<string, string> = { first: "100" };
      if (cursor) params.after = cursor;

      const { ok, data } = await predictApiFetch("/v1/markets", params);
      if (!ok || !data) break;

      for (const m of data.data || []) {
        if (m.conditionId) {
          const key = m.conditionId.toLowerCase();
          if (m.title || m.question) marketNameCache.set(key, m.title || m.question);
          if (m.id) marketIdCache.set(key, m.id);
        }
      }
      cursor = data.cursor || null;
      pages++;
    } while (cursor && pages < maxPages);

    marketCacheLoaded = true;
    marketCacheLoadedAt = now;
  } catch {
    // API unavailable — fall through to subgraph resolution
  }
}

// Resolve condition/market IDs to human-readable names
// Strategy: conditionId → questionId (positions) → NegRiskQuestion (orderbook) → name
// Fallback: Predict.fun REST API for non-NegRisk markets
async function resolveMarketNames(conditionIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (conditionIds.length === 0) return names;

  // Step 1: Look up questionIds from positions subgraph
  const idFilter = conditionIds.map((id) => `"${id}"`).join(", ");
  let questionIdMap = new Map<string, string>(); // conditionId → questionId
  try {
    const posData = await query(
      ENDPOINTS.positions,
      `{ conditions(where: { id_in: [${idFilter}] }) { id questionId } }`
    );
    for (const c of posData?.conditions || []) {
      questionIdMap.set(c.id, c.questionId);
    }
  } catch {
    // positions subgraph unavailable
  }

  // Step 2: Resolve questionIds via NegRisk entities in orderbook subgraph
  const questionIds = [...new Set(questionIdMap.values())];
  if (questionIds.length > 0) {
    const qFilter = questionIds.map((id) => `"${id}"`).join(", ");
    try {
      const data = await query(
        ENDPOINTS.orderbook,
        `{ negRiskQuestions(where: { id_in: [${qFilter}] }) { id question market { id title } } }`
      );
      const qNameMap = new Map<string, string>();
      for (const q of data?.negRiskQuestions || []) {
        qNameMap.set(q.id, q.question || q.market?.title || q.id);
      }
      // Map back: conditionId → questionId → name
      for (const [condId, qId] of questionIdMap) {
        const name = qNameMap.get(qId);
        if (name) names.set(condId, name);
      }
    } catch {
      // orderbook subgraph unavailable
    }
  }

  // Also try direct NegRisk market/question lookup by conditionId (some may match directly)
  const stillMissing = conditionIds.filter((id) => !names.has(id));
  if (stillMissing.length > 0) {
    const mFilter = stillMissing.map((id) => `"${id}"`).join(", ");
    try {
      const data = await query(
        ENDPOINTS.orderbook,
        `{ negRiskQuestions(where: { id_in: [${mFilter}] }) { id question market { id title } } negRiskMarkets(where: { id_in: [${mFilter}] }) { id title } }`
      );
      for (const q of data?.negRiskQuestions || []) {
        if (!names.has(q.id)) names.set(q.id, q.question || q.market?.title || q.id);
      }
      for (const m of data?.negRiskMarkets || []) {
        if (m.title && !names.has(m.id)) names.set(m.id, m.title);
      }
    } catch {}
  }

  // Step 3: Fallback to Predict.fun REST API for any remaining unresolved IDs
  const apiMissing = conditionIds.filter((id) => !names.has(id));
  if (apiMissing.length > 0) {
    await loadMarketNamesFromAPI();
    for (const id of apiMissing) {
      const cached = marketNameCache.get(id.toLowerCase());
      if (cached) names.set(id, cached);
    }
  }

  return names;
}

function marketLabel(id: string, names: Map<string, string>): string {
  return names.get(id) || id;
}

// ─── Known Protocol Contracts ───────────────────────────────────────────────
// These are Predict.fun infrastructure contracts, not human traders.
// Used to filter leaderboards/whale lists and label oracle addresses.

const KNOWN_CONTRACTS: Record<string, { name: string; role: string }> = {
  // ─── Orderbook subgraph contracts ───
  "0x8bc070bedab741406f4b1eb65a72bee27894b689": { name: "CTFExchange (Non-Yield)", role: "Exchange — matches orders for non-yield markets" },
  "0x6beb5a40c032afc305961162d8204cda16decfa5": { name: "CTFExchange (Yield)", role: "Exchange — matches orders for yield-bearing markets" },
  "0x365fb81bd4a24d6303cd2f19c349de6894d8d58a": { name: "NegRiskCtfExchange (Non-Yield)", role: "Exchange — matches NegRisk orders for non-yield markets" },
  "0x8a289d458f5a134ba40015085a8f50ffb681b41d": { name: "NegRiskCtfExchange (Yield)", role: "Exchange — matches NegRisk orders for yield-bearing markets" },
  // ─── Positions subgraph contracts ───
  "0x22da1810b194ca018378464a58f6ac2b10c9d244": { name: "ConditionalTokens (Non-Yield)", role: "CTF — manages conditional token splits/merges/redemptions" },
  "0x9400f8ad57e9e0f352345935d6d3175975eb1d9f": { name: "ConditionalTokens (Yield)", role: "CTF — manages yield-bearing conditional tokens via Venus" },
  "0xf64b0b318aaf83bd9071110af24d24445719a07f": { name: "NegRisk ConditionalTokens (Yield)", role: "CTF — manages NegRisk yield-bearing conditional tokens" },
  "0xc3cf7c252f65e0d8d88537df96569ae94a7f1a6e": { name: "NegRiskAdapter (Non-Yield)", role: "Oracle — resolves NEG_RISK_NON_YIELD markets" },
  "0x41dce1a4b8fb5e6327701750af6231b7cd0b2a40": { name: "NegRiskAdapter (Yield)", role: "Oracle — resolves NEG_RISK_YIELD markets" },
  "0xbb7250101e0e3611d7e136ffe73bc24b98e3e175": { name: "NegRiskOperator (Yield)", role: "Operator — prepares NegRisk yield markets" },
  "0x56020f5024641d577cb54032af70a23a986ecffd": { name: "NegRiskOperator (Non-Yield)", role: "Operator — prepares NegRisk non-yield markets" },
  // ─── Yield subgraph contracts ───
  "0x14e3a0a4ab4e4fa60fc6b4acce200afad9233ece": { name: "RewardDistributor", role: "Distributes yield rewards to position holders" },
  "0x76f4632032d3e16fe15e06ddb60b53c67bce17a0": { name: "UMA Optimistic Oracle", role: "Oracle — provides price resolution via UMA protocol" },
};

function isKnownContract(addr: string): boolean {
  return addr.toLowerCase() in KNOWN_CONTRACTS;
}

// GraphQL-safe list of protocol addresses for where: { user_not_in / id_not_in } filters
const PROTOCOL_ADDR_LIST = JSON.stringify(Object.keys(KNOWN_CONTRACTS));

function contractLabel(addr: string): { is_contract: boolean; contract_name?: string; contract_role?: string } {
  const info = KNOWN_CONTRACTS[addr.toLowerCase()];
  if (info) return { is_contract: true, contract_name: info.name, contract_role: info.role };
  return { is_contract: false };
}

// ─── Meta-Tool Constants ────────────────────────────────────────────────────

const PERSONA_THRESHOLDS = {
  whale_oi_pct: 0.05,          // >5% of market OI
  arb_min_trades: 100,
  arb_taker_ratio: 0.70,
  early_mover_window: 86400,   // 24h in seconds
  sniper_window: 172800,       // 48h in seconds
  resolution_fast: 604800,     // 7 days
  resolution_medium: 2592000,  // 30 days
  resolution_slow: 7776000,    // 90 days
  liquidity_deep_tpd: 10,     // trades per day
  liquidity_thin_tpd: 1,
  dormant_seconds: 604800,     // 7 days
  concentrated_top3_pct: 0.50,
};

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function classifyResolutionLatency(
  createdAt: number,
  resolvedAt: number | null,
  resolved: boolean
): { tag: string; seconds: number | null } {
  if (resolved && resolvedAt) {
    const s = resolvedAt - createdAt;
    const tag =
      s < PERSONA_THRESHOLDS.resolution_fast ? "fast" :
      s < PERSONA_THRESHOLDS.resolution_medium ? "medium" :
      s < PERSONA_THRESHOLDS.resolution_slow ? "slow" : "stale";
    return { tag, seconds: s };
  }
  const age = nowUnix() - createdAt;
  const tag =
    age < PERSONA_THRESHOLDS.resolution_fast ? "pending_fast" :
    age < PERSONA_THRESHOLDS.resolution_medium ? "pending_medium" :
    age < PERSONA_THRESHOLDS.resolution_slow ? "pending_slow" : "potentially_stale";
  return { tag, seconds: age };
}

function classifyLiquidity(
  tradeCount: number,
  volume: number,
  createdAt: number,
  lastTradeAt: number
): { tag: string; tradesPerDay: number; volumePerTrade: number; daysSinceLastTrade: number } {
  const ageInDays = Math.max((nowUnix() - createdAt) / 86400, 1);
  const tradesPerDay = tradeCount / ageInDays;
  const volumePerTrade = tradeCount > 0 ? volume / tradeCount : 0;
  const daysSinceLastTrade = (nowUnix() - lastTradeAt) / 86400;

  let tag: string;
  if (daysSinceLastTrade > 7) tag = "dormant";
  else if (tradesPerDay >= PERSONA_THRESHOLDS.liquidity_deep_tpd) tag = "deep";
  else if (tradesPerDay >= PERSONA_THRESHOLDS.liquidity_thin_tpd) tag = "moderate";
  else tag = "thin";

  return { tag, tradesPerDay: Math.round(tradesPerDay * 100) / 100, volumePerTrade: Math.round(volumePerTrade * 100) / 100, daysSinceLastTrade: Math.round(daysSinceLastTrade * 10) / 10 };
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
        `{ globals { totalTrades totalVolume totalFees uniqueTraders activeMarkets tradingPaused } _meta { block { number } hasIndexingErrors } }`
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
        `{ conditions(first: ${limit}, orderBy: openInterest, orderDirection: desc, where: { openInterest_gt: "0" }) { id openInterest splitCount mergeCount resolved resolvedAt source outcomeSlotCount } }`
      );
      const ids = data.conditions.map((c: any) => c.id);
      const names = await resolveMarketNames(ids);
      lines.push(`# Top ${limit} Markets by Open Interest\n`);
      lines.push("| # | Condition ID | Market | Open Interest | Status | Splits | Merges |");
      lines.push("|---|---|---|---|---|---|---|");
      data.conditions.forEach((c: any, i: number) => {
        let status = c.resolved ? "Resolved" : "Active";
        if (c.resolved && parseFloat(c.openInterest) > 0) {
          const days = Math.round((nowUnix() - parseInt(c.resolvedAt)) / 86400);
          status = `⚠ Zombie OI (${days}d)`;
        }
        lines.push(
          `| ${i + 1} | ${c.id} | ${marketLabel(c.id, names)} | ${fmtUsd(c.openInterest)} | ${status} | ${c.splitCount} | ${c.mergeCount} |`
        );
      });
    } else {
      const orderBy = rank_by === "trades" ? "tradeCount" : "volume";
      const data = await query(
        ENDPOINTS.orderbook,
        `{ markets(first: ${limit}, orderBy: ${orderBy}, orderDirection: desc) { id volume tradeCount fees exchange } }`
      );
      const ids = (data?.markets || []).map((m: any) => m.id);
      const names = await resolveMarketNames(ids);
      const label = rank_by === "trades" ? "Trade Count" : "Volume";
      lines.push(`# Top ${limit} Markets by ${label}\n`);
      lines.push("| # | Condition ID | Market | Volume | Trades | Fees | Exchange |");
      lines.push("|---|---|---|---|---|---|---|");
      (data?.markets || []).forEach((m: any, i: number) => {
        lines.push(
          `| ${i + 1} | ${m.id} | ${marketLabel(m.id, names)} | ${fmtUsd(m.volume)} | ${parseInt(m.tradeCount).toLocaleString()} | ${fmtUsd(m.fees)} | ${m.exchange} |`
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

    const [posData, obData, yieldData] = await Promise.all([
      query(
        ENDPOINTS.positions,
        `{ condition(id: "${id}") { id oracle questionId outcomeSlotCount resolved payoutNumerators openInterest splitCount mergeCount createdAt resolvedAt source } marketOpenInterest(id: "${id}") { amount splitCount mergeCount lastUpdated } userPositions(first: 5, orderBy: netQuantity, orderDirection: desc, where: { condition: "${id}", netQuantity_gt: "0" }) { id user { id } netQuantity totalSplit totalMerged } }`
      ),
      query(
        ENDPOINTS.orderbook,
        `{ market(id: "${id}") { id volume tradeCount fees exchange createdAt lastTradeAt } }`
      ),
      query(
        ENDPOINTS.yield,
        `{ oracleRequests(first: 1, where: { requester: "${id}" }) { id settled settledAt } tokenMappings(first: 1) { underlying vToken enabled totalDeposited } }`
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

    const names = await resolveMarketNames([id]);
    const title = names.get(id);
    lines.push(`# ${title ? title : `Market ${fmtAddr(condition_id)}`}\n`);

    if (cond) {
      lines.push("## Condition");
      lines.push(`- Status: ${cond.resolved ? "**Resolved**" : "**Active**"}`);
      lines.push(`- Outcomes: ${cond.outcomeSlotCount}`);
      lines.push(`- Source: ${cond.source}`);
      const oracleInfo = contractLabel(cond.oracle);
      if (oracleInfo.is_contract) {
        lines.push(`- Oracle: ${cond.oracle} (**${oracleInfo.contract_name}** — ${oracleInfo.contract_role})`);
      } else {
        lines.push(`- Oracle: ${cond.oracle}`);
      }
      lines.push(`- Created: ${fmtDate(cond.createdAt)}`);
      if (cond.resolved) {
        lines.push(`- Resolved: ${fmtDate(cond.resolvedAt)}`);
        lines.push(`- Payouts: [${cond.payoutNumerators.join(", ")}]`);
        const oi = parseFloat(cond.openInterest);
        if (oi > 0) {
          const daysSinceResolution = Math.round((nowUnix() - parseInt(cond.resolvedAt)) / 86400);
          // Cross-ref yield oracle: determine if OI is stuck waiting on oracle vs unredeemed by users
          const oracleReq = yieldData?.oracleRequests?.[0];
          if (oracleReq && !oracleReq.settled) {
            lines.push(`- **⚠ Zombie OI: ${fmtUsd(cond.openInterest)} blocked** (${daysSinceResolution}d — oracle request unsettled, yield module cannot release funds until settlement)`);
          } else if (oracleReq && oracleReq.settled) {
            lines.push(`- **⚠ Zombie OI: ${fmtUsd(cond.openInterest)} unredeemed** (${daysSinceResolution}d since resolution, oracle settled ${fmtDate(oracleReq.settledAt)} — winners must manually redeem via UI)`);
          } else {
            lines.push(`- **⚠ Zombie OI: ${fmtUsd(cond.openInterest)} unredeemed** (${daysSinceResolution} days since resolution — winners must manually redeem via UI)`);
          }
        }
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

    // Yield subgraph: oracle request status + token mapping exposure
    const oracleReqDetail = yieldData?.oracleRequests?.[0];
    const tokenMapping = yieldData?.tokenMappings?.[0];
    if (oracleReqDetail || tokenMapping) {
      lines.push("\n## Yield / Oracle");
      if (oracleReqDetail) {
        lines.push(`- Oracle Request: ${oracleReqDetail.id}`);
        lines.push(`- Settled: ${oracleReqDetail.settled ? `Yes (${fmtDate(oracleReqDetail.settledAt)})` : "No — pending settlement"}`);
      }
      if (tokenMapping) {
        lines.push(`- Underlying Token: ${tokenMapping.underlying}`);
        lines.push(`- vToken: ${tokenMapping.vToken}`);
        lines.push(`- Vault Enabled: ${tokenMapping.enabled}`);
        lines.push(`- Total Deposited: ${fmtUsd(tokenMapping.totalDeposited)}`);
      }
    }

    if (posData.userPositions.length > 0) {
      const holderAddrs = posData.userPositions.map((p: any) => p.user.id);
      const holderTypes = await classifyAddresses(holderAddrs);
      lines.push("\n## Top Holders");
      lines.push("| Address | Type | Net Position | Total Split | Total Merged |");
      lines.push("|---|---|---|---|---|");
      posData.userPositions.forEach((p: any) => {
        const ci = contractLabel(p.user.id);
        const addrType = holderTypes.get(p.user.id.toLowerCase());
        const typeCol = ci.is_contract
          ? `Protocol (${ci.contract_name})`
          : addrTypeLabel(addrType);
        lines.push(
          `| ${p.user.id} | ${typeCol} | ${fmtUsd(p.netQuantity)} | ${fmtUsd(p.totalSplit)} | ${fmtUsd(p.totalMerged)} |`
        );
      });
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: Live Orderbook ────────────────────────────────────────────────────

server.tool(
  "get_market_orderbook",
  "Get the live order book for a Predict.fun market — current bids and asks with prices and sizes. Requires PREDICT_API_KEY. Provide market_id (integer from Predict.fun API) or condition_id. Use this to see the current state of the market, not historical trades.",
  {
    condition_id: z
      .string()
      .optional()
      .describe("The conditionId (0x hex string) of the market — used to look up the numeric market_id from cache"),
    market_id: z
      .number()
      .int()
      .optional()
      .describe("The numeric market ID from Predict.fun API (e.g. 1187). More reliable than condition_id lookup."),
  },
  async ({ condition_id, market_id }) => {
    if (!PREDICT_API_KEY) {
      return {
        content: [{ type: "text", text: "PREDICT_API_KEY is required for live orderbook data. Set it in your .env file." }],
      };
    }

    if (!condition_id && !market_id) {
      return {
        content: [{ type: "text", text: "Provide either condition_id or market_id." }],
      };
    }

    let numericId: number | undefined = market_id;

    if (!numericId && condition_id) {
      const condKey = condition_id.toLowerCase();
      await loadMarketNamesFromAPI();
      numericId = marketIdCache.get(condKey);

      if (!numericId) {
        // Cache miss — try fetching the single market directly via conditionId search
        // The API doesn't support conditionId filter, so we inform the user
        return {
          content: [{ type: "text", text: `Market ${condition_id} not found in API cache. Try providing the numeric market_id instead (find it via get_top_markets or the Predict.fun website URL).` }],
        };
      }
    }

    const { ok, data, rateLimitRemaining } = await predictApiFetch(`/v1/markets/${numericId}/orderbook`);

    if (!ok || !data) {
      return {
        content: [{ type: "text", text: `Could not fetch orderbook for market ${numericId} (${condition_id}). The market may be resolved or inactive.` }],
      };
    }

    const ob = data.data ?? data; // response is { success, data: { bids, asks, ... } }
    // bids/asks are arrays of [price, size] tuples
    const allBids: number[][] = ob.bids ?? [];
    const allAsks: number[][] = ob.asks ?? [];

    const condKey = condition_id?.toLowerCase() ?? "";
    const names = condKey ? await resolveMarketNames([condKey]) : new Map<string, string>();
    const title = condKey ? names.get(condKey) : undefined;
    const lines: string[] = [`# Live Orderbook: ${title || condition_id || `Market ${numericId}`}\n`];
    lines.push(`*Market ID: ${numericId}*`);
    if (rateLimitRemaining !== null) lines.push(`*Rate limit: ${rateLimitRemaining} remaining*`);
    lines.push("");

    if (allBids.length === 0 && allAsks.length === 0) {
      lines.push("No active orders in this market.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const bestBidPrice = allBids[0]?.[0];
    const bestAskPrice = allAsks[0]?.[0];
    if (bestBidPrice !== undefined && bestAskPrice !== undefined) {
      const spread = (bestAskPrice - bestBidPrice).toFixed(4);
      const mid = (bestBidPrice + bestAskPrice) / 2;
      lines.push(`**Best Bid:** $${bestBidPrice.toFixed(4)} | **Best Ask:** $${bestAskPrice.toFixed(4)} | **Spread:** $${spread}`);
      lines.push(`**Mid Price:** $${mid.toFixed(4)} | **Implied YES Prob:** ${(mid * 100).toFixed(1)}%\n`);
    }

    if (allBids.length > 0) {
      lines.push("## Bids (Buy YES)");
      lines.push("| Price | Size |");
      lines.push("|---|---|");
      allBids.slice(0, 10).forEach(([price, size]) => {
        lines.push(`| $${price.toFixed(4)} | ${fmtUsd(size.toString())} |`);
      });
    }

    if (allAsks.length > 0) {
      lines.push("\n## Asks (Sell YES / Buy NO)");
      lines.push("| Price | Size |");
      lines.push("|---|---|");
      allAsks.slice(0, 10).forEach(([price, size]) => {
        lines.push(`| $${price.toFixed(4)} | ${fmtUsd(size.toString())} |`);
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
        `{ account(id: "${addr}") { id totalTrades totalVolume totalFees makerTrades takerTrades makerVolume takerVolume firstTradeAt lastTradeAt } }`
      ),
      query(
        ENDPOINTS.positions,
        `{ account(id: "${addr}") { id splitCount mergeCount redeemCount totalSplitVolume totalMergeVolume totalPayouts firstSeenAt lastActiveAt } userPositions(first: 10, orderBy: netQuantity, orderDirection: desc, where: { user: "${addr}", netQuantity_gt: "0" }) { id netQuantity totalSplit totalMerged realizedPayout condition { id openInterest resolved resolvedAt payoutNumerators } } }`
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

    const ci = contractLabel(addr);
    const byteLen = ci.is_contract ? 999 : await isContract(addr);
    const addrType: AddrType = ci.is_contract ? "protocol" : byteLen === 0 ? "eoa" : byteLen <= SMART_WALLET_MAX_BYTES ? "user" : "bot";
    const lines: string[] = ci.is_contract
      ? [`# ${ci.contract_name} (Protocol Contract)\n`, `**${ci.contract_role}**\n`, `Address: ${addr}\n`, `> ⚠ This is a Predict.fun infrastructure contract, not a human trader. Metrics below reflect protocol operations, not trading activity.\n`]
      : addrType === "bot"
        ? [`# Bot/Contract ${fmtAddr(address)}\n`, `Address: ${addr}\n`, `> This address is a trading bot or vault contract (${byteLen} bytes of bytecode). Metrics reflect automated operations.\n`]
        : addrType === "user"
          ? [`# Trader ${fmtAddr(address)} (Smart Wallet)\n`, `Address: ${addr}\n`]
          : [`# Trader ${fmtAddr(address)}\n`];

    if (obAcct) {
      const splitVol = parseFloat(posAcct?.totalSplitVolume || "0");
      const netPnl =
        parseFloat(posAcct?.totalPayouts || "0") -
        splitVol +
        parseFloat(posAcct?.totalMergeVolume || "0");
      const pnlUnreliable = posAcct && splitVol === 0 && parseFloat(obAcct.totalVolume) > 0;

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
        if (pnlUnreliable) {
          lines.push(`- Estimated Net P&L: ⚠ unreliable — positions subgraph shows $0 invested but orderbook shows ${fmtUsd(obAcct.totalVolume)} traded`);
          lines.push(`  > Wallet entered via orderbook buys (not collateral splits). Fetching fill-level breakdown from orderbook subgraph...`);
          // Fetch recent fills as taker and maker to show USDC flow breakdown
          try {
            const [takerFills, makerFills] = await Promise.all([
              query(ENDPOINTS.orderbook, `{ orderFilledEvents(first: 100, orderBy: timestamp, orderDirection: desc, where: { taker: "${addr}" }) { side takerAmountFilled fee timestamp } }`),
              query(ENDPOINTS.orderbook, `{ orderFilledEvents(first: 100, orderBy: timestamp, orderDirection: desc, where: { maker: "${addr}" }) { side makerAmountFilled fee timestamp } }`),
            ]);
            const takerEvents = takerFills?.orderFilledEvents || [];
            const makerEvents = makerFills?.orderFilledEvents || [];
            // As taker: BUY side = USDC out, SELL side = USDC in
            const takerBuyVol = takerEvents.filter((f: any) => f.side === "BUY").reduce((s: number, f: any) => s + parseFloat(f.takerAmountFilled), 0);
            const takerSellVol = takerEvents.filter((f: any) => f.side === "SELL").reduce((s: number, f: any) => s + parseFloat(f.takerAmountFilled), 0);
            // As maker: BUY side means taker bought, maker sold tokens → USDC in for maker; SELL side = USDC out for maker
            const makerBuyVol = makerEvents.filter((f: any) => f.side === "BUY").reduce((s: number, f: any) => s + parseFloat(f.makerAmountFilled), 0);
            const makerSellVol = makerEvents.filter((f: any) => f.side === "SELL").reduce((s: number, f: any) => s + parseFloat(f.makerAmountFilled), 0);
            const totalFeesSampled = [...takerEvents, ...makerEvents].reduce((s: number, f: any) => s + parseFloat(f.fee || "0"), 0);
            const usdcOut = takerBuyVol + makerSellVol;
            const usdcIn = takerSellVol + makerBuyVol + parseFloat(posAcct.totalPayouts);
            const sampleSize = takerEvents.length + makerEvents.length;
            lines.push(`\n### Fill-Level Breakdown (last ${sampleSize} fills sampled)`);
            lines.push(`- As Taker — BUY fills (USDC out): ${fmtUsd(takerBuyVol.toString())} (${takerEvents.filter((f: any) => f.side === "BUY").length} fills)`);
            lines.push(`- As Taker — SELL fills (USDC in): ${fmtUsd(takerSellVol.toString())} (${takerEvents.filter((f: any) => f.side === "SELL").length} fills)`);
            lines.push(`- As Maker — BUY fills (USDC in): ${fmtUsd(makerBuyVol.toString())} (${makerEvents.filter((f: any) => f.side === "BUY").length} fills)`);
            lines.push(`- As Maker — SELL fills (USDC out): ${fmtUsd(makerSellVol.toString())} (${makerEvents.filter((f: any) => f.side === "SELL").length} fills)`);
            lines.push(`- Fees in sample: ${fmtUsd(totalFeesSampled.toString())}`);
            lines.push(`- Redemption payouts (positions): ${fmtUsd(posAcct.totalPayouts)}`);
            lines.push(`- **Sampled net (USDC in − out): ${fmtUsd((usdcIn - usdcOut).toString())}** ⚠ partial — only last ${sampleSize} fills, full history has ${parseInt(obAcct.totalTrades).toLocaleString()} trades`);
          } catch {
            lines.push(`  > Fill-level query failed. Total OB volume: ${fmtUsd(obAcct.totalVolume)} across ${parseInt(obAcct.totalTrades).toLocaleString()} trades.`);
          }
        } else {
          lines.push(`- Estimated Net P&L: ${fmtUsd(netPnl.toString())}`);
        }
      }
    }

    if (posData.userPositions.length > 0) {
      const posIds = posData.userPositions.map((p: any) => p.condition.id);
      const posNames = await resolveMarketNames(posIds);
      lines.push("\n## Active Positions");
      lines.push("| Market | Net Position | Invested | Merged | Status |");
      lines.push("|---|---|---|---|---|");
      posData.userPositions.forEach((p: any) => {
        let status = "Active";
        if (p.condition.resolved) {
          const resolvedAt = p.condition.resolvedAt ? parseInt(p.condition.resolvedAt) : 0;
          const daysSince = resolvedAt ? Math.round((Date.now() / 1000 - resolvedAt) / 86400) : 0;
          const net = parseFloat(p.netQuantity);
          if (net > 0 && daysSince > 0) {
            status = `⚠ Zombie OI (${daysSince}d unredeemed, ${fmtUsd(p.netQuantity)})`;
          } else {
            status = "Resolved";
          }
        }
        lines.push(
          `| ${marketLabel(p.condition.id, posNames)} | ${fmtUsd(p.netQuantity)} | ${fmtUsd(p.totalSplit)} | ${fmtUsd(p.totalMerged)} | ${status} |`
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
      .enum(["trades", "splits", "merges", "redemptions", "yield_claims", "all"])
      .describe("Type of activity to fetch. Use 'all' for a unified chronological feed across all three subgraphs."),
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
          `{ orderFilledEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc) { id maker { id } taker { id } makerAmountFilled takerAmountFilled fee price side exchange timestamp transactionHash } }`
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
        const splitIds = data.splitEvents.map((e: any) => e.condition.id);
        const splitNames = await resolveMarketNames(splitIds);
        lines.push(`# Recent ${limit} Position Splits\n`);
        lines.push("| Time | Address | Amount | Condition ID | Market |");
        lines.push("|---|---|---|---|---|");
        data.splitEvents.forEach((e: any) => {
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${e.stakeholder} | ${fmtUsd(e.amount)} | ${e.condition.id} | ${marketLabel(e.condition.id, splitNames)} |`
          );
        });
        break;
      }

      case "merges": {
        const data = await query(
          ENDPOINTS.positions,
          `{ mergeEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc) { id stakeholder amount source timestamp condition { id resolved } } }`
        );
        const mergeIds = data.mergeEvents.map((e: any) => e.condition.id);
        const mergeNames = await resolveMarketNames(mergeIds);
        lines.push(`# Recent ${limit} Position Merges\n`);
        lines.push("| Time | Address | Amount | Condition ID | Market |");
        lines.push("|---|---|---|---|---|");
        data.mergeEvents.forEach((e: any) => {
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${e.stakeholder} | ${fmtUsd(e.amount)} | ${e.condition.id} | ${marketLabel(e.condition.id, mergeNames)} |`
          );
        });
        break;
      }

      case "redemptions": {
        const data = await query(
          ENDPOINTS.positions,
          `{ redemptionEvents(first: ${limit}, orderBy: timestamp, orderDirection: desc) { id redeemer payout source timestamp condition { id payoutNumerators } } }`
        );
        const redeemIds = data.redemptionEvents.map((e: any) => e.condition.id);
        const redeemNames = await resolveMarketNames(redeemIds);
        lines.push(`# Recent ${limit} Redemptions\n`);
        lines.push("| Time | Address | Payout | Condition ID | Market | Winner |");
        lines.push("|---|---|---|---|---|---|");
        data.redemptionEvents.forEach((e: any) => {
          const winner = e.condition.payoutNumerators
            ? e.condition.payoutNumerators.indexOf("1") === 0
              ? "Yes"
              : "No"
            : "N/A";
          lines.push(
            `| ${fmtDate(e.timestamp)} | ${e.redeemer} | ${fmtUsd(e.payout)} | ${e.condition.id} | ${marketLabel(e.condition.id, redeemNames)} | ${winner} |`
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
            `| ${fmtDate(e.timestamp)} | ${fmtUsd(e.underlyingAmount)} | ${e.vTokenAmount} | ${e.transactionHash} |`
          );
        });
        break;
      }

      case "all": {
        // Unified feed: fetch from all three subgraphs in parallel, merge + sort by timestamp
        const perSource = Math.max(5, Math.ceil(limit * 1.5)); // fetch extra to have enough after merge
        const [tradesData, splitsData, mergesData, redemptionsData, yieldData] = await Promise.all([
          query(ENDPOINTS.orderbook, `{ orderFilledEvents(first: ${perSource}, orderBy: timestamp, orderDirection: desc) { id maker { id } taker { id } makerAmountFilled takerAmountFilled fee price side timestamp } }`),
          query(ENDPOINTS.positions, `{ splitEvents(first: ${perSource}, orderBy: timestamp, orderDirection: desc) { id stakeholder amount timestamp condition { id } } }`),
          query(ENDPOINTS.positions, `{ mergeEvents(first: ${perSource}, orderBy: timestamp, orderDirection: desc) { id stakeholder amount timestamp condition { id } } }`),
          query(ENDPOINTS.positions, `{ redemptionEvents(first: ${perSource}, orderBy: timestamp, orderDirection: desc) { id redeemer payout timestamp condition { id } } }`),
          query(ENDPOINTS.yield, `{ yieldClaimEvents(first: ${perSource}, orderBy: timestamp, orderDirection: desc) { id underlyingAmount timestamp transactionHash } }`),
        ]);

        type UnifiedEvent = { ts: number; source: string; type: string; who: string; amount: string; detail: string };
        const unified: UnifiedEvent[] = [];

        (tradesData?.orderFilledEvents || []).forEach((e: any) => {
          unified.push({ ts: parseInt(e.timestamp), source: "orderbook", type: "TRADE", who: fmtAddr(e.taker.id), amount: fmtUsd(e.takerAmountFilled), detail: `${e.side} @ $${parseFloat(e.price).toFixed(4)}` });
        });
        (splitsData?.splitEvents || []).forEach((e: any) => {
          unified.push({ ts: parseInt(e.timestamp), source: "positions", type: "SPLIT", who: fmtAddr(e.stakeholder), amount: fmtUsd(e.amount), detail: fmtAddr(e.condition.id) });
        });
        (mergesData?.mergeEvents || []).forEach((e: any) => {
          unified.push({ ts: parseInt(e.timestamp), source: "positions", type: "MERGE", who: fmtAddr(e.stakeholder), amount: fmtUsd(e.amount), detail: fmtAddr(e.condition.id) });
        });
        (redemptionsData?.redemptionEvents || []).forEach((e: any) => {
          unified.push({ ts: parseInt(e.timestamp), source: "positions", type: "REDEEM", who: fmtAddr(e.redeemer), amount: fmtUsd(e.payout), detail: fmtAddr(e.condition.id) });
        });
        (yieldData?.yieldClaimEvents || []).forEach((e: any) => {
          unified.push({ ts: parseInt(e.timestamp), source: "yield", type: "YIELD", who: "—", amount: fmtUsd(e.underlyingAmount), detail: e.transactionHash?.slice(0, 12) + "…" });
        });

        unified.sort((a, b) => b.ts - a.ts);
        const top = unified.slice(0, limit);

        lines.push(`# Unified Activity Feed (last ${top.length} events across all subgraphs)\n`);
        lines.push("| Time | Source | Type | Who | Amount | Detail |");
        lines.push("|---|---|---|---|---|---|");
        top.forEach((e) => {
          lines.push(`| ${fmtDate(e.ts.toString())} | ${e.source} | ${e.type} | ${e.who} | ${e.amount} | ${e.detail} |`);
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
      "> **Note:** Predict.fun deposits user USDT collateral into Venus Protocol to earn ~3-5% APY while markets are live. The yield shown here represents protocol-level settlement events only. Per-user yield accrues automatically via position value snapshots — it is not individually claimable on-chain. The on-chain yield claim count will appear low relative to total deposits because these are batch protocol settlements, not individual user claims.\n",
      "## Global Stats",
      `- Total Deposited to Venus: ${fmtUsd(g.totalVTokenMinted)}`,
      `- Total Redeemed: ${fmtUsd(g.totalUnderlyingRedeemed)}`,
      `- **Net in Venus: ${fmtUsd(net.toString())}**`,
      `- Total Yield Claimed (protocol settlements): ${fmtUsd(g.totalYieldClaimed)}`,
      `- Settlement Events: ${g.yieldClaimCount}`,
      `- Reward Claims: ${g.rewardClaimCount} (${fmtUsd(g.totalRewardsClaimed)})`,
      `- Oracle Requests: ${g.totalOracleRequests}`,
      `- Oracle Settlements: ${g.totalOracleSettlements}`,
    ];

    if (data.tokenMappings.length > 0) {
      lines.push("\n## Token Mappings");
      data.tokenMappings.forEach((tm: any) => {
        lines.push(`\n### ${tm.underlying} → ${tm.vToken}`);
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
          `| ${fmtDate(e.timestamp)} | ${fmtUsd(e.underlyingAmount)} | ${e.transactionHash} |`
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
    // Exclude protocol contracts at the GraphQL level (they dominate top positions)
    const data = await query(
      ENDPOINTS.positions,
      `{ userPositions(first: ${limit}, orderBy: netQuantity, orderDirection: desc, where: { netQuantity_gt: "${min_position}", user_not_in: ${PROTOCOL_ADDR_LIST} }) { id user { id totalSplitVolume totalPayouts } netQuantity totalSplit totalMerged realizedPayout condition { id openInterest resolved source } } }`
    );

    const humanPositions = data?.userPositions || [];
    const sliced = humanPositions.slice(0, limit);

    // Cross-reference orderbook + yield for all whale user addresses
    const userIds = sliced.map((p: any) => p.user.id);
    const userIdFilter = userIds.map((id: string) => `"${id}"`).join(",");
    const [whaleNames, obData, yieldData] = await Promise.all([
      resolveMarketNames(sliced.map((p: any) => p.condition.id)),
      userIds.length > 0
        ? query(ENDPOINTS.orderbook, `{ accounts(where: { id_in: [${userIdFilter}] }) { id totalTrades totalVolume totalFees makerTrades takerTrades } }`)
        : Promise.resolve({ accounts: [] }),
      userIds.length > 0
        ? query(ENDPOINTS.yield, `{ yieldAccounts(where: { id_in: [${userIdFilter}] }) { id totalRewardsClaimed rewardClaimCount } }`)
        : Promise.resolve({ yieldAccounts: [] }),
    ]);
    const obMap = new Map((obData?.accounts || []).map((a: any) => [a.id.toLowerCase(), a]));
    const yieldMap = new Map((yieldData?.yieldAccounts || []).map((a: any) => [a.id.toLowerCase(), a]));
    const addrTypes = await classifyAddresses(userIds);

    const lines = [
      `# Whale Positions (min ${fmtUsd(min_position.toString())})\n`,
      `*Protocol contracts (${Object.keys(KNOWN_CONTRACTS).length}) excluded · data from positions + orderbook + yield subgraphs*\n`,
      "| # | Address | Type | Position | Invested (splits) | OB Volume | Yield Rewards | Market | OI | % OI | Flag |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    ];
    sliced.forEach((p: any, i: number) => {
      const pctOi =
        parseFloat(p.condition.openInterest) > 0
          ? ((parseFloat(p.netQuantity) / parseFloat(p.condition.openInterest)) * 100).toFixed(1)
          : "N/A";
      const typeTag = addrTypeLabel(addrTypes.get(p.user.id.toLowerCase()));
      const ob = obMap.get(p.user.id.toLowerCase()) as any;
      const yld = yieldMap.get(p.user.id.toLowerCase()) as any;
      const splitVol = parseFloat(p.user.totalSplitVolume || "0");
      const obVol = ob ? parseFloat(ob.totalVolume) : 0;
      const yieldRew = yld ? fmtUsd(yld.totalRewardsClaimed) : "—";
      const flag = splitVol === 0 && obVol > 0 ? "⚠ OB-only entry" : "";
      lines.push(
        `| ${i + 1} | ${p.user.id} | ${typeTag} | ${fmtUsd(p.netQuantity)} | ${fmtUsd(p.user.totalSplitVolume)} | ${ob ? fmtUsd(ob.totalVolume) : "—"} | ${yieldRew} | ${marketLabel(p.condition.id, whaleNames)} | ${fmtUsd(p.condition.openInterest)} | ${pctOi}% | ${flag} |`
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
        `{ accounts(first: ${limit}, orderBy: totalPayouts, orderDirection: desc, where: { totalPayouts_gt: "0", id_not_in: ${PROTOCOL_ADDR_LIST} }) { id splitCount mergeCount redeemCount totalSplitVolume totalMergeVolume totalPayouts } }`
      );
      const sliced = (data?.accounts || []).slice(0, limit);
      const ids = sliced.map((a: any) => a.id);
      const idFilter = ids.map((id: string) => `"${id}"`).join(",");

      // Cross-reference orderbook + yield subgraphs for the same wallets
      const [obData, yieldData] = await Promise.all([
        query(ENDPOINTS.orderbook, `{ accounts(where: { id_in: [${idFilter}] }) { id totalTrades totalVolume totalFees } }`),
        query(ENDPOINTS.yield, `{ yieldAccounts(where: { id_in: [${idFilter}] }) { id totalRewardsClaimed } }`),
      ]);
      const obMap = new Map((obData?.accounts || []).map((a: any) => [a.id.toLowerCase(), a]));
      const yieldMap = new Map((yieldData?.yieldAccounts || []).map((a: any) => [a.id.toLowerCase(), a]));

      const addrTypes = await classifyAddresses(ids);
      lines.push(`# Top ${limit} Traders by Payouts\n`);
      lines.push(`*Protocol contracts excluded · data from positions + orderbook + yield subgraphs*\n`);
      lines.push("| # | Address | Type | Payouts | Invested | Merged | OB Volume | Fees | Yield | Redemptions | Est. P&L |");
      lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
      sliced.forEach((a: any, i: number) => {
        const splitVol = parseFloat(a.totalSplitVolume);
        const pnl =
          parseFloat(a.totalPayouts) +
          parseFloat(a.totalMergeVolume) -
          splitVol;
        const ob = obMap.get(a.id.toLowerCase()) as any;
        const yld = yieldMap.get(a.id.toLowerCase()) as any;
        const obVol = ob ? parseFloat(ob.totalVolume) : 0;
        const obFees = ob ? fmtUsd(ob.totalFees) : "—";
        const yieldRew = yld ? fmtUsd(yld.totalRewardsClaimed) : "—";
        const pnlDisplay = splitVol === 0 && obVol > 0
          ? "⚠ orderbook-only"
          : fmtUsd(pnl.toString());
        const typeTag = addrTypeLabel(addrTypes.get(a.id.toLowerCase()));
        lines.push(
          `| ${i + 1} | ${a.id} | ${typeTag} | ${fmtUsd(a.totalPayouts)} | ${fmtUsd(a.totalSplitVolume)} | ${fmtUsd(a.totalMergeVolume)} | ${ob ? fmtUsd(ob.totalVolume) : "—"} | ${obFees} | ${yieldRew} | ${a.redeemCount} | ${pnlDisplay} |`
        );
      });
    } else {
      const orderBy = rank_by === "trades" ? "totalTrades" : "totalVolume";
      const data = await query(
        ENDPOINTS.orderbook,
        `{ accounts(first: ${limit}, orderBy: ${orderBy}, orderDirection: desc, where: { id_not_in: ${PROTOCOL_ADDR_LIST} }) { id totalTrades totalVolume totalFees makerTrades takerTrades } }`
      );
      const sliced = (data?.accounts || []).slice(0, limit);
      const ids = sliced.map((a: any) => a.id);
      const idFilter = ids.map((id: string) => `"${id}"`).join(",");

      // Cross-reference positions + yield for same wallets
      const [posData2, yieldData2] = await Promise.all([
        ids.length > 0
          ? query(ENDPOINTS.positions, `{ accounts(where: { id_in: [${idFilter}] }) { id totalPayouts totalSplitVolume redeemCount } }`)
          : Promise.resolve({ accounts: [] }),
        ids.length > 0
          ? query(ENDPOINTS.yield, `{ yieldAccounts(where: { id_in: [${idFilter}] }) { id totalRewardsClaimed } }`)
          : Promise.resolve({ yieldAccounts: [] }),
      ]);
      const posMap2 = new Map((posData2?.accounts || []).map((a: any) => [a.id.toLowerCase(), a]));
      const yieldMap2 = new Map((yieldData2?.yieldAccounts || []).map((a: any) => [a.id.toLowerCase(), a]));

      const addrTypes = await classifyAddresses(ids);
      const label = rank_by === "trades" ? "Trades" : "Volume";
      lines.push(`# Top ${limit} Traders by ${label}\n`);
      lines.push(`*Protocol contracts excluded · data from positions + orderbook + yield subgraphs*\n`);
      lines.push("| # | Address | Type | Volume | Trades | Fees | Maker | Taker | Payouts | Yield Rewards |");
      lines.push("|---|---|---|---|---|---|---|---|---|---|");
      sliced.forEach((a: any, i: number) => {
        const typeTag = addrTypeLabel(addrTypes.get(a.id.toLowerCase()));
        const pos2 = posMap2.get(a.id.toLowerCase()) as any;
        const yld2 = yieldMap2.get(a.id.toLowerCase()) as any;
        const payouts = pos2 ? fmtUsd(pos2.totalPayouts) : "—";
        const yieldRew = yld2 ? fmtUsd(yld2.totalRewardsClaimed) : "—";
        lines.push(
          `| ${i + 1} | ${a.id} | ${typeTag} | ${fmtUsd(a.totalVolume)} | ${parseInt(a.totalTrades).toLocaleString()} | ${fmtUsd(a.totalFees)} | ${parseInt(a.makerTrades).toLocaleString()} | ${parseInt(a.takerTrades).toLocaleString()} | ${payouts} | ${yieldRew} |`
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

    const resolvedIds = data.conditions.map((c: any) => c.id);
    const resolvedNames = await resolveMarketNames(resolvedIds);

    const lines = [
      `# Recently Resolved Markets\n`,
      "| # | Condition ID | Market | Winning | OI at Resolution | Splits | Resolved At |",
      "|---|---|---|---|---|---|---|",
    ];

    data.conditions.forEach((c: any, i: number) => {
      const winIdx = c.payoutNumerators.indexOf("1");
      const winner =
        winIdx === 0 ? "Outcome A (Yes)" : winIdx === 1 ? "Outcome B (No)" : `Outcome ${winIdx}`;
      lines.push(
        `| ${i + 1} | ${c.id} | ${marketLabel(c.id, resolvedNames)} | ${winner} | ${fmtUsd(c.openInterest)} | ${c.splitCount} | ${fmtDate(c.resolvedAt)} |`
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
    const data = await query(endpoint, graphql_query);
    return {
      content: [
        { type: "text", text: JSON.stringify(data, null, 2) },
      ],
    };
  }
);

// ─── Meta-Tool: Find Trader Persona ─────────────────────────────────────────

server.tool(
  "find_trader_persona",
  "Classify a trader into behavioral archetypes: whale_accumulator, yield_farmer, arbitrageur, early_mover, or resolution_sniper. Returns structured JSON with matched personas and supporting metrics.",
  {
    address: z.string().describe("Trader wallet address (0x...)"),
  },
  async ({ address }) => {
    const addr = address.toLowerCase();

    // Parallel queries across all 3 subgraphs
    const [obData, posData, yldData, positionsData] = await Promise.all([
      query(
        ENDPOINTS.orderbook,
        `{ account(id: "${addr}") { id totalTrades totalVolume totalFees makerTrades takerTrades makerVolume takerVolume firstTradeAt lastTradeAt } }`
      ),
      query(
        ENDPOINTS.positions,
        `{ account(id: "${addr}") { id splitCount mergeCount redeemCount totalSplitVolume totalMergeVolume totalPayouts firstSeenAt lastActiveAt } }`
      ),
      query(
        ENDPOINTS.yield,
        `{ yieldAccount(id: "${addr}") { id totalRewardsClaimed rewardClaimCount } }`
      ),
      query(
        ENDPOINTS.positions,
        `{ userPositions(first: 50, orderBy: netQuantity, orderDirection: desc, where: { user: "${addr}", netQuantity_gt: "0" }) { id netQuantity totalSplit condition { id openInterest resolved splitCount createdAt resolvedAt } } }`
      ),
    ]);

    const obAcct = obData?.account;
    const posAcct = posData?.account;
    const yldAcct = yldData?.yieldAccount;
    const positions = positionsData?.userPositions || [];

    if (!obAcct && !posAcct && !yldAcct) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "No activity found", address }) }],
      };
    }

    const personas: Array<{
      persona: string;
      confidence: string;
      evidence: Record<string, any>;
    }> = [];

    // 1. Whale Accumulator: holds >5% of market OI
    for (const p of positions) {
      const oi = parseFloat(p.condition.openInterest);
      const net = parseFloat(p.netQuantity);
      if (oi > 0) {
        const pctOi = net / oi;
        if (pctOi >= PERSONA_THRESHOLDS.whale_oi_pct) {
          personas.push({
            persona: "whale_accumulator",
            confidence: pctOi > 0.25 ? "high" : "medium",
            evidence: {
              condition_id: p.condition.id,
              position_size: net,
              market_oi: oi,
              pct_of_oi: Math.round(pctOi * 1000) / 10,
              market_splits: parseInt(p.condition.splitCount),
            },
          });
          break; // One match is enough
        }
      }
    }

    // 2. Yield Farmer: any reward claims
    if (yldAcct && parseInt(yldAcct.rewardClaimCount) > 0 && parseFloat(yldAcct.totalRewardsClaimed) > 0) {
      personas.push({
        persona: "yield_farmer",
        confidence: parseInt(yldAcct.rewardClaimCount) > 10 ? "high" : "medium",
        evidence: {
          total_rewards_claimed: parseFloat(yldAcct.totalRewardsClaimed),
          claim_count: parseInt(yldAcct.rewardClaimCount),
        },
      });
    }

    // 3. Arbitrageur: high frequency, small avg size, taker-heavy
    if (obAcct) {
      const trades = parseInt(obAcct.totalTrades);
      const volume = parseFloat(obAcct.totalVolume);
      const takerTrades = parseInt(obAcct.takerTrades);
      if (trades >= PERSONA_THRESHOLDS.arb_min_trades) {
        const avgSize = volume / trades;
        const takerRatio = takerTrades / trades;
        if (takerRatio >= PERSONA_THRESHOLDS.arb_taker_ratio && avgSize < 500) {
          personas.push({
            persona: "arbitrageur",
            confidence: trades > 500 && takerRatio > 0.85 ? "high" : "medium",
            evidence: {
              total_trades: trades,
              avg_trade_size: Math.round(avgSize * 100) / 100,
              taker_ratio: Math.round(takerRatio * 1000) / 10,
              total_volume: volume,
            },
          });
        }
      }
    }

    // Detect orderbook-only wallet: trades on OB but never split collateral
    const isObOnly = obAcct && posAcct &&
      parseFloat(posAcct.totalSplitVolume) === 0 &&
      parseFloat(obAcct.totalVolume) > 0;

    // 4. Early Mover: entered positions within 24h of market creation
    // First try via splits (positions subgraph); fall back to orderbook fills for OB-only wallets
    let earlyMoverFound = false;
    for (const p of positions) {
      if (earlyMoverFound) break;
      if (parseFloat(p.totalSplit) > 0) {
        try {
          const splitData = await query(
            ENDPOINTS.positions,
            `{ splitEvents(first: 1, orderBy: timestamp, orderDirection: asc, where: { stakeholder: "${addr}", condition: "${p.condition.id}" }) { timestamp } }`
          );
          const firstSplit = splitData?.splitEvents?.[0];
          if (firstSplit) {
            const condCreated = parseInt(p.condition.createdAt);
            const splitTime = parseInt(firstSplit.timestamp);
            const delta = splitTime - condCreated;
            if (delta >= 0 && delta <= PERSONA_THRESHOLDS.early_mover_window) {
              personas.push({
                persona: "early_mover",
                confidence: delta < 3600 ? "high" : "medium",
                evidence: {
                  condition_id: p.condition.id,
                  market_created_at: condCreated,
                  first_entry_at: splitTime,
                  seconds_after_creation: delta,
                  entry_method: "split",
                },
              });
              earlyMoverFound = true;
            }
          }
        } catch { /* skip */ }
      } else if (isObOnly) {
        // OB-only: check first orderbook fill in this market
        try {
          const obFillData = await query(
            ENDPOINTS.orderbook,
            `{ orderFilledEvents(first: 1, orderBy: timestamp, orderDirection: asc, where: { taker: "${addr}", market: "${p.condition.id}" }) { timestamp } }`
          );
          const firstFill = obFillData?.orderFilledEvents?.[0];
          if (firstFill) {
            const condCreated = parseInt(p.condition.createdAt);
            const fillTime = parseInt(firstFill.timestamp);
            const delta = fillTime - condCreated;
            if (delta >= 0 && delta <= PERSONA_THRESHOLDS.early_mover_window) {
              personas.push({
                persona: "early_mover",
                confidence: delta < 3600 ? "high" : "medium",
                evidence: {
                  condition_id: p.condition.id,
                  market_created_at: condCreated,
                  first_entry_at: fillTime,
                  seconds_after_creation: delta,
                  entry_method: "orderbook_fill",
                },
              });
              earlyMoverFound = true;
            }
          }
        } catch { /* skip */ }
      }
    }

    // 5. Resolution Sniper: large activity within 48h before resolution
    // Use splits for split-entry wallets; use OB fills for OB-only wallets
    const resolvedPositions = positions.filter((p: any) => p.condition.resolved && p.condition.resolvedAt);
    for (const p of resolvedPositions.slice(0, 5)) {
      const resolvedAt = parseInt(p.condition.resolvedAt);
      const windowStart = resolvedAt - PERSONA_THRESHOLDS.sniper_window;
      try {
        if (!isObOnly) {
          const splitData = await query(
            ENDPOINTS.positions,
            `{ splitEvents(first: 3, orderBy: amount, orderDirection: desc, where: { stakeholder: "${addr}", condition: "${p.condition.id}", timestamp_gt: "${windowStart}", timestamp_lt: "${resolvedAt}" }) { amount timestamp } }`
          );
          if (splitData?.splitEvents?.length > 0) {
            const totalLateSplits = splitData.splitEvents.reduce(
              (sum: number, s: any) => sum + parseFloat(s.amount), 0
            );
            if (totalLateSplits > 100) {
              personas.push({
                persona: "resolution_sniper",
                confidence: totalLateSplits > 1000 ? "high" : "medium",
                evidence: {
                  condition_id: p.condition.id,
                  resolved_at: resolvedAt,
                  late_activity_volume: Math.round(totalLateSplits * 100) / 100,
                  events_in_window: splitData.splitEvents.length,
                  detection_method: "split_events",
                },
              });
              break;
            }
          }
        } else {
          // OB-only: look for large taker fills in the pre-resolution window
          const obFillData = await query(
            ENDPOINTS.orderbook,
            `{ orderFilledEvents(first: 5, orderBy: takerAmountFilled, orderDirection: desc, where: { taker: "${addr}", market: "${p.condition.id}", timestamp_gt: "${windowStart}", timestamp_lt: "${resolvedAt}" }) { takerAmountFilled timestamp } }`
          );
          if (obFillData?.orderFilledEvents?.length > 0) {
            const totalLateVolume = obFillData.orderFilledEvents.reduce(
              (sum: number, f: any) => sum + parseFloat(f.takerAmountFilled), 0
            );
            if (totalLateVolume > 100) {
              personas.push({
                persona: "resolution_sniper",
                confidence: totalLateVolume > 1000 ? "high" : "medium",
                evidence: {
                  condition_id: p.condition.id,
                  resolved_at: resolvedAt,
                  late_activity_volume: Math.round(totalLateVolume * 100) / 100,
                  events_in_window: obFillData.orderFilledEvents.length,
                  detection_method: "orderbook_fills",
                },
              });
              break;
            }
          }
        }
      } catch { /* skip */ }
    }

    // 6. Orderbook-Only Trader: significant OB volume but zero split collateral
    if (isObOnly) {
      const trades = parseInt(obAcct.totalTrades);
      const volume = parseFloat(obAcct.totalVolume);
      personas.push({
        persona: "orderbook_only_trader",
        confidence: volume > 10000 ? "high" : "medium",
        evidence: {
          total_trades: trades,
          total_volume: volume,
          total_split_volume: 0,
          note: "Enters positions via orderbook buys rather than collateral splits. P&L from positions subgraph is unreliable.",
        },
      });
    }

    const result = {
      address: addr,
      personas_matched: personas.length,
      personas,
      summary: {
        total_trades: obAcct ? parseInt(obAcct.totalTrades) : 0,
        total_volume: obAcct ? parseFloat(obAcct.totalVolume) : 0,
        total_split_volume: posAcct ? parseFloat(posAcct.totalSplitVolume) : 0,
        active_positions: positions.length,
        has_yield_activity: !!yldAcct,
        is_orderbook_only: !!isObOnly,
        data_sources: ["positions", "orderbook", "yield"],
      },
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Meta-Tool: Scan Trader Personas ────────────────────────────────────────

server.tool(
  "scan_trader_personas",
  "Find traders matching a specific behavioral archetype across the platform. Returns structured JSON with matching traders and evidence.",
  {
    persona: z
      .enum(["whale_accumulator", "yield_farmer", "arbitrageur", "early_mover", "resolution_sniper"])
      .describe("The trader archetype to scan for"),
    limit: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Max number of traders to return"),
  },
  async ({ persona, limit }) => {
    const results: Array<{ address: string; evidence: Record<string, any> }> = [];

    switch (persona) {
      case "whale_accumulator": {
        const data = await query(
          ENDPOINTS.positions,
          `{ userPositions(first: 100, orderBy: netQuantity, orderDirection: desc, where: { netQuantity_gt: "0", user_not_in: ${PROTOCOL_ADDR_LIST} }) { user { id } netQuantity condition { id openInterest splitCount } } }`
        );
        for (const p of data?.userPositions || []) {
          if (results.length >= limit) break;
          const oi = parseFloat(p.condition.openInterest);
          const net = parseFloat(p.netQuantity);
          if (oi > 0 && net / oi >= PERSONA_THRESHOLDS.whale_oi_pct) {
            results.push({
              address: p.user.id,
              evidence: {
                position_size: net,
                market_oi: oi,
                pct_of_oi: Math.round((net / oi) * 1000) / 10,
                condition_id: p.condition.id,
                market_splits: parseInt(p.condition.splitCount),
              },
            });
          }
        }
        break;
      }

      case "yield_farmer": {
        const data = await query(
          ENDPOINTS.yield,
          `{ yieldAccounts(first: ${limit}, orderBy: totalRewardsClaimed, orderDirection: desc) { id totalRewardsClaimed rewardClaimCount } }`
        );
        if (!data?.yieldAccounts || data.yieldAccounts.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ persona: "yield_farmer", results: [], note: "No yield accounts found on Predict.fun yet. The yield/rewards feature may not be active on this platform." }) }],
          };
        }
        for (const a of data.yieldAccounts) {
          results.push({
            address: a.id,
            evidence: {
              total_rewards_claimed: parseFloat(a.totalRewardsClaimed),
              claim_count: parseInt(a.rewardClaimCount),
            },
          });
        }
        break;
      }

      case "arbitrageur": {
        const data = await query(
          ENDPOINTS.orderbook,
          `{ accounts(first: 50, orderBy: totalTrades, orderDirection: desc) { id totalTrades totalVolume takerTrades } }`
        );
        for (const a of data?.accounts || []) {
          if (results.length >= limit) break;
          const trades = parseInt(a.totalTrades);
          const volume = parseFloat(a.totalVolume);
          const takerTrades = parseInt(a.takerTrades);
          if (trades >= PERSONA_THRESHOLDS.arb_min_trades) {
            const avgSize = volume / trades;
            const takerRatio = takerTrades / trades;
            if (takerRatio >= PERSONA_THRESHOLDS.arb_taker_ratio && avgSize < 500) {
              results.push({
                address: a.id,
                evidence: {
                  total_trades: trades,
                  avg_trade_size: Math.round(avgSize * 100) / 100,
                  taker_ratio: Math.round(takerRatio * 1000) / 10,
                  total_volume: volume,
                },
              });
            }
          }
        }
        break;
      }

      case "early_mover": {
        // Find recently created markets and their first participants
        const now = nowUnix();
        const recentCutoff = now - 30 * 86400; // last 30 days
        const condData = await query(
          ENDPOINTS.positions,
          `{ conditions(first: 20, orderBy: createdAt, orderDirection: desc, where: { createdAt_gt: "${recentCutoff}" }) { id createdAt } }`
        );
        const seen = new Set<string>();
        for (const cond of condData?.conditions || []) {
          if (results.length >= limit) break;
          const splitData = await query(
            ENDPOINTS.positions,
            `{ splitEvents(first: 5, orderBy: timestamp, orderDirection: asc, where: { condition: "${cond.id}", timestamp_lt: "${parseInt(cond.createdAt) + PERSONA_THRESHOLDS.early_mover_window}" }) { stakeholder timestamp amount } }`
          );
          for (const s of splitData?.splitEvents || []) {
            if (results.length >= limit) break;
            if (seen.has(s.stakeholder)) continue;
            seen.add(s.stakeholder);
            results.push({
              address: s.stakeholder,
              evidence: {
                condition_id: cond.id,
                market_created_at: parseInt(cond.createdAt),
                split_at: parseInt(s.timestamp),
                seconds_after_creation: parseInt(s.timestamp) - parseInt(cond.createdAt),
                amount: parseFloat(s.amount),
              },
            });
          }
        }
        break;
      }

      case "resolution_sniper": {
        const condData = await query(
          ENDPOINTS.positions,
          `{ conditions(first: 20, orderBy: resolvedAt, orderDirection: desc, where: { resolved: true }) { id resolvedAt } }`
        );
        const seen = new Set<string>();
        for (const cond of condData?.conditions || []) {
          if (results.length >= limit) break;
          const resolvedAt = parseInt(cond.resolvedAt);
          const windowStart = resolvedAt - PERSONA_THRESHOLDS.sniper_window;
          const splitData = await query(
            ENDPOINTS.positions,
            `{ splitEvents(first: 10, orderBy: amount, orderDirection: desc, where: { condition: "${cond.id}", timestamp_gt: "${windowStart}", timestamp_lt: "${resolvedAt}" }) { stakeholder amount timestamp } }`
          );
          for (const s of splitData?.splitEvents || []) {
            if (results.length >= limit) break;
            if (seen.has(s.stakeholder)) continue;
            seen.add(s.stakeholder);
            if (parseFloat(s.amount) > 100) {
              results.push({
                address: s.stakeholder,
                evidence: {
                  condition_id: cond.id,
                  resolved_at: resolvedAt,
                  split_amount: parseFloat(s.amount),
                  seconds_before_resolution: resolvedAt - parseInt(s.timestamp),
                },
              });
            }
          }
        }
        break;
      }
    }

    const output = {
      persona,
      traders_found: results.length,
      traders: results,
    };

    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
  }
);

// ─── Meta-Tool: Tag Market Structure ────────────────────────────────────────

server.tool(
  "tag_market_structure",
  "Classify a market by structural features: resolution latency, liquidity profile, oracle type, and tail-risk indicators. Returns structured JSON.",
  {
    condition_id: z.string().describe("The conditionId (0x hex string) of the market"),
  },
  async ({ condition_id }) => {
    const id = condition_id.toLowerCase();

    // Parallel queries across subgraphs
    const [posData, obData, topHolders] = await Promise.all([
      query(
        ENDPOINTS.positions,
        `{ condition(id: "${id}") { id oracle questionId outcomeSlotCount resolved openInterest splitCount mergeCount createdAt resolvedAt source } }`
      ),
      query(
        ENDPOINTS.orderbook,
        `{ market(id: "${id}") { id volume tradeCount fees createdAt lastTradeAt exchange } }`
      ),
      query(
        ENDPOINTS.positions,
        `{ userPositions(first: 5, orderBy: netQuantity, orderDirection: desc, where: { condition: "${id}", netQuantity_gt: "0" }) { user { id } netQuantity } }`
      ),
    ]);

    const cond = posData?.condition;
    const market = obData?.market;
    const holders = topHolders?.userPositions || [];

    if (!cond && !market) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Market not found", condition_id }) }],
      };
    }

    const tags: Record<string, any> = {};

    // 0. Market Type Classification
    if (cond) {
      let marketType = "standard";
      const src = cond.source.toLowerCase();
      if (src.includes("negrisk") && src.includes("yield")) marketType = "neg_risk_yield";
      else if (src.includes("negrisk")) marketType = "neg_risk";
      else if (src.includes("yield")) marketType = "ct_yield";
      else if (src.includes("bond")) marketType = "bond";
      tags.market_type = {
        tag: marketType,
        source: cond.source,
        outcome_slots: parseInt(cond.outcomeSlotCount),
        ...(marketType === "bond" && { note: "Bond Markets offer fixed-style returns on highly probable outcomes. Lower risk, lower reward." }),
      };
    }

    // 1. Resolution Latency
    if (cond) {
      const createdAt = parseInt(cond.createdAt);
      const resolvedAt = cond.resolvedAt ? parseInt(cond.resolvedAt) : null;
      const latency = classifyResolutionLatency(createdAt, resolvedAt, cond.resolved);
      tags.resolution_latency = {
        tag: latency.tag,
        resolved: cond.resolved,
        age_seconds: latency.seconds,
        age_days: latency.seconds ? Math.round((latency.seconds / 86400) * 10) / 10 : null,
        created_at: createdAt,
        resolved_at: resolvedAt,
      };
    }

    // 2. Liquidity Profile
    if (market) {
      const liquidity = classifyLiquidity(
        parseInt(market.tradeCount),
        parseFloat(market.volume),
        parseInt(market.createdAt),
        parseInt(market.lastTradeAt)
      );
      tags.liquidity_profile = {
        tag: liquidity.tag,
        trades_per_day: liquidity.tradesPerDay,
        volume_per_trade: liquidity.volumePerTrade,
        days_since_last_trade: liquidity.daysSinceLastTrade,
        total_trades: parseInt(market.tradeCount),
        total_volume: parseFloat(market.volume),
        total_fees: parseFloat(market.fees),
      };
    }

    // 3. Oracle Type
    if (cond) {
      const oracleInfo = contractLabel(cond.oracle);
      let oracleTag = "standard";
      let contractName: string | null = null;
      let contractRole: string | null = null;

      if (oracleInfo.is_contract) {
        contractName = oracleInfo.contract_name!;
        contractRole = oracleInfo.contract_role!;
        if (contractName === "NegRiskAdapter") oracleTag = "neg_risk_adapter";
        else if (contractName === "CTFOracle") oracleTag = "ctf_oracle";
        else if (contractName === "YieldOracle") oracleTag = "yield_oracle";
      } else if (cond.source.includes("NegRisk")) {
        oracleTag = "neg_risk";
      }

      // Check if oracle is a UMA oracle by looking for oracle requests
      try {
        const oracleData = await query(
          ENDPOINTS.yield,
          `{ oracleRequests(first: 1, where: { requester: "${cond.oracle}" }) { id settled } }`
        );
        if (oracleData?.oracleRequests?.length > 0) {
          oracleTag = "uma_oracle";
        }
      } catch {
        // Keep existing tag
      }
      tags.oracle_type = {
        tag: oracleTag,
        oracle_address: cond.oracle,
        ...(contractName && { contract_name: contractName }),
        ...(contractRole && { contract_role: contractRole }),
        is_protocol_contract: oracleInfo.is_contract,
        source: cond.source,
        outcome_slots: parseInt(cond.outcomeSlotCount),
      };
    }

    // 4. Tail-Risk Indicators
    if (cond) {
      const oi = parseFloat(cond.openInterest);
      const volume = market ? parseFloat(market.volume) : 0;

      // OI concentration: top 3 holders share
      let top3Pct = 0;
      if (oi > 0 && holders.length > 0) {
        const top3Sum = holders
          .slice(0, 3)
          .reduce((sum: number, h: any) => sum + parseFloat(h.netQuantity), 0);
        top3Pct = top3Sum / oi;
      }

      const oiVolumeRatio = volume > 0 ? oi / volume : null;
      const concentrated = top3Pct >= PERSONA_THRESHOLDS.concentrated_top3_pct;

      // Zombie OI: resolved market with remaining open interest
      const isZombieOi = cond.resolved && oi > 0;
      const daysSinceResolution = cond.resolved && cond.resolvedAt
        ? Math.round((nowUnix() - parseInt(cond.resolvedAt)) / 86400)
        : null;

      tags.tail_risk = {
        concentrated_oi: concentrated,
        top_3_holders_pct: Math.round(top3Pct * 1000) / 10,
        top_holders: holders.slice(0, 3).map((h: any) => {
          const ci = contractLabel(h.user.id);
          return {
            address: h.user.id,
            position: parseFloat(h.netQuantity),
            ...(ci.is_contract && { is_contract: true, contract_name: ci.contract_name }),
          };
        }),
        oi_volume_ratio: oiVolumeRatio ? Math.round(oiVolumeRatio * 1000) / 1000 : null,
        open_interest: oi,
        ...(isZombieOi && { zombie_oi: true, unredeemed_amount: oi, days_since_resolution: daysSinceResolution }),
        flags: [
          ...(concentrated ? ["concentrated_oi"] : []),
          ...(oiVolumeRatio && oiVolumeRatio > 1 ? ["illiquid_exit"] : []),
          ...(isZombieOi ? ["zombie_oi"] : []),
        ],
      };
    }

    const result = {
      condition_id: id,
      market_name: (await resolveMarketNames([id])).get(id) || null,
      tags,
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Meta-Tool: Scan Markets by Structure ───────────────────────────────────

server.tool(
  "scan_markets_by_structure",
  "Find markets matching structural criteria: resolution speed, liquidity depth, oracle type, or tail-risk flags. Returns structured JSON.",
  {
    filter: z
      .enum([
        "fast_resolution", "slow_resolution", "stale",
        "deep_liquidity", "thin_liquidity", "dormant",
        "uma_oracle", "concentrated_oi", "high_tail_risk",
      ])
      .describe("Structural filter to apply"),
    resolved_only: z
      .boolean()
      .default(false)
      .describe("Only include resolved markets (required for resolution filters)"),
    limit: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of markets to return"),
  },
  async ({ filter, resolved_only, limit }) => {
    const markets: Array<{ condition_id: string; name: string | null; metrics: Record<string, any> }> = [];

    switch (filter) {
      case "fast_resolution":
      case "slow_resolution":
      case "stale": {
        const data = await query(
          ENDPOINTS.positions,
          `{ conditions(first: 50, orderBy: resolvedAt, orderDirection: desc, where: { resolved: true }) { id createdAt resolvedAt openInterest splitCount source } }`
        );
        const targetRange =
          filter === "fast_resolution" ? [0, PERSONA_THRESHOLDS.resolution_fast] :
          filter === "slow_resolution" ? [PERSONA_THRESHOLDS.resolution_medium, PERSONA_THRESHOLDS.resolution_slow] :
          [PERSONA_THRESHOLDS.resolution_slow, Infinity];

        const matched = (data?.conditions || []).filter((c: any) => {
          const latency = parseInt(c.resolvedAt) - parseInt(c.createdAt);
          return latency >= targetRange[0] && latency < targetRange[1];
        });

        const ids = matched.slice(0, limit).map((c: any) => c.id);
        const names = await resolveMarketNames(ids);

        for (const c of matched.slice(0, limit)) {
          const latency = parseInt(c.resolvedAt) - parseInt(c.createdAt);
          markets.push({
            condition_id: c.id,
            name: names.get(c.id) || null,
            metrics: {
              resolution_days: Math.round((latency / 86400) * 10) / 10,
              open_interest: parseFloat(c.openInterest),
              splits: parseInt(c.splitCount),
              source: c.source,
            },
          });
        }
        break;
      }

      case "deep_liquidity":
      case "thin_liquidity":
      case "dormant": {
        const orderBy = filter === "deep_liquidity" ? "tradeCount" : "createdAt";
        const direction = filter === "deep_liquidity" ? "desc" : "desc";
        const data = await query(
          ENDPOINTS.orderbook,
          `{ markets(first: 50, orderBy: ${orderBy}, orderDirection: ${direction}) { id volume tradeCount fees createdAt lastTradeAt } }`
        );

        for (const m of data?.markets || []) {
          if (markets.length >= limit) break;
          const liq = classifyLiquidity(
            parseInt(m.tradeCount),
            parseFloat(m.volume),
            parseInt(m.createdAt),
            parseInt(m.lastTradeAt)
          );
          if (
            (filter === "deep_liquidity" && liq.tag === "deep") ||
            (filter === "thin_liquidity" && liq.tag === "thin") ||
            (filter === "dormant" && liq.tag === "dormant")
          ) {
            markets.push({
              condition_id: m.id,
              name: null, // resolved below
              metrics: {
                liquidity_tag: liq.tag,
                trades_per_day: liq.tradesPerDay,
                volume_per_trade: liq.volumePerTrade,
                days_since_last_trade: liq.daysSinceLastTrade,
                total_volume: parseFloat(m.volume),
                total_trades: parseInt(m.tradeCount),
              },
            });
          }
        }
        // Resolve names
        const ids = markets.map((m) => m.condition_id);
        const names = await resolveMarketNames(ids);
        for (const m of markets) {
          m.name = names.get(m.condition_id) || null;
        }
        break;
      }

      case "uma_oracle": {
        // Find oracle addresses from yield subgraph, then match to conditions
        const oracleData = await query(
          ENDPOINTS.yield,
          `{ oracleRequests(first: 50, orderBy: createdAt, orderDirection: desc) { id requester settled settledAt } }`
        );
        const oracleAddresses = [...new Set((oracleData?.oracleRequests || []).map((o: any) => o.requester))];

        if (oracleAddresses.length > 0) {
          const oracleFilter = oracleAddresses.slice(0, 10).map((a: any) => `"${a}"`).join(", ");
          const condData = await query(
            ENDPOINTS.positions,
            `{ conditions(first: ${limit}, orderBy: openInterest, orderDirection: desc, where: { oracle_in: [${oracleFilter}]${resolved_only ? ", resolved: true" : ""} }) { id oracle openInterest resolved splitCount createdAt resolvedAt } }`
          );
          const ids = (condData?.conditions || []).map((c: any) => c.id);
          const names = await resolveMarketNames(ids);
          for (const c of condData?.conditions || []) {
            markets.push({
              condition_id: c.id,
              name: names.get(c.id) || null,
              metrics: {
                oracle_address: c.oracle,
                open_interest: parseFloat(c.openInterest),
                resolved: c.resolved,
                splits: parseInt(c.splitCount),
              },
            });
          }
        }
        break;
      }

      case "concentrated_oi":
      case "high_tail_risk": {
        const condData = await query(
          ENDPOINTS.positions,
          `{ conditions(first: 30, orderBy: openInterest, orderDirection: desc, where: { openInterest_gt: "100"${resolved_only ? ", resolved: true" : ""} }) { id openInterest splitCount source } }`
        );

        for (const cond of condData?.conditions || []) {
          if (markets.length >= limit) break;
          const oi = parseFloat(cond.openInterest);
          const holdersData = await query(
            ENDPOINTS.positions,
            `{ userPositions(first: 3, orderBy: netQuantity, orderDirection: desc, where: { condition: "${cond.id}", netQuantity_gt: "0" }) { user { id } netQuantity } }`
          );
          const holders = holdersData?.userPositions || [];
          const top3Sum = holders.reduce((sum: number, h: any) => sum + parseFloat(h.netQuantity), 0);
          const top3Pct = oi > 0 ? top3Sum / oi : 0;
          const isConcentrated = top3Pct >= PERSONA_THRESHOLDS.concentrated_top3_pct;

          if (filter === "concentrated_oi" && isConcentrated) {
            markets.push({
              condition_id: cond.id,
              name: null,
              metrics: {
                top_3_holders_pct: Math.round(top3Pct * 1000) / 10,
                open_interest: oi,
                top_holders: holders.map((h: any) => ({
                  address: h.user.id,
                  position: parseFloat(h.netQuantity),
                })),
              },
            });
          } else if (filter === "high_tail_risk") {
            // Check both concentration and OI/volume ratio
            let obMarket: any = null;
            try {
              const obData = await query(
                ENDPOINTS.orderbook,
                `{ market(id: "${cond.id}") { volume } }`
              );
              obMarket = obData?.market;
            } catch { /* skip */ }
            const volume = obMarket ? parseFloat(obMarket.volume) : 0;
            const oiVolumeRatio = volume > 0 ? oi / volume : 999;
            if (isConcentrated || oiVolumeRatio > 1) {
              markets.push({
                condition_id: cond.id,
                name: null,
                metrics: {
                  top_3_holders_pct: Math.round(top3Pct * 1000) / 10,
                  oi_volume_ratio: Math.round(oiVolumeRatio * 1000) / 1000,
                  open_interest: oi,
                  volume,
                  risk_flags: [
                    ...(isConcentrated ? ["concentrated_oi"] : []),
                    ...(oiVolumeRatio > 1 ? ["illiquid_exit"] : []),
                  ],
                },
              });
            }
          }
        }
        // Resolve names
        const allIds = markets.map((m) => m.condition_id);
        if (allIds.length > 0) {
          const names = await resolveMarketNames(allIds);
          for (const m of markets) {
            m.name = names.get(m.condition_id) || null;
          }
        }
        break;
      }
    }

    const output = {
      filter,
      resolved_only,
      markets_found: markets.length,
      markets,
    };

    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
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
{ orderFilledEvents(first: 10, orderBy: timestamp, orderDirection: desc, where: { makerAmountFilled_gt: "1000" }) { maker { id } taker { id } makerAmountFilled price side exchange timestamp } }
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

server.prompt(
  "trader_persona_analysis",
  "Classify traders by behavioral archetypes and find similar traders",
  { address: z.string().optional().describe("Optional: specific trader address to classify") },
  ({ address }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: address
            ? `Classify trader ${address} into behavioral archetypes on Predict.fun. Use find_trader_persona to detect if they match: whale_accumulator, yield_farmer, arbitrageur, early_mover, or resolution_sniper. Then use get_trader_profile for their full trading history. Based on their persona, use scan_trader_personas to find similar traders. Summarize their strategy and how they compare to others.`
            : `Scan the Predict.fun platform for interesting trader archetypes. Use scan_trader_personas for each persona type: whale_accumulator, yield_farmer, arbitrageur, early_mover, and resolution_sniper. Compare the results — which personas are most common? Are there traders who appear in multiple categories? Use get_trader_profile on the most interesting ones to build a full picture.`,
        },
      },
    ],
  })
);

server.prompt(
  "market_quality_scan",
  "Scan markets by structural quality indicators to find opportunities or risks",
  {},
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Perform a structural quality scan of Predict.fun markets. Run these scans in sequence:

1. Use scan_markets_by_structure with filter "deep_liquidity" to find the most actively traded markets.
2. Use scan_markets_by_structure with filter "concentrated_oi" to find markets where a few whales dominate.
3. Use scan_markets_by_structure with filter "high_tail_risk" to identify markets with exit liquidity concerns.
4. Use scan_markets_by_structure with filter "dormant" to find markets that may be abandoned.
5. Use scan_markets_by_structure with filter "fast_resolution" to see which markets resolved quickly.

For the most interesting markets from each scan, use tag_market_structure to get the full structural breakdown. Summarize: Which markets are highest quality (deep liquidity, distributed OI, active trading)? Which are risky (concentrated, illiquid, stale)?`,
        },
      },
    ],
  })
);

// ─── HTTP/SSE Transport ─────────────────────────────────────────────────────

function startHttpTransport(port: number) {
  const app = express();
  const sessions = new Map<string, SSEServerTransport>();

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);
    res.on("close", () => {
      sessions.delete(transport.sessionId);
    });
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Invalid or expired session" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "predictfun-mcp" });
  });

  app.listen(port, () => {
    console.error(`SSE transport listening on http://localhost:${port}/sse`);
  });
}

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const httpPort = process.env.MCP_HTTP_PORT || (process.argv.includes("--http") ? "3850" : null);
  const httpOnly = process.argv.includes("--http-only");

  if (httpPort || httpOnly) {
    const port = parseInt(httpPort || "3850", 10);
    startHttpTransport(port);
  }

  if (!httpOnly) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  console.error("predictfun-mcp running");
}

main().catch(console.error);
