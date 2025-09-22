// P2P Configuration Constants
export const P2P_CONFIG = {
    VERSION: '1.6.6',
    DEFAULT_PORT: 6001,
    REPLAY_INTERVAL: 1500,
    DISCOVERY_INTERVAL: 60000,
    KEEP_ALIVE_INTERVAL: 6000,
    MAX_BLOCKS_BUFFER: 100,
    MAX_RECOVER_ATTEMPTS: 25,
    HISTORY_INTERVAL: 10000,
    KEEP_HISTORY_FOR: 20000,
    HANDSHAKE_TIMEOUT: 5000,
    EMERGENCY_COOLDOWN: 5000,
    RATE_LIMIT_EMERGENCY: 3000,
    RATE_LIMIT_NORMAL: 10000,
    PEER_LIST_REQUEST_INTERVAL: 60000,
    PEER_LIST_INITIAL_DELAY: 5000
} as const;

// Runtime configuration from environment
export const P2P_RUNTIME_CONFIG = {
    MAX_PEERS: Number(process.env.MAX_PEERS) || 15,
    P2P_PORT: Number(process.env.P2P_PORT) || P2P_CONFIG.DEFAULT_PORT,
    P2P_HOST: process.env.P2P_HOST || '::',
    PEERS: process.env.PEERS ? process.env.PEERS.split(',') : [],
    NO_DISCOVERY: process.env.NO_DISCOVERY === '1',
    OFFLINE: process.env.OFFLINE === '1',
    DISCOVERY_EXCLUDE: process.env.DISCOVERY_EXCLUDE ? process.env.DISCOVERY_EXCLUDE.split(',') : []
} as const;