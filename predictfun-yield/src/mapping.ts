import { BigInt, BigDecimal, Bytes } from "@graphprotocol/graph-ts";
import {
  YieldClaimed,
  VTokenMinted,
  UnderlyingTokenRedeemed,
  UnderlyingTokenEnabled,
  UnderlyingTokenDisabled,
  UnderlyingTokenConnectedToVToken,
} from "../generated/YieldBearingConditionalTokens/YieldBearingConditionalTokens";
import {
  RewardClaimed,
  RewardDistributionUpdated,
} from "../generated/RewardDistributor/RewardDistributor";
import {
  RequestPrice,
  ProposePrice,
  Settle,
} from "../generated/UmaOptimisticOracle/UmaOptimisticOracle";
import {
  YieldGlobal,
  TokenMapping,
  RewardRound,
  YieldAccount,
  OracleRequest,
  YieldClaimEvent,
  VTokenMintEvent,
  UnderlyingRedeemedEvent,
  UnderlyingEnabledEvent,
  UnderlyingDisabledEvent,
  RewardClaimEvent,
  RewardDistributionEvent,
  OracleRequestEvent,
  OracleProposalEvent,
  OracleSettlementEvent,
} from "../generated/schema";

// ─── Constants ───────────────────────────────────────────────────────────────

let ZERO = BigInt.zero();
let ZERO_BD = BigDecimal.zero();
let ONE = BigInt.fromI32(1);
let USDT_DECIMALS: u8 = 18;
let GLOBAL_ID = Bytes.fromHexString("0x00");
let ZERO_ADDRESS = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000"
);

function toDecimal(amount: BigInt): BigDecimal {
  return amount
    .toBigDecimal()
    .div(BigInt.fromI32(10).pow(USDT_DECIMALS).toBigDecimal());
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

function loadGlobal(): YieldGlobal {
  let g = YieldGlobal.load(GLOBAL_ID);
  if (g == null) {
    g = new YieldGlobal(GLOBAL_ID);
    g.totalYieldClaimed = ZERO_BD;
    g.totalVTokenMinted = ZERO_BD;
    g.totalUnderlyingRedeemed = ZERO_BD;
    g.totalRewardsClaimed = ZERO_BD;
    g.totalOracleRequests = ZERO;
    g.totalOracleSettlements = ZERO;
    g.yieldClaimCount = ZERO;
    g.rewardClaimCount = ZERO;
    g.save();
  }
  return g;
}

function loadTokenMapping(underlying: Bytes): TokenMapping {
  let tm = TokenMapping.load(underlying);
  if (tm == null) {
    tm = new TokenMapping(underlying);
    tm.underlying = underlying;
    tm.vToken = ZERO_ADDRESS;
    tm.enabled = false;
    tm.totalDeposited = ZERO_BD;
    tm.totalYieldClaimed = ZERO_BD;
    tm.totalVTokenMinted = ZERO_BD;
    tm.totalRedeemed = ZERO_BD;
    tm.lastUpdated = ZERO;
  }
  return tm;
}

function loadRewardRound(round: BigInt): RewardRound {
  let id = Bytes.fromByteArray(Bytes.fromBigInt(round));
  let rr = RewardRound.load(id);
  if (rr == null) {
    rr = new RewardRound(id);
    rr.round = round;
    rr.totalClaimed = ZERO_BD;
    rr.claimCount = ZERO;
    rr.updatedAt = ZERO;
  }
  return rr;
}

function loadYieldAccount(address: Bytes, timestamp: BigInt): YieldAccount {
  let a = YieldAccount.load(address);
  if (a == null) {
    a = new YieldAccount(address);
    a.totalRewardsClaimed = ZERO_BD;
    a.rewardClaimCount = ZERO;
    a.firstSeenAt = timestamp;
    a.lastActiveAt = timestamp;
  }
  return a;
}

function oracleRequestId(
  requester: Bytes,
  identifier: Bytes,
  timestamp: BigInt
): Bytes {
  return requester
    .concat(identifier)
    .concat(Bytes.fromByteArray(Bytes.fromBigInt(timestamp)));
}

function loadOracleRequest(
  requester: Bytes,
  identifier: Bytes,
  reqTimestamp: BigInt
): OracleRequest {
  let id = oracleRequestId(requester, identifier, reqTimestamp);
  let req = OracleRequest.load(id);
  if (req == null) {
    req = new OracleRequest(id);
    req.requester = requester;
    req.identifier = identifier;
    req.requestTimestamp = reqTimestamp;
    req.ancillaryData = Bytes.fromHexString("0x");
    req.currency = ZERO_ADDRESS;
    req.reward = ZERO_BD;
    req.finalFee = ZERO_BD;
    req.proposer = null;
    req.proposedPrice = null;
    req.expirationTimestamp = null;
    req.settled = false;
    req.settledPrice = null;
    req.settledPayout = null;
    req.createdAt = ZERO;
    req.createdAtBlock = ZERO;
    req.settledAt = null;
  }
  return req;
}

// ─── YieldBearingConditionalTokens Handlers ──────────────────────────────────

export function handleYieldClaimed(event: YieldClaimed): void {
  let vTokenAmt = toDecimal(event.params.vTokenAmount);
  let underlyingAmt = toDecimal(event.params.underlyingAmount);

  let entity = new YieldClaimEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.underlying = event.params.underlying;
  entity.vToken = event.params.vToken;
  entity.vTokenAmount = vTokenAmt;
  entity.underlyingAmount = underlyingAmt;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let tm = loadTokenMapping(event.params.underlying);
  tm.totalYieldClaimed = tm.totalYieldClaimed.plus(underlyingAmt);
  tm.lastUpdated = event.block.timestamp;
  tm.save();

  let g = loadGlobal();
  g.totalYieldClaimed = g.totalYieldClaimed.plus(underlyingAmt);
  g.yieldClaimCount = g.yieldClaimCount.plus(ONE);
  g.save();
}

export function handleVTokenMinted(event: VTokenMinted): void {
  let amount = toDecimal(event.params.underlyingAmount);

  let entity = new VTokenMintEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.underlying = event.params.underlying;
  entity.vToken = event.params.vToken;
  entity.underlyingAmount = amount;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let tm = loadTokenMapping(event.params.underlying);
  tm.totalVTokenMinted = tm.totalVTokenMinted.plus(amount);
  tm.lastUpdated = event.block.timestamp;
  tm.save();

  let g = loadGlobal();
  g.totalVTokenMinted = g.totalVTokenMinted.plus(amount);
  g.save();
}

export function handleUnderlyingTokenRedeemed(
  event: UnderlyingTokenRedeemed
): void {
  let redeemed = toDecimal(event.params.amountRedeemed);
  let received = toDecimal(event.params.amountReceived);

  let entity = new UnderlyingRedeemedEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.underlying = event.params.underlying;
  entity.vToken = event.params.vToken;
  entity.amountRedeemed = redeemed;
  entity.amountReceived = received;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let tm = loadTokenMapping(event.params.underlying);
  tm.totalRedeemed = tm.totalRedeemed.plus(redeemed);
  tm.lastUpdated = event.block.timestamp;
  tm.save();

  let g = loadGlobal();
  g.totalUnderlyingRedeemed = g.totalUnderlyingRedeemed.plus(redeemed);
  g.save();
}

export function handleUnderlyingTokenEnabled(
  event: UnderlyingTokenEnabled
): void {
  let amount = toDecimal(event.params.amount);

  let entity = new UnderlyingEnabledEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.underlying = event.params.underlying;
  entity.amount = amount;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let tm = loadTokenMapping(event.params.underlying);
  tm.enabled = true;
  tm.totalDeposited = tm.totalDeposited.plus(amount);
  tm.lastUpdated = event.block.timestamp;
  tm.save();
}

export function handleUnderlyingTokenDisabled(
  event: UnderlyingTokenDisabled
): void {
  let redeemed = toDecimal(event.params.amountRedeemed);
  let yieldAmt = toDecimal(event.params.yieldClaimed);

  let entity = new UnderlyingDisabledEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.underlying = event.params.underlying;
  entity.amountRedeemed = redeemed;
  entity.yieldRecipient = event.params.yieldRecipient;
  entity.yieldClaimed = yieldAmt;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let tm = loadTokenMapping(event.params.underlying);
  tm.enabled = false;
  tm.lastUpdated = event.block.timestamp;
  tm.save();
}

export function handleUnderlyingTokenConnectedToVToken(
  event: UnderlyingTokenConnectedToVToken
): void {
  let tm = loadTokenMapping(event.params.underlying);
  tm.vToken = event.params.vToken;
  tm.lastUpdated = event.block.timestamp;
  tm.save();
}

// ─── RewardDistributor Handlers ──────────────────────────────────────────────

export function handleRewardClaimed(event: RewardClaimed): void {
  let amount = toDecimal(event.params.amount);
  let round = event.params.round;

  let rr = loadRewardRound(round);
  rr.totalClaimed = rr.totalClaimed.plus(amount);
  rr.claimCount = rr.claimCount.plus(ONE);
  rr.updatedAt = event.block.timestamp;
  rr.save();

  let acct = loadYieldAccount(event.params.user, event.block.timestamp);
  acct.totalRewardsClaimed = acct.totalRewardsClaimed.plus(amount);
  acct.rewardClaimCount = acct.rewardClaimCount.plus(ONE);
  acct.lastActiveAt = event.block.timestamp;
  acct.save();

  let entity = new RewardClaimEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.account = event.params.user;
  entity.rewardRound = rr.id;
  entity.amount = amount;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let g = loadGlobal();
  g.totalRewardsClaimed = g.totalRewardsClaimed.plus(amount);
  g.rewardClaimCount = g.rewardClaimCount.plus(ONE);
  g.save();
}

export function handleRewardDistributionUpdated(
  event: RewardDistributionUpdated
): void {
  let rr = loadRewardRound(event.params.round);
  rr.updatedAt = event.block.timestamp;
  rr.save();

  let entity = new RewardDistributionEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.round = event.params.round;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

// ─── UMA Optimistic Oracle Handlers ──────────────────────────────────────────

export function handleRequestPrice(event: RequestPrice): void {
  let req = loadOracleRequest(
    event.params.requester,
    event.params.identifier,
    event.params.timestamp
  );
  req.ancillaryData = event.params.ancillaryData;
  req.currency = event.params.currency;
  req.reward = toDecimal(event.params.reward);
  req.finalFee = toDecimal(event.params.finalFee);
  req.createdAt = event.block.timestamp;
  req.createdAtBlock = event.block.number;
  req.save();

  let entity = new OracleRequestEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.requester = event.params.requester;
  entity.identifier = event.params.identifier;
  entity.requestTimestamp = event.params.timestamp;
  entity.ancillaryData = event.params.ancillaryData;
  entity.currency = event.params.currency;
  entity.reward = toDecimal(event.params.reward);
  entity.finalFee = toDecimal(event.params.finalFee);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let g = loadGlobal();
  g.totalOracleRequests = g.totalOracleRequests.plus(ONE);
  g.save();
}

export function handleProposePrice(event: ProposePrice): void {
  let req = loadOracleRequest(
    event.params.requester,
    event.params.identifier,
    event.params.timestamp
  );
  req.proposer = event.params.proposer;
  req.proposedPrice = event.params.proposedPrice;
  req.expirationTimestamp = event.params.expirationTimestamp;
  req.save();

  let entity = new OracleProposalEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.request = req.id;
  entity.requester = event.params.requester;
  entity.proposer = event.params.proposer;
  entity.identifier = event.params.identifier;
  entity.requestTimestamp = event.params.timestamp;
  entity.proposedPrice = event.params.proposedPrice;
  entity.expirationTimestamp = event.params.expirationTimestamp;
  entity.currency = event.params.currency;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleSettle(event: Settle): void {
  let req = loadOracleRequest(
    event.params.requester,
    event.params.identifier,
    event.params.timestamp
  );
  req.settled = true;
  req.settledPrice = event.params.price;
  req.settledPayout = toDecimal(event.params.payout);
  req.settledAt = event.block.timestamp;
  req.save();

  let entity = new OracleSettlementEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.request = req.id;
  entity.requester = event.params.requester;
  entity.proposer = event.params.proposer;
  entity.identifier = event.params.identifier;
  entity.requestTimestamp = event.params.timestamp;
  entity.price = event.params.price;
  entity.payout = toDecimal(event.params.payout);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let g = loadGlobal();
  g.totalOracleSettlements = g.totalOracleSettlements.plus(ONE);
  g.save();
}
