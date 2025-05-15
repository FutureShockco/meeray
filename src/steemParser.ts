import { TransactionType } from './transactions/types.js';

import logger from './logger.js';
/**
 * Custom operation data interface
 */
interface SteemOperationData {
    id: string;              // Custom JSON id
    json: string;            // JSON string payload
    required_auths: string[]; // Required authorizations
}

/**
 * Steem block operation interface (as a tuple)
 */
type SteemOperation = [string, SteemOperationData];

/**
 * Steem transaction interface
 */
interface SteemTransaction {
    operations: SteemOperation[];
    transaction_id: string;
}

/**
 * Steem block interface
 */
export interface SteemBlock {
    transactions: SteemTransaction[];
    timestamp: number;
}

export interface SteemBlockResult {
    transactions: ParsedTransaction[];
    timestamp: number;
}


/**
 * Parsed transaction interface
 */
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
                logger.debug(`Transaction added: ${json.contract}`);

                let txType: number;
                switch (json.contract.toLowerCase()) {
                    case 'witness_register':
                        txType = TransactionType.WITNESS_REGISTER;
                        break;
                    case 'witness_vote':
                        txType = TransactionType.WITNESS_VOTE;
                        break;
                    case 'witness_unvote':
                        txType = TransactionType.WITNESS_UNVOTE;
                        break;
                    case 'create_token':
                        txType = TransactionType.CREATE_TOKEN;
                        break;
                    case 'mint_token':
                        txType = TransactionType.MINT_TOKEN;
                        break;
                    case 'transfer_token':
                        txType = TransactionType.TRANSFER_TOKEN;
                        break;
                    case 'create_nft_collection':
                        txType = TransactionType.CREATE_NFT_COLLECTION;
                        break;
                    case 'mint_nft':
                        txType = TransactionType.MINT_NFT;
                        break;
                    case 'transfer_nft':
                        txType = TransactionType.TRANSFER_NFT;
                        break;
                    case 'create_market':
                        txType = TransactionType.CREATE_MARKET;
                        break;
                    case 'place_order':
                        txType = TransactionType.PLACE_ORDER;
                        break;
                    case 'create_pool':
                        txType = TransactionType.CREATE_POOL;
                        break;
                    case 'stake':
                        txType = TransactionType.STAKE;
                        break;
                    case 'unstake':
                        txType = TransactionType.UNSTAKE;
                        break;
                    case 'create_farm':
                        txType = TransactionType.CREATE_FARM;
                        break;
                    case 'stake_farm':
                        txType = TransactionType.STAKE_FARM;
                        break;
                    case 'unstake_farm':
                        txType = TransactionType.UNSTAKE_FARM;
                        break;
                    case 'claim_farm':
                        txType = TransactionType.CLAIM_FARM;
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
                    sender: opData.required_auths[0],
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