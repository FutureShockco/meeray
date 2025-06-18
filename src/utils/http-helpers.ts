import logger from '../logger.js';
import { toBigInt, formatTokenAmount, getTokenDecimals } from './bigint-utils.js';

// Helper to transform numeric string fields in a transaction's data object
export const transformTransactionData = (txData: any): any => {
    if (!txData) return txData;
    const transformedData = { ...txData };
    // Comprehensive list of fields that might need transformation across various transaction types
    const numericFields = [
        'amount', 'fee', 'maxSupply', 'initialSupply', 'currentSupply', 'value', 
        'ask', 'bid', 'price', 'quantity', 'volume', 'low', 'high', 'open', 'close', // market orders/data
        'goal', 'raisedAmount', 'amountContributed', 'tokensAllocated', // launchpad
        'totalStaked', 'rewardRate', 'stakedAmount', 'rewardsEarned', // farms
        'mintPrice', 'royaltyFeeAmount', 'startingPrice', 'currentPrice', 'endingPrice' // NFTs
        // Add other known numeric string fields from various tx data payloads as identified
    ]; 

    for (const field of numericFields) {
        if (transformedData[field] && typeof transformedData[field] === 'string') {
            try {
                transformedData[field] = toBigInt(transformedData[field] as string).toString();
            } catch (e) {
                // Log silently or with lower severity if some fields are expected to not be bigints
                logger.debug(`Failed to transform field ${field} in transaction data: ${transformedData[field]} - ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    // Recursively transform nested structures if known (e.g., orders within a market tx)
    if (transformedData.orders && Array.isArray(transformedData.orders)) { 
        transformedData.orders = transformedData.orders.map((order: any) => transformTransactionData(order));
    }
    // Handle generic params object if it might contain such fields
    if (transformedData.params && typeof transformedData.params === 'object') { 
        transformedData.params = transformTransactionData(transformedData.params); // Recursive call
    }
    // Handle specific nested objects known to contain numeric strings
    if (transformedData.tokenomicsSnapshot && typeof transformedData.tokenomicsSnapshot === 'object') {
        transformedData.tokenomicsSnapshot = transformTransactionData(transformedData.tokenomicsSnapshot);
    }
    if (transformedData.presale && typeof transformedData.presale === 'object') {
        transformedData.presale = transformTransactionData(transformedData.presale);
        if (transformedData.presale.participants && Array.isArray(transformedData.presale.participants)) {
            transformedData.presale.participants = transformedData.presale.participants.map((p:any) => transformTransactionData(p));
        }
    }

    return transformedData;
}; 

/**
 * Formats a token amount for HTTP response with both formatted and raw values
 * @param amount The amount as string or BigInt
 * @param symbol The token symbol to determine decimal places
 * @returns Object with formatted and raw amount
 */
export function formatTokenAmountForResponse(amount: string | bigint | number, symbol: string): {
    amount: string;        // Formatted amount with decimals (e.g., "123.456")
    rawAmount: string;     // Raw amount in smallest units (e.g., "123456000")
} {
    const bigIntAmount = toBigInt(amount);
    const formatted = formatTokenAmount(bigIntAmount, symbol);
    const raw = bigIntAmount.toString();
    
    return {
        amount: formatted,
        rawAmount: raw
    };
}

/**
 * Formats multiple token amounts in an object for HTTP response
 * @param balances Object with token symbols as keys and amounts as values
 * @returns Object with formatted and raw amounts for each token
 */
export function formatTokenBalancesForResponse(balances: Record<string, string | bigint | number>): {
    [symbol: string]: {
        amount: string;
        rawAmount: string;
    };
} {
    const result: any = {};
    
    for (const [symbol, amount] of Object.entries(balances)) {
        result[symbol] = formatTokenAmountForResponse(amount, symbol);
    }
    
    return result;
}

/**
 * Formats a single token amount for simple responses (just formatted value)
 * @param amount The amount as string or BigInt
 * @param symbol The token symbol to determine decimal places
 * @returns Formatted amount string
 */
export function formatTokenAmountSimple(amount: string | bigint | number, symbol: string): string {
    const bigIntAmount = toBigInt(amount);
    return formatTokenAmount(bigIntAmount, symbol);
}

/**
 * Transforms transaction data for HTTP responses
 * @param data The transaction data object
 * @returns Transformed transaction data
 */
export function transformTransactionDataForResponse(data: any): any {
    if (!data) return data;
    
    const transformed = { ...data };
    
    // Handle token amounts in transaction data
    const amountFields = ['amount', 'amountIn', 'amountOut', 'minAmountOut', 'tokenA_amount', 'tokenB_amount', 'lpTokenAmount'];
    const tokenFields = ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'maxSupply', 'currentSupply'];
    
    for (const field of amountFields) {
        if (transformed[field] && typeof transformed[field] === 'string') {
            // For amount fields, we need to know the token symbol
            // This is a simplified approach - in practice, you might need more context
            transformed[field] = toBigInt(transformed[field]).toString();
        }
    }
    
    for (const field of tokenFields) {
        if (transformed[field] && typeof transformed[field] === 'string') {
            transformed[field] = toBigInt(transformed[field]).toString();
        }
    }
    
    return transformed;
} 