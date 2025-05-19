import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { MarketPlaceOrderData, Order, TradingPair, OrderStatus, OrderType, OrderSide } from './market-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js';
import { matchingEngine } from './matching-engine.js'; // Will be created later
import crypto from 'crypto';

// Placeholder for generating unique order IDs
function generateOrderId(): string {
  return crypto.randomBytes(16).toString('hex'); // Example: 32-char hex string
}

// AccountBalance interface removed as userAccount.balances is a map { [tokenIdentifier: string]: number }

export async function validateTx(data: MarketPlaceOrderData, sender: string): Promise<boolean> {
  logger.debug(`[market-place-order] Validating order from ${sender}: ${JSON.stringify(data)}`);

  if (sender !== data.userId) {
    logger.warn('[market-place-order] Sender must match userId for the order.');
    return false;
  }
  if (!data.pairId || !data.type || !data.side || typeof data.quantity !== 'number') {
    logger.warn('[market-place-order] Missing required fields: pairId, type, side, quantity.');
    return false;
  }

  const tradingPair = await cache.findOnePromise('tradingPairs', { _id: data.pairId }) as TradingPair | null;
  if (!tradingPair) {
    logger.warn(`[market-place-order] TradingPair ${data.pairId} not found.`);
    return false;
  }
  if (tradingPair.status !== 'TRADING') {
    logger.warn(`[market-place-order] TradingPair ${data.pairId} is not in TRADING status (current: ${tradingPair.status}).`);
    return false;
  }

  // Validate OrderType and associated fields
  if (data.type === OrderType.LIMIT) {
    if (typeof data.price !== 'number' || data.price <= 0) {
      logger.warn('[market-place-order] Price must be a positive number for LIMIT orders.');
      return false;
    }
    // Validate price against tickSize
    if (data.price % tradingPair.tickSize !== 0) {
      logger.warn(`[market-place-order] Price ${data.price} for ${data.pairId} does not adhere to tick size ${tradingPair.tickSize}.`);
      // return false; // Be strict or round? For now, be strict.
    }
  } else if (data.type === OrderType.MARKET) {
    if (data.price !== undefined) {
      logger.warn('[market-place-order] Price should not be provided for MARKET orders.');
      // Potentially ignore it or return false. For now, just a warning, processing might ignore it.
    }
    if (data.side === OrderSide.BUY && data.quoteOrderQty === undefined && data.quantity <=0) {
        logger.warn('[market-place-order] For MARKET BUY, either quantity (base asset) or quoteOrderQty (quote asset to spend) must be positive.');
        return false;
    }
    if (data.side === OrderSide.SELL && data.quantity <=0) {
        logger.warn('[market-place-order] For MARKET SELL, quantity (base asset to sell) must be positive.');
        return false;
    }

  } else {
    logger.warn(`[market-place-order] Unsupported order type: ${data.type}.`);
    return false;
  }

  // Validate quantity against lotSize (stepSize)
  if (data.quantity % tradingPair.lotSize !== 0) {
    logger.warn(`[market-place-order] Quantity ${data.quantity} for ${data.pairId} does not adhere to lot size ${tradingPair.lotSize}.`);
    // return false; // Strict validation
  }
  if (data.quantity <= 0 && (data.type === OrderType.MARKET && data.side === OrderSide.SELL)) {
    logger.warn('[market-place-order] Quantity must be positive.');
    return false;
  }
   if (data.quantity <= 0 && data.type === OrderType.LIMIT) {
    logger.warn('[market-place-order] Quantity must be positive for Limit orders.');
    return false;
  }

  // Validate minNotional if it's a LIMIT order or MARKET SELL (where price is known or quantity is for base)
  if (data.type === OrderType.LIMIT && data.price) {
    if ((data.price * data.quantity) < tradingPair.minNotional) {
      logger.warn(`[market-place-order] Order value (price*quantity) ${data.price * data.quantity} is less than minNotional ${tradingPair.minNotional} for ${data.pairId}.`);
      // return false;
    }
  }
  // For MARKET BUY with quoteOrderQty, minNotional might apply to quoteOrderQty directly.
  if (data.type === OrderType.MARKET && data.side === OrderSide.BUY && data.quoteOrderQty !== undefined) {
      if (data.quoteOrderQty < tradingPair.minNotional) {
          logger.warn(`[market-place-order] QuoteOrderQty ${data.quoteOrderQty} is less than minNotional ${tradingPair.minNotional} for ${data.pairId}.`);
          // return false;
      }
  }

  // Check user account and balance
  const userAccount = await getAccount(data.userId);
  if (!userAccount) {
    logger.warn(`[market-place-order] User account ${data.userId} not found.`);
    return false;
  }

  // Balance check: depends on order side
  let requiredAssetSymbol: string | undefined;
  let requiredAssetIssuer: string | undefined;
  let requiredAmount: number | undefined;

  if (data.side === OrderSide.BUY) {
    requiredAssetSymbol = tradingPair.quoteAssetSymbol;
    requiredAssetIssuer = tradingPair.quoteAssetIssuer;
    if (data.type === OrderType.LIMIT && typeof data.price === 'number') {
      requiredAmount = data.quantity * data.price;
    } else if (data.type === OrderType.MARKET && typeof data.quoteOrderQty === 'number') {
      requiredAmount = data.quoteOrderQty;
    } else {
      // For market buy with base quantity, it's tricky to pre-calculate exact quote needed due to slippage.
      // System might reserve a bit more or rely on post-trade settlement adjustments.
      // For now, we will skip strict balance check for this specific market buy case in validation,
      // assuming matching engine will handle it. Or, could require a max spend limit.
      logger.debug('[market-place-order] Market BUY by base quantity - precise pre-check for quote balance is complex.');
      // A practical approach is to check if they have *some* quote balance, or a reasonable amount.
      // Or, the matching engine must not fill more than their available quote balance.
    }
  } else { // SELL order
    requiredAssetSymbol = tradingPair.baseAssetSymbol;
    requiredAssetIssuer = tradingPair.baseAssetIssuer;
    requiredAmount = data.quantity; // Total base asset needed
  }

  if (requiredAmount !== undefined && requiredAssetSymbol !== undefined && requiredAssetIssuer !== undefined) {
      const tokenIdentifier = `${requiredAssetSymbol}@${requiredAssetIssuer}`;
      const userBalanceAmount = userAccount.balances[tokenIdentifier];
      if (userBalanceAmount === undefined || userBalanceAmount < requiredAmount) {
        logger.warn(`[market-place-order] Insufficient balance for ${data.userId}. Needs ${requiredAmount} ${tokenIdentifier}, has ${userBalanceAmount || 0}.`);
        return false;
      }
  } else if (requiredAmount !== undefined && (requiredAssetSymbol === undefined || requiredAssetIssuer === undefined) ){
    // This case implies a market buy by base quantity where we decided not to do a strict balance check earlier.
    // Or some other logic error if symbol/issuer are not defined when amount is.
    logger.debug('[market-place-order] Skipping strict balance check due to undefined asset details for required amount or market buy by base quantity.');
  }

  logger.info('[market-place-order] Validation successful.');
  return true;
}

export async function process(data: MarketPlaceOrderData, sender: string): Promise<boolean> {
  logger.info(`[market-place-order] Processing order from ${sender}: ${JSON.stringify(data)}`);
  try {
    const tradingPair = await cache.findOnePromise('tradingPairs', { _id: data.pairId }) as TradingPair | null;
    if (!tradingPair) { // Should be caught by validation, but good to double check
        logger.error(`[market-place-order] CRITICAL: TradingPair ${data.pairId} not found during processing.`);
        return false;
    }

    const orderId = generateOrderId();
    const now = new Date().toISOString();

    const order: Order = {
      _id: orderId,
      userId: data.userId,
      pairId: data.pairId,
      baseAssetSymbol: tradingPair.baseAssetSymbol,
      quoteAssetSymbol: tradingPair.quoteAssetSymbol,
      type: data.type,
      side: data.side,
      price: data.type === OrderType.LIMIT ? data.price : undefined,
      quantity: data.quantity,
      quoteOrderQty: data.type === OrderType.MARKET && data.side === OrderSide.BUY ? data.quoteOrderQty : undefined,
      filledQuantity: 0,
      status: OrderStatus.OPEN, // Initial status, matching engine might change it immediately
      createdAt: now,
      updatedAt: now,
      timeInForce: data.timeInForce || 'GTC', // Default to GTC
    };

    // Escrow funds (lock balance for the order)
    let escrowAssetSymbol: string | undefined;
    let escrowAssetIssuer: string | undefined;
    let escrowAmount: number | undefined;

    if (order.side === OrderSide.BUY) {
      escrowAssetSymbol = tradingPair.quoteAssetSymbol;
      escrowAssetIssuer = tradingPair.quoteAssetIssuer;
      if (order.type === OrderType.LIMIT && typeof order.price === 'number') {
        escrowAmount = order.quantity * order.price;
      } else if (order.type === OrderType.MARKET && typeof order.quoteOrderQty === 'number') {
        escrowAmount = order.quoteOrderQty;
      } else {
        // For market BUY with base quantity, escrowing is complex without knowing execution price.
        // A common strategy is to NOT escrow here, but ensure matching engine does not overspend user's available quote balance.
        // Or escrow a maximum possible amount if a 'maxSlippage' or 'worstPrice' is determined.
        // For now, we'll assume the matching engine will handle this carefully.
        logger.info(`[market-place-order] Market BUY for ${order.quantity} ${order.baseAssetSymbol} - escrow of quote asset handled by matching or requires max spend.`);
        // Not adjusting balance here; matching engine must ensure funds.
      }
    } else { // SELL order
      escrowAssetSymbol = tradingPair.baseAssetSymbol;
      escrowAssetIssuer = tradingPair.baseAssetIssuer;
      escrowAmount = order.quantity;
    }

    if (escrowAmount !== undefined && escrowAssetSymbol !== undefined && escrowAssetIssuer !== undefined) {
        const tokenIdentifier = `${escrowAssetSymbol}@${escrowAssetIssuer}`;
        const balanceAdjusted = await adjustBalance(sender, tokenIdentifier, -escrowAmount);
        if (!balanceAdjusted) {
            logger.error(`[market-place-order] Failed to escrow ${escrowAmount} ${tokenIdentifier} for order ${orderId}.`);
            // No need to change order status yet, as it hasn't been submitted to matching engine.
            return false; // Abort before submitting to matching engine
        }
    }

    // Submit to matching engine
    // The matchingEngine.addOrder will handle persistence of the order itself if it's accepted.
    // It will also return outcomes like immediate fills, partial fills, or just accepted to book.
    const matchResult = await matchingEngine.addOrder(order);

    if (!matchResult.accepted) {
        logger.warn(`[market-place-order] Order ${orderId} rejected by matching engine. Reason: ${matchResult.rejectReason}`);
        // Rollback escrow if funds were held
        if (escrowAmount !== undefined && escrowAssetSymbol !== undefined && escrowAssetIssuer !== undefined) {
            const tokenIdentifier = `${escrowAssetSymbol}@${escrowAssetIssuer}`;
            await adjustBalance(sender, tokenIdentifier, escrowAmount);
        }
        return false;
    }

    // Order accepted, potentially partially or fully filled. `matchResult` would contain details of trades.
    // The matching engine is responsible for updating order status (OPEN, PARTIALLY_FILLED, FILLED)
    // and creating Trade documents. It should also update involved user balances for fills.

    logger.info(`[market-place-order] Order ${orderId} (${order.side} ${order.quantity} ${order.baseAssetSymbol} @ ${order.price || 'MARKET'}) processed. Engine response: ${JSON.stringify(matchResult)}`);

    // Event logging for order placement (even if not immediately filled, it's an intent)
    const eventDocument = {
      type: 'marketPlaceOrder',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: { ...order, status: matchResult.order.status || order.status } // Use status from matching engine's order object
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[market-place-order] CRITICAL: Failed to log marketPlaceOrder event for ${orderId}: ${err || 'no result'}.`);
            }
            resolve();
        });
    });

    return true;
  } catch (error) {
    logger.error(`[market-place-order] Error processing order placement by ${sender}: ${error}`);
    return false;
  }
} 