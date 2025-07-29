import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { MarketCancelOrderData, Order, OrderStatus, TradingPair, OrderSide, OrderType } from './market-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { matchingEngine } from './matching-engine.js'; // Assumed to handle the actual removal from book & state update
import { amountToString, convertToBigInt, BigIntMath } from '../../utils/bigint.js';

// Define keys for converting OrderDB to Order
const ORDER_NUMERIC_FIELDS: Array<keyof Order> = ['price', 'quantity', 'filledQuantity', 'averageFillPrice', 'cumulativeQuoteValue', 'quoteOrderQty'];

export async function validateTx(data: MarketCancelOrderData, sender: string): Promise<boolean> {
  logger.debug(`[market-cancel-order] Validating cancellation from ${sender}: ${JSON.stringify(data)}`);

  if (sender !== data.userId) {
    logger.warn('[market-cancel-order] Sender must match userId for the order cancellation.');
    return false;
  }
  if (!data.orderId || !data.pairId) {
    logger.warn('[market-cancel-order] Missing required fields: orderId, pairId.');
    return false;
  }

  // Validate format of IDs if necessary (e.g. using validate.string)
  if (!validate.string(data.orderId, 32, 32)) { // Assuming orderId is a 32-char hex
      logger.warn(`[market-cancel-order] Invalid orderId format: ${data.orderId}`);
      // return false;
  }
  if (!validate.string(data.pairId, 24, 24)) { // Assuming pairId is a 24-char hex
    logger.warn(`[market-cancel-order] Invalid pairId format: ${data.pairId}`);
    // return false;
  }

  const orderFromCache = await cache.findOnePromise('orders', { _id: data.orderId, pairId: data.pairId, userId: data.userId });
  if (!orderFromCache) {
    logger.warn(`[market-cancel-order] Order ${data.orderId} for pair ${data.pairId} by user ${data.userId} not found or not owned by sender.`);
    return false;
  }
  const order = convertToBigInt<Order>(orderFromCache as any, ORDER_NUMERIC_FIELDS); // Convert DB strings to BigInts

  if (order.status === OrderStatus.FILLED || order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED || order.status === OrderStatus.EXPIRED) {
    logger.warn(`[market-cancel-order] Order ${data.orderId} is already in a final state: ${order.status}. Cannot cancel.`);
    return false;
  }
  // If it's PARTIALLY_FILLED, it can still be cancelled (the remaining part).

  const userAccount = await getAccount(data.userId);
  if (!userAccount) {
    logger.warn(`[market-cancel-order] User account ${data.userId} not found.`);
    return false; // Should not happen if order exists and userId matches sender
  }
  
  logger.debug('[market-cancel-order] Validation successful.');
  return true;
}

export async function process(data: MarketCancelOrderData, sender: string, id: string): Promise<boolean> {
  logger.debug(`[market-cancel-order] Processing cancellation from ${sender}: ${JSON.stringify(data)}`);
  try {
    const orderFromCache = await cache.findOnePromise('orders', { _id: data.orderId, userId: sender });
    if (!orderFromCache) {
        logger.error(`[market-cancel-order] CRITICAL: Order ${data.orderId} not found for user ${sender} during processing.`);
        return false;
    }
    const orderToCancel = convertToBigInt<Order>(orderFromCache as any, ORDER_NUMERIC_FIELDS);

    if (orderToCancel.status !== OrderStatus.OPEN && orderToCancel.status !== OrderStatus.PARTIALLY_FILLED) {
        logger.warn(`[market-cancel-order] Order ${data.orderId} is no longer cancellable. Current status: ${orderToCancel.status}.`);
        // Consider this a success if already cancelled, or a soft failure if filled.
        // For simplicity, if it got filled/cancelled between validation and process, we can say it's not an error for this tx.
        return true; 
    }
    
    // The matchingEngine.cancelOrder should handle:
    // 1. Removing the order from the live order book.
    // 2. Updating the order's status to CANCELLED in persistence (e.g., 'orders' collection).
    // 3. Calculating and returning any escrowed funds.
    const cancelSuccess = await matchingEngine.cancelOrder(data.orderId, data.pairId, data.userId);

    if (!cancelSuccess) {
      logger.error(`[market-cancel-order] Matching engine failed to cancel order ${data.orderId}.`);
      // This might be due to the order being filled just now, or an internal engine error.
      // If the engine indicates it was filled, this isn't a failure of the cancel op per se.
      return false; 
    }

    // If cancelSuccess is true, the matching engine has updated the order to CANCELLED.
    // Now, refund escrowed assets.
    // The amount to refund depends on what was escrowed and how much was filled.
    const tradingPairFromCache = await cache.findOnePromise('tradingPairs', { _id: orderToCancel.pairId });
    if (!tradingPairFromCache) {
        logger.error(`[market-cancel-order] CRITICAL: TradingPair ${orderToCancel.pairId} for order ${orderToCancel._id} not found.`);
        return false; // This would be a serious data integrity issue
    }
    // Assuming TradingPairDB needs conversion for its BigInt fields if fetched from DB
    const tradingPairNumericFields: (keyof TradingPair)[] = ['tickSize', 'lotSize', 'minNotional', 'minTradeAmount', 'maxTradeAmount'];
    const tradingPair = convertToBigInt<TradingPair>(tradingPairFromCache as any, tradingPairNumericFields);

    let refundAssetSymbol: string | undefined;
    let refundAssetIssuer: string | undefined;
    let amountToRefund: bigint = BigInt(0); // Initialize as BigInt

    // orderToCancel fields (quantity, filledQuantity, price, quoteOrderQty) are BigInt here
    const remainingQuantity = BigIntMath.sub(orderToCancel.quantity, orderToCancel.filledQuantity);

    if (orderToCancel.side === OrderSide.BUY) { // Compare with enum
      refundAssetSymbol = tradingPair.quoteAssetSymbol;
      refundAssetIssuer = tradingPair.quoteAssetIssuer;
      if (orderToCancel.type === OrderType.LIMIT && orderToCancel.price && remainingQuantity > BigInt(0)) { // Compare with enum & BigInt(0)
        amountToRefund = BigIntMath.mul(remainingQuantity, orderToCancel.price);
      } else if (orderToCancel.type === OrderType.MARKET && orderToCancel.quoteOrderQty) { // Compare with enum
        if (orderToCancel.filledQuantity === BigInt(0) && orderToCancel.quoteOrderQty) { // Compare with BigInt(0)
            amountToRefund = orderToCancel.quoteOrderQty; 
        }
      }
    } else { // SELL order
      refundAssetSymbol = tradingPair.baseAssetSymbol;
      refundAssetIssuer = tradingPair.baseAssetIssuer;
      if (remainingQuantity > BigInt(0)) { // Compare with BigInt(0)
         amountToRefund = remainingQuantity;
      }
    }

    if (amountToRefund > BigInt(0) && refundAssetSymbol && refundAssetIssuer !== undefined) { // Compare with BigInt(0)
      const tokenIdentifier = `${refundAssetSymbol}${refundAssetIssuer ? '@' + refundAssetIssuer : ''}`;
      const refundProcessed = await adjustBalance(sender, tokenIdentifier, amountToRefund); // amountToRefund is BigInt
      if (!refundProcessed) {
        logger.error(`[market-cancel-order] CRITICAL: Failed to refund ${amountToString(amountToRefund)} ${tokenIdentifier} to ${sender}.`);
        // This is a critical error. The order is cancelled in the engine, but funds not returned.
        // Manual intervention might be needed.
        return false; // Or throw to indicate a severe problem
      }
      logger.debug(`[market-cancel-order] Refunded ${amountToString(amountToRefund)} ${tokenIdentifier} to ${sender}.`);
    } else {
        logger.debug(`[market-cancel-order] No amount to refund for order ${data.orderId}.`);
    }

    logger.debug(`[market-cancel-order] Order ${data.orderId} cancelled successfully by ${sender}.`);



    return true;
  } catch (error) {
    logger.error(`[market-cancel-order] Error processing order cancellation by ${sender}: ${error}`);
    return false;
  }
} 