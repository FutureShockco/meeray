import { Order, OrderSide, OrderType, OrderBookLevel, Trade, OrderStatus, createOrder } from './market-interfaces.js';
import logger from '../../logger.js';
import { BigIntMath, toBigInt, toString } from '../../utils/bigint.js';
import crypto from 'crypto'; // Added crypto import for randomBytes

// Helper to sort bids (descending price, then ascending time) and asks (ascending price, then ascending time)
// For simplicity, timestamp (createdAt) is used for time priority.
function compareOrders(a: Order, b: Order, side: OrderSide): number {
    const priceA = BigIntMath.toBigInt(a.price!);
    const priceB = BigIntMath.toBigInt(b.price!);

    if (side === OrderSide.BUY) { // Bids: Higher price first
        if (priceA !== priceB) {
            return priceB > priceA ? 1 : -1;
        }
    } else { // Asks: Lower price first
        if (priceA !== priceB) {
            return priceA > priceB ? 1 : -1;
        }
    }
    // If prices are equal, older order gets priority (FIFO)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export interface OrderBookMatchResult {
    trades: Trade[];
    takerOrderFullyFilled: boolean;
    partialFillAmount?: bigint;     // How much of the taker order was filled if not fully
    removedMakerOrders: string[];   // IDs of maker orders that were fully consumed
    updatedMakerOrder?: Order;      // If a maker order was partially consumed
}

export class OrderBook {
    private pairId: string;
    private bids: Order[];          // Sorted: highest price first, then FIFO
    private asks: Order[];          // Sorted: lowest price first, then FIFO
    private tickSize: bigint;
    private lotSize: bigint;

    constructor(pairId: string, tickSize: bigint, lotSize: bigint) {
        this.pairId = pairId;
        this.bids = [];
        this.asks = [];
        this.tickSize = tickSize;
        this.lotSize = lotSize;
        logger.debug(`[OrderBook-${pairId}] Initialized with tickSize: ${toString(tickSize)}, lotSize: ${toString(lotSize)}`);
    }

    // Add a new LIMIT order to the book
    public addOrder(order: Order): void {
        if (order.type !== OrderType.LIMIT || !order.price) {
            logger.warn(`[OrderBook-${this.pairId}] Attempted to add non-LIMIT or unpriced order to book: ${order._id}`);
            return;
        }
        if (order.filledQuantity === undefined) {
            order.filledQuantity = BigInt(0); // Ensure BigInt(0)
        }
        // Ensure order.quantity and order.price are BigInts
        order.quantity = toBigInt(order.quantity);
        order.price = toBigInt(order.price);

        if (order.side === OrderSide.BUY) {
            this.bids.push(order);
            this.bids.sort((a, b) => compareOrders(a, b, OrderSide.BUY));
        } else {
            this.asks.push(order);
            this.asks.sort((a, b) => compareOrders(a, b, OrderSide.SELL));
        }
        logger.debug(`[OrderBook-${this.pairId}] Added order ${order._id}: ${order.side} ${toString(order.quantity)} @ ${toString(order.price)}`);
    }

    // Remove an order from the book (e.g., cancellation)
    public removeOrder(orderId: string): boolean {
        let initialLength = this.bids.length + this.asks.length;
        this.bids = this.bids.filter(o => o._id !== orderId);
        this.asks = this.asks.filter(o => o._id !== orderId);
        const removed = (this.bids.length + this.asks.length) < initialLength;
        if (removed) {
            logger.debug(`[OrderBook-${this.pairId}] Removed order ${orderId}`);
        }
        return removed;
    }

    // Match a new incoming (taker) order against the book
    // For LIMIT orders, this tries to fill it. If not fully filled, the remainder is added to the book.
    // For MARKET orders, this tries to fill it as much as possible at available prices.
    public matchOrder(takerOrder: Order): OrderBookMatchResult {
        const trades: Trade[] = [];
        let takerQuantityRemaining = toBigInt(takerOrder.quantity);
        takerOrder.filledQuantity = takerOrder.filledQuantity ? toBigInt(takerOrder.filledQuantity) : BigInt(0);
        let takerOrderFullyFilled = false;
        const removedMakerOrders: string[] = [];
        let updatedMakerOrder: Order | undefined = undefined;

        logger.debug(`[OrderBook-${this.pairId}] Matching order ${takerOrder._id}: ${takerOrder.side} ${toString(takerOrder.quantity)} @ ${takerOrder.price ? toString(takerOrder.price) : 'MARKET'}`);

        const bookToMatchAgainst = takerOrder.side === OrderSide.BUY ? this.asks : this.bids;
        
        for (let i = 0; i < bookToMatchAgainst.length && takerQuantityRemaining > BigInt(0); ) {
            const makerOrder = bookToMatchAgainst[i];
            // Ensure makerOrder fields are BigInt
            makerOrder.price = toBigInt(makerOrder.price!);
            makerOrder.quantity = toBigInt(makerOrder.quantity);
            makerOrder.filledQuantity = makerOrder.filledQuantity ? toBigInt(makerOrder.filledQuantity) : BigInt(0);

            let tradePrice = makerOrder.price!;

            if (takerOrder.type === OrderType.LIMIT && takerOrder.price) {
                const takerPrice = toBigInt(takerOrder.price);
                if (takerOrder.side === OrderSide.BUY && takerPrice < tradePrice) {
                    break; 
                }
                if (takerOrder.side === OrderSide.SELL && takerPrice > tradePrice) {
                    break; 
                }
            }

            const makerQuantityAvailable = BigIntMath.sub(makerOrder.quantity, makerOrder.filledQuantity);
            const quantityToTrade = BigIntMath.min(takerQuantityRemaining, makerQuantityAvailable);

            if (BigIntMath.isZero(quantityToTrade)) {
                i++;
                continue;
            }

            const tradeTimestamp = new Date().toISOString();
            const trade: Trade = {
                _id: crypto.randomBytes(16).toString('hex'),
                pairId: this.pairId,
                baseAssetSymbol: takerOrder.baseAssetSymbol,
                quoteAssetSymbol: takerOrder.quoteAssetSymbol,
                makerOrderId: makerOrder._id,
                takerOrderId: takerOrder._id,
                price: tradePrice, // is BigInt
                quantity: quantityToTrade, // is BigInt
                buyerUserId: takerOrder.side === OrderSide.BUY ? takerOrder.userId : makerOrder.userId,
                sellerUserId: takerOrder.side === OrderSide.SELL ? takerOrder.userId : makerOrder.userId,
                timestamp: tradeTimestamp,
                isMakerBuyer: makerOrder.side === OrderSide.BUY,
                total: BigIntMath.mul(tradePrice, quantityToTrade),
                maker: makerOrder.userId,
                taker: takerOrder.userId
            };
            trades.push(trade);

            takerQuantityRemaining = BigIntMath.sub(takerQuantityRemaining, quantityToTrade);
            makerOrder.filledQuantity = BigIntMath.add(makerOrder.filledQuantity, quantityToTrade);
            takerOrder.filledQuantity = BigIntMath.add(takerOrder.filledQuantity, quantityToTrade);

            if (makerOrder.filledQuantity >= makerOrder.quantity) {
                makerOrder.status = OrderStatus.FILLED;
                removedMakerOrders.push(makerOrder._id);
                bookToMatchAgainst.splice(i, 1);
            } else {
                makerOrder.status = OrderStatus.PARTIALLY_FILLED;
                updatedMakerOrder = { ...makerOrder };
                i++;
            }
        }

        if (takerQuantityRemaining <= BigInt(0)) {
            takerOrderFullyFilled = true;
        }

        if (takerOrder.type === OrderType.LIMIT && !takerOrderFullyFilled && takerQuantityRemaining > BigInt(0)) {
             // Use createOrder to ensure proper Order structure and BigInt conversions
            const remainingTakerOrder = createOrder({
                ...takerOrder, // Spread existing details like userId, pairId, side, type, price
                _id: crypto.randomUUID(), // New ID for the new book order
                quantity: takerQuantityRemaining, // This is already BigInt
                filledQuantity: BigInt(0), 
                status: OrderStatus.OPEN,
                createdAt: new Date().toISOString(), // New creation time for this book entry
                updatedAt: new Date().toISOString()
            });
            // this.addOrder(remainingTakerOrder); // Logic for adding back to book handled by matching engine
            logger.debug(`[OrderBook-${this.pairId}] Taker LIMIT order ${takerOrder._id} partially filled. Remainder ${toString(remainingTakerOrder.quantity)} could be added to book.`);
        }
        
        logger.debug(`[OrderBook-${this.pairId}] Match attempt for ${takerOrder._id} resulted in ${trades.length} trades. Taker fully filled: ${takerOrderFullyFilled}.`);

        return {
            trades,
            takerOrderFullyFilled,
            partialFillAmount: takerQuantityRemaining > BigInt(0) ? takerQuantityRemaining : undefined,
            removedMakerOrders,
            updatedMakerOrder
        };
    }

    // Get a snapshot of the current order book
    public getSnapshot(depth: number = 20): { bids: OrderBookLevel[], asks: OrderBookLevel[] } {
        const bidsSnapshot: OrderBookLevel[] = [];
        const asksSnapshot: OrderBookLevel[] = [];

        // Aggregate bids
        const bidPrices: { [price: string]: bigint } = {};
        for (const order of this.bids) {
            const priceStr = BigIntMath.toBigInt(order.price!).toString();
            const quantity = BigIntMath.sub(order.quantity, order.filledQuantity);
            if (quantity > 0n) {
                bidPrices[priceStr] = (bidPrices[priceStr] || 0n) + quantity;
            }
        }

        // Aggregate asks
        const askPrices: { [price: string]: bigint } = {};
        for (const order of this.asks) {
            const priceStr = BigIntMath.toBigInt(order.price!).toString();
            const quantity = BigIntMath.sub(order.quantity, order.filledQuantity);
            if (quantity > 0n) {
                askPrices[priceStr] = (askPrices[priceStr] || 0n) + quantity;
            }
        }

        // Aggregate bids and sort
        for (const priceStr in bidPrices) {
            bidsSnapshot.push({ 
                price: BigIntMath.toBigInt(priceStr),
                quantity: bidPrices[priceStr]
            });
        }
        bidsSnapshot.sort((a, b) => BigIntMath.compareDesc(a.price, b.price));

        // Aggregate asks and sort
        for (const priceStr in askPrices) {
            asksSnapshot.push({ 
                price: BigIntMath.toBigInt(priceStr),
                quantity: askPrices[priceStr]
            });
        }
        asksSnapshot.sort((a, b) => BigIntMath.compare(a.price, b.price));

        return {
            bids: bidsSnapshot.slice(0, depth),
            asks: asksSnapshot.slice(0, depth),
        };
    }
} 