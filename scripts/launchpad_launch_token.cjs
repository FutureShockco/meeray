const { Client, PrivateKey } = require('dsteem');
const fs = require('fs');
const path = require('path');

// Configuration
const STEEM_API_URL = 'https://api.justyy.com';
const KEYS_FILE_PATH = path.join(__dirname, 'keys.json');

// Helper for date strings (e.g., ISO format for startTime, endTime)
const getFutureDateString = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString();
};

async function main() {
    const client = new Client(STEEM_API_URL);
    let privateKeysData;
    try {
        const keysFileContent = fs.readFileSync(KEYS_FILE_PATH, 'utf8');
        privateKeysData = JSON.parse(keysFileContent);
        if (!privateKeysData || !Array.isArray(privateKeysData) || privateKeysData.length === 0) {
            console.error('Error: keys.json is missing, empty, or not an array.');
            process.exit(1);
        }
    } catch (err) {
        console.error(`Error loading or parsing ${KEYS_FILE_PATH}:`, err.message);
        process.exit(1);
    }

    const signingPrivateKeyString = privateKeysData[0]; // echelon-curie's active key
    const userIdAccount = 'echelon-curie'; 
    const feeTokenIssuer = 'echelon-fee-token-issuer'; // Placeholder for fee token issuer

    const tokenomicsData = {
        totalSupply: 100000000, // 100 Million
        tokenDecimals: 6,
        allocations: [
            { recipient: "PROJECT_TEAM", percentage: 15, lockupMonths: 6, vestingSchedule: { type: "LINEAR_MONTHLY", durationMonths: 24, cliffMonths: 6 } },
            { recipient: "PRESALE_INVESTORS", percentage: 30 },
            { recipient: "LIQUIDITY_POOL", percentage: 25 },
            { recipient: "ECOSYSTEM_FUND", percentage: 20, vestingSchedule: { type: "LINEAR_MONTHLY", durationMonths: 36 } },
            { recipient: "ADVISORS", percentage: 10, lockupMonths: 3, vestingSchedule: { type: "LINEAR_MONTHLY", durationMonths: 12, cliffMonths: 3 } }
        ]
    };

    const presaleDetailsData = {
        presaleTokenAllocationPercentage: 30,
        pricePerToken: 0.05, // Price in quote asset
        quoteAssetForPresaleSymbol: "ECHUSD", // Assuming a stablecoin like ECHUSD
        quoteAssetForPresaleIssuer: feeTokenIssuer, // Issuer of the stablecoin
        minContributionPerUser: 50,
        maxContributionPerUser: 5000,
        startTime: getFutureDateString(7),   // 7 days from now
        endTime: getFutureDateString(14),  // 14 days from now
        hardCap: 1000000, // Max to raise in quote asset
        softCap: 250000,
        whitelistRequired: true,
        fcfsAfterReservedAllocation: true
    };

    const liquidityProvisionData = {
        dexIdentifier: "EchelonSwapV1", // Name of the DEX
        liquidityTokenAllocationPercentage: 25,
        quoteAssetForLiquiditySymbol: "ECHUSD",
        quoteAssetForLiquidityIssuer: feeTokenIssuer,
        initialQuoteAmountProvidedByProject: 50000, // Project provides 50k of stablecoin liquidity
        lpTokenLockupMonths: 12
    };

    const launchTokenData = {
        userId: userIdAccount,
        tokenName: "Launchpad Star",
        tokenSymbol: "LPSTR",
        tokenStandard: "NATIVE", // or "WRAPPED_NATIVE_LIKE"
        tokenDescription: "A new token launched via the Echelon Launchpad.",
        tokenLogoUrl: "https://example.com/lpstr.png",
        projectWebsite: "https://launchpadstar.example.com",
        projectSocials: { twitter: "@launchpadstar", telegram: "t.me/launchpadstar" },
        tokenomics: tokenomicsData,
        presaleDetails: presaleDetailsData,
        liquidityProvisionDetails: liquidityProvisionData,
        launchFeeTokenSymbol: "ECH", // Fee paid in native ECH token
        // launchFeeTokenIssuer: "..." // Not needed if native ECH
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [userIdAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'launchpad_launch_token',
                payload: launchTokenData
            })
        }
    ];

    console.log('Attempting to broadcast Launchpad Launch Token operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('Launchpad Launch Token operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting Launchpad Launch Token operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 