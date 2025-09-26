import config from './config.js';
import logger from './logger.js';
import { steemBridge } from './modules/steemBridge.js';
import settings from './settings.js';
import { TransactionType } from './transactions/types.js';
import { parseTokenAmount } from './utils/bigint.js';
import { isTokenIssuedByNode } from './utils/token.js';

interface SteemOperationData {
    id: string;
    json: string;
    required_auths: string[];
    from?: string;
    to?: string;
    amount?: string;
}

type SteemOperation = [string, SteemOperationData];

interface SteemTransaction {
    operations: SteemOperation[];
    transaction_id: string;
}

export interface SteemBlock {
    transactions: SteemTransaction[];
    timestamp: number;
}

export interface SteemBlockResult {
    transactions: ParsedTransaction[];
    timestamp: number;
}

export interface ParsedTransaction {
    type: number;
    data: any;
    sender: string;
    ts: number;
    ref: string;
    hash?: string;
}

// eslint-disable-next-line max-lines-per-function, complexity
const parseSteemTransactions = async (steemBlock: SteemBlock, blockNum: number): Promise<SteemBlockResult> => {
    logger.info(`Starting to parse Steem block ${blockNum} with ${steemBlock.transactions.length} transactions`);
    const txs: ParsedTransaction[] = [];
    let opIndex = 0;
    for (const tx of steemBlock.transactions) {
        for (const op of tx.operations) {
            try {
                const [opType, opData] = op;
                const isCustomJsonForChain = opType === 'custom_json' && opData.id === config.chainId;
                const isTransferAndBridgeEnabled = opType === 'transfer' && settings.steemBridgeEnabled === true && opData.to === settings.steemBridgeAccount;
                if (!isCustomJsonForChain && !isTransferAndBridgeEnabled) {
                    opIndex++;
                    continue;
                }
                if (isCustomJsonForChain) {
                    let json: { contract: string; payload: any };
                    try {
                        json = JSON.parse(opData.json);
                    } catch (e) {
                        logger.warn(`Failed to parse JSON in block ${blockNum}, operation ${opIndex}:`, e);
                        opIndex++;
                        continue;
                    }
                    if (!json.contract || !json.payload) {
                        opIndex++;
                        continue;
                    }
                    // Only process transactions with active authorization
                    if (!opData.required_auths || opData.required_auths.length === 0) {
                        logger.debug(`Skipping transaction in block ${blockNum}, operation ${opIndex}: No active authorization`);
                        opIndex++;
                        continue;
                    }
                    // Validate that the first required auth is a valid non-empty string
                    const sender = opData.required_auths[0];
                    if (!sender || typeof sender !== 'string' || sender.trim() === '') {
                        logger.warn(`Skipping transaction in block ${blockNum}, operation ${opIndex}: Invalid sender (${sender})`);
                        opIndex++;
                        continue;
                    }
                    let txType: number;
                    switch (json.contract.toLowerCase()) {
                        case 'nft_create_collection':
                            txType = TransactionType.NFT_CREATE_COLLECTION;
                            break;
                        case 'nft_mint':
                            txType = TransactionType.NFT_MINT;
                            break;
                        case 'nft_transfer':
                            txType = TransactionType.NFT_TRANSFER;
                            break;
                        case 'nft_list_item':
                            txType = TransactionType.NFT_LIST_ITEM;
                            break;
                        case 'nft_delist_item':
                            txType = TransactionType.NFT_DELIST_ITEM;
                            break;
                        case 'nft_buy_item':
                            txType = TransactionType.NFT_BUY_ITEM;
                            break;
                        case 'nft_accept_bid':
                            txType = TransactionType.NFT_ACCEPT_BID;
                            break;
                        case 'nft_close_auction':
                            txType = TransactionType.NFT_CLOSE_AUCTION;
                            break;
                        case 'nft_batch_operations':
                            txType = TransactionType.NFT_BATCH_OPERATIONS;
                            break;
                        case 'nft_cancel_bid':
                            txType = TransactionType.NFT_CANCEL_BID;
                            break;
                        case 'nft_make_offer':
                            txType = TransactionType.NFT_MAKE_OFFER;
                            break;
                        case 'nft_accept_offer':
                            txType = TransactionType.NFT_ACCEPT_OFFER;
                            break;
                        case 'nft_cancel_offer':
                            txType = TransactionType.NFT_CANCEL_OFFER;
                            break;
                        case 'farm_create':
                            txType = TransactionType.FARM_CREATE;
                            break;
                        case 'farm_stake':
                            txType = TransactionType.FARM_STAKE;
                            break;
                        case 'farm_unstake':
                            txType = TransactionType.FARM_UNSTAKE;
                            break;
                        case 'farm_claim_rewards':
                            txType = TransactionType.FARM_CLAIM_REWARDS;
                            break;
                        case 'pool_create':
                            txType = TransactionType.POOL_CREATE;
                            break;
                        case 'pool_add_liquidity':
                            txType = TransactionType.POOL_ADD_LIQUIDITY;
                            break;
                        case 'pool_remove_liquidity':
                            txType = TransactionType.POOL_REMOVE_LIQUIDITY;
                            break;
                        case 'pool_swap':
                            txType = TransactionType.POOL_SWAP;
                            break;
                        case 'token_create':
                            txType = TransactionType.TOKEN_CREATE;
                            break;
                        case 'token_mint':
                            txType = TransactionType.TOKEN_MINT;
                            break;
                        case 'token_transfer':
                            txType = TransactionType.TOKEN_TRANSFER;
                            break;
                        case 'token_update':
                            txType = TransactionType.TOKEN_UPDATE;
                            break;
                        case 'token_withdraw':
                            txType = TransactionType.TOKEN_WITHDRAW;
                            break;
                        case 'witness_register':
                            txType = TransactionType.WITNESS_REGISTER;
                            break;
                        case 'witness_vote':
                            txType = TransactionType.WITNESS_VOTE;
                            break;
                        case 'witness_unvote':
                            txType = TransactionType.WITNESS_UNVOTE;
                            break;
                        case 'launchpad_launch_token':
                            txType = TransactionType.LAUNCHPAD_LAUNCH_TOKEN;
                            break;
                        case 'launchpad_participate_presale':
                            txType = TransactionType.LAUNCHPAD_PARTICIPATE_PRESALE;
                            break;
                        case 'launchpad_claim_tokens':
                            txType = TransactionType.LAUNCHPAD_CLAIM_TOKENS;
                            break;
                        case 'launchpad_update_status':
                            txType = TransactionType.LAUNCHPAD_UPDATE_STATUS;
                            break;
                        case 'launchpad_finalize_presale':
                            txType = TransactionType.LAUNCHPAD_FINALIZE_PRESALE;
                            break;
                        case 'launchpad_set_main_token':
                            txType = TransactionType.LAUNCHPAD_SET_MAIN_TOKEN;
                            break;
                        case 'launchpad_refund_presale':
                            txType = TransactionType.LAUNCHPAD_REFUND_PRESALE;
                            break;
                        case 'launchpad_update_whitelist':
                            txType = TransactionType.LAUNCHPAD_UPDATE_WHITELIST;
                            break;
                        case 'market_cancel_order':
                            txType = TransactionType.MARKET_CANCEL_ORDER;
                            break;
                        case 'market_trade':
                            txType = TransactionType.MARKET_TRADE;
                            break;
                        default: {
                            const typeNum = parseInt(json.contract);
                            if (!isNaN(typeNum) && TransactionType[typeNum]) {
                                txType = typeNum;
                            } else {
                                logger.debug(`Unknown transaction type in block ${blockNum}, operation ${opIndex}:`, json.contract);
                                opIndex++;
                                continue;
                            }
                        }
                    }
                    const newTx: ParsedTransaction = {
                        type: txType,
                        data: json.payload,
                        sender: sender.trim(),
                        ts: new Date(steemBlock.timestamp + 'Z').getTime(),
                        ref: blockNum + ':' + opIndex,
                    };

                    try {
                        newTx.hash = tx.transaction_id;
                        txs.push(newTx);
                    } catch (error) {
                        logger.error(`Error processing transaction in block ${blockNum}, operation ${opIndex}:`, error);
                    }
                }
                if (isTransferAndBridgeEnabled && settings.skipBridgeOperationsUntilBlock > 0 && blockNum <= settings.skipBridgeOperationsUntilBlock) {
                    const [opType, opData] = op;
                    const { from, to, amount } = opData;
                    if (to !== settings.steemBridgeAccount && opType !== 'transfer') {
                        opIndex++;
                        continue;
                    }
                    const tokenSymbol = amount?.split(' ')[1] === settings.steemTokenSymbol ? settings.steemTokenSymbol : settings.sbdTokenSymbol;
                    const amountValue = amount?.split(' ')[0] || '0';

                    const issuedByNode = await isTokenIssuedByNode(tokenSymbol);
                    if (!issuedByNode) {
                        opIndex++;
                        continue;
                    }

                    const mintData = {
                        symbol: tokenSymbol,
                        to: from || 'null',
                        amount: parseTokenAmount(amountValue, tokenSymbol).toString(),
                    };

                    await steemBridge.enqueueDeposit(mintData);
                    logger.info(`[steemParser] Bridge deposit detected: ${amountValue} ${tokenSymbol} from ${from}, queued for broadcast`);
                }
            } catch (error) {
                logger.error(`Error processing operation in block ${blockNum}, operation ${opIndex}:`, error);
            }
            opIndex++;
        }
    }
    logger.debug(`Finished parsing Steem block ${blockNum}, found ${txs.length} valid transactions`);
    return { transactions: txs, timestamp: new Date(steemBlock.timestamp + 'Z').getTime() };
};

export default parseSteemTransactions;
