// Runtime settings sourced from environment variables

export const steemBridgeEnabled: boolean = process.env.USE_STEEM_BRIDGE === 'true';
export const steemBridgeAccount: string = process.env.STEEM_BRIDGE_ACCOUNT || '';
export const steemBridgeActiveKey: string = process.env.STEEM_BRIDGE_ACTIVE_KEY || '';

export const steemAccount: string = process.env.STEEM_ACCOUNT || '';
export const steemTokenSymbol: string = process.env.STEEM_TOKEN_SYMBOL || 'TESTS';
export const sbdTokenSymbol: string = process.env.SBD_TOKEN_SYMBOL || 'SBD';
export const steemApiUrls: string[] = process.env.STEEM_API ? process.env.STEEM_API.split(',').map(s => s.trim()).filter(Boolean) : [];

export const apiPort: number = process.env.API_PORT ? Number(process.env.API_PORT) : 3000;
export const p2pPort: number = process.env.P2P_PORT ? Number(process.env.P2P_PORT) : 6001;
export const logLevel: string = process.env.LOG_LEVEL || 'debug';
export const peers: string[] = process.env.PEERS ? process.env.PEERS.split(',').map(s => s.trim()).filter(Boolean) : [];
export const mongoUrl: string = process.env.MONGO_URL || 'mongodb://localhost:27017';
export const mongoDb: string = process.env.MONGO_DB || 'meeray';
export const useNotification: boolean = process.env.USE_NOTIFICATION === 'true';


export default {
    steemBridgeEnabled,
    steemBridgeAccount,
    steemBridgeActiveKey,
    steemAccount,
    steemTokenSymbol,
    sbdTokenSymbol,
    steemApiUrls,
    apiPort,
    p2pPort,
    logLevel,
    peers,
    mongoUrl,
    mongoDb,
    useNotification,
};


