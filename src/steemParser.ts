import { TransactionType } from './transactions/types.js';

import logger from './logger.js';

interface SteemOperationData {
    id: string;              // Custom JSON id
    json: string;            // JSON string payload
    required_auths: string[]; // Required authorizations
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

/**
 * Parses transactions from a Steem block
 * @param steemBlock The Steem block to parse
 * @param blockNum The block number
 * @returns Array of parsed transactions
 */
const parseSteemTransactions = async (steemBlock: SteemBlock, blockNum: number): Promise<SteemBlockResult> => {
    const txs: ParsedTransaction[] = [];
    let opIndex = 0;
    // Process each transaction
    for (let tx of steemBlock.transactions) {
        for (let op of tx.operations) {
            try {
                const [opType, opData] = op;
                if (opType !== 'custom_json' || opData.id !== 'sidechain') {
                    opIndex++;
                    continue;
                }

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
                logger.debug(`Transaction added: ${json.contract}`);

                let txType: number;
                switch (json.contract.toLowerCase()) {
                    // NFT Transactions
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
                    
                    // Farm Transactions
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
                    
                    // Pool Transactions
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
                    
                    // Token Transactions
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
                    
                    // Witness Transactions
                    case 'witness_register':
                        txType = TransactionType.WITNESS_REGISTER;
                        break;
                    case 'witness_vote':
                        txType = TransactionType.WITNESS_VOTE;
                        break;
                    case 'witness_unvote':
                        txType = TransactionType.WITNESS_UNVOTE;
                        break;
                    
                    // Launchpad Transactions
                    case 'launchpad_launch_token':
                        txType = TransactionType.LAUNCHPAD_LAUNCH_TOKEN;
                        break;
                    case 'launchpad_participate_presale':
                        txType = TransactionType.LAUNCHPAD_PARTICIPATE_PRESALE;
                        break;
                    case 'launchpad_claim_tokens':
                        txType = TransactionType.LAUNCHPAD_CLAIM_TOKENS;
                        break;
                    
                    // Market Transactions
                    case 'market_create_pair':
                        txType = TransactionType.MARKET_CREATE_PAIR;
                        break;
                    case 'market_place_order':
                        txType = TransactionType.MARKET_PLACE_ORDER;
                        break;
                    case 'market_cancel_order':
                        txType = TransactionType.MARKET_CANCEL_ORDER;
                        break;
                    
                    // Market Trading (Unified AMM + Orderbook)
                    case 'market_trade':
                        txType = TransactionType.MARKET_TRADE;
                        break;
                    
                    default:
                        const typeNum = parseInt(json.contract);
                        if (!isNaN(typeNum) && TransactionType[typeNum]) {
                            txType = typeNum;
                        } else {
                            logger.debug(`Unknown transaction type in block ${blockNum}, operation ${opIndex}:`, json.contract);
                            opIndex++;
                            continue;
                        }
                }
                
                const newTx: ParsedTransaction = {
                    type: txType,
                    data: json.payload,
                    sender: sender.trim(),
                    ts: new Date(steemBlock.timestamp + 'Z').getTime(),
                    ref: blockNum + ':' + opIndex
                };

                try {
                    newTx.hash = tx.transaction_id;
                    txs.push(newTx);
                } catch (error) {
                    logger.error(`Error processing transaction in block ${blockNum}, operation ${opIndex}:`, error);
                }
            } catch (error) {
                logger.error(`Error processing operation in block ${blockNum}, operation ${opIndex}:`, error);
            }

            opIndex++;
        }
    }
    
    return { transactions: txs, timestamp: new Date(steemBlock.timestamp + 'Z').getTime() };
};

export default parseSteemTransactions; 