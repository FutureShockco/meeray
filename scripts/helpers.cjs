const { Client, PrivateKey } = require('dsteem');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const ACCOUNTS_FILE_PATH = path.join(__dirname, 'accounts_steem.json');

// Token name components for random generation
const TOKEN_ADJECTIVES = [
    'Super', 'Mega', 'Hyper', 'Ultra', 'Power', 'Epic', 'Magic', 'Cosmic',
    'Crystal', 'Golden', 'Silver', 'Diamond', 'Ruby', 'Emerald', 'Quantum',
    'Digital', 'Cyber', 'Tech', 'Smart', 'Future'
];

const TOKEN_NOUNS = [
    'Coin', 'Token', 'Cash', 'Money', 'Gold', 'Credit', 'Points', 'Stars',
    'Gems', 'Bits', 'Bytes', 'Chain', 'Link', 'Block', 'Net', 'Web',
    'Cloud', 'Data', 'Share', 'Unit'
];

// NFT Collection name components
const NFT_COLLECTION_THEMES = [
    'Crypto', 'Digital', 'Pixel', 'Virtual', 'Meta', 'Cyber', 'Future', 'Retro',
    'Space', 'Fantasy', 'Tech', 'Art', 'Gaming', 'Collectible', 'Rare'
];

const NFT_COLLECTION_TYPES = [
    'Heroes', 'Legends', 'Warriors', 'Creatures', 'Worlds', 'Realms', 'Artifacts',
    'Cards', 'Items', 'Treasures', 'Pets', 'Avatars', 'Lands', 'Assets', 'Gems'
];

// Pool name components for random generation
const POOL_TOKEN_SYMBOLS = [
    'BTC', 'ETH', 'USDT', 'BNB', 'SOL', 'ADA', 'DOT', 'AVAX', 'MATIC',
    'LINK', 'UNI', 'AAVE', 'SNX', 'SUSHI', 'YFI', 'COMP', 'MKR', 'BAL'
];

// Market order types and sides
const MARKET_ORDER_TYPES = ['limit', 'market'];
const MARKET_ORDER_SIDES = ['buy', 'sell'];

// Farm configuration options
const FARM_TYPES = ['TOKEN', 'LP_TOKEN'];
const REWARD_INTERVALS = [
    3600,      // 1 hour
    86400,     // 1 day
    604800,    // 1 week
    2592000    // 30 days
];

// Launchpad configuration options
const LAUNCHPAD_PHASES = ['SEED', 'PRIVATE', 'PUBLIC'];
const LAUNCHPAD_DURATIONS = [
    86400,     // 1 day
    172800,    // 2 days
    259200,    // 3 days
    432000,    // 5 days
    604800     // 7 days
];

function getRandomElement(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function generateRandomTokenData() {
    const adjective = getRandomElement(TOKEN_ADJECTIVES);
    const noun = getRandomElement(TOKEN_NOUNS);
    const name = `${adjective} ${noun}`;
    // Create symbol from initials, add random number, max 8 chars
    const symbol = `${adjective.substring(0, 1)}${noun.substring(0, 1)}${Math.floor(Math.random() * 1000)}`;

    return {
        name,
        symbol: symbol.toUpperCase(),
        precision: Math.floor(Math.random() * 8) + 1, // 1-8 decimals
        maxSupply: BigInt(100000000000).toString(), // 100M-1B
        initialSupply: BigInt(0).toString(), // 1M-11M
        description: `${name} - A revolutionary digital asset`,
        logoUrl: `https://example.com/tokens/${symbol.toLowerCase()}.png`,
        websiteUrl: `https://example.com/tokens/${symbol.toLowerCase()}`
    };
}

function generateRandomNFTCollectionData() {
    const theme = getRandomElement(NFT_COLLECTION_THEMES);
    const type = getRandomElement(NFT_COLLECTION_TYPES);
    const name = `${theme} ${type}`;
    const symbol = `${theme.substring(0, 1)}${type.substring(0, 1)}${Math.floor(Math.random() * 1000)}`;

    return {
        name,
        symbol: symbol.toUpperCase(),
        description: `${name} - A unique digital collectibles series`,
        logoUrl: `https://example.com/nft/${symbol.toLowerCase()}.png`,
        websiteUrl: `https://example.com/nft/${symbol.toLowerCase()}`,
        maxSupply: Math.floor(Math.random() * 9000) + 1000, // 1000-10000
        metadata: {
            properties: {
                rarity: ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'],
                attributes: ['Strength', 'Speed', 'Magic', 'Intelligence', 'Luck']
            }
        }
    };
}

function generateRandomPoolData() {
    // Get two different random tokens
    const tokenAIndex = Math.floor(Math.random() * POOL_TOKEN_SYMBOLS.length);
    let tokenBIndex;
    do {
        tokenBIndex = Math.floor(Math.random() * POOL_TOKEN_SYMBOLS.length);
    } while (tokenBIndex === tokenAIndex);

    return {
        tokenA_symbol: POOL_TOKEN_SYMBOLS[tokenAIndex],
        tokenA_issuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
        tokenB_symbol: POOL_TOKEN_SYMBOLS[tokenBIndex],
        tokenB_issuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer'
    };
}

function generateRandomPoolOperation() {
    // Generate random amounts between 1 and 1000 as whole numbers
    const amount = BigInt(Math.floor(Math.random() * 999) + 1);

    return {
        amount: amount.toString(),
        minAmountOut: (amount * BigInt(99) / BigInt(100)).toString(), // 1% slippage
        maxPrice: (amount * BigInt(101) / BigInt(100)).toString(),    // 1% price impact
    };
}

function generateRandomMarketPairData() {
    // Get two different random tokens for the pair
    const tokenAIndex = Math.floor(Math.random() * POOL_TOKEN_SYMBOLS.length);
    let tokenBIndex;
    do {
        tokenBIndex = Math.floor(Math.random() * POOL_TOKEN_SYMBOLS.length);
    } while (tokenBIndex === tokenAIndex);

    return {
        baseSymbol: POOL_TOKEN_SYMBOLS[tokenAIndex],
        baseIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
        quoteSymbol: POOL_TOKEN_SYMBOLS[tokenBIndex],
        quoteIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer'
    };
}

function generateRandomMarketOrder() {
    const orderType = getRandomElement(MARKET_ORDER_TYPES);
    const orderSide = getRandomElement(MARKET_ORDER_SIDES);
    // Generate amount and price as whole numbers then convert to string for BigInt compatibility
    const amount = BigInt(Math.floor(Math.random() * 999) + 1); // Example: 1 to 1000 units
    const price = BigInt(Math.floor(Math.random() * 99) + 1);   // Example: 1 to 100 price units

    return {
        type: orderType,
        side: orderSide,
        amount: amount.toString(),
        price: orderType === 'limit' ? price.toString() : undefined,
        minAmountOut: orderType === 'market' ? (amount * BigInt(99) / BigInt(100)).toString() : undefined // 1% slippage for market orders
    };
}

function generateRandomFarmData() {
    const farmType = getRandomElement(FARM_TYPES);
    const rewardInterval = getRandomElement(REWARD_INTERVALS);

    // Get random tokens for staking and rewards
    const stakingTokenIndex = Math.floor(Math.random() * POOL_TOKEN_SYMBOLS.length);
    let rewardTokenIndex;
    do {
        rewardTokenIndex = Math.floor(Math.random() * POOL_TOKEN_SYMBOLS.length);
    } while (rewardTokenIndex === stakingTokenIndex);

    return {
        farmType,
        stakingTokenSymbol: POOL_TOKEN_SYMBOLS[stakingTokenIndex],
        stakingTokenIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
        rewardTokenSymbol: POOL_TOKEN_SYMBOLS[rewardTokenIndex],
        rewardTokenIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
        rewardPerBlock: (BigInt(Math.floor(Math.random() * 10) + 1)).toString(), // represent as integer
        rewardInterval,
        multiplier: Math.floor(Math.random() * 5) + 1, // 1-5x multiplier
        maxStakingAmount: (BigInt(Math.floor(Math.random() * 1000000) + 10000)).toString()
    };
}

function generateRandomFarmOperation() {
    // Generate random amount between 1 and 1000 as whole numbers
    const amount = BigInt(Math.floor(Math.random() * 999) + 1);

    return {
        amount: amount.toString()
    };
}

function generateRandomLaunchpadData() {
    // Generate random token data for the launch
    const tokenData = generateRandomTokenData();
    const phase = getRandomElement(LAUNCHPAD_PHASES);
    const duration = getRandomElement(LAUNCHPAD_DURATIONS);

    return {
        tokenSymbol: tokenData.symbol,
        tokenName: tokenData.name,
        tokenPrecision: tokenData.precision,
        tokenMaxSupply: tokenData.maxSupply,
        tokenInitialSupply: tokenData.initialSupply,
        description: tokenData.description,
        logoUrl: tokenData.logoUrl,
        websiteUrl: tokenData.websiteUrl,
        phase,
        duration,
        startBlock: Math.floor(Date.now() / 3000), // Approximate current block
        softCap: (BigInt(Math.floor(Math.random() * 100000) + 10000)).toString(),
        hardCap: (BigInt(Math.floor(Math.random() * 1000000) + 100000)).toString(),
        tokenPrice: (BigInt(Math.floor(Math.random() * 10) + 1)).toString(), // represent as integer, precision will define decimals
        minInvestment: (BigInt(Math.floor(Math.random() * 100) + 10)).toString(),
        maxInvestment: (BigInt(Math.floor(Math.random() * 10000) + 1000)).toString(),
        vestingSchedule: [
            {
                percentage: 20,
                releaseBlock: Math.floor(Date.now() / 3000) + 100000
            },
            {
                percentage: 40,
                releaseBlock: Math.floor(Date.now() / 3000) + 200000
            },
            {
                percentage: 40,
                releaseBlock: Math.floor(Date.now() / 3000) + 300000
            }
        ]
    };
}

function generateRandomLaunchpadOperation() {
    // Generate random investment amount between min and max
    const amount = BigInt(Math.floor(Math.random() * 999) + 1);

    return {
        amount: amount.toString()
    };
}

async function getClient() {
    const STEEM_API_URL = process.env.STEEM_API_URL || 'https://api.steemit.com';
    const SSC_ID = process.env.SSC_ID || 'sidechain';

    const CLIENT_OPTIONS = {};
    if (process.env.CHAIN_ID) CLIENT_OPTIONS.chainId = process.env.CHAIN_ID;
    if (process.env.ADDRESS_PREFIX) CLIENT_OPTIONS.addressPrefix = process.env.ADDRESS_PREFIX;

    return {
        client: new Client(STEEM_API_URL, CLIENT_OPTIONS),
        sscId: SSC_ID
    };
}

async function getGlobalProperties(client) {
    const result = await client.database.getDynamicGlobalProperties();
    return result;
}

async function getRandomAccount() {
    try {
        const accountsFileContent = fs.readFileSync(ACCOUNTS_FILE_PATH, 'utf8');
        const accounts = JSON.parse(accountsFileContent);
        const randomIndex = Math.floor(Math.random() * accounts.length);
        const selectedAccount = accounts[randomIndex];

        if (!selectedAccount) {
            throw new Error('No account found in accounts_steem.json');
        }
        if (!selectedAccount.private_keys || !selectedAccount.private_keys.active) {
            throw new Error(`Active key for account "${selectedAccount.account_name}" not found`);
        }

        return {
            username: selectedAccount.account_name,
            privateKey: PrivateKey.fromString(selectedAccount.private_keys.active)
        };
    } catch (err) {
        console.error(`Error loading account data: ${err.message}`);
        process.exit(1);
    }
}

async function getMasterAccount() {
    try {
        let privateKeys;
        try {
            // Load private keys from external file that will be gitignored
            const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
            privateKeys = JSON.parse(keysFile);
        } catch (err) {
            console.error('Error loading keys.json file:', err);
            process.exit(1);
        }

        return {
            username: 'echelon-node1',
            privateKey: PrivateKey.fromString(privateKeys[0])
        };
    } catch (err) {
        console.error(`Error loading account data: ${err.message}`);
        process.exit(1);
    }
}

// Helper for broadcasting custom_json operations
async function sendCustomJson(client, sscId, contractAction, payload, username, privateKey) {
    const operation = ['custom_json', {
        required_auths: [username],
        required_posting_auths: [],
        id: sscId,
        json: JSON.stringify({
            contract: contractAction,
            payload: payload
        })
    }];

    try {
        console.log(`Broadcasting ${contractAction} with payload:`, JSON.stringify(payload, null, 2));
        const result = await client.broadcast.sendOperations([operation], privateKey);
        console.log(`${contractAction} successful: TX ID ${result.id}`);
        console.log(result.block_num);
        return result;
    } catch (error) {
        console.error(`Error in ${contractAction}:`, error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', error.data.stack);
        }
        throw error;
    }
}

// Helper for broadcasting custom_json operations
async function transfer(client, from, to, amount, username, privateKey) {
    const operation = ['transfer', {
        required_auths: [username],
        required_posting_auths: [],
        from,
        to,
        amount,
        memo: 'Deposit from Steem'
    }];

    try {
        console.log(`Broadcasting transfer from ${from} to ${to} with amount: ${amount}`);
        const result = await client.broadcast.sendOperations([operation], privateKey);
        console.log(`Transfer successful: TX ID ${result.id}`);
        console.log(result.block_num);
        return result;
    } catch (error) {
        console.error(`Error in transfer:`, error);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', error.data.stack);
        }
        throw error;
    }
}

function generatePoolId(tokenA_symbol, tokenB_symbol) {
    // Ensure canonical order to prevent duplicate pools (e.g., A-B vs B-A)
    const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
    return `${token1}_${token2}`;
  }

module.exports = {
    getClient,
    getGlobalProperties,
    getRandomAccount,
    getMasterAccount,
    generateRandomTokenData,
    generateRandomNFTCollectionData,
    generateRandomPoolData,
    generateRandomPoolOperation,
    generateRandomMarketPairData,
    generateRandomMarketOrder,
    generateRandomFarmData,
    generateRandomFarmOperation,
    generateRandomLaunchpadData,
    generateRandomLaunchpadOperation,
    sendCustomJson,
    transfer,
    generatePoolId
}; 