import chainConfig from './chainConfig.js';
import array from './array.js';
import integer from './integer.js';
import float from './float.js';
import json from './json.js';
import publicKey from './publicKey.js';
import string from './string.js';

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
    float: (value: any, canBeZero?: boolean, canBeNegative?: boolean, max?: number, min?: number) => boolean;
    json: (value: any, max: number) => boolean;
    publicKey: (value: any, max?: number) => boolean;
    string: (value: any, maxLength?: number, minLength?: number, allowedChars?: string, allowedCharsMiddle?: string) => boolean;
}

/**
 * Validation module with functions for validating different data types
 */
const validation: ValidationModule = {
    chainConfig,
    array,
    integer,
    float,
    json,
    publicKey,
    string
};

export default validation; 