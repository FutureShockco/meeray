/**
 * Validates integer values like amounts (strictly positive),
 * @param value Value to validate
 * @param canBeZero Whether the value can be zero
 * @param canBeNegative Whether the value can be negative
 * @param max Maximum allowed value
 * @param min Minimum allowed value
 * @returns True if the integer is valid, false otherwise
 */
const validateInteger = (
    value: any,
    canBeZero?: boolean,
    canBeNegative?: boolean,
    max?: number,
    min?: number
): boolean => {
    if (!max)
        max = Number.MAX_SAFE_INTEGER;
    if (!min)
        if (canBeNegative)
            min = Number.MIN_SAFE_INTEGER;
        else
            min = 0;
    
    if (typeof value !== 'number')
        return false;
    if (!Number.isSafeInteger(value))
        return false;
    if (!canBeZero && value === 0)
        return false;
    if (!canBeNegative && value < 0)
        return false;
    if (value > max)
        return false;
    if (value < min)
        return false;

    return true;
};

export default validateInteger;