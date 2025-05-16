/**
 * Validates floating point values
 * @param value Value to validate
 * @param canBeZero Whether the value can be zero
 * @param canBeNegative Whether the value can be negative
 * @param max Maximum allowed value
 * @param min Minimum allowed value
 * @returns True if the float is valid, false otherwise
 */
const validateFloat = (
    value: any,
    canBeZero?: boolean,
    canBeNegative?: boolean,
    max?: number,
    min?: number
): boolean => {
    if (!max)
        max = Math.pow(2,33)-1;
    if (!min)
        if (canBeNegative)
            min = -Math.pow(2,33)+1;
        else
            min = 0;
    
    if (typeof value !== 'number')
        return false;
    if (isNaN(value))
        return false;
    let parts = value.toString().split('.');
    if (parts.length > 2)
        return false;
    if (parts.length === 2 && parts[1].length > 6)
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

export default validateFloat; 