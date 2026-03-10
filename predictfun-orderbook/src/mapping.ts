import { BigInt, BigDecimal, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  OrderFilled,
  OrdersMatched,
  OrderCancelled,
  FeeCharged,
  TokenRegistered,
  TradingPaused,
  TradingUnpaused,
} from "../generated/CTFExchangeYield/CTFExchange";
import {
  MarketPrepared,
  QuestionPrepared,
} from "../generated/NegRiskAdapterNonYield/NegRiskAdapter";
import {
  FeeRefunded,
  FeeWithdrawn,
} from "../generated/FeeModuleYield/FeeModule";
import {
  Global,
  Market,
  NegRiskMarket,
  NegRiskQuestion,
  Orderbook,
  OrderFilledEvent,
  OrdersMatchedEvent,
  OrderCancelledEvent,
  FeeChargedEvent,
  FeeRefundedEvent,
  FeeWithdrawnEvent,
  Account,
  TradingPauseEvent,
  TradeData,
} from "../generated/schema";

// ─── Constants ───────────────────────────────────────────────────────────────

let ZERO = BigInt.zero();
let ZERO_BD = BigDecimal.zero();
let ONE = BigInt.fromI32(1);
let USDT_DECIMALS: u8 = 18;
let GLOBAL_ID = Bytes.fromHexString("0x00");

let CTF_YIELD = Bytes.fromHexString("0x6bEb5a40C032AFc305961162d8204CDA16DECFa5");
let CTF_NON_YIELD = Bytes.fromHexString("0x8BC070BEdAB741406F4B1Eb65A72bee27894B689");
let NEG_RISK_YIELD = Bytes.fromHexString("0x8A289d458f5a134bA40015085A8F50Ffb681B41d");
let NEG_RISK_NON_YIELD = Bytes.fromHexString("0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A");
let FEE_YIELD_ADDR = Bytes.fromHexString("0xFbC2259aBB3F01c019ECE1d0200Ee673BB7BA34F");
let FEE_NON_YIELD_ADDR = Bytes.fromHexString("0xF1f8F5C641F20C48526269EF7DFF19172Efa9783");
let NEG_FEE_YIELD_ADDR = Bytes.fromHexString("0xD172f3FBabe763Ee8E52D8b32421574236dA6057");
let NEG_FEE_NON_YIELD_ADDR = Bytes.fromHexString("0xF2311C668aAA8dEc48D5da577d3018eb94b3132F");

function toDecimal(amount: BigInt): BigDecimal {
  let factor = BigInt.fromI32(10).pow(USDT_DECIMALS).toBigDecimal();
  return amount.toBigDecimal().div(factor);
}

function tokenIdToBytes(tokenId: BigInt): Bytes {
  return Bytes.fromHexString(tokenId.toHexString());
}

function exchangeLabel(address: Bytes): string {
  if (address.equals(CTF_YIELD)) return "CTF_YIELD";
  if (address.equals(CTF_NON_YIELD)) return "CTF_NON_YIELD";
  if (address.equals(NEG_RISK_YIELD)) return "NEG_RISK_YIELD";
  if (address.equals(NEG_RISK_NON_YIELD)) return "NEG_RISK_NON_YIELD";
  return address.toHexString();
}

function feeModuleLabel(address: Bytes): string {
  if (address.equals(FEE_YIELD_ADDR)) return "FEE_YIELD";
  if (address.equals(FEE_NON_YIELD_ADDR)) return "FEE_NON_YIELD";
  if (address.equals(NEG_FEE_YIELD_ADDR)) return "NEG_RISK_FEE_YIELD";
  if (address.equals(NEG_FEE_NON_YIELD_ADDR)) return "NEG_RISK_FEE_NON_YIELD";
  return address.toHexString();
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

function loadGlobal(): Global {
  let g = Global.load(GLOBAL_ID);
  if (g == null) {
    g = new Global(GLOBAL_ID);
    g.totalTrades = ZERO;
    g.totalVolume = ZERO_BD;
    g.totalFees = ZERO_BD;
    g.uniqueTraders = ZERO;
    g.activeMarkets = ZERO;
    g.tradingPaused = false;
    g.save();
  }
  return g;
}

function loadAccount(address: Bytes): Account {
  let a = Account.load(address);
  if (a == null) {
    a = new Account(address);
    a.totalTrades = ZERO;
    a.totalVolume = ZERO_BD;
    a.totalFees = ZERO_BD;
    a.makerTrades = ZERO;
    a.takerTrades = ZERO;
    a.makerVolume = ZERO_BD;
    a.takerVolume = ZERO_BD;
    a.firstTradeAt = ZERO;
    a.lastTradeAt = ZERO;
  }
  return a;
}

function loadOrderbook(tokenId: BigInt): Orderbook {
  let id = tokenIdToBytes(tokenId);
  let ob = Orderbook.load(id);
  if (ob == null) {
    ob = new Orderbook(id);
    ob.tokenId = tokenId;
    ob.market = null;
    ob.buys = ZERO;
    ob.sells = ZERO;
    ob.buyVolume = ZERO_BD;
    ob.sellVolume = ZERO_BD;
    ob.fees = ZERO_BD;
    ob.lastTradePrice = ZERO_BD;
    ob.lastTradeAt = ZERO;
  }
  return ob;
}

// ─── OrderFilled Handler ─────────────────────────────────────────────────────

export function handleOrderFilled(event: OrderFilled): void {
  let makerAmount = toDecimal(event.params.makerAmountFilled);
  let takerAmount = toDecimal(event.params.takerAmountFilled);
  let fee = toDecimal(event.params.fee);
  let exchange = exchangeLabel(event.address);

  let isBuy = event.params.makerAssetId.isZero();
  let side: string;
  let tokenId: BigInt;
  let volume: BigDecimal;
  let price = ZERO_BD;

  if (isBuy) {
    side = "BUY";
    tokenId = event.params.takerAssetId;
    volume = makerAmount;
    if (takerAmount.gt(ZERO_BD)) {
      price = makerAmount.div(takerAmount);
    }
  } else {
    side = "SELL";
    tokenId = event.params.makerAssetId;
    volume = takerAmount;
    if (makerAmount.gt(ZERO_BD)) {
      price = takerAmount.div(makerAmount);
    }
  }
  let obId = tokenIdToBytes(tokenId);

  // Save immutable event
  let entity = new OrderFilledEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.orderHash = event.params.orderHash;
  entity.maker = event.params.maker;
  entity.taker = event.params.taker;
  entity.makerAssetId = event.params.makerAssetId;
  entity.takerAssetId = event.params.takerAssetId;
  entity.makerAmountFilled = makerAmount;
  entity.takerAmountFilled = takerAmount;
  entity.fee = fee;
  entity.price = price;
  entity.side = side;
  entity.exchange = exchange;
  entity.orderbook = obId;
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  // Timeseries data point
  let tsId = event.transaction.hash
    .toHexString()
    .concat("-")
    .concat(event.logIndex.toString());
  let td = new TradeData(tsId);
  td.timestamp = event.block.timestamp.toI64();
  td.volume = volume;
  td.fee = fee;
  td.price = price;
  td.tokenId = tokenId;
  td.exchange = exchange;
  td.save();

  // Update orderbook
  let ob = loadOrderbook(tokenId);
  if (isBuy) {
    ob.buys = ob.buys.plus(ONE);
    ob.buyVolume = ob.buyVolume.plus(volume);
  } else {
    ob.sells = ob.sells.plus(ONE);
    ob.sellVolume = ob.sellVolume.plus(volume);
  }
  ob.fees = ob.fees.plus(fee);
  ob.lastTradePrice = price;
  ob.lastTradeAt = event.block.timestamp;
  ob.save();

  // Update market stats if orderbook is linked to a market
  let marketId = ob.market;
  if (changetype<usize>(marketId) != 0) {
    let m = Market.load(marketId as Bytes);
    if (changetype<usize>(m) != 0) {
      let market = m as Market;
      market.volume = market.volume.plus(volume);
      market.tradeCount = market.tradeCount.plus(ONE);
      market.fees = market.fees.plus(fee);
      market.lastTradeAt = event.block.timestamp;
      market.save();
    }
  }

  // Update maker account
  let maker = loadAccount(event.params.maker);
  let isNewMaker = maker.firstTradeAt.isZero();
  maker.totalTrades = maker.totalTrades.plus(ONE);
  maker.makerTrades = maker.makerTrades.plus(ONE);
  maker.totalVolume = maker.totalVolume.plus(volume);
  maker.makerVolume = maker.makerVolume.plus(volume);
  maker.lastTradeAt = event.block.timestamp;
  if (isNewMaker) {
    maker.firstTradeAt = event.block.timestamp;
  }
  maker.save();

  // Update taker account
  let taker = loadAccount(event.params.taker);
  let isNewTaker = taker.firstTradeAt.isZero();
  taker.totalTrades = taker.totalTrades.plus(ONE);
  taker.takerTrades = taker.takerTrades.plus(ONE);
  taker.totalVolume = taker.totalVolume.plus(volume);
  taker.takerVolume = taker.takerVolume.plus(volume);
  taker.totalFees = taker.totalFees.plus(fee);
  taker.lastTradeAt = event.block.timestamp;
  if (isNewTaker) {
    taker.firstTradeAt = event.block.timestamp;
  }
  taker.save();

  // Update global
  let global = loadGlobal();
  global.totalTrades = global.totalTrades.plus(ONE);
  global.totalVolume = global.totalVolume.plus(volume);
  global.totalFees = global.totalFees.plus(fee);
  if (isNewMaker) {
    global.uniqueTraders = global.uniqueTraders.plus(ONE);
  }
  if (isNewTaker) {
    global.uniqueTraders = global.uniqueTraders.plus(ONE);
  }
  global.save();
}

// ─── OrdersMatched Handler ───────────────────────────────────────────────────

export function handleOrdersMatched(event: OrdersMatched): void {
  let entity = new OrdersMatchedEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.takerOrderHash = event.params.takerOrderHash;
  entity.takerOrderMaker = event.params.takerOrderMaker;
  entity.makerAssetId = event.params.makerAssetId;
  entity.takerAssetId = event.params.takerAssetId;
  entity.makerAmountFilled = toDecimal(event.params.makerAmountFilled);
  entity.takerAmountFilled = toDecimal(event.params.takerAmountFilled);
  entity.exchange = exchangeLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

// ─── OrderCancelled Handler ──────────────────────────────────────────────────

export function handleOrderCancelled(event: OrderCancelled): void {
  let entity = new OrderCancelledEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.orderHash = event.params.orderHash;
  entity.exchange = exchangeLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

// ─── FeeCharged Handler ──────────────────────────────────────────────────────

export function handleFeeCharged(event: FeeCharged): void {
  let entity = new FeeChargedEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.receiver = event.params.receiver;
  entity.tokenId = event.params.tokenId;
  entity.amount = toDecimal(event.params.amount);
  entity.exchange = exchangeLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

// ─── TokenRegistered Handler ─────────────────────────────────────────────────

export function handleTokenRegistered(event: TokenRegistered): void {
  let condId = event.params.conditionId;
  let market = Market.load(condId);
  if (market == null) {
    market = new Market(condId);
    market.token0 = event.params.token0;
    market.token1 = event.params.token1;
    market.exchange = exchangeLabel(event.address);
    market.createdAt = event.block.timestamp;
    market.createdAtBlock = event.block.number;
    market.createdAtTransaction = event.transaction.hash;
    market.volume = ZERO_BD;
    market.tradeCount = ZERO;
    market.fees = ZERO_BD;
    market.lastTradeAt = ZERO;
    market.save();

    let ob0 = loadOrderbook(event.params.token0);
    ob0.market = condId;
    ob0.save();

    let ob1 = loadOrderbook(event.params.token1);
    ob1.market = condId;
    ob1.save();

    let g = loadGlobal();
    g.activeMarkets = g.activeMarkets.plus(ONE);
    g.save();
  }
}

// ─── MarketPrepared Handler (NegRisk) ────────────────────────────────────────

export function handleMarketPrepared(event: MarketPrepared): void {
  let id = event.params.marketId;
  let m = NegRiskMarket.load(id);
  if (m == null) {
    m = new NegRiskMarket(id);
    m.oracle = event.params.oracle;
    m.feeBips = event.params.feeBips;
    m.data = event.params.data;
    m.questionCount = ZERO;
    m.createdAt = event.block.timestamp;
    m.createdAtBlock = event.block.number;
    m.save();
  }
}

// ─── QuestionPrepared Handler (NegRisk) ──────────────────────────────────────

export function handleQuestionPrepared(event: QuestionPrepared): void {
  let id = event.params.questionId;
  let q = NegRiskQuestion.load(id);
  if (q == null) {
    q = new NegRiskQuestion(id);
    q.market = event.params.marketId;
    q.index = event.params.index;
    q.data = event.params.data;
    q.createdAt = event.block.timestamp;
    q.save();

    let m = NegRiskMarket.load(event.params.marketId);
    if (changetype<usize>(m) != 0) {
      let market = m as NegRiskMarket;
      market.questionCount = market.questionCount.plus(ONE);
      market.save();
    }
  }
}

// ─── TradingPaused / Unpaused Handlers ───────────────────────────────────────

export function handleTradingPaused(event: TradingPaused): void {
  let entity = new TradingPauseEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.pauser = event.params.pauser;
  entity.paused = true;
  entity.exchange = exchangeLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let g = loadGlobal();
  g.tradingPaused = true;
  g.save();
}

export function handleTradingUnpaused(event: TradingUnpaused): void {
  let entity = new TradingPauseEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.pauser = event.params.pauser;
  entity.paused = false;
  entity.exchange = exchangeLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let g = loadGlobal();
  g.tradingPaused = false;
  g.save();
}

// ─── Fee Module Handlers ─────────────────────────────────────────────────────

export function handleFeeRefunded(event: FeeRefunded): void {
  let entity = new FeeRefundedEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.token = event.params.token;
  entity.to = event.params.to;
  entity.tokenId = event.params.id;
  entity.amount = toDecimal(event.params.amount);
  entity.module = feeModuleLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleFeeWithdrawn(event: FeeWithdrawn): void {
  let entity = new FeeWithdrawnEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  entity.token = event.params.token;
  entity.to = event.params.to;
  entity.tokenId = event.params.id;
  entity.amount = toDecimal(event.params.amount);
  entity.module = feeModuleLabel(event.address);
  entity.timestamp = event.block.timestamp;
  entity.blockNumber = event.block.number;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
