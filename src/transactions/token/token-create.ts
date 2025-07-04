import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js';
import validate from '../../validation/index.js';
import { TokenCreateData, TokenCreateDataDB, TokenForStorage, TokenForStorageDB } from './token-interfaces.js';
import { convertToBigInt, convertToString, toString, setTokenDecimals, convertAllBigIntToStringRecursive, toBigInt } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS_INPUT: Array<keyof TokenCreateData> = ['maxSupply', 'initialSupply']; 

export async function validateTx(data: TokenCreateDataDB, sender: string): Promise<boolean> {
  try {
    // Convert DB string numerics to BigInts for TokenCreateData logic
    const tokenCreationInput = convertToBigInt<TokenCreateData>(data, NUMERIC_FIELDS_INPUT);
    // Handle precision separately as it's a number, not BigInt
    if (data.precision !== undefined) {
        tokenCreationInput.precision = data.precision; 
    }
    // Non-numeric fields like symbol, name, mintable, burnable, description, etc.,
    // are directly assigned or handled by convertToBigInt if not in NUMERIC_FIELDS_INPUT.
    // For explicit clarity and to ensure all fields of TokenCreateData are considered from TokenCreateDataDB:
    tokenCreationInput.symbol = data.symbol;
    tokenCreationInput.name = data.name;
    tokenCreationInput.mintable = data.mintable;
    tokenCreationInput.burnable = data.burnable;
    tokenCreationInput.description = data.description;
    tokenCreationInput.logoUrl = data.logoUrl;
    tokenCreationInput.websiteUrl = data.websiteUrl;
    // currentSupply is not expected as direct input in `data` for create, it will be derived from initialSupply.
    // If `data` somehow had currentSupply, convertToBigInt would attempt to convert it if `currentSupply` was in NUMERIC_FIELDS_INPUT.
    // By removing it from NUMERIC_FIELDS_INPUT, we correctly signal it's not a primary numeric input field for creation.

    // Basic required field checks
    if (!tokenCreationInput.symbol || !tokenCreationInput.name || tokenCreationInput.maxSupply === undefined) {
      logger.warn('[token-create] Invalid data: Missing required fields (symbol, name, maxSupply).');
      return false;
    }

    // symbol: 3-10 chars, uppercase letters and numbers only
    if (!validate.string(tokenCreationInput.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn('[token-create] Invalid symbol format.');
      return false;
    }

    // Prevent symbols starting with 'LP_'
    if (tokenCreationInput.symbol.startsWith('LP_')) {
      logger.warn('[token-create] Token symbol cannot start with "LP_". This prefix is reserved for liquidity pool tokens.');
      return false;
    }

    // name: 1-50 chars
    if (!validate.string(tokenCreationInput.name, 50, 1)) {
      logger.warn('[token-create] Invalid name length (must be 1-50 characters).');
      return false;
    }

    // precision: 0-18 (is a number, not BigInt)
    if (tokenCreationInput.precision !== undefined && !validate.integer(tokenCreationInput.precision, true, false, 18, 0)) {
      logger.warn('[token-create] Invalid precision (must be 0-18).');
      return false;
    }

    // maxSupply: must be positive bigint (min 1)
    if (!validate.bigint(tokenCreationInput.maxSupply, false, false, undefined, BigInt(1))) {
      logger.warn('[token-create] Invalid maxSupply. Must be a positive integer (min 1).');
      return false;
    }
    
    // Ensure initialSupply is non-negative if provided
    if (tokenCreationInput.initialSupply !== undefined && tokenCreationInput.initialSupply < BigInt(0)) {
        logger.warn('[token-create] Invalid initialSupply. Must be non-negative.');
        return false;
    }
    // Ensure initialSupply <= maxSupply
    if (tokenCreationInput.initialSupply !== undefined && tokenCreationInput.maxSupply !== undefined && tokenCreationInput.initialSupply > tokenCreationInput.maxSupply) {
        logger.warn('[token-create] Invalid initialSupply. Cannot be greater than maxSupply.');
        return false;
    }

    if (tokenCreationInput.mintable !== undefined && typeof tokenCreationInput.mintable !== 'boolean') {
      logger.warn('[token-create] Invalid mintable flag. Must be boolean.');
      return false;
    }

    if (tokenCreationInput.burnable !== undefined && typeof tokenCreationInput.burnable !== 'boolean') {
      logger.warn('[token-create] Invalid burnable flag. Must be boolean.');
      return false;
    }
    
    if (tokenCreationInput.symbol === config.nativeToken) {
      logger.warn(`[token-create] Symbol ${tokenCreationInput.symbol} is reserved.`);
      return false;
    }

    const existingToken = await cache.findOnePromise('tokens', { _id: tokenCreationInput.symbol });
    if (existingToken) {
      logger.warn(`[token-create] Token with symbol ${tokenCreationInput.symbol} already exists.`);
      return false;
    }
    
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`[token-create] Sender account ${sender} not found.`);
      return false; 
    }

    return true;
  } catch (error) {
    logger.error(`[token-create] Error validating token creation: ${error}`);
    return false;
  }
}

export async function process(data: TokenCreateDataDB, sender: string, id: string): Promise<boolean> {
    // Convert string numerics to BigInts for logic, to prevent string comparison issues.
    const tokenCreationInput = convertToBigInt<TokenCreateData>(data, NUMERIC_FIELDS_INPUT);
    if (data.precision !== undefined) {
        tokenCreationInput.precision = data.precision;
    }
    
    console.log(data,sender);
    logger.debug(`[token-create] Processing token creation for ${tokenCreationInput.symbol} by ${sender}`);

    // Validate
    // if (!validate(tokenCreationInput)) {
    //     logger.error('[token-create] Validation failed for input data.');
    //     return false;
    // }

    try {
        const existingToken = await cache.findOnePromise('tokens', { _id: tokenCreationInput.symbol });
        if (existingToken) {
            logger.error(`[token-create] Token with symbol ${tokenCreationInput.symbol} already exists.`);
            return false;
        }

        // Use 8 as the default precision if not provided
        const effectivePrecision = tokenCreationInput.precision === undefined ? 8 : tokenCreationInput.precision;
        if (effectivePrecision < 0 || effectivePrecision > 18) { 
            logger.error(`[token-create] Invalid precision ${effectivePrecision} for token ${tokenCreationInput.symbol}. Must be between 0 and 18.`);
            return false;
        }

        setTokenDecimals(tokenCreationInput.symbol, effectivePrecision);

        const initialSupplyForLogic = tokenCreationInput.initialSupply || BigInt(0);
        const maxSupplyForLogic = tokenCreationInput.maxSupply || BigInt(0); 

        if (initialSupplyForLogic < BigInt(0) || maxSupplyForLogic < BigInt(0)) {
            logger.error('[token-create] Initial supply and max supply cannot be negative.');
            return false;
        }

        if (maxSupplyForLogic !== BigInt(0) && initialSupplyForLogic > maxSupplyForLogic) {
            logger.error('[token-create] Initial supply cannot exceed max supply.');
            return false;
        }

        const tokenToStore: TokenForStorage = {
            _id: tokenCreationInput.symbol,
            symbol: tokenCreationInput.symbol,
            name: tokenCreationInput.name,
            issuer: sender,
            precision: effectivePrecision,
            maxSupply: maxSupplyForLogic,
            currentSupply: initialSupplyForLogic, 
            mintable: tokenCreationInput.mintable === undefined ? true : tokenCreationInput.mintable,
            burnable: tokenCreationInput.burnable === undefined ? true : tokenCreationInput.burnable,
            description: tokenCreationInput.description || '',
            logoUrl: tokenCreationInput.logoUrl || '',
            websiteUrl: tokenCreationInput.websiteUrl || '',
            createdAt: new Date().toISOString()
        };

        const tokenToStoreDB: TokenForStorageDB = convertAllBigIntToStringRecursive(tokenToStore);

        const insertSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('tokens', tokenToStoreDB, (err, result) => {
                if (err || !result) {
                    logger.error(`[token-create] Failed to insert token ${tokenToStoreDB._id}`);
                    resolve(false);
                } else { 
                  resolve(true);
                }
            });
        });

        if (!insertSuccess) return false;

        if (initialSupplyForLogic > BigInt(0)) {
            const updateSuccess = await cache.updateOnePromise(
                'accounts',
                { name: sender },
                { $set: { [`balances.${tokenToStoreDB._id}`]: toString(initialSupplyForLogic) } }
            );
            if (!updateSuccess) {
                logger.error(`[token-create] Failed to set initial balance for ${sender} for token ${tokenToStoreDB._id}.`);
                // TODO: Consider rollback of token insertion if this critical step fails
                return false;
            }
        }

        // Log event using the new centralized logger
        const eventData = { 
            symbol: tokenCreationInput.symbol,
            name: tokenCreationInput.name,
            precision: effectivePrecision,
            maxSupply: toString(tokenCreationInput.maxSupply), 
            initialSupply: toString(initialSupplyForLogic), 
            mintable: tokenToStore.mintable, 
            burnable: tokenToStore.burnable  
        };
        // Pass the transactionId to link the event to the original transaction
        await logTransactionEvent('tokenCreate', sender, eventData, id); 

        logger.info(`[token-create] Token ${tokenToStoreDB._id} created successfully by ${sender}.`);
        return true;

    } catch (error) {
        logger.error(`[token-create] Error processing token creation for ${tokenCreationInput.symbol} by ${sender}: ${error}`);
        return false;
    }
} 