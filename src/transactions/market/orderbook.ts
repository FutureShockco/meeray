import { Order, OrderSide, OrderType, OrderBookLevel, Trade, OrderStatus } from './market-interfaces.js';
import logger from '../../logger.js';
import { Decimal } from 'decimal.js'; // For precise arithmetic
import crypto from 'crypto'; // Added crypto import for randomBytes

// Helper to sort bids (descending price, then ascending time) and asks (ascending price, then ascending time)
// For simplicity, timestamp (createdAt) is used for time priority.
function compareOrders(a: Order, b: Order, side: OrderSide): number {
    const priceA = new Decimal(a.price!);
    const priceB = new Decimal(b.price!);

    if (side === OrderSide.BUY) { // Bids: Higher price first
        if (!priceA.equals(priceB)) {
            return priceB.minus(priceA).toNumber(); 
        }
    } else { // Asks: Lower price first
        if (!priceA.equals(priceB)) {
            return priceA.minus(priceB).toNumber();
        }
    }
    // If prices are equal, older order gets priority (FIFO)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export interface OrderBookMatchResult {
    trades: Trade[];
    takerOrderFullyFilled: boolean;
    partialFillAmount?: number; // How much of the taker order was filled if not fully
    removedMakerOrders: string[]; // IDs of maker orders that were fully consumed
    updatedMakerOrder?: Order; // If a maker order was partially consumed
}

export class OrderBook {
    private pairId: string;
    private bids: Order[]; // Sorted: highest price first, then FIFO
    private asks: Order[]; // Sorted: lowest price first, then FIFO
    private tickSize: Decimal;
    private lotSize: Decimal;

    constructor(pairId: string, tickSize: number, lotSize: number) {
        this.pairId = pairId;
        this.bids = [];
        this.asks = [];
        this.tickSize = new Decimal(tickSize);
        this.lotSize = new Decimal(lotSize);
        logger.info(`[OrderBook-${pairId}] Initialized with tickSize: ${tickSize}, lotSize: ${lotSize}`);
    }

    // Add a new LIMIT order to the book
    public addOrder(order: Order): void {
        if (order.type !== OrderType.LIMIT || !order.price) {
            logger.warn(`[OrderBook-${this.pairId}] Attempted to add non-LIMIT or unpriced order to book: ${order._id}`);
            return;
        }

        // TODO: Validate order.price against tickSize and order.quantity against lotSize if not done upstream
        // For example: 
        // if (new Decimal(order.price).mod(this.tickSize). !== 0) { throw new Error('Price violates tick size'); }
        // if (new Decimal(order.quantity).mod(this.lotSize) !== 0) { throw new Error('Quantity violates lot size'); }

        if (order.side === OrderSide.BUY) {
            this.bids.push(order);
            this.bids.sort((a, b) => compareOrders(a, b, OrderSide.BUY));
        } else {
            this.asks.push(order);
            this.asks.sort((a, b) => compareOrders(a, b, OrderSide.SELL));
        }
        logger.debug(`[OrderBook-${this.pairId}] Added order ${order._id}: ${order.side} ${order.quantity} @ ${order.price}`);
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
        let takerQuantityRemaining = new Decimal(takerOrder.quantity);
        let takerOrderFullyFilled = false;
        const removedMakerOrders: string[] = [];
        let updatedMakerOrder: Order | undefined = undefined;

        logger.info(`[OrderBook-${this.pairId}] Matching order ${takerOrder._id}: ${takerOrder.side} ${takerOrder.quantity} @ ${takerOrder.price || 'MARKET'}`);

        const bookToMatchAgainst = takerOrder.side === OrderSide.BUY ? this.asks : this.bids;
        
        for (let i = 0; i < bookToMatchAgainst.length && takerQuantityRemaining.greaterThan(0); ) {
            const makerOrder = bookToMatchAgainst[i];
            let tradePrice = new Decimal(makerOrder.price!); // Maker price determines trade price

            // Price check for LIMIT taker orders
            if (takerOrder.type === OrderType.LIMIT && takerOrder.price) {
                const takerPrice = new Decimal(takerOrder.price);
                if (takerOrder.side === OrderSide.BUY && takerPrice.lessThan(tradePrice)) {
                    break; // Taker buy price is lower than best ask, no match
                }
                if (takerOrder.side === OrderSide.SELL && takerPrice.greaterThan(tradePrice)) {
                    break; // Taker sell price is higher than best bid, no match
                }
            }

            const makerQuantityAvailable = new Decimal(makerOrder.quantity).minus(makerOrder.filledQuantity);
            const quantityToTrade = Decimal.min(takerQuantityRemaining, makerQuantityAvailable);

            if (quantityToTrade.lessThanOrEqualTo(0)) { // Should not happen if makerOrder still in book
                i++;
                continue;
            }

            // Create trade
            const tradeTimestamp = new Date().toISOString();
            const trade: Trade = {
                _id: crypto.randomBytes(16).toString('hex'), // Generate unique trade ID
                pairId: this.pairId,
                baseAssetSymbol: takerOrder.baseAssetSymbol, // Assuming same as maker
                quoteAssetSymbol: takerOrder.quoteAssetSymbol,
                makerOrderId: makerOrder._id,
                takerOrderId: takerOrder._id,
                price: tradePrice.toNumber(),
                quantity: quantityToTrade.toNumber(),
                buyerUserId: takerOrder.side === OrderSide.BUY ? takerOrder.userId : makerOrder.userId,
                sellerUserId: takerOrder.side === OrderSide.SELL ? takerOrder.userId : makerOrder.userId,
                timestamp: tradeTimestamp,
                isMakerBuyer: makerOrder.side === OrderSide.BUY,
                // Fee calculation would happen here or in matching engine
            };
            trades.push(trade);

            // Update quantities
            takerQuantityRemaining = takerQuantityRemaining.minus(quantityToTrade);
            makerOrder.filledQuantity = new Decimal(makerOrder.filledQuantity).plus(quantityToTrade).toNumber();
            takerOrder.filledQuantity = new Decimal(takerOrder.filledQuantity).plus(quantityToTrade).toNumber(); // Update taker's filled qty too

            if (new Decimal(makerOrder.filledQuantity).greaterThanOrEqualTo(makerOrder.quantity)) {
                makerOrder.status = OrderStatus.FILLED;
                removedMakerOrders.push(makerOrder._id);
                bookToMatchAgainst.splice(i, 1); // Remove filled maker order
                 // Do not increment i, next order is now at current index
            } else {
                makerOrder.status = OrderStatus.PARTIALLY_FILLED;
                updatedMakerOrder = { ...makerOrder }; // Store the state of the partially filled maker
                i++; // Move to next maker order
            }
        }

        if (takerQuantityRemaining.lessThanOrEqualTo(0)) {
            takerOrderFullyFilled = true;
        }

        // If taker order is a LIMIT order and not fully filled, add its remainder to the book
        if (takerOrder.type === OrderType.LIMIT && !takerOrderFullyFilled && takerQuantityRemaining.greaterThan(0)) {
            const remainingTakerOrder: Order = {
                ...takerOrder,
                quantity: takerQuantityRemaining.toNumber(),
                filledQuantity: 0, // This part is for the new book entry, original takerOrder.filledQuantity is already updated
                status: OrderStatus.OPEN, // It becomes a new open order on the book
                // Ensure _id is new or handled appropriately if re-booking same order ID with remaining qty
            };
            // this.addOrder(remainingTakerOrder); // Or matching engine decides
            logger.debug(`[OrderBook-${this.pairId}] Taker LIMIT order ${takerOrder._id} partially filled. Remainder ${remainingTakerOrder.quantity} could be added to book.`);
        }
        
        logger.info(`[OrderBook-${this.pairId}] Match attempt for ${takerOrder._id} resulted in ${trades.length} trades. Taker fully filled: ${takerOrderFullyFilled}.`);

        return {
            trades,
            takerOrderFullyFilled,
            partialFillAmount: takerOrder.filledQuantity, // Total filled on taker for this match attempt
            removedMakerOrders,
            updatedMakerOrder
        };
    }

    // Get a snapshot of the current order book (e.g., for API display)
    public getSnapshot(depth: number = 20): { bids: OrderBookLevel[], asks: OrderBookLevel[] } {
        const bidsSnapshot: OrderBookLevel[] = [];
        const asksSnapshot: OrderBookLevel[] = [];

        // Aggregate bids
        const bidPrices: { [price: string]: Decimal } = {};
        for (const order of this.bids) {
            const priceStr = new Decimal(order.price!).toFixed(this.tickSize.decimalPlaces());
            const quantity = new Decimal(order.quantity).minus(order.filledQuantity);
            if (quantity.greaterThan(0)) {
                bidPrices[priceStr] = (bidPrices[priceStr] || new Decimal(0)).plus(quantity);
            }
        }
        for (const priceStr in bidPrices) {
            bidsSnapshot.push({ price: parseFloat(priceStr), quantity: bidPrices[priceStr].toNumber() });
        }
        bidsSnapshot.sort((a, b) => b.price - a.price); // Highest price first

        // Aggregate asks
        const askPrices: { [price: string]: Decimal } = {};
        for (const order of this.asks) {
            const priceStr = new Decimal(order.price!).toFixed(this.tickSize.decimalPlaces());
            const quantity = new Decimal(order.quantity).minus(order.filledQuantity);
            if (quantity.greaterThan(0)) {
                askPrices[priceStr] = (askPrices[priceStr] || new Decimal(0)).plus(quantity);
            }
        }
        for (const priceStr in askPrices) {
            asksSnapshot.push({ price: parseFloat(priceStr), quantity: askPrices[priceStr].toNumber() });
        }
        asksSnapshot.sort((a, b) => a.price - b.price); // Lowest price first

        return {
            bids: bidsSnapshot.slice(0, depth),
            asks: asksSnapshot.slice(0, depth),
        };
    }
} 