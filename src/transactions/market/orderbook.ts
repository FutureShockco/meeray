import { OrderData, OrderSide, OrderType, OrderBookLevelData, TradeData, OrderStatus, createOrder } from './market-interfaces.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint.js';
import crypto from 'crypto';

// Helper to sort bids (descending price, then ascending time) and asks (ascending price, then ascending time)
function compareOrders(a: OrderData, b: OrderData, side: OrderSide): number {
    const priceA = toBigInt(a.price!);
    const priceB = toBigInt(b.price!);

    if (side === OrderSide.BUY) {
        // Bids: highest price first, then FIFO (earliest timestamp first)
        if (priceA > priceB) return -1;
        if (priceA < priceB) return 1;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    } else {
        // Asks: lowest price first, then FIFO (earliest timestamp first)
        if (priceA < priceB) return -1;
        if (priceA > priceB) return 1;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
}

export interface OrderBookMatchResult {
    trades: TradeData[];
    removedMakerOrders: string[]; // Order IDs that were completely filled
    takerOrderRemaining: OrderData | null; // Remaining portion of taker order, if any
    updatedMakerOrder?: OrderData;      // If a maker order was partially consumed
}

export class OrderBook {
    private pairId: string;
    private bids: OrderData[];          // Sorted: highest price first, then FIFO
    private asks: OrderData[];          // Sorted: lowest price first, then FIFO
    private tickSize: bigint;
    private lotSize: bigint;

    constructor(pairId: string, tickSize: bigint, lotSize: bigint) {
        this.pairId = pairId;
        this.bids = [];
        this.asks = [];
        this.tickSize = tickSize;
        this.lotSize = lotSize;
        logger.debug(`[OrderBook-${pairId}] Initialized with tickSize: ${tickSize.toString()}, lotSize: ${lotSize.toString()}`);
    }

    public addOrder(order: OrderData): void {
        if (order.side === OrderSide.BUY) {
            this.bids.push(order);
            this.bids.sort((a, b) => compareOrders(a, b, OrderSide.BUY));
        } else {
            this.asks.push(order);
            this.asks.sort((a, b) => compareOrders(a, b, OrderSide.SELL));
        }

        // Validate that price and quantity are valid for the pair's tick/lot size
        if (order.price && toBigInt(order.price) % this.tickSize !== 0n) {
            logger.warn(`[OrderBook-${this.pairId}] Order ${order._id} price ${order.price.toString()} is not aligned to tick size ${this.tickSize.toString()}.`);
        }

        if (toBigInt(order.quantity) % this.lotSize !== 0n) {
            logger.warn(`[OrderBook-${this.pairId}] Order ${order._id} quantity ${order.quantity.toString()} is not aligned to lot size ${this.lotSize.toString()}.`);
        }

        logger.debug(`[OrderBook-${this.pairId}] Added order ${order._id}: ${order.side} ${order.quantity.toString()} @ ${order.price ? order.price.toString() : 'MARKET'}`);
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
        const removedMakerOrders: string[] = [];
        let takerQuantityRemaining = toBigInt(takerOrder.quantity);
        let takerOrderRemaining: OrderData | null = null;
        let updatedMakerOrder: OrderData | undefined = undefined;

        logger.debug(`[OrderBook-${this.pairId}] Matching order ${takerOrder._id}: ${takerOrder.side} ${takerOrder.quantity.toString()} @ ${takerOrder.price ? takerOrder.price.toString() : 'MARKET'}`);

        const makerBook = takerOrder.side === OrderSide.BUY ? this.asks : this.bids;

        for (let i = 0; i < makerBook.length && takerQuantityRemaining > 0n; i++) {
            const makerOrder = makerBook[i];

            // Check if orders can match based on price
            if (takerOrder.type === OrderType.LIMIT && takerOrder.price) {
                const takerPrice = toBigInt(takerOrder.price);
                const makerPrice = toBigInt(makerOrder.price!);
                
                if (takerOrder.side === OrderSide.BUY && takerPrice < makerPrice) break;
                if (takerOrder.side === OrderSide.SELL && takerPrice > makerPrice) break;
            }

            // Calculate quantities available for trade
            const makerQuantityAvailable = toBigInt(makerOrder.quantity) - toBigInt(makerOrder.filledQuantity);
            const quantityToTrade = takerQuantityRemaining < makerQuantityAvailable ? takerQuantityRemaining : makerQuantityAvailable;

            if (quantityToTrade === 0n) {
                continue;
            }

            // Determine trade price (maker's price takes precedence for limit orders)
            const tradePrice = toBigInt(makerOrder.price!);
            // Generate deterministic trade ID based on the order matching
            const tradeId = crypto.createHash('sha256')
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
                taker: takerOrder.userId
            };

            trades.push(trade);

            // Update quantities
            takerQuantityRemaining = takerQuantityRemaining - quantityToTrade;
            makerOrder.filledQuantity = toBigInt(makerOrder.filledQuantity) + quantityToTrade;
            takerOrder.filledQuantity = toBigInt(takerOrder.filledQuantity) + quantityToTrade;

            // Determine order statuses
            if (makerOrder.filledQuantity >= toBigInt(makerOrder.quantity)) {
                makerOrder.status = OrderStatus.FILLED;
                removedMakerOrders.push(makerOrder._id);
            } else {
                makerOrder.status = OrderStatus.PARTIALLY_FILLED;
                updatedMakerOrder = makerOrder;
            }
        }

        // Remove filled maker orders from the book
        removedMakerOrders.forEach(orderId => {
            const index = makerBook.findIndex(o => o._id === orderId);
            if (index !== -1) {
                makerBook.splice(index, 1);
            }
        });

        // Handle remaining taker order
        if (takerQuantityRemaining > 0n) {
            if (takerOrder.type === OrderType.LIMIT) {
                const remainingTakerOrder: OrderData = {
                    ...takerOrder,
                    quantity: takerQuantityRemaining,
                    status: toBigInt(takerOrder.filledQuantity) > 0n ? OrderStatus.PARTIALLY_FILLED : OrderStatus.OPEN
                };
                takerOrderRemaining = remainingTakerOrder;
                logger.debug(`[OrderBook-${this.pairId}] Taker LIMIT order ${takerOrder._id} partially filled. Remainder ${remainingTakerOrder.quantity.toString()} could be added to book.`);
            } else {
                // MARKET orders don't get added to the book; they just get partially filled or rejected
                takerOrder.status = toBigInt(takerOrder.filledQuantity) > 0n ? OrderStatus.PARTIALLY_FILLED : OrderStatus.REJECTED;
                logger.debug(`[OrderBook-${this.pairId}] Taker MARKET order ${takerOrder._id} could not be fully filled.`);
            }
        } else {
            takerOrder.status = OrderStatus.FILLED;
        }

        return {
            trades,
            removedMakerOrders,
            takerOrderRemaining,
            updatedMakerOrder
        };
    }

    public getSnapshot(depth: number = 20): { bids: OrderBookLevelData[], asks: OrderBookLevelData[] } {
        const bidsSnapshot: OrderBookLevelData[] = [];
        const asksSnapshot: OrderBookLevelData[] = [];

        // Process bids (group by price)
        const bidPriceLevels = new Map<string, bigint>();
        for (const order of this.bids.slice(0, depth)) {
            const priceStr = toBigInt(order.price!).toString();
            const quantity = toBigInt(order.quantity) - toBigInt(order.filledQuantity);
            bidPriceLevels.set(priceStr, (bidPriceLevels.get(priceStr) || 0n) + quantity);
        }

        // Process asks (group by price)
        const askPriceLevels = new Map<string, bigint>();
        for (const order of this.asks.slice(0, depth)) {
            const priceStr = toBigInt(order.price!).toString();
            const quantity = toBigInt(order.quantity) - toBigInt(order.filledQuantity);
            askPriceLevels.set(priceStr, (askPriceLevels.get(priceStr) || 0n) + quantity);
        }

        // Convert to OrderBookLevel format for bids
        for (const [priceStr, totalQuantity] of bidPriceLevels) {
            bidsSnapshot.push({
                price: toBigInt(priceStr),
                quantity: totalQuantity
            });
        }
        bidsSnapshot.sort((a, b) => a.price > b.price ? -1 : 1); // Descending price

        // Convert to OrderBookLevel format for asks
        for (const [priceStr, totalQuantity] of askPriceLevels) {
            asksSnapshot.push({
                price: toBigInt(priceStr),
                quantity: totalQuantity
            });
        }
        asksSnapshot.sort((a, b) => a.price < b.price ? -1 : 1); // Ascending price

        return { bids: bidsSnapshot, asks: asksSnapshot };
    }
}
