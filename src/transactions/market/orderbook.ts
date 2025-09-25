import crypto from 'crypto';

import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint.js';
import { OrderBookLevelData, OrderData, OrderSide, OrderStatus, OrderType, TradeData } from './market-interfaces.js';

function compareOrders(a: OrderData, b: OrderData, side: OrderSide): number {
    const priceA = toBigInt(a.price!);
    const priceB = toBigInt(b.price!);
    if (side === OrderSide.BUY) {
        if (priceA > priceB) return -1;
        if (priceA < priceB) return 1;
    } else {
        if (priceA < priceB) return -1;
        if (priceA > priceB) return 1;
    }
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    return timeA - timeB;
}

export interface OrderBookMatchResult {
    trades: TradeData[];
    removedMakerOrders: string[];
    takerOrderRemaining: OrderData | null;
    updatedMakerOrder?: OrderData;
}

export class OrderBook {
    private pairId: string;
    private bids: OrderData[];
    private asks: OrderData[];
    constructor(pairId: string) {
        this.pairId = pairId;
        this.bids = [];
        this.asks = [];
        logger.debug(`[OrderBook-${pairId}] Initialized}`);
    }

    public addOrder(order: OrderData): void {
        if (order.side === OrderSide.BUY) {
            this.bids.push(order);
            this.bids.sort((a, b) => compareOrders(a, b, OrderSide.BUY));
        } else {
            this.asks.push(order);
            this.asks.sort((a, b) => compareOrders(a, b, OrderSide.SELL));
        }
        logger.debug(
            `[OrderBook-${this.pairId}] Added order ${order._id}: ${order.side} ${order.quantity.toString()} @ ${order.price ? order.price.toString() : 'MARKET'}`
        );
    }

    public removeOrder(orderId: string): boolean {
        const bidIndex = this.bids.findIndex(o => o._id === orderId);
        if (bidIndex !== -1) {
            this.bids.splice(bidIndex, 1);
            return true;
        }
        const askIndex = this.asks.findIndex(o => o._id === orderId);
        if (askIndex !== -1) {
            this.asks.splice(askIndex, 1);
            return true;
        }
        return false;
    }

    public matchOrder(takerOrder: OrderData): OrderBookMatchResult {
        const trades: TradeData[] = [];
        const removedMakerOrderIds: string[] = [];
        let takerQuantityRemaining = toBigInt(takerOrder.quantity);
        let takerOrderRemaining: OrderData | null = null;
        let updatedMakerOrder: OrderData | undefined = undefined;
        const makerBook = takerOrder.side === OrderSide.BUY ? this.asks : this.bids;
        const indicesToRemove: number[] = [];
        for (let i = 0; i < makerBook.length && takerQuantityRemaining > 0n; i++) {
            const makerOrder = makerBook[i];
            if (!makerOrder.price) {
                logger.warn(`[OrderBook-${this.pairId}] Maker order ${makerOrder._id} missing price, skipping`);
                continue;
            }
            if (takerOrder.type === OrderType.LIMIT && takerOrder.price) {
                const takerPrice = toBigInt(takerOrder.price);
                const makerPrice = toBigInt(makerOrder.price);

                if (takerOrder.side === OrderSide.BUY && takerPrice < makerPrice) break;
                if (takerOrder.side === OrderSide.SELL && takerPrice > makerPrice) break;
            }
            const makerQuantityAvailable = toBigInt(makerOrder.quantity) - toBigInt(makerOrder.filledQuantity || '0');
            const quantityToTrade =
                takerQuantityRemaining < makerQuantityAvailable ? takerQuantityRemaining : makerQuantityAvailable;

            if (quantityToTrade <= 0n) {
                continue;
            }
            const tradePrice = toBigInt(makerOrder.price);
            const tradeId = crypto
                .createHash('sha256')
                .update(`${this.pairId}_${makerOrder._id}_${takerOrder._id}_${quantityToTrade}_${tradePrice}`)
                .digest('hex')
                .substring(0, 16);

            const trade: TradeData = {
                _id: tradeId,
                pairId: this.pairId,
                baseAssetSymbol: makerOrder.baseAssetSymbol || '',
                quoteAssetSymbol: makerOrder.quoteAssetSymbol || '',
                makerOrderId: makerOrder._id,
                takerOrderId: takerOrder._id,
                buyerUserId: takerOrder.side === OrderSide.BUY ? takerOrder.userId : makerOrder.userId,
                sellerUserId: takerOrder.side === OrderSide.SELL ? takerOrder.userId : makerOrder.userId,
                price: tradePrice,
                quantity: quantityToTrade,
                timestamp: new Date().toISOString(),
                isMakerBuyer: takerOrder.side === OrderSide.SELL,
                feeAmount: 0n,
                feeCurrency: makerOrder.quoteAssetSymbol || '',
                makerFee: 0n,
                takerFee: 0n,
                total: tradePrice * quantityToTrade,
                maker: makerOrder.userId,
                taker: takerOrder.userId,
            };
            trades.push(trade);
            takerQuantityRemaining = takerQuantityRemaining - quantityToTrade;
            const newMakerFilled = toBigInt(makerOrder.filledQuantity || '0') + quantityToTrade;
            const newTakerFilled = toBigInt(takerOrder.filledQuantity || '0') + quantityToTrade;
            makerOrder.filledQuantity = newMakerFilled.toString();
            takerOrder.filledQuantity = newTakerFilled.toString();
            if (newMakerFilled >= toBigInt(makerOrder.quantity)) {
                makerOrder.status = OrderStatus.FILLED;
                removedMakerOrderIds.push(makerOrder._id);
                indicesToRemove.push(i);
            } else {
                makerOrder.status = OrderStatus.PARTIALLY_FILLED;
                updatedMakerOrder = makerOrder;
            }
        }
        for (let i = indicesToRemove.length - 1; i >= 0; i--) {
            makerBook.splice(indicesToRemove[i], 1);
        }
        if (takerQuantityRemaining > 0n) {
            if (takerOrder.type === OrderType.LIMIT) {
                const remainingTakerOrder: OrderData = {
                    ...takerOrder,
                    status: toBigInt(takerOrder.filledQuantity || '0') > 0n ? OrderStatus.PARTIALLY_FILLED : OrderStatus.OPEN,
                };
                takerOrderRemaining = remainingTakerOrder;
                logger.debug(
                    `[OrderBook-${this.pairId}] Taker LIMIT order ${takerOrder._id} partially filled. Unfilled amount: ${takerQuantityRemaining.toString()}`
                );
            } else {
                takerOrder.status =
                    toBigInt(takerOrder.filledQuantity || '0') > 0n ? OrderStatus.PARTIALLY_FILLED : OrderStatus.REJECTED;
                logger.debug(`[OrderBook-${this.pairId}] Taker MARKET order ${takerOrder._id} could not be fully filled.`);
            }
        } else {
            takerOrder.status = OrderStatus.FILLED;
        }
        logger.debug(
            `[OrderBook-${this.pairId}] Match complete: ${trades.length} trades, ${removedMakerOrderIds.length} makers removed`
        );
        return {
            trades,
            removedMakerOrders: removedMakerOrderIds,
            takerOrderRemaining,
            updatedMakerOrder,
        };
    }

    public getSnapshot(depth: number = 20): { bids: OrderBookLevelData[]; asks: OrderBookLevelData[] } {
        const bidsSnapshot: OrderBookLevelData[] = [];
        const asksSnapshot: OrderBookLevelData[] = [];
        const bidPriceLevels = new Map<string, bigint>();
        for (const order of this.bids) {
            if (!order.price) continue;
            const remainingQuantity = toBigInt(order.quantity) - toBigInt(order.filledQuantity || '0');
            if (remainingQuantity <= 0n) continue; // Skip fully filled or invalid orders
            const priceStr = order.price.toString();
            bidPriceLevels.set(priceStr, (bidPriceLevels.get(priceStr) || 0n) + remainingQuantity);
        }
        const askPriceLevels = new Map<string, bigint>();
        for (const order of this.asks) {
            if (!order.price) continue;
            const remainingQuantity = toBigInt(order.quantity) - toBigInt(order.filledQuantity || '0');
            if (remainingQuantity <= 0n) continue; // Skip fully filled or invalid orders
            const priceStr = order.price.toString();
            askPriceLevels.set(priceStr, (askPriceLevels.get(priceStr) || 0n) + remainingQuantity);
        }
        for (const [priceStr, totalQuantity] of bidPriceLevels) {
            bidsSnapshot.push({
                price: toBigInt(priceStr),
                quantity: totalQuantity,
            });
        }
        bidsSnapshot.sort((a, b) => (a.price > b.price ? -1 : 1)); // Descending price
        for (const [priceStr, totalQuantity] of askPriceLevels) {
            asksSnapshot.push({
                price: toBigInt(priceStr),
                quantity: totalQuantity,
            });
        }
        asksSnapshot.sort((a, b) => (a.price < b.price ? -1 : 1)); // Ascending price
        return {
            bids: bidsSnapshot.slice(0, depth),
            asks: asksSnapshot.slice(0, depth),
        };
    }
}
