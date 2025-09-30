import chain from './chain.js';
import config from './config.js';
import logger from './logger.js';
import settings from './settings.js';
import { TransactionType } from './transactions/types.js';
import { parseTokenAmount } from './utils/bigint.js';
import { isTokenIssuedByBridge } from './utils/token.js';
import { steemBridge } from './modules/steemBridge.js';

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
    hash: string;
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
                const isTransferWithBridge = settings.steemBridgeEnabled && opType === 'transfer' && opData.to === settings.steemBridgeAccount;
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
                        case 'pool_claim_fees':
                            txType = TransactionType.POOL_CLAIM_FEES;
                            break;
                        case 'nft_update':
                            txType = TransactionType.NFT_UPDATE;
                            break;
                        case 'nft_update_collection':
                            txType = TransactionType.NFT_UPDATE_COLLECTION;
                            break;
                        case 'farm_update_weight':
                            txType = TransactionType.FARM_UPDATE_WEIGHT;
                            break;
                        case 'launchpad_configure_presale':
                            txType = TransactionType.LAUNCHPAD_CONFIGURE_PRESALE;
                            break;
                        case 'launchpad_configure_tokenomics':
                            txType = TransactionType.LAUNCHPAD_CONFIGURE_TOKENOMICS;
                            break;
                        case 'launchpad_configure_airdrop':
                            txType = TransactionType.LAUNCHPAD_CONFIGURE_AIRDROP;
                            break;
                        case 'launchpad_update_metadata':
                            txType = TransactionType.LAUNCHPAD_UPDATE_METADATA;
                            break;
                        // NFT Transactions
                        case 'nft_create_collection':
                        case 'nft_mint':
                        case 'nft_transfer':
                        case 'nft_list_item':
                        case 'nft_delist_item':
                        case 'nft_buy_item':
                        case 'nft_update':
                        case 'nft_update_collection':
                        case 'nft_accept_bid':
                        case 'nft_close_auction':
                        case 'nft_batch_operations':
                        case 'nft_cancel_bid':
                        case 'nft_make_offer':
                        case 'nft_accept_offer':
                        case 'nft_cancel_offer': {
                            const nftMap = {
                                'nft_create_collection': TransactionType.NFT_CREATE_COLLECTION,
                                'nft_mint': TransactionType.NFT_MINT,
                                'nft_transfer': TransactionType.NFT_TRANSFER,
                                'nft_list_item': TransactionType.NFT_LIST_ITEM,
                                'nft_delist_item': TransactionType.NFT_DELIST_ITEM,
                                'nft_buy_item': TransactionType.NFT_BUY_ITEM,
                                'nft_update': TransactionType.NFT_UPDATE,
                                'nft_update_collection': TransactionType.NFT_UPDATE_COLLECTION,
                                'nft_accept_bid': TransactionType.NFT_ACCEPT_BID,
                                'nft_close_auction': TransactionType.NFT_CLOSE_AUCTION,
                                'nft_batch_operations': TransactionType.NFT_BATCH_OPERATIONS,
                                'nft_cancel_bid': TransactionType.NFT_CANCEL_BID,
                                'nft_make_offer': TransactionType.NFT_MAKE_OFFER,
                                'nft_accept_offer': TransactionType.NFT_ACCEPT_OFFER,
                                'nft_cancel_offer': TransactionType.NFT_CANCEL_OFFER,
                            };
                            txType = nftMap[json.contract.toLowerCase() as keyof typeof nftMap];
                            break;
                        }

                        // Farm Transactions
                        case 'farm_create':
                        case 'farm_stake':
                        case 'farm_unstake':
                        case 'farm_claim_rewards':
                        case 'farm_update_weight': {
                            const farmMap = {
                                'farm_create': TransactionType.FARM_CREATE,
                                'farm_stake': TransactionType.FARM_STAKE,
                                'farm_unstake': TransactionType.FARM_UNSTAKE,
                                'farm_claim_rewards': TransactionType.FARM_CLAIM_REWARDS,
                                'farm_update_weight': TransactionType.FARM_UPDATE_WEIGHT,
                            };
                            txType = farmMap[json.contract.toLowerCase() as keyof typeof farmMap];
                            break;
                        }

                        // Pool Transactions
                        case 'pool_create':
                        case 'pool_add_liquidity':
                        case 'pool_remove_liquidity':
                        case 'pool_swap':
                        case 'pool_claim_fees': {
                            const poolMap = {
                                'pool_create': TransactionType.POOL_CREATE,
                                'pool_add_liquidity': TransactionType.POOL_ADD_LIQUIDITY,
                                'pool_remove_liquidity': TransactionType.POOL_REMOVE_LIQUIDITY,
                                'pool_swap': TransactionType.POOL_SWAP,
                                'pool_claim_fees': TransactionType.POOL_CLAIM_FEES,
                            };
                            txType = poolMap[json.contract.toLowerCase() as keyof typeof poolMap];
                            break;
                        }

                        // Token Transactions
                        case 'token_create':
                        case 'token_mint':
                        case 'token_transfer':
                        case 'token_update':
                        case 'token_withdraw': {
                            const tokenMap = {
                                'token_create': TransactionType.TOKEN_CREATE,
                                'token_mint': TransactionType.TOKEN_MINT,
                                'token_transfer': TransactionType.TOKEN_TRANSFER,
                                'token_update': TransactionType.TOKEN_UPDATE,
                                'token_withdraw': TransactionType.TOKEN_WITHDRAW,
                            };
                            txType = tokenMap[json.contract.toLowerCase() as keyof typeof tokenMap];
                            break;
                        }

                        // Witness Transactions
                        case 'witness_register':
                        case 'witness_vote':
                        case 'witness_unvote': {
                            const witnessMap = {
                                'witness_register': TransactionType.WITNESS_REGISTER,
                                'witness_vote': TransactionType.WITNESS_VOTE,
                                'witness_unvote': TransactionType.WITNESS_UNVOTE,
                            };
                            txType = witnessMap[json.contract.toLowerCase() as keyof typeof witnessMap];
                            break;
                        }

                        // Launchpad Transactions
                        case 'launchpad_launch_token':
                        case 'launchpad_participate_presale':
                        case 'launchpad_claim_tokens':
                        case 'launchpad_update_status':
                        case 'launchpad_finalize_presale':
                        case 'launchpad_set_main_token':
                        case 'launchpad_refund_presale':
                        case 'launchpad_update_whitelist':
                        case 'launchpad_configure_presale':
                        case 'launchpad_configure_tokenomics':
                        case 'launchpad_configure_airdrop':
                        case 'launchpad_update_metadata': {
                            const launchpadMap = {
                                'launchpad_launch_token': TransactionType.LAUNCHPAD_LAUNCH_TOKEN,
                                'launchpad_participate_presale': TransactionType.LAUNCHPAD_PARTICIPATE_PRESALE,
                                'launchpad_claim_tokens': TransactionType.LAUNCHPAD_CLAIM_TOKENS,
                                'launchpad_update_status': TransactionType.LAUNCHPAD_UPDATE_STATUS,
                                'launchpad_finalize_presale': TransactionType.LAUNCHPAD_FINALIZE_PRESALE,
                                'launchpad_set_main_token': TransactionType.LAUNCHPAD_SET_MAIN_TOKEN,
                                'launchpad_refund_presale': TransactionType.LAUNCHPAD_REFUND_PRESALE,
                                'launchpad_update_whitelist': TransactionType.LAUNCHPAD_UPDATE_WHITELIST,
                                'launchpad_configure_presale': TransactionType.LAUNCHPAD_CONFIGURE_PRESALE,
                                'launchpad_configure_tokenomics': TransactionType.LAUNCHPAD_CONFIGURE_TOKENOMICS,
                                'launchpad_configure_airdrop': TransactionType.LAUNCHPAD_CONFIGURE_AIRDROP,
                                'launchpad_update_metadata': TransactionType.LAUNCHPAD_UPDATE_METADATA,
                            };
                            txType = launchpadMap[json.contract.toLowerCase() as keyof typeof launchpadMap];
                            break;
                        }

                        // Market Transactions
                        case 'market_cancel_order':
                        case 'market_trade': {
                            const marketMap = {
                                'market_cancel_order': TransactionType.MARKET_CANCEL_ORDER,
                                'market_trade': TransactionType.MARKET_TRADE,
                            };
                            txType = marketMap[json.contract.toLowerCase() as keyof typeof marketMap];
                            break;
                        }
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


                    try {
                        const newTx: ParsedTransaction = {
                            type: txType,
                            data: json.payload,
                            sender: sender.trim(),
                            ts: new Date(steemBlock.timestamp + 'Z').getTime(),
                            ref: blockNum + ':' + opIndex,
                            hash: tx.transaction_id,
                        };
                        txs.push(newTx);
                    } catch (error) {
                        logger.error(`Error processing transaction in block ${blockNum}, operation ${opIndex}:`, error);
                    }
                }
                if (isTransferWithBridge) {
                    const [opType, opData] = op;
                    const { from, to, amount } = opData;

                    const tokenSymbol = amount?.split(' ')[1] === settings.steemTokenSymbol ? settings.steemTokenSymbol : settings.sbdTokenSymbol;
                    const amountValue = amount?.split(' ')[0] || '0';

                    const issuedByNode = await isTokenIssuedByBridge(tokenSymbol);
                    if (!issuedByNode) {
                        opIndex++;
                        continue;
                    }

                    const mintData = {
                        symbol: tokenSymbol,
                        to: from as string,
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
