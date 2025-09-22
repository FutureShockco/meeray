import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { MarketCancelOrderData, OrderData, OrderStatus, OrderSide } from './market-interfaces.js';
import { getAccount, adjustUserBalance } from '../../utils/account.js';
import { matchingEngine } from './matching-engine.js';
import { toBigInt, calculateTradeValue } from '../../utils/bigint.js';

export async function validateTx(data: MarketCancelOrderData, sender: string): Promise<boolean> {
    try {
        logger.debug(`[market-cancel-order] Validating cancellation from ${sender}: ${JSON.stringify(data)}`);

        // Validate required fields
        if (!data.orderId || !data.pairId) {
            logger.warn('[market-cancel-order] Missing required fields: orderId, pairId.');
            return false;
        }

        // Validate field formats
        if (!validate.string(data.orderId, 64, 1)) {
            logger.warn(`[market-cancel-order] Invalid orderId format: ${data.orderId}`);
            return false;
        }

        if (!validate.string(data.pairId, 128, 1)) {
            logger.warn(`[market-cancel-order] Invalid pairId format: ${data.pairId}`);
            return false;
        }

        // Check if order exists and belongs to sender
        const orderFromCache = await cache.findOnePromise('orders', { 
            _id: data.orderId, 
            pairId: data.pairId, 
            userId: sender 
        });

        if (!orderFromCache) {
            logger.warn(`[market-cancel-order] Order ${data.orderId} for pair ${data.pairId} by user ${sender} not found or not owned by sender.`);
            return false;
        }

        // Check if order is in a cancellable state
        if (orderFromCache.status === OrderStatus.FILLED || 
            orderFromCache.status === OrderStatus.CANCELLED || 
            orderFromCache.status === OrderStatus.REJECTED || 
            orderFromCache.status === OrderStatus.EXPIRED) {
            logger.warn(`[market-cancel-order] Order ${data.orderId} is already in a final state: ${orderFromCache.status}. Cannot cancel.`);
            return false;
        }

        // Validate sender account exists
        const userAccount = await getAccount(sender);
        if (!userAccount) {
            logger.warn(`[market-cancel-order] User account ${sender} not found.`);
            return false;
        }

        logger.debug('[market-cancel-order] Validation successful.');
        return true;

    } catch (error) {
        logger.error(`[market-cancel-order] Error validating order cancellation: ${error}`);
        return false;
    }
}

export async function processTx(data: MarketCancelOrderData, sender: string, id: string): Promise<boolean> {
    try {
        logger.debug(`[market-cancel-order] Processing cancellation from ${sender} for order ${data.orderId}`);

        // Get the order from cache
        const order = await cache.findOnePromise('orders', { _id: data.orderId, pairId: data.pairId, userId: sender }) as OrderData;

        // Use matching engine to cancel the order
        const cancelSuccess = await matchingEngine.cancelOrder(data.orderId, data.pairId, sender);
        
        if (!cancelSuccess) {
            logger.error(`[market-cancel-order] Failed to cancel order ${data.orderId} in matching engine.`);
            return false;
        }

        // Update order status in database
        const updateSuccess = await new Promise<boolean>((resolve) => {
            cache.updateOne('orders', 
                { _id: data.orderId }, 
                { 
                    $set: { 
                        status: OrderStatus.CANCELLED,
                        updatedAt: new Date().toISOString()
                    } 
                }, 
                (err, result) => {
                    if (err || !result) {
                        logger.error(`[market-cancel-order] Failed to update order status: ${err}`);
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                }
            );
        });

        if (!updateSuccess) {
            logger.error(`[market-cancel-order] Failed to update order ${data.orderId} status to cancelled.`);
            return false;
        }

        // If order was partially filled, we need to return locked funds
        const unfilledQuantity = toBigInt(order.quantity) - toBigInt(order.filledQuantity);
        if (unfilledQuantity > BigInt(0)) {
            // For buy orders, return locked quote currency
            // For sell orders, return locked base currency
            const tokenToReturn = order.side === OrderSide.BUY ? 
                order.quoteAssetSymbol : 
                order.baseAssetSymbol;
            
            let amountToReturn: bigint;
            if (order.side === OrderSide.BUY) {
                // Buy order: return quote currency, considering decimal differences
                amountToReturn = calculateTradeValue(toBigInt(order.price || 0), unfilledQuantity, order.baseAssetSymbol, order.quoteAssetSymbol);
            } else {
                // Sell order: return base currency (no price conversion needed)
                amountToReturn = unfilledQuantity;
            }

            if (amountToReturn > BigInt(0)) {
                await adjustUserBalance(sender, tokenToReturn, amountToReturn);
            }
        }

        logger.info(`[market-cancel-order] Successfully cancelled order ${data.orderId} for user ${sender}`);
        return true;

    } catch (error) {
        logger.error(`[market-cancel-order] Error processing order cancellation: ${error}`);
        return false;
    }
}