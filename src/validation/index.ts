import chainConfig from './chainConfig.js';
import array from './array.js';
import integer from './integer.js';
import json from './json.js';
import publicKey from './publicKey.js';
import string from './string.js';
import bigint from './bigint.js';
import boolean from './boolean.js';
import { validateUrl, validateLogoUrl } from './url.js';
import {
    validatePoolTokens,
    validatePoolAddLiquidityFields,
    poolExists,
    validateUserBalances,
    validatePoolRatioTolerance,
    validateLpTokenExists
} from './pool.js';
import { tokenSymbols, newToken, tokenTransfer, tokenExists, isIssuer, canMintToken } from './token.js';
import userBalances from './balance.js';
/**
 * Chain configuration validation
 */
export interface ChainConfig {
    groups: Record<string, {
        members: string[];
        validate: (...args: any[]) => boolean;
    }>;
    groupsInv: Record<string, string>;
    parameters: Record<string, (val: any) => boolean>;
}

/**
 * Validation module interface
 */
export interface ValidationModule {
    chainConfig: ChainConfig;
    array: (value: any, maxLength?: number) => boolean;
    integer: (value: any, canBeZero?: boolean, canBeNegative?: boolean, max?: number, min?: number) => boolean;
    json: (value: any, max: number) => boolean;
    publicKey: (value: any, max?: number) => boolean;
    string: (value: any, maxLength?: number, minLength?: number, allowedChars?: string, allowedCharsMiddle?: string) => boolean;
    bigint: (value: string | bigint, allowZero?: boolean, allowNegative?: boolean, maxValue?: bigint, minValue?: bigint) => boolean;
    boolean: (value: any) => boolean;
    validateUrl: (value: string, maxLength?: number) => boolean;
    validateLogoUrl: (value: string, maxLength?: number) => boolean;
    tokenSymbols: (symbols: any[] | any) => boolean;
    newToken: (data: any) => Promise<boolean>;
    tokenTransfer: (sender: string, symbol: string, to: string, amount: string | bigint, memo?: string, isTransfer?: boolean) => boolean;
    tokenExists: (symbol: string) => Promise<boolean>;
    isIssuer: (sender: string, symbol: string) => Promise<boolean>;
    canMintToken: (sender: string, symbol: string, amount: string | bigint) => Promise<boolean>;
    userBalances: (user: string, requirements: Array<{ symbol: string; amount: string | bigint }>) => Promise<boolean>;
    validatePoolTokens: (data: any) => boolean;
    validatePoolAddLiquidityFields: (data: any, sender: string) => boolean;
    poolExists: (poolId: string) => Promise<any | null>;
    validateUserBalances: (user: string, tokenASymbol: string, tokenBSymbol: string, tokenAAmount: string | bigint, tokenBAmount: string | bigint) => Promise<boolean>;
    validatePoolRatioTolerance: (pool: any, tokenAAmount: string | bigint, tokenBAmount: string | bigint) => boolean;
    validateLpTokenExists: (tokenASymbol: string, tokenBSymbol: string, poolId: string) => Promise<boolean>;
}

/**
 * Validation module with functions for validating different data types
 */
const validation: ValidationModule = {
    chainConfig,
    array,
    integer,
    json,
    publicKey,
    string,
    bigint,
    boolean,
    validateUrl,
    validateLogoUrl,
    tokenSymbols,
    newToken,
    tokenTransfer,
    tokenExists,
    isIssuer,
    canMintToken,
    userBalances,
    validatePoolTokens,
    validatePoolAddLiquidityFields,
    poolExists,
    validateUserBalances,
    validatePoolRatioTolerance,
    validateLpTokenExists
};

export default validation; 