import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { Order, OrderDB, TradingPair, TradingPairDB, OrderType, OrderSide, OrderStatus } from './market-interfaces.js';
import { getAccount } from '../../utils/account-utils.js';
import { convertToBigInt, convertToString, BigIntMath } from '../../utils/bigint-utils.js';
import crypto from 'crypto';
import { matchingEngine } from './matching-engine.js'; // Will be created later

const NUMERIC_FIELDS_ORDER: Array<keyof Order> = ['price', 'quantity', 'filledQuantity', 'averageFillPrice', 'cumulativeQuoteValue', 'quoteOrderQty'];
const NUMERIC_FIELDS_PAIR: Array<keyof TradingPair> = ['tickSize', 'lotSize', 'minNotional', 'minTradeAmount', 'maxTradeAmount'];

function generateOrderId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// AccountBalance interface removed as userAccount.balances is a map { [tokenIdentifier: string]: number }

export async function validateTx(data: OrderDB, sender: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for validation
    const order = convertToBigInt<Order>(data, NUMERIC_FIELDS_ORDER);

    if (!order.pairId || !order.type || !order.side || !order.quantity) {
      logger.warn('[market-place-order] Invalid data: Missing required fields.');
      return false;
    }

    if (order.type === OrderType.LIMIT && !order.price) {
      logger.warn('[market-place-order] LIMIT orders require a price.');
      return false;
    }

    const pairDB = await cache.findOnePromise('tradingPairs', { _id: order.pairId }) as TradingPairDB | null;
    if (!pairDB) {
      logger.warn(`[market-place-order] Trading pair ${order.pairId} not found.`);
      return false;
    }

    // Convert pair amounts to BigInt for validation
    const pair = convertToBigInt<TradingPair>(pairDB, NUMERIC_FIELDS_PAIR);

    // Validate price tick size for limit orders
    if (order.type === OrderType.LIMIT && order.price) {
      if (order.price % pair.tickSize !== BigInt(0)) {
        logger.warn(`[market-place-order] Price ${order.price} does not conform to tick size ${pair.tickSize}.`);
        return false;
      }
    }

    // Validate quantity lot size
    if (order.quantity % pair.lotSize !== BigInt(0)) {
      logger.warn(`[market-place-order] Quantity ${order.quantity} does not conform to lot size ${pair.lotSize}.`);
      return false;
    }

    // Validate minimum notional value for limit orders
    if (order.type === OrderType.LIMIT && order.price) {
      const notionalValue = order.quantity * order.price;
      if (notionalValue < pair.minNotional) {
        logger.warn(`[market-place-order] Order value ${notionalValue} is below minimum notional ${pair.minNotional}.`);
        return false;
      }
    }

    // Validate trade amount limits
    if (order.type === OrderType.LIMIT && order.price) {
      const tradeAmount = order.quantity * order.price;
      if (tradeAmount < pair.minTradeAmount || tradeAmount > pair.maxTradeAmount) {
        logger.warn(`[market-place-order] Trade amount ${tradeAmount} is outside allowed range [${pair.minTradeAmount}, ${pair.maxTradeAmount}].`);
        return false;
      }
    }

    const account = await getAccount(sender);
    if (!account) {
      logger.warn(`[market-place-order] Account ${sender} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[market-place-order] Error validating order for pair ${data.pairId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: OrderDB, sender: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for processing
    const order = convertToBigInt<Order>(data, NUMERIC_FIELDS_ORDER);

    const pairDB = await cache.findOnePromise('tradingPairs', { _id: order.pairId }) as TradingPairDB | null;
    if (!pairDB) {
      logger.error(`[market-place-order] CRITICAL: Trading pair ${order.pairId} not found during processing.`);
      return false;
    }

    // Convert pair amounts to BigInt for processing
    const pair = convertToBigInt<TradingPair>(pairDB, NUMERIC_FIELDS_PAIR);

    // Create the order document with proper padding for amounts
    const newOrder: Order = {
      _id: generateOrderId(),
      userId: sender,
      pairId: order.pairId,
      baseAssetSymbol: pair.baseAssetSymbol,
      baseAssetIssuer: pair.baseAssetIssuer,
      quoteAssetSymbol: pair.quoteAssetSymbol,
      quoteAssetIssuer: pair.quoteAssetIssuer,
      type: order.type,
      side: order.side,
      status: OrderStatus.OPEN,
      price: order.price,
      quantity: order.quantity,
      filledQuantity: BigInt(0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      timeInForce: order.timeInForce || 'GTC'
    };

    // Calculate and escrow the required amount
    let escrowAmount = BigInt(0);
    let tokenIdentifier = '';

    if (order.side === OrderSide.BUY) {
      if (order.type === OrderType.LIMIT && order.price) {
        escrowAmount = order.quantity * order.price;
        tokenIdentifier = `${pair.quoteAssetSymbol}@${pair.quoteAssetIssuer}`;
      } else if (order.type === OrderType.MARKET && order.quoteOrderQty) {
        escrowAmount = order.quoteOrderQty;
        tokenIdentifier = `${pair.quoteAssetSymbol}@${pair.quoteAssetIssuer}`;
      }
    } else {
      escrowAmount = order.quantity;
      tokenIdentifier = `${pair.baseAssetSymbol}@${pair.baseAssetIssuer}`;
    }

    // Convert order to DB format with proper padding for all numeric fields
    const newOrderDB = convertToString(newOrder, NUMERIC_FIELDS_ORDER);

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
      logger.error('[market-place-order] Failed to insert order. Aborting.');
      return false;
    }

    logger.debug(`[market-place-order] Order ${newOrder._id} placed for pair ${order.pairId} by ${sender}. Type: ${order.type}, Side: ${order.side}, Quantity: ${order.quantity}, Price: ${order.price?.toString() || 'MARKET'}`);

    const eventDocument = {
      type: 'orderPlaced',
      actor: sender,
      data: {
        orderId: newOrder._id,
        pairId: order.pairId,
        orderType: order.type,
        side: order.side,
        quantity: order.quantity.toString(),
        price: order.price?.toString()
      }
    };

    await new Promise<void>((resolve) => {
      cache.insertOne('events', eventDocument, (err, result) => {
        if (err || !result) {
          logger.error(`[market-place-order] CRITICAL: Failed to log orderPlaced event for ${newOrder._id}: ${err || 'no result'}.`);
        }
        resolve();
      });
    });

    return true;
  } catch (error) {
    logger.error(`[market-place-order] Error processing order for pair ${data.pairId} by ${sender}: ${error}`);
    return false;
  }
} 