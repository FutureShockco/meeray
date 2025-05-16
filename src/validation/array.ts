/**
 * Validates array values like allowed transaction types
 * (array of strictly positive integers) with at least 1 element
 * @param value Value to validate
 * @param maxLength Maximum allowed length of the array
 * @returns True if the array is valid, false otherwise
 */
const validateArray = (
    value: any,
    maxLength?: number
): boolean => {
    if (!value)
        return false;
    if (!Array.isArray(value))
        return false;
    if (value.length < 1)
        return false;
    if (maxLength && value.length > maxLength)
        return false;

    return true;
};

export default validateArray; 