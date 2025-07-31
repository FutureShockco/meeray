import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { MarketCancelOrderData, OrderData, OrderStatus, TradingPairData, OrderSide, OrderType } from './market-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { matchingEngine } from './matching-engine.js'; // Assumed to handle the actual removal from book & state update
import { toBigInt } from '../../utils/bigint.js';

// Define keys for converting OrderDB to Order
const ORDER_NUMERIC_FIELDS: Array<keyof OrderData> = ['price', 'quantity', 'filledQuantity', 'averageFillPrice', 'cumulativeQuoteValue', 'quoteOrderQty'];

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

  if (orderFromCache.status === OrderStatus.FILLED || orderFromCache.status === OrderStatus.CANCELLED || orderFromCache.status === OrderStatus.REJECTED || orderFromCache.status === OrderStatus.EXPIRED) {
    logger.warn(`[market-cancel-order] Order ${data.orderId} is already in a final state: ${orderFromCache.status}. Cannot cancel.`);
    return false;
  }

  const userAccount = await getAccount(data.userId);
  if (!userAccount) {
    logger.warn(`[market-cancel-order] User account ${data.userId} not found.`);
    return false;
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

    if (orderFromCache.status !== OrderStatus.OPEN && orderFromCache.status !== OrderStatus.PARTIALLY_FILLED) {
        logger.warn(`[market-cancel-order] Order ${data.orderId} is no longer cancellable. Current status: ${orderFromCache.status}.`);
        return true; 
    }
    
    const cancelSuccess = await matchingEngine.cancelOrder(data.orderId, data.pairId, data.userId);
    if (!cancelSuccess) {
      logger.error(`[market-cancel-order] Matching engine failed to cancel order ${data.orderId}.`);
      return false; 
    }

    // Now, refund escrowed assets.
    const tradingPairFromCache = await cache.findOnePromise('tradingPairs', { _id: orderFromCache.pairId });
    if (!tradingPairFromCache) {
        logger.error(`[market-cancel-order] CRITICAL: TradingPair ${orderFromCache.pairId} for order ${orderFromCache._id} not found.`);
        return false;
    }

    let refundAssetSymbol: string | undefined;
    let refundAssetIssuer: string | undefined;
    let amountToRefund: bigint = BigInt(0);

    const remainingQuantity = toBigInt(orderFromCache.quantity) - toBigInt(orderFromCache.filledQuantity);

    if (orderFromCache.side === OrderSide.BUY) {
      refundAssetSymbol = tradingPairFromCache.quoteAssetSymbol;
      refundAssetIssuer = tradingPairFromCache.quoteAssetIssuer;
      if (orderFromCache.type === OrderType.LIMIT && orderFromCache.price && remainingQuantity > BigInt(0)) {
        amountToRefund = remainingQuantity * toBigInt(orderFromCache.price);
      } else if (orderFromCache.type === OrderType.MARKET && orderFromCache.quoteOrderQty) {
        if (toBigInt(orderFromCache.filledQuantity) === BigInt(0) && orderFromCache.quoteOrderQty) {
            amountToRefund = toBigInt(orderFromCache.quoteOrderQty); 
        }
      }
    } else { // SELL order
      refundAssetSymbol = tradingPairFromCache.baseAssetSymbol;
      refundAssetIssuer = tradingPairFromCache.baseAssetIssuer;
      if (remainingQuantity > BigInt(0)) {
         amountToRefund = remainingQuantity;
      }
    }

    if (amountToRefund > BigInt(0) && refundAssetSymbol && refundAssetIssuer !== undefined) {
      const tokenIdentifier = `${refundAssetSymbol}${refundAssetIssuer ? '@' + refundAssetIssuer : ''}`;
      const refundProcessed = await adjustBalance(sender, tokenIdentifier, amountToRefund);
      if (!refundProcessed) {
        logger.error(`[market-cancel-order] CRITICAL: Failed to refund ${amountToRefund} ${tokenIdentifier} to ${sender}.`);
        return false;
      }
      logger.debug(`[market-cancel-order] Refunded ${amountToRefund} ${tokenIdentifier} to ${sender}.`);
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