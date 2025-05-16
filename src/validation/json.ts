/**
 * Validates JSON values for content and profile data
 * @param value Value to validate
 * @param max Maximum allowed JSON string length
 * @returns True if the JSON is valid, false otherwise
 */
const validateJson = (
    value: any,
    max: number
): boolean => {
    if (!value)
        return false;
    if (typeof value !== 'object')
        return false;
    try {
        if (JSON.stringify(value).length > max)
            return false;
    } catch (error) {
        return false;
    }

    return true;
};

export default validateJson; 