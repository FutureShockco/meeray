import validateInteger from './integer.js';
import validateBigInt from './bigint.js';

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
    posInt: (val: any) => validateBigInt(val, false, false),
    posNonZeroInt: (val: any) => validateBigInt(val, false, false, BigInt(1)),
    posAmount: (val: any) => validateBigInt(val, true, false),
    posNonZeroAmount: (val: any) => validateBigInt(val, false, false, BigInt(1))
};

/**
 * Parameter groups that must be updated together
 * Proposals to update any of these must be specified along with the other fields in the same group
 */
const groups: Record<string, ParameterGroup> = {
    ecoRentTimes: {
        members: ['ecoRentStartTime', 'ecoRentEndTime', 'ecoClaimTime'],
        validate: (v1: bigint, v2: bigint, v3: bigint) => v1 < v2 && v2 < v3
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
    ecoRentStartTime: types.posNonZeroInt,
    ecoRentEndTime: types.posNonZeroInt,
    ecoClaimTime: types.posNonZeroInt,
};

export default {
    groups,
    groupsInv,
    parameters
}; 