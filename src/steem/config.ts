interface SteemConfig {
    maxConsecutiveErrors: number;
    minRetryDelay: number;
    maxRetryDelay: number;
    circuitBreakerThreshold: number;
    prefetchBlocks: number;
    maxPrefetchBlocks: number;
    syncExitThreshold: number;
    defaultBroadcastInterval: number;
    fastBroadcastInterval: number;
    syncEntryQuorumPercent: number;
    syncExitQuorumPercent: number;
    minWitnessesForQuorumConsideration: number;
    postSyncLenientBlocks: number;
    steemHeightExpiry: number;
    forcedBroadcastInterval: number;
    syncBlockFetchDelay: number;
    syncModeBlockFetchBatch: number;
    normalModeBlockFetchBatch: number;
    steemHeadPollingInterval: number;
    syncModePollingInterval: number;
    maxRapidBroadcasts: number;
    defaultSteemEndpoints: string[];
}

const steemConfig: SteemConfig = {
    maxConsecutiveErrors: 20,
    minRetryDelay: 1000,
    maxRetryDelay: 15000,
    circuitBreakerThreshold: 30,
    prefetchBlocks: 1,
    maxPrefetchBlocks: 5,
    syncExitThreshold: 1,
    defaultBroadcastInterval: 30000,
    fastBroadcastInterval: 5000,
    syncEntryQuorumPercent: 50,
    syncExitQuorumPercent: 60,
    minWitnessesForQuorumConsideration: 3,
    postSyncLenientBlocks: 3,
    steemHeightExpiry: 30000,
    forcedBroadcastInterval: 30000,
    syncBlockFetchDelay: 200,
    syncModeBlockFetchBatch: 10,
    normalModeBlockFetchBatch: 1,
    steemHeadPollingInterval: 10000,
    syncModePollingInterval: 3000,
    maxRapidBroadcasts: 5,
    defaultSteemEndpoints: [
        'https://api.steemit.com',
        'https://api.justyy.com',
        'https://api.steem.fans',
        'https://api.futureshock.world',
        'https://steemd.steemworld.org',
    ],
};

export default steemConfig;
