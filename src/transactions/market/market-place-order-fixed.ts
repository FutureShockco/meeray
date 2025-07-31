import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { OrderType, OrderSide, OrderStatus, MarketPlaceOrderData } from './market-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';
import crypto from 'crypto';
import { logTransactionEvent } from '../../utils/event-logger.js';

function generateOrderId(): string {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

export async function validateTx(data: MarketPlaceOrderData, sender: string): Promise<boolean> {
  try {
    const orderInput = data; // No conversion needed with single interface

    if (!orderInput.pairId || !orderInput.type || !orderInput.side) {
      logger.warn('[market-place-order] Invalid data: Missing required fields (pairId, type, side).');
      return false;
    }
    if (orderInput.quantity === undefined && orderInput.quoteOrderQty === undefined) {
        logger.warn('[market-place-order] Invalid data: Missing quantity or quoteOrderQty.');
        return false;
    }
    if (orderInput.quantity !== undefined && toBigInt(orderInput.quantity) <= BigInt(0)) {
        logger.warn('[market-place-order] Invalid quantity, must be > 0.');
        return false;
    }
    if (orderInput.quoteOrderQty !== undefined && toBigInt(orderInput.quoteOrderQty) <= BigInt(0)) {
        logger.warn('[market-place-order] Invalid quoteOrderQty, must be > 0.');
        return false;
    }

    if (orderInput.type === OrderType.LIMIT && (orderInput.price === undefined || toBigInt(orderInput.price) <= BigInt(0))) {
      logger.warn('[market-place-order] LIMIT orders require a positive price.');
      return false;
    }

    const pairDB = await cache.findOnePromise('tradingPairs', { _id: orderInput.pairId });
    if (!pairDB) {
      logger.warn(`[market-place-order] Trading pair ${orderInput.pairId} not found.`);
      return false;
    }
    const pair = pairDB; // Use data directly

    const effectiveQuantity = orderInput.quantity ? toBigInt(orderInput.quantity) : BigInt(0);

    if (orderInput.type === OrderType.LIMIT && orderInput.price) {
      const price = toBigInt(orderInput.price);
      const tickSize = toBigInt(pair.tickSize);
      if (price % tickSize !== BigInt(0)) {
        logger.warn(`[market-place-order] Price ${price} does not conform to tick size ${tickSize}.`);
        return false;
      }
    }

    if (effectiveQuantity > BigInt(0)) {
      const lotSize = toBigInt(pair.lotSize);
      if (effectiveQuantity % lotSize !== BigInt(0)) {
        logger.warn(`[market-place-order] Quantity ${effectiveQuantity} does not conform to lot size ${lotSize}.`);
        return false;
      }
    }

    if (orderInput.type === OrderType.LIMIT && orderInput.price && effectiveQuantity > BigInt(0)) {
      const price = toBigInt(orderInput.price);
      const notionalValue = effectiveQuantity * price;
      const minNotional = toBigInt(pair.minNotional);
      if (notionalValue < minNotional) {
        logger.warn(`[market-place-order] Order value ${notionalValue} is below minimum notional ${minNotional}.`);
        return false;
      }
      const minTradeAmount = pair.minTradeAmount ? toBigInt(pair.minTradeAmount) : null;
      const maxTradeAmount = pair.maxTradeAmount ? toBigInt(pair.maxTradeAmount) : null;
      if ((minTradeAmount && notionalValue < minTradeAmount) || 
          (maxTradeAmount && notionalValue > maxTradeAmount)) {
        logger.warn(`[market-place-order] Notional value ${notionalValue} is outside allowed trade range [${minTradeAmount}, ${maxTradeAmount}].`);
        return false;
      }
    }

    const account = await getAccount(sender);
    if (!account) {
      logger.warn(`[market-place-order] Account ${sender} not found.`);
      return false;
    }
    
    let requiredAmount = BigInt(0);
    let tokenToEscrowSymbol = '';
    let tokenToEscrowIssuer = '';

    if (orderInput.side === OrderSide.BUY) {
      tokenToEscrowSymbol = pair.quoteAssetSymbol;
      tokenToEscrowIssuer = pair.quoteAssetIssuer;
      if (orderInput.type === OrderType.LIMIT && orderInput.price) {
        requiredAmount = effectiveQuantity * toBigInt(orderInput.price);
      } else if (orderInput.type === OrderType.MARKET && orderInput.quoteOrderQty) {
        requiredAmount = toBigInt(orderInput.quoteOrderQty);
      } else if (orderInput.type === OrderType.MARKET) {
        logger.warn('[market-place-order] MARKET BUY orders without quoteOrderQty are not fully supported for pre-validation of balance.');
      }
    } else {
      tokenToEscrowSymbol = pair.baseAssetSymbol;
      tokenToEscrowIssuer = pair.baseAssetIssuer;
      requiredAmount = effectiveQuantity; 
    }

    if (requiredAmount > BigInt(0)) {
        const tokenIdentifierForEscrow = `${tokenToEscrowSymbol}${tokenToEscrowIssuer ? '@' + tokenToEscrowIssuer : ''}`;
        const availableBalanceStr = account.balances?.[tokenIdentifierForEscrow] || '0';
        const availableBalance = toBigInt(availableBalanceStr);
        if (availableBalance < requiredAmount) {
            logger.warn(`[market-place-order] Insufficient balance for ${sender} to escrow ${requiredAmount} of ${tokenIdentifierForEscrow}. Available: ${availableBalance}`);
            return false;
        }
    }

    return true;
  } catch (error: any) {
    const pairId = (data as any)?.pairId || 'unknown_pair';
    logger.error(`[market-place-order] Error validating order for pair ${pairId} by ${sender}: ${error?.message || error}`);
    return false;
  }
}

export async function process(dataDb: MarketPlaceOrderData, sender: string, transactionId: string): Promise<boolean> {
  try {
    const orderInput = dataDb; // No conversion needed with single interface

    const pairDB = await cache.findOnePromise('tradingPairs', { _id: orderInput.pairId });
    if (!pairDB) {
      logger.error(`[market-place-order] CRITICAL: Trading pair ${orderInput.pairId} not found during processing.`);
      return false;
    }
    const pair = pairDB; // Use data directly

    let finalQuantity = orderInput.quantity ? toBigInt(orderInput.quantity) : BigInt(0);
    if (orderInput.type === OrderType.MARKET && orderInput.side === OrderSide.BUY && orderInput.quoteOrderQty && !orderInput.quantity) {
        finalQuantity = BigInt(0);
    }
    if (finalQuantity < BigInt(0)) {
        logger.error('[market-place-order] Invalid quantity for order processing.');
        return false;
    }

    const newOrderObject = {
      _id: generateOrderId(),
      userId: sender,
      pairId: orderInput.pairId,
      baseAssetSymbol: pair.baseAssetSymbol,
      baseAssetIssuer: pair.baseAssetIssuer,
      quoteAssetSymbol: pair.quoteAssetSymbol,
      quoteAssetIssuer: pair.quoteAssetIssuer,
      type: orderInput.type,
      side: orderInput.side,
      status: OrderStatus.OPEN,
      price: orderInput.price ? orderInput.price.toString() : undefined,
      quantity: finalQuantity.toString(),
      filledQuantity: '0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      timeInForce: orderInput.timeInForce || 'GTC',
      quoteOrderQty: orderInput.quoteOrderQty ? orderInput.quoteOrderQty.toString() : undefined,
      expiresAt: orderInput.expiresAt || (orderInput.expirationTimestamp ? new Date(orderInput.expirationTimestamp * 1000).toISOString() : undefined),
    };

    let requiredEscrowAmount = BigInt(0);
    let tokenToEscrowSymbol = '';
    let tokenToEscrowIssuer = '';
    let escrowSuccessful = true;

    if (newOrderObject.side === OrderSide.BUY) {
      tokenToEscrowSymbol = pair.quoteAssetSymbol;
      tokenToEscrowIssuer = pair.quoteAssetIssuer;
      if (newOrderObject.type === OrderType.LIMIT && newOrderObject.price) {
        requiredEscrowAmount = finalQuantity * toBigInt(newOrderObject.price);
      } else if (newOrderObject.type === OrderType.MARKET && newOrderObject.quoteOrderQty) {
        requiredEscrowAmount = toBigInt(newOrderObject.quoteOrderQty);
      }
    } else {
      tokenToEscrowSymbol = pair.baseAssetSymbol;
      tokenToEscrowIssuer = pair.baseAssetIssuer;
      requiredEscrowAmount = finalQuantity;
    }

    if (requiredEscrowAmount > BigInt(0)) {
        const tokenIdentifierForEscrow = `${tokenToEscrowSymbol}${tokenToEscrowIssuer ? '@' + tokenToEscrowIssuer : ''}`;
        const escrowUpdateSuccess = await adjustBalance(sender, tokenIdentifierForEscrow, -requiredEscrowAmount);
        if (!escrowUpdateSuccess) {
            logger.error(`[market-place-order] Failed to escrow ${requiredEscrowAmount} of ${tokenIdentifierForEscrow} from ${sender}.`);
            escrowSuccessful = false;
        }
    }

    if (!escrowSuccessful) {
        logger.warn(`[market-place-order] Escrow failed for order by ${sender}. Order will not be placed.`);
        return false; 
    }

    // Store order directly with string values for MongoDB
    const orderInsertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('orders', newOrderObject, (err, success) => {
        if (err || !success) {
          logger.error(`[market-place-order] Failed to insert order: ${err || 'insert not successful'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!orderInsertSuccess) {
      logger.error('[market-place-order] Failed to insert order. Aborting and attempting to release escrow.');
      if (requiredEscrowAmount > BigInt(0)) {
          const tokenIdentifierForEscrow = `${tokenToEscrowSymbol}${tokenToEscrowIssuer ? '@' + tokenToEscrowIssuer : ''}`;
          await adjustBalance(sender, tokenIdentifierForEscrow, requiredEscrowAmount);
          logger.info(`[market-place-order] Escrow of ${requiredEscrowAmount} ${tokenIdentifierForEscrow} released for ${sender} due to order insertion failure.`);
      }
      return false;
    }

    logger.debug(`[market-place-order] Order ${newOrderObject._id} placed for pair ${orderInput.pairId} by ${sender}.`);

    const eventData = {
        orderId: newOrderObject._id,
        pairId: newOrderObject.pairId,
        userId: newOrderObject.userId,
        orderType: newOrderObject.type,
        side: newOrderObject.side,
        status: newOrderObject.status,
        price: newOrderObject.price,
        quantity: newOrderObject.quantity,
        filledQuantity: newOrderObject.filledQuantity,
        quoteOrderQty: newOrderObject.quoteOrderQty,
        timeInForce: newOrderObject.timeInForce,
        createdAt: newOrderObject.createdAt,
    };
    await logTransactionEvent('marketOrderPlaced', sender, eventData, transactionId);

    return true;
  } catch (error: any) {
    const pairId = (dataDb as any)?.pairId || 'unknown_pair';
    logger.error(`[market-place-order] Error processing order for pair ${pairId} by ${sender}: ${error?.message || error}`);
    return false;
  }
}
