import { isValidPubKey } from "../crypto.js";
/**
 * Validates public key values
 * @param value Value to validate
 * @param max Maximum allowed length
 * @returns True if the public key is valid, false otherwise
 */
const validatePublicKey = (
    value: any,
    max?: number
): boolean => {
    
    if (!value)
        return false;
    if (typeof value !== 'string')
        return false;
    if (max && value.length > max)
        return false;
    if (!isValidPubKey(value))
        return false;
        
    return true;
};

export default validatePublicKey;