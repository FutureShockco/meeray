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
export interface ValidateModule {
    chainConfig: ChainConfig;
    array: (value: any, maxLength?: number) => boolean;
    integer: (value: any, canBeZero?: boolean, canBeNegative?: boolean, max?: number, min?: number) => boolean;
    float: (value: any, canBeZero?: boolean, canBeNegative?: boolean, max?: number, min?: number) => boolean;
    json: (value: any, max: number) => boolean;
    publicKey: (value: any, max?: number) => boolean;
    string: (value: any, maxLength?: number, minLength?: number, allowedChars?: string, allowedCharsMiddle?: string) => boolean;
    bigint: (value: string | bigint, allowZero?: boolean, allowNegative?: boolean, maxValue?: bigint, minValue?: bigint) => boolean;
    boolean: (value: any) => boolean;
    validateUrl: (value: string, maxLength?: number) => boolean;
    validateLogoUrl: (value: string, maxLength?: number) => boolean;
    validatePoolAddLiquidityFields: (data: any, sender: string) => boolean;
    poolExists: (poolId: string) => Promise<any | null>;
    validateUserBalances: (user: string, tokenASymbol: string, tokenBSymbol: string, tokenAAmount: string | bigint, tokenBAmount: string | bigint) => Promise<boolean>;
    validatePoolRatioTolerance: (pool: any, tokenAAmount: string | bigint, tokenBAmount: string | bigint) => boolean;
    validateLpTokenExists: (tokenASymbol: string, tokenBSymbol: string, poolId: string) => Promise<boolean>;
}

declare const validate: ValidateModule;

export default validate;