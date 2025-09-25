import crypto from 'crypto';

import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';

export enum OrderType {
    LIMIT = 'LIMIT',
    MARKET = 'MARKET',
    
}

export enum OrderSide {
    BUY = 'BUY',
    SELL = 'SELL',
}

export enum OrderStatus {
    OPEN = 'OPEN', 
    PARTIALLY_FILLED = 'PARTIALLY_FILLED',
    FILLED = 'FILLED',
    CANCELLED = 'CANCELLED', 
    REJECTED = 'REJECTED', 
    EXPIRED = 'EXPIRED', 
}

export interface TradingPairData {
    _id: string;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    tickSize: string | bigint;
    lotSize: string | bigint;
    minNotional: string | bigint;
    minTradeAmount: string | bigint;
    maxTradeAmount: string | bigint;
    status: string;
    createdAt: string;
    lastUpdatedAt?: string;
}


export interface TradeData {
    _id: string;
    pairId: string;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    makerOrderId: string;
    takerOrderId: string;
    price: string | bigint;
    quantity: string | bigint;
    buyerUserId: string;
    sellerUserId: string;
    timestamp: string;
    isMakerBuyer: boolean;
    // Added for UI/API clarity
    side?: string; // 'BUY' | 'SELL'
    feeAmount?: string | bigint; 
    feeCurrency?: string;
    makerFee?: string | bigint;
    takerFee?: string | bigint;
    total: string | bigint;
    maker: string;
    taker: string;
}

export interface OrderData {
    _id: string;
    userId: string;
    pairId: string;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    type: OrderType;
    side: OrderSide;
    status: OrderStatus;
    price?: string | bigint;
    quantity: string | bigint;
    filledQuantity: string | bigint;
    averageFillPrice?: string | bigint;
    cumulativeQuoteValue?: string | bigint;
    quoteOrderQty?: string | bigint;
    createdAt: string;
    updatedAt: string;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
    expiresAt?: string;
}


function generateOrderId(
    userId: string,
    pairId: string,
    side: OrderSide,
    type: OrderType,
    quantity: bigint,
    price?: bigint,
    transactionId?: string
): string {
    const priceStr = price ? price.toString() : 'market';
    const txId = transactionId || 'no-tx';
    return crypto
        .createHash('sha256')
        .update(`${userId}_${pairId}_${side}_${type}_${quantity}_${priceStr}_${txId}`)
        .digest('hex')
        .substring(0, 16);
}


export function createOrder(
    data: Partial<
        OrderData & {
            amount?: bigint | string | number;
            expirationTimestamp?: bigint | number;
            tickSize?: bigint | string;
            lotSize?: bigint | string;
            transactionId?: string;
        }
    >
): OrderData {
    
    const quantityValue =
        data.quantity !== undefined ? toBigInt(data.quantity) : data.amount !== undefined ? toBigInt(data.amount) : toBigInt(0);

    const priceValue = data.price !== undefined ? toBigInt(data.price) : undefined;
    const userId = data.userId || '';
    const pairId = data.pairId || '';
    const side = data.side || OrderSide.BUY;
    const type = data.type || OrderType.LIMIT;

    const orderId = data._id || generateOrderId(userId, pairId, side, type, quantityValue, priceValue, data.transactionId);

    let expiresAtValue: string | undefined = data.expiresAt;
    if (data.expirationTimestamp !== undefined) {
        expiresAtValue = new Date(Number(data.expirationTimestamp) * 1000).toISOString(); 
        if (data.expiresAt && data.expiresAt !== expiresAtValue) {
            logger.warn('Both expiresAt (string) and expirationTimestamp (number) provided. Using expirationTimestamp.');
        }
    }

    
    const priceValueString = data.price !== undefined ? toDbString(data.price) : undefined;
    const paddedQuantity = toDbString(quantityValue);
    const paddedFilledQuantity = data.filledQuantity !== undefined ? toDbString(data.filledQuantity) : toDbString(0);
    const paddedAverageFillPrice = data.averageFillPrice !== undefined ? toDbString(data.averageFillPrice) : undefined;
    const paddedCumulativeQuoteValue =
        data.cumulativeQuoteValue !== undefined ? toDbString(data.cumulativeQuoteValue) : undefined;
    const paddedQuoteOrderQty = data.quoteOrderQty !== undefined ? toDbString(data.quoteOrderQty) : undefined;

    return {
        _id: orderId,
        userId: data.userId || '',
        pairId: data.pairId || '',
        baseAssetSymbol: data.baseAssetSymbol || '',
        quoteAssetSymbol: data.quoteAssetSymbol || '',
        side: data.side || OrderSide.BUY,
        type: data.type || OrderType.LIMIT,
        price: priceValueString,
        quantity: paddedQuantity,
        filledQuantity: paddedFilledQuantity,
        status: data.status || OrderStatus.OPEN,
        averageFillPrice: paddedAverageFillPrice,
        cumulativeQuoteValue: paddedCumulativeQuoteValue,
        quoteOrderQty: paddedQuoteOrderQty,
        createdAt: data.createdAt || new Date().toISOString(),
        updatedAt: data.updatedAt || new Date().toISOString(),
        timeInForce: data.timeInForce,
        expiresAt: expiresAtValue,
    };
}


export function isAlignedToTickSize(value: bigint, tickSize: bigint): boolean {
    return tickSize > 0n ? value % tickSize === 0n : true;
}
export function isAlignedToLotSize(value: bigint, lotSize: bigint): boolean {
    return lotSize > 0n ? value % lotSize === 0n : true;
}


export interface TradeData {
    _id: string;
    pairId: string;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    makerOrderId: string;
    takerOrderId: string;
    price: string | bigint;
    quantity: string | bigint;
    buyerUserId: string;
    sellerUserId: string;
    timestamp: string;
    isMakerBuyer: boolean;
    

    
    feeAmount?: string | bigint; 
    feeCurrency?: string;
    makerFee?: string | bigint;
    takerFee?: string | bigint;
    total: string | bigint;
    maker: string;
    taker: string;
}


export interface OrderBookLevelData {
    price: string | bigint;
    quantity: string | bigint; 
    orderCount?: number; 
}


export interface OrderBookSnapshotData {
    pairId: string; 
    timestamp: string; 
    lastUpdateId?: number; 
    bids: OrderBookLevelData[]; 
    asks: OrderBookLevelData[]; 
}


export interface MarketCreatePairData {
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    tickSize: string | bigint; 
    lotSize: string | bigint; 
    minNotional: string | bigint; 
    initialStatus?: string; 
    minTradeAmount?: string | bigint; 
    maxTradeAmount?: string | bigint; 
}

export interface MarketPlaceOrderData {
    pairId: string;
    type: OrderType;
    side: OrderSide;
    price?: string | bigint; 
    quantity: string | bigint;
    quoteOrderQty?: string | bigint; 
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
    expiresAt?: string; 
    expirationTimestamp?: number; 
}

export interface MarketCancelOrderData {
    orderId: string;
    pairId: string; 
}





export interface HybridTradeData {
    tokenIn: string; 
    tokenOut: string; 
    amountIn: string | bigint; 

    
    price?: string | bigint; 
    

    
    maxSlippagePercent?: number; 
    

    minAmountOut?: string | bigint; 
    
    

    routes?: HybridRoute[]; 
}


export interface HybridRoute {
    type: 'AMM' | 'ORDERBOOK';
    allocation: number; 
    details: AMMRouteDetails | OrderbookRouteDetails;
}

export interface AMMRouteDetails {
    poolId?: string; 
    hops?: Array<{
        
        poolId: string;
        tokenIn: string;
        tokenOut: string;
    }>;
}

export interface OrderbookRouteDetails {
    pairId: string; 
    side: OrderSide; 
    orderType?: OrderType; 
    price?: string | bigint; 
}


export interface LiquiditySource {
    type: 'AMM' | 'ORDERBOOK';
    id: string; 
    tokenA: string;
    tokenB: string;
    reserveA?: string | bigint; 
    reserveB?: string | bigint; 
    bestBid?: string | bigint; 
    bestAsk?: string | bigint; 
    bidDepth?: string | bigint; 
    askDepth?: string | bigint; 
    hasLiquidity?: boolean; 
}


export interface HybridQuote {
    amountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    priceImpact: number;
    priceImpactFormatted: string;
    routes: Array<{
        type: 'AMM' | 'ORDERBOOK';
        allocation: number;
        amountIn: string;
        amountOut: string;
        priceImpact: number;
        details: any;
    }>;
    warning?: string; 
}


export interface HybridTradeResult {
    success: boolean;
    actualAmountOut: string;
    actualPriceImpact: number;
    executedRoutes: Array<{
        type: 'AMM' | 'ORDERBOOK';
        amountIn: string;
        amountOut: string;
        transactionId?: string;
    }>;
    totalGasUsed?: string;
    error?: string;
}
