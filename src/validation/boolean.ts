/**
 * Validates array values like allowed transaction types
 * (array of strictly positive integers) with at least 1 element
 * @param value Value to validate
 * @param maxLength Maximum allowed length of the array
 * @returns True if the array is valid, false otherwise
 */
const validateBoolean = (value: any): boolean => {
    if (!value) return false;
    if (typeof value !== 'boolean') return false;

    return true;
};

export default validateBoolean;
