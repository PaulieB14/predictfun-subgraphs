import { BigInt, BigDecimal, Bytes } from "@graphprotocol/graph-ts";
import {
  ConditionPreparation,
  ConditionResolution,
  PositionSplit as CTFPositionSplit,
  PositionsMerge as CTFPositionsMerge,
  PayoutRedemption as CTFPayoutRedemption,
  TransferSingle,
} from "../generated/ConditionalTokensNonYield/ConditionalTokens";
import {
  PositionSplit as NRPositionSplit,
  PositionsMerge as NRPositionsMerge,
  PositionsConverted,
  PayoutRedemption as NRPayoutRedemption,
  OutcomeReported,
} from "../generated/NegRiskAdapterNonYield/NegRiskAdapter";
import {
  Global,
  Condition,
  MarketOpenInterest,
  UserPosition,
  Account,
  SplitEvent,
  MergeEvent,
  RedemptionEvent,
  NegRiskConversionEvent,
  OutcomeReportedEvent,
  TransferEvent,
} from "../generated/schema";

// ─── Constants ───────────────────────────────────────────────────────────────

let ZERO = BigInt.zero();
let ZERO_BD = BigDecimal.zero();
let ONE = BigInt.fromI32(1);
let USDT_DECIMALS: u8 = 18;
let GLOBAL_ID = Bytes.fromHexString("0x00");
let ZERO_ADDRESS = Bytes.fromHexString("0x0000000000000000000000000000000000000000");

let CT_NON_YIELD = Bytes.fromHexString("0x22DA1810B194ca018378464a58f6Ac2B10C9d244");
let CT_YIELD = Bytes.fromHexString("0x9400F8Ad57e9e0F352345935d6D3175975eb1d9F");
let NR_NON_YIELD = Bytes.fromHexString("0xc3Cf7c252f65E0d8D88537dF96569AE94a7F1A6E");
let NR_YIELD = Bytes.fromHexString("0x41dCe1A4B8FB5e6327701750aF6231B7CD0B2A40");

function toDecimal(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(BigInt.fromI32(10).pow(USDT_DECIMALS).toBigDecimal());
}

function sourceLabel(address: Bytes): string {
  if (address.equals(CT_NON_YIELD)) return "CT_NON_YIELD";
  if (address.equals(CT_YIELD)) return "CT_YIELD";
  if (address.equals(NR_NON_YIELD)) return "NR_NON_YIELD";
  if (address.equals(NR_YIELD)) return "NR_YIELD";
  return address.toHexString();
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

function loadGlobal(): Global {
  let g = Global.load(GLOBAL_ID);
  if (g == null) {
    g = new Global(GLOBAL_ID);
    g.totalSplits = ZERO;
    g.totalMerges = ZERO;
    g.totalRedemptions = ZERO;
    g.totalSplitVolume = ZERO_BD;
    g.totalMergeVolume = ZERO_BD;
    g.totalPayouts = ZERO_BD;
    g.totalOpenInterest = ZERO_BD;
    g.activeConditions = ZERO;
    g.save();
  }
  return g;
}

function loadAccount(address: Bytes, timestamp: BigInt): Account {
  let a = Account.load(address);
  if (a == null) {
    a = new Account(address);
    a.splitCount = ZERO;
    a.mergeCount = ZERO;
    a.redeemCount = ZERO;
    a.totalSplitVolume = ZERO_BD;
    a.totalMergeVolume = ZERO_BD;
    a.totalPayouts = ZERO_BD;
    a.firstSeenAt = timestamp;
    a.lastActiveAt = timestamp;
  }
  return a;
}

function loadCondition(conditionId: Bytes): Condition {
  let c = Condition.load(conditionId);
  if (c == null) {
    c = new Condition(conditionId);
    c.oracle = ZERO_ADDRESS;
    c.questionId = Bytes.fromHexString("0x00");
    c.outcomeSlotCount = ZERO;
    c.resolved = false;
    c.payoutNumerators = null;
    c.openInterest = ZERO_BD;
    c.splitCount = ZERO;
    c.mergeCount = ZERO;
    c.createdAt = ZERO;
    c.createdAtBlock = ZERO;
    c.resolvedAt = null;
    c.resolvedAtBlock = null;
    c.source = "UNKNOWN";
  }
  return c;
}

function loadOI(conditionId: Bytes): MarketOpenInterest {
  let oi = MarketOpenInterest.load(conditionId);
  if (oi == null) {
    oi = new MarketOpenInterest(conditionId);
    oi.condition = conditionId;
    oi.amount = ZERO_BD;
    oi.splitCount = ZERO;
    oi.mergeCount = ZERO;
    oi.lastUpdated = ZERO;
  }
  return oi;
}

function loadUserPosition(user: Bytes, conditionId: Bytes): UserPosition {
  let id = user.concat(conditionId);
  let p = UserPosition.load(id);
  if (p == null) {
    p = new UserPosition(id);
    p.user = user;
    p.condition = conditionId;
    p.netQuantity = ZERO_BD;
    p.totalSplit = ZERO_BD;
    p.totalMerged = ZERO_BD;
    p.totalRedeemed = ZERO_BD;
    p.realizedPayout = ZERO_BD;
    p.lastUpdated = ZERO;
  }
  return p;
}

// ─── ConditionalTokens: ConditionPreparation ─────────────────────────────────

export function handleConditionPreparation(event: ConditionPreparation): void {
  let c = loadCondition(event.params.conditionId);
  c.oracle = event.params.oracle;
  c.questionId = event.params.questionId;
  c.outcomeSlotCount = event.params.outcomeSlotCount;
  c.createdAt = event.block.timestamp;
  c.createdAtBlock = event.block.number;
  c.source = sourceLabel(event.address);
  c.save();

  let g = loadGlobal();
  g.activeConditions = g.activeConditions.plus(ONE);
  g.save();
}

// ─── ConditionalTokens: ConditionResolution ──────────────────────────────────

export function handleConditionResolution(event: ConditionResolution): void {
  let c = loadCondition(event.params.conditionId);
  c.resolved = true;
  c.payoutNumerators = event.params.payoutNumerators;
  c.resolvedAt = event.block.timestamp;
  c.resolvedAtBlock = event.block.number;
  c.save();
}

// ─── ConditionalTokens: PositionSplit ────────────────────────────────────────

export function handleCTFPositionSplit(event: CTFPositionSplit): void {
  let amount = toDecimal(event.params.amount);
  let condId = event.params.conditionId;
  let source = sourceLabel(event.address);

  let entity = new SplitEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.stakeholder = event.params.stakeholder;
  entity.condition = condId;
  entity.collateralToken = event.params.collateralToken;
  entity.amount = amount;
  entity.source = source;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  // Update condition
  let c = loadCondition(condId);
  c.splitCount = c.splitCount.plus(ONE);
  c.openInterest = c.openInterest.plus(amount);
  c.save();

  // Update OI
  let oi = loadOI(condId);
  oi.amount = oi.amount.plus(amount);
  oi.splitCount = oi.splitCount.plus(ONE);
  oi.lastUpdated = event.block.timestamp;
  oi.save();

  // Update user position
  let pos = loadUserPosition(event.params.stakeholder, condId);
  pos.netQuantity = pos.netQuantity.plus(amount);
  pos.totalSplit = pos.totalSplit.plus(amount);
  pos.lastUpdated = event.block.timestamp;
  pos.save();

  // Update account
  let acct = loadAccount(event.params.stakeholder, event.block.timestamp);
  acct.splitCount = acct.splitCount.plus(ONE);
  acct.totalSplitVolume = acct.totalSplitVolume.plus(amount);
  acct.lastActiveAt = event.block.timestamp;
  acct.save();

  // Update global
  let g = loadGlobal();
  g.totalSplits = g.totalSplits.plus(ONE);
  g.totalSplitVolume = g.totalSplitVolume.plus(amount);
  g.totalOpenInterest = g.totalOpenInterest.plus(amount);
  g.save();
}

// ─── ConditionalTokens: PositionsMerge ───────────────────────────────────────

export function handleCTFPositionsMerge(event: CTFPositionsMerge): void {
  let amount = toDecimal(event.params.amount);
  let condId = event.params.conditionId;

  let entity = new MergeEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.stakeholder = event.params.stakeholder;
  entity.condition = condId;
  entity.collateralToken = event.params.collateralToken;
  entity.amount = amount;
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let c = loadCondition(condId);
  c.mergeCount = c.mergeCount.plus(ONE);
  c.openInterest = c.openInterest.minus(amount);
  c.save();

  let oi = loadOI(condId);
  oi.amount = oi.amount.minus(amount);
  oi.mergeCount = oi.mergeCount.plus(ONE);
  oi.lastUpdated = event.block.timestamp;
  oi.save();

  let pos = loadUserPosition(event.params.stakeholder, condId);
  pos.netQuantity = pos.netQuantity.minus(amount);
  pos.totalMerged = pos.totalMerged.plus(amount);
  pos.lastUpdated = event.block.timestamp;
  pos.save();

  let acct = loadAccount(event.params.stakeholder, event.block.timestamp);
  acct.mergeCount = acct.mergeCount.plus(ONE);
  acct.totalMergeVolume = acct.totalMergeVolume.plus(amount);
  acct.lastActiveAt = event.block.timestamp;
  acct.save();

  let g = loadGlobal();
  g.totalMerges = g.totalMerges.plus(ONE);
  g.totalMergeVolume = g.totalMergeVolume.plus(amount);
  g.totalOpenInterest = g.totalOpenInterest.minus(amount);
  g.save();
}

// ─── ConditionalTokens: PayoutRedemption ─────────────────────────────────────

export function handleCTFPayoutRedemption(event: CTFPayoutRedemption): void {
  let payout = toDecimal(event.params.payout);
  let condId = event.params.conditionId;

  let entity = new RedemptionEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.redeemer = event.params.redeemer;
  entity.condition = condId;
  entity.payout = payout;
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let pos = loadUserPosition(event.params.redeemer, condId);
  pos.totalRedeemed = pos.totalRedeemed.plus(payout);
  pos.realizedPayout = pos.realizedPayout.plus(payout);
  pos.netQuantity = ZERO_BD;
  pos.lastUpdated = event.block.timestamp;
  pos.save();

  let acct = loadAccount(event.params.redeemer, event.block.timestamp);
  acct.redeemCount = acct.redeemCount.plus(ONE);
  acct.totalPayouts = acct.totalPayouts.plus(payout);
  acct.lastActiveAt = event.block.timestamp;
  acct.save();

  let g = loadGlobal();
  g.totalRedemptions = g.totalRedemptions.plus(ONE);
  g.totalPayouts = g.totalPayouts.plus(payout);
  g.save();
}

// ─── ConditionalTokens: TransferSingle ───────────────────────────────────────

export function handleTransferSingle(event: TransferSingle): void {
  let entity = new TransferEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.operator = event.params.operator;
  entity.from = event.params.from;
  entity.to = event.params.to;
  entity.tokenId = event.params.id;
  entity.value = toDecimal(event.params.value);
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

// ─── NegRiskAdapter: PositionSplit ───────────────────────────────────────────

export function handleNRPositionSplit(event: NRPositionSplit): void {
  let amount = toDecimal(event.params.amount);
  let condId = event.params.conditionId;

  let entity = new SplitEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.stakeholder = event.params.stakeholder;
  entity.condition = condId;
  entity.collateralToken = ZERO_ADDRESS;
  entity.amount = amount;
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let c = loadCondition(condId);
  c.splitCount = c.splitCount.plus(ONE);
  c.openInterest = c.openInterest.plus(amount);
  c.save();

  let oi = loadOI(condId);
  oi.amount = oi.amount.plus(amount);
  oi.splitCount = oi.splitCount.plus(ONE);
  oi.lastUpdated = event.block.timestamp;
  oi.save();

  let pos = loadUserPosition(event.params.stakeholder, condId);
  pos.netQuantity = pos.netQuantity.plus(amount);
  pos.totalSplit = pos.totalSplit.plus(amount);
  pos.lastUpdated = event.block.timestamp;
  pos.save();

  let acct = loadAccount(event.params.stakeholder, event.block.timestamp);
  acct.splitCount = acct.splitCount.plus(ONE);
  acct.totalSplitVolume = acct.totalSplitVolume.plus(amount);
  acct.lastActiveAt = event.block.timestamp;
  acct.save();

  let g = loadGlobal();
  g.totalSplits = g.totalSplits.plus(ONE);
  g.totalSplitVolume = g.totalSplitVolume.plus(amount);
  g.totalOpenInterest = g.totalOpenInterest.plus(amount);
  g.save();
}

// ─── NegRiskAdapter: PositionsMerge ──────────────────────────────────────────

export function handleNRPositionsMerge(event: NRPositionsMerge): void {
  let amount = toDecimal(event.params.amount);
  let condId = event.params.conditionId;

  let entity = new MergeEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.stakeholder = event.params.stakeholder;
  entity.condition = condId;
  entity.collateralToken = ZERO_ADDRESS;
  entity.amount = amount;
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let c = loadCondition(condId);
  c.mergeCount = c.mergeCount.plus(ONE);
  c.openInterest = c.openInterest.minus(amount);
  c.save();

  let oi = loadOI(condId);
  oi.amount = oi.amount.minus(amount);
  oi.mergeCount = oi.mergeCount.plus(ONE);
  oi.lastUpdated = event.block.timestamp;
  oi.save();

  let pos = loadUserPosition(event.params.stakeholder, condId);
  pos.netQuantity = pos.netQuantity.minus(amount);
  pos.totalMerged = pos.totalMerged.plus(amount);
  pos.lastUpdated = event.block.timestamp;
  pos.save();

  let acct = loadAccount(event.params.stakeholder, event.block.timestamp);
  acct.mergeCount = acct.mergeCount.plus(ONE);
  acct.totalMergeVolume = acct.totalMergeVolume.plus(amount);
  acct.lastActiveAt = event.block.timestamp;
  acct.save();

  let g = loadGlobal();
  g.totalMerges = g.totalMerges.plus(ONE);
  g.totalMergeVolume = g.totalMergeVolume.plus(amount);
  g.totalOpenInterest = g.totalOpenInterest.minus(amount);
  g.save();
}

// ─── NegRiskAdapter: PositionsConverted ──────────────────────────────────────

export function handlePositionsConverted(event: PositionsConverted): void {
  let entity = new NegRiskConversionEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.stakeholder = event.params.stakeholder;
  entity.marketId = event.params.marketId;
  entity.indexSet = event.params.indexSet;
  entity.amount = toDecimal(event.params.amount);
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

// ─── NegRiskAdapter: PayoutRedemption ────────────────────────────────────────

export function handleNRPayoutRedemption(event: NRPayoutRedemption): void {
  let payout = toDecimal(event.params.payout);
  let condId = event.params.conditionId;

  let entity = new RedemptionEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.redeemer = event.params.redeemer;
  entity.condition = condId;
  entity.payout = payout;
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let pos = loadUserPosition(event.params.redeemer, condId);
  pos.totalRedeemed = pos.totalRedeemed.plus(payout);
  pos.realizedPayout = pos.realizedPayout.plus(payout);
  pos.netQuantity = ZERO_BD;
  pos.lastUpdated = event.block.timestamp;
  pos.save();

  let acct = loadAccount(event.params.redeemer, event.block.timestamp);
  acct.redeemCount = acct.redeemCount.plus(ONE);
  acct.totalPayouts = acct.totalPayouts.plus(payout);
  acct.lastActiveAt = event.block.timestamp;
  acct.save();

  let g = loadGlobal();
  g.totalRedemptions = g.totalRedemptions.plus(ONE);
  g.totalPayouts = g.totalPayouts.plus(payout);
  g.save();
}

// ─── NegRiskAdapter: OutcomeReported ─────────────────────────────────────────

export function handleOutcomeReported(event: OutcomeReported): void {
  let entity = new OutcomeReportedEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.marketId = event.params.marketId;
  entity.questionId = event.params.questionId;
  entity.outcome = event.params.outcome;
  entity.source = sourceLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
