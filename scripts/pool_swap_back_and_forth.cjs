/**
 * Pool Swap Back-and-Forth Script
 * 
 * This script performs alternating swaps between two configurable tokens
 * to demonstrate the impact of the 0.3% trading fees over multiple trades.
 * 
 * Configuration (edit constants below):
 * - TOKEN_A & TOKEN_B: The token pair to swap between
 * - INITIAL_AMOUNT: Starting amount of TOKEN_A
 * - TOTAL_SWAPS: Number of swaps to perform
 * - SLIPPAGE_PERCENT: Slippage tolerance
 * 
 * Features:
 * - Uses real quotes from the MeeRay API (https://api.meeray.com)
 * - Gets accurate swap amounts and routes for each trade
 * - Accounts for 0.3% fees and slippage protection
 * - Tracks total value loss due to fees over multiple swaps
 * - Provides detailed logging with price impact information
 * 
 * Requirements:
 * - Node.js 18+ (for built-in fetch support)
 * - Active internet connection to call MeeRay API
 * 
 * Expected behavior: Amount decreases with each swap due to fees
 */

const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');

// Configuration
const MEERAY_API_BASE = 'https://api.meeray.com';
const TOKEN_A = 'MRY';
const TOKEN_B = 'TESTS';
const INITIAL_AMOUNT = '1.0'; // 1.0 TOKEN_A (user-friendly format for API)
const SLIPPAGE_PERCENT = 1;
const TOTAL_SWAPS = 20;

/**
 * Converts raw amount (smallest units) to user-friendly format for API calls
 * The API expects user-friendly amounts (like "1.5") and returns raw amounts for transactions
 * Assumes 8 decimals for most tokens (MRY default)
 */
function formatAmountForAPI(rawAmount, tokenSymbol) {
    const decimals = 8; // Default decimals for most tokens including MRY
    const amount = BigInt(rawAmount);
    const divisor = BigInt(10 ** decimals);
    const integerPart = amount / divisor;
    const decimalPart = amount % divisor;
    
    if (decimalPart === 0n) {
        return integerPart.toString();
    }
    
    const decimalStr = decimalPart.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${integerPart}.${decimalStr}`;
}

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ for built-in fetch support.');
    console.error('   Please upgrade Node.js or install node-fetch: npm install node-fetch');
    process.exit(1);
}

/**
 * Gets a swap quote from the MeeRay API
 */
async function getSwapQuote(fromToken, toToken, amountIn, slippagePercent = SLIPPAGE_PERCENT) {
    try {
        const response = await fetch(`${MEERAY_API_BASE}/pools/route-swap`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                fromTokenSymbol: fromToken,
                toTokenSymbol: toToken,
                amountIn: amountIn,
                slippage: slippagePercent
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorData}`);
        }

        const data = await response.json();
        return data.bestRoute;
    } catch (error) {
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            throw new Error(`Network error: Cannot connect to MeeRay API. Please check your internet connection.`);
        }
        throw error;
    }
}

async function performSwap(client, sscId, username, privateKey, fromToken, toToken, amountIn, swapNumber) {
    console.log(`\n=== SWAP ${swapNumber}: ${fromToken} → ${toToken} ===`);
    console.log(`💰 Amount In: ${amountIn} ${fromToken}`);
    console.log(`🔍 Getting quote from MeeRay API...`);

    try {
        // Get real quote from API (pass user-friendly amount)
        const quote = await getSwapQuote(fromToken, toToken, amountIn);
        
        const swapData = {
            tokenIn_symbol: fromToken,
            tokenOut_symbol: toToken,
            amountIn: quote.finalAmountIn, // Raw amount in smallest units
            minAmountOut: quote.minFinalAmountOut, // Raw amount in smallest units  
            slippagePercent: SLIPPAGE_PERCENT,
            hops: quote.hops.map(hop => ({
                poolId: hop.poolId,
                tokenIn_symbol: hop.tokenIn,
                tokenOut_symbol: hop.tokenOut,
                amountIn: hop.amountIn, // Raw amount in smallest units
                minAmountOut: hop.minAmountOut // Raw amount in smallest units
            }))
        };

        console.log(`📊 API Quote:`);
        console.log(`   Expected Out: ${quote.finalAmountOutFormatted || quote.finalAmountOut} ${toToken}`);
        console.log(`   Min Amount Out: ${quote.minFinalAmountOutFormatted || quote.minFinalAmountOut} ${toToken}`);
        console.log(`   Price Impact: ${quote.totalPriceImpactFormatted || quote.totalPriceImpact}`);
        console.log(`   Route: ${quote.hops.length} hop(s)`);

        const result = await sendCustomJson(
            client,
            sscId,
            'pool_swap',
            swapData,
            username,
            privateKey
        );
        console.log(`✅ ${fromToken} → ${toToken} swap ${swapNumber} successful!`);
        
        // Return formatted amount for next API call (use API's formatted version if available)
        return quote.finalAmountOutFormatted || formatAmountForAPI(quote.finalAmountOut, toToken);
    } catch (error) {
        console.error(`❌ ${fromToken} → ${toToken} swap ${swapNumber} failed:`, error.message);
        throw error;
    }
}

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    console.log(`🔄 Starting ${TOTAL_SWAPS} back-and-forth pool swaps with account: ${username}`);
    console.log(`📊 Trade route: ${TOKEN_A} ⇄ ${TOKEN_B} (${TOTAL_SWAPS} swaps total)`);
    console.log('💡 Each swap applies 0.3% fees, so amounts will decrease over time');
    console.log('🌐 Using real quotes from MeeRay API at https://api.meeray.com');

    let currentAmount = INITIAL_AMOUNT;
    let currentToken = TOKEN_A; // Track which token we currently have
    
    console.log(`\n🚀 Starting with ${INITIAL_AMOUNT} ${TOKEN_A}`);

    try {
        for (let i = 1; i <= TOTAL_SWAPS; i++) {
            if (currentToken === TOKEN_A) {
                // Swap TOKEN_A to TOKEN_B
                currentAmount = await performSwap(client, sscId, username, privateKey, TOKEN_A, TOKEN_B, currentAmount, i);
                currentToken = TOKEN_B;
            } else {
                // Swap TOKEN_B to TOKEN_A
                currentAmount = await performSwap(client, sscId, username, privateKey, TOKEN_B, TOKEN_A, currentAmount, i);
                currentToken = TOKEN_A;
            }
            
            console.log(`📈 Current holding: ${currentAmount} ${currentToken}`);
            
            // Add delay between swaps to ensure transaction processing
            if (i < TOTAL_SWAPS) {
                console.log(`⏳ Waiting 3 seconds before next swap...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        
        // Calculate total loss due to fees
        // If we ended with TOKEN_B, get current quote to TOKEN_A for comparison
        let finalAmountInTokenA = parseFloat(currentAmount);
        if (currentToken === TOKEN_B) {
            try {
                console.log(`\n💱 Getting final conversion quote ${TOKEN_B} → ${TOKEN_A} for loss calculation...`);
                const finalQuote = await getSwapQuote(TOKEN_B, TOKEN_A, currentAmount);
                finalAmountInTokenA = parseFloat(finalQuote.finalAmountOutFormatted || formatAmountForAPI(finalQuote.finalAmountOut, TOKEN_A));
                console.log(`   Final ${currentAmount} ${TOKEN_B} = ${finalAmountInTokenA} ${TOKEN_A}`);
            } catch (error) {
                console.warn(`   Could not get final conversion quote: ${error.message}`);
                console.log(`   Using raw ${TOKEN_B} amount for loss calculation (may not be accurate)`);
            }
        }
        
        const initialAmountFloat = parseFloat(INITIAL_AMOUNT);
        const totalLoss = initialAmountFloat - finalAmountInTokenA;
        const lossPercentage = (totalLoss / initialAmountFloat) * 100;
        
        console.log(`\n🎉 ${TOTAL_SWAPS}-swap sequence completed successfully!`);
        console.log(`\n💰 FINAL RESULTS:`);
        console.log(`   Started with: ${INITIAL_AMOUNT} ${TOKEN_A}`);
        console.log(`   Ended with: ${currentAmount} ${currentToken}`);
        if (currentToken === TOKEN_B) {
            console.log(`   ${TOKEN_A} equivalent: ${finalAmountInTokenA.toString()} ${TOKEN_A}`);
        }
        console.log(`   Total loss: ${totalLoss.toFixed(8)} ${TOKEN_A} (${lossPercentage.toFixed(4)}%)`);
        console.log(`   Average loss per swap: ${(lossPercentage / TOTAL_SWAPS).toFixed(4)}%`);
        
    } catch (error) {
        console.error('\n💥 Swap sequence failed:', error.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
});
