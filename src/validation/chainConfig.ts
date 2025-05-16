import validateInteger from './integer.js';
import validateFloat from './float.js';

/**
 * Type validation functions
 */
interface ValidationType {
    (val: any): boolean;
}

/**
 * Parameter group config
 */
interface ParameterGroup {
    members: string[];
    validate: (...args: any[]) => boolean;
}

/**
 * Validation types for different types of values
 */
const types: Record<string, ValidationType> = {
    posInt: (val: any) => validateInteger(val, true, false),
    posNonZeroInt: (val: any) => validateInteger(val, false, false),
    posFloat: (val: any) => validateFloat(val, true, false),
    posNonZeroFloat: (val: any) => validateFloat(val, false, false)
};

/**
 * Parameter groups that must be updated together
 * Proposals to update any of these must be specified along with the other fields in the same group
 */
const groups: Record<string, ParameterGroup> = {
    ecoRentTimes: {
        members: ['ecoRentStartTime', 'ecoRentEndTime', 'ecoClaimTime'],
        validate: (v1: number, v2: number, v3: number) => v1 < v2 && v2 < v3
    }
};

/**
 * Inverse mapping of parameters to their groups
 */
const groupsInv: Record<string, string> = (() => {
    const result: Record<string, string> = {};
    for (let g in groups)
        for (let p in groups[g].members)
            result[groups[g].members[p]] = g;
    return result;
})();

/**
 * Chain parameters with their validation functions
 */
const parameters: Record<string, ValidationType> = {
    accountPriceBase: types.posNonZeroInt,
    accountPriceCharMult: types.posFloat,
    accountPriceChars: types.posNonZeroInt,
    accountPriceMin: types.posInt,

    ecoStartRent: types.posFloat,
    ecoBaseRent: types.posFloat,
    ecoDvRentFactor: types.posFloat,
    ecoPunishPercent: types.posFloat,
    ecoRentStartTime: types.posNonZeroInt,
    ecoRentEndTime: types.posNonZeroInt,
    ecoClaimTime: types.posNonZeroInt,

    rewardPoolMaxShare: types.posFloat,
    rewardPoolAmount: types.posNonZeroInt,

    masterFee: types.posInt,
    preloadVt: types.posInt,
    preloadBwGrowth: types.posFloat,

    chainUpdateFee: types.posNonZeroInt,
    chainUpdateMaxParams: types.posNonZeroInt,
    chainUpdateGracePeriodSeconds: types.posNonZeroInt,
};

export default {
    groups,
    groupsInv,
    parameters
}; 