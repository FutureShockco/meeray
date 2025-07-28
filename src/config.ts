import { TransactionType } from "./transactions/types.js";

const config = {
  // Protocol/chain constants (do not change via .env)
  chainId: 'sidechain-dev',
  networkName: 'Echelon Devnet',
  nativeToken: 'ECH',
  nativeTokenPrecision: 8,
  originHash: 'e201950993be0e15b14ab19dccb165972ff0ba7ea162c5ad6eec9b5268bce468',
  burnAccountName: 'null',
  tokenCreationFee: 100,
  nftCreationFee: 10,
  tradingFee: 0.0025,
  maxWitnesses: 20,
  masterBalance: '20000000000000000',
  masterName: 'echelon-node1',
  masterPublicKey: 'e27B66QHwRLjnjxi5KAa9G7fLSDajtoB6CxuZ87oTdfS',
  blockTime: 2940, // ms
  syncBlockTime: 1000, // ms
  witnessReward: 100000000, // 1 ECH in smallest units (1 * 10^8)
  farmReward: 100000000, // 1 ECH in smallest units (1 * 10^8)
  steemChainId: '0000000000000000000000000000000000000000000000000000000000000000',
  steemStartBlock: process.env.NODE_ENV === 'development' ? 2272280 : 95762370, // starting Steem block for sidechain
  steemBlockDelay: 1, // blocks - delay between Steem blocks
  steemBlockMaxDelay: 6, // blocks - max delay between Steem blocks
  mongoUri:
    process.env.MONGO_URL && process.env.MONGO_DB
      ? `${process.env.MONGO_URL.replace(/\/$/, '')}/${process.env.MONGO_DB}`
      : 'mongodb://localhost:27017/echelon',
  kafkaBroker: process.env.KAFKA_BROKER || 'host.docker.internal:9092',
  kafkaAdvertisedListener: process.env.KAFKA_ADVERTISED_LISTENER || 'PLAINTEXT://host.docker.internal:9092',
  useNotification: process.env.USE_NOTIFICATION === 'true' || false,
  steemAccount: process.env.STEEM_ACCOUNT || 'echelon-node1',
  steemApi: process.env.STEEM_API ? process.env.STEEM_API.split(',') : ['https://api.steemit.com'],
  peers: process.env.PEERS ? process.env.PEERS.split(',') : [],
  witnessPublicKey: process.env.WITNESS_PUBLIC_KEY || '',
  witnessPrivateKey: process.env.WITNESS_PRIVATE_KEY || '',
  p2pPort: process.env.P2P_PORT ? Number(process.env.P2P_PORT) : 6001,
  apiPort: process.env.API_PORT ? Number(process.env.API_PORT) : 3000,
  logLevel: process.env.LOG_LEVEL || 'debug',
  b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  tokenSymbolAllowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  tokenNameAllowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  tokenNameMaxLength: 50,
  tokenSymbolMaxLength: 10,
  tokenSymbolMinLength: 3,
  tokenPrecisionMax: 18,
  tokenPrecisionMin: 0,
  tokenMinSupply: 1,
  tokenMaxSupply: 1000000000000000000,
  consensusRounds: 2,
  witnesses: 5,
  maxDrift: 30000, // 30 seconds max drift for block timestamp
  maxTokenAmountDigits: 30, // Maximum digits for token amounts
  notifPurge: 1000, // how often to purge old notifications (blocks)
  notifPurgeAfter: 10, // how many purge intervals to keep
  notifMaxMentions: 5, // max mentions per comment
  allowedUsernameChars: 'abcdefghijklmnopqrstuvwxyz0123456789.-',
  maxTxPerBlock: 1000, // Added for block validation compatibility
  ecoBlocks: 10000, // Added for chain memory management compatibility
  txExpirationTime: 3600000, // 1 hour, for tx memory cleanup compatibility
  witnessShufflePrecision: 8, // Added for witness schedule compatibility
  block0ts: 0, // Set to appropriate genesis timestamp if needed
  ecoBlocksIncreasesSoon: undefined, // Set to a number if needed for dynamic block memory
  randomBytesLength: 32,
  txLimits: {
    [TransactionType.WITNESS_VOTE]: 0,
  }
};

// Block-number-based config history (hardforks)
const history: Record<number, Partial<typeof config>> = {
  0: {
    // Default config values for block 0 (override as needed)
    blockTime: 3000,
    consensusRounds: 2,
    ecoBlocks: 10000,
    maxTxPerBlock: 1000,
    // ...add more fields as needed
  },
  1000090: {
    witnesses: 10,
    // ...add more overrides for this hardfork
  },
  // Add more hardforks as needed
};

function read(blockNum: number): typeof config {
  let finalConfig: any = {};
  let latestHf = 0;
  for (const key of Object.keys(history).map(Number).sort((a, b) => a - b)) {
    if (blockNum >= key) {
      Object.assign(finalConfig, history[key]);
      latestHf = key;
    } else {
      break;
    }
  }
  // Merge with base config as fallback
  return { ...config, ...finalConfig };
}

export default { ...config, history, read }; 