import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { Order, OrderDB, TradingPair, TradingPairDB, OrderType, OrderSide, OrderStatus, MarketPlaceOrderData, MarketPlaceOrderDataDB } from './market-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js';
import { convertToBigInt, convertToString, toString, toBigInt } from '../../utils/bigint-utils.js';
import crypto from 'crypto';
import { logTransactionEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS_MARKET_PLACE_ORDER_DATA: Array<keyof MarketPlaceOrderData> = ['price', 'quantity', 'quoteOrderQty'];
const NUMERIC_FIELDS_ORDER_STORAGE: Array<keyof Order> = ['price', 'quantity', 'filledQuantity', 'averageFillPrice', 'cumulativeQuoteValue', 'quoteOrderQty'];
const NUMERIC_FIELDS_PAIR: Array<keyof TradingPair> = ['tickSize', 'lotSize', 'minNotional', 'minTradeAmount', 'maxTradeAmount'];

function generateOrderId(): string {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

export async function validateTx(data: MarketPlaceOrderDataDB, sender: string): Promise<boolean> {
  try {
    const orderInput = convertToBigInt<MarketPlaceOrderData>(data, NUMERIC_FIELDS_MARKET_PLACE_ORDER_DATA);

    if (!orderInput.pairId || !orderInput.type || !orderInput.side) {
      logger.warn('[market-place-order] Invalid data: Missing required fields (pairId, type, side).');
      return false;
    }
    if (orderInput.quantity === undefined && orderInput.quoteOrderQty === undefined) {
        logger.warn('[market-place-order] Invalid data: Missing quantity or quoteOrderQty.');
        return false;
    }
    if (orderInput.quantity !== undefined && orderInput.quantity <= BigInt(0)) {
        logger.warn('[market-place-order] Invalid quantity, must be > 0.');
        return false;
    }
    if (orderInput.quoteOrderQty !== undefined && orderInput.quoteOrderQty <= BigInt(0)) {
        logger.warn('[market-place-order] Invalid quoteOrderQty, must be > 0.');
        return false;
    }

    if (orderInput.type === OrderType.LIMIT && (orderInput.price === undefined || orderInput.price <= BigInt(0))) {
      logger.warn('[market-place-order] LIMIT orders require a positive price.');
      return false;
    }

    const pairDB = await cache.findOnePromise('tradingPairs', { _id: orderInput.pairId }) as TradingPairDB | null;
    if (!pairDB) {
      logger.warn(`[market-place-order] Trading pair ${orderInput.pairId} not found.`);
      return false;
    }
    const pair = convertToBigInt<TradingPair>(pairDB, NUMERIC_FIELDS_PAIR);

    const effectiveQuantity = orderInput.quantity || BigInt(0);

    if (orderInput.type === OrderType.LIMIT && orderInput.price) {
      if (orderInput.price % pair.tickSize !== BigInt(0)) {
        logger.warn(`[market-place-order] Price ${orderInput.price} does not conform to tick size ${pair.tickSize}.`);
        return false;
      }
    }

    if (effectiveQuantity > BigInt(0) && effectiveQuantity % pair.lotSize !== BigInt(0)) {
      logger.warn(`[market-place-order] Quantity ${effectiveQuantity} does not conform to lot size ${pair.lotSize}.`);
      return false;
    }

    if (orderInput.type === OrderType.LIMIT && orderInput.price && effectiveQuantity > BigInt(0)) {
      const notionalValue = effectiveQuantity * orderInput.price;
      if (notionalValue < pair.minNotional) {
        logger.warn(`[market-place-order] Order value ${notionalValue} is below minimum notional ${pair.minNotional}.`);
        return false;
      }
      if ((pair.minTradeAmount && notionalValue < pair.minTradeAmount) || 
          (pair.maxTradeAmount && notionalValue > pair.maxTradeAmount)) {
        logger.warn(`[market-place-order] Notional value ${notionalValue} is outside allowed trade range [${pair.minTradeAmount}, ${pair.maxTradeAmount}].`);
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
        requiredAmount = effectiveQuantity * orderInput.price;
      } else if (orderInput.type === OrderType.MARKET && orderInput.quoteOrderQty) {
        requiredAmount = orderInput.quoteOrderQty;
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

export async function process(transaction: { data: MarketPlaceOrderDataDB, sender: string, _id: string }): Promise<boolean> {
  const { data: dataDb, sender, _id: transactionId } = transaction;
  try {
    const orderInput = convertToBigInt<MarketPlaceOrderData>(dataDb, NUMERIC_FIELDS_MARKET_PLACE_ORDER_DATA);

    const pairDB = await cache.findOnePromise('tradingPairs', { _id: orderInput.pairId }) as TradingPairDB | null;
    if (!pairDB) {
      logger.error(`[market-place-order] CRITICAL: Trading pair ${orderInput.pairId} not found during processing.`);
      return false;
    }
    const pair = convertToBigInt<TradingPair>(pairDB, NUMERIC_FIELDS_PAIR);

    let finalQuantity = orderInput.quantity;
    if (orderInput.type === OrderType.MARKET && orderInput.side === OrderSide.BUY && orderInput.quoteOrderQty && !orderInput.quantity) {
        finalQuantity = BigInt(0);
    }
    if (finalQuantity === undefined || finalQuantity < BigInt(0)) {
        logger.error('[market-place-order] Invalid quantity for order processing.');
        return false;
    }

    const newOrderObject: Order = {
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
      price: orderInput.price,
      quantity: finalQuantity,
      filledQuantity: BigInt(0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      timeInForce: orderInput.timeInForce || 'GTC',
      quoteOrderQty: orderInput.quoteOrderQty,
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
        requiredEscrowAmount = newOrderObject.quantity * newOrderObject.price;
      } else if (newOrderObject.type === OrderType.MARKET && newOrderObject.quoteOrderQty) {
        requiredEscrowAmount = newOrderObject.quoteOrderQty;
      }
    } else {
      tokenToEscrowSymbol = pair.baseAssetSymbol;
      tokenToEscrowIssuer = pair.baseAssetIssuer;
      requiredEscrowAmount = newOrderObject.quantity;
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

    const newOrderDB = convertToString(newOrderObject, NUMERIC_FIELDS_ORDER_STORAGE);

    const orderInsertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('orders', newOrderDB, (err, success) => {
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
        price: newOrderObject.price ? toString(newOrderObject.price) : undefined,
        quantity: toString(newOrderObject.quantity),
        filledQuantity: toString(newOrderObject.filledQuantity),
        quoteOrderQty: newOrderObject.quoteOrderQty ? toString(newOrderObject.quoteOrderQty) : undefined,
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