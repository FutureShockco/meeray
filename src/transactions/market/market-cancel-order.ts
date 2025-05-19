import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { MarketCancelOrderData, Order, OrderStatus, TradingPair } from './market-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js';
import { matchingEngine } from './matching-engine.js'; // Assumed to handle the actual removal from book & state update

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

  const order = await cache.findOnePromise('orders', { _id: data.orderId, pairId: data.pairId, userId: data.userId }) as Order | null;
  if (!order) {
    logger.warn(`[market-cancel-order] Order ${data.orderId} for pair ${data.pairId} by user ${data.userId} not found or not owned by sender.`);
    return false;
  }

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
  
  logger.info('[market-cancel-order] Validation successful.');
  return true;
}

export async function process(data: MarketCancelOrderData, sender: string): Promise<boolean> {
  logger.info(`[market-cancel-order] Processing cancellation from ${sender}: ${JSON.stringify(data)}`);
  try {
    // Re-fetch order to ensure it's still in a cancellable state (race condition mitigation)
    const orderToCancel = await cache.findOnePromise('orders', { _id: data.orderId, userId: sender }) as Order | null;
    if (!orderToCancel) {
        logger.error(`[market-cancel-order] CRITICAL: Order ${data.orderId} not found for user ${sender} during processing.`);
        return false;
    }

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
    const tradingPair = await cache.findOnePromise('tradingPairs', { _id: orderToCancel.pairId }) as TradingPair | null;
    if (!tradingPair) {
        logger.error(`[market-cancel-order] CRITICAL: TradingPair ${orderToCancel.pairId} for order ${orderToCancel._id} not found during refund.`);
        return false; // This would be a serious data integrity issue
    }

    let refundAssetSymbol: string | undefined;
    let refundAssetIssuer: string | undefined;
    let amountToRefund = 0;

    const remainingQuantity = orderToCancel.quantity - orderToCancel.filledQuantity;

    if (orderToCancel.side === 'BUY') {
      refundAssetSymbol = tradingPair.quoteAssetSymbol;
      refundAssetIssuer = tradingPair.quoteAssetIssuer;
      if (orderToCancel.type === 'LIMIT' && orderToCancel.price && remainingQuantity > 0) {
        amountToRefund = remainingQuantity * orderToCancel.price;
      } else if (orderToCancel.type === 'MARKET' && orderToCancel.quoteOrderQty) {
        // For market buy by quoteOrderQty, if partially filled, refunding is complex.
        // The `cumulativeQuoteValue` used for fills vs `quoteOrderQty` would determine remainder.
        // This logic is simplified: assumes if it was MARKET BUY by quoteOrderQty and it's cancelled before *any* fill,
        // the full quoteOrderQty could be refunded. If partially filled, it means some quote was spent.
        // A more robust system would track actual locked quote vs spent quote.
        // For now, if it was a market order, refunding exact pre-escrowed amount is hard without knowing precisely what was held.
        // Let's assume for simplicity: if LIMIT, price is known. If MARKET, precise refund is tricky here.
        // The matching engine should ideally tell us the amount to refund or handle it.
        // Let's assume for LIMIT BUY, it's remaining quantity * price.
        // For MARKET BUY with quoteOrderQty that was never filled at all, refund quoteOrderQty. This is a simplification.
        if (orderToCancel.filledQuantity === 0 && orderToCancel.quoteOrderQty) {
            amountToRefund = orderToCancel.quoteOrderQty; 
        }
        // If partially filled market buy, refund logic needs to be more precise based on actual quote spent vs quote held.
      }
    } else { // SELL order
      refundAssetSymbol = tradingPair.baseAssetSymbol;
      refundAssetIssuer = tradingPair.baseAssetIssuer;
      if (remainingQuantity > 0) {
         amountToRefund = remainingQuantity; // Refund remaining base asset
      }
    }

    if (amountToRefund > 0 && refundAssetSymbol && refundAssetIssuer) {
      const tokenIdentifier = `${refundAssetSymbol}@${refundAssetIssuer}`;
      const refundProcessed = await adjustBalance(sender, tokenIdentifier, amountToRefund);
      if (!refundProcessed) {
        logger.error(`[market-cancel-order] CRITICAL: Failed to refund ${amountToRefund} ${tokenIdentifier} to ${sender} for cancelled order ${data.orderId}. Funds may be stuck!`);
        // This is a critical error. The order is cancelled in the engine, but funds not returned.
        // Manual intervention might be needed.
        return false; // Or throw to indicate a severe problem
      }
      logger.info(`[market-cancel-order] Refunded ${amountToRefund} ${tokenIdentifier} to ${sender} for order ${data.orderId}.`);
    } else {
        logger.info(`[market-cancel-order] No amount to refund for order ${data.orderId}, or refund calculation not applicable for this order type/state.`);
    }

    logger.info(`[market-cancel-order] Order ${data.orderId} cancelled successfully by ${sender}.`);

    // Event logging
    const eventDocument = {
      type: 'marketCancelOrder',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: { 
        orderId: data.orderId,
        pairId: data.pairId,
        userId: data.userId,
        status: OrderStatus.CANCELLED // Status should be confirmed by matching engine result ideally
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[market-cancel-order] CRITICAL: Failed to log marketCancelOrder event for ${data.orderId}: ${err || 'no result'}.`);
            }
            resolve();
        });
    });

    return true;
  } catch (error) {
    logger.error(`[market-cancel-order] Error processing order cancellation by ${sender}: ${error}`);
    return false;
  }
} 