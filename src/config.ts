const config = {
  chainId: 'sidechain',
  networkName: 'Echelon Devnet',
  nativeTokenSymbol: 'ECH',
  nativeTokenName: 'Echelon',
  nativeTokenPrecision: 8,
  originHash: 'e201950993be0e15b14ab19dccb165972ff0ba7ea162c5ad6eec9b5268bce468',
  burnAccountName: 'null',
  maxWitnesses: 20,
  masterBalance: '20000000000000000',
  masterName: 'echelon-node1',
  masterPublicKey: 'e27B66QHwRLjnjxi5KAa9G7fLSDajtoB6CxuZ87oTdfS',
  blockTime: 2940,
  syncBlockTime: 1000,
  witnessReward: 100000000,
  farmReward: 100000000,
  steemChainId: '0000000000000000000000000000000000000000000000000000000000000000',
  steemStartBlock: process.env.NODE_ENV === 'development' ? 2757515 : 95762370,
  steemBlockDelay: 1,
  steemBlockMaxDelay: 6,
  b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  tokenSymbolAllowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  tokenNameAllowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  tokenNameMaxLength: 50,
  tokenCreationFee: 10000000000, // 100 ECH
  nftCollectionCreationFee: 10000000000, // 100 ECH
  tokenSymbolMaxLength: 10,
  tokenSymbolMinLength: 3,
  tokenPrecisionMax: 18,
  tokenPrecisionMin: 0,
  tokenMinSupply: 1,
  tokenMaxSupply: 1000000000000000000,
  maxTokenAmountDigits: 30, // Maximum digits for token amounts
  consensusRounds: 2,
  witnesses: 20,
  maxDrift: 30000,
  notifPurge: 1000,
  notifPurgeAfter: 10,
  allowedUsernameChars: 'abcdefghijklmnopqrstuvwxyz0123456789.-',
  maxTxPerBlock: 1000,
  txExpirationTime: 3600000,
  witnessShufflePrecision: 8,
  memoryBlocks: 1000,
  randomBytesLength: 32
};

// Block-number-based config history (hardforks)
const history: Record<number, Partial<typeof config>> = {
  0: {
    blockTime: 3000,
    consensusRounds: 2,
    maxTxPerBlock: 1000,
  },
  1000090: {
    witnesses: 10,
  },
  31480: {
    witnesses: 2, 
  },
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
  return { ...config, ...finalConfig };
}

export default { ...config, history, read }; 