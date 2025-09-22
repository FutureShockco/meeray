/**
 * Validates string values like usernames, targets, receivers, links, memos, tags
 * @param value String value to validate
 * @param maxLength Maximum length of the string (optional)
 * @param minLength Minimum length of the string (optional)
 * @param allowedChars Characters allowed in the string (for first and last positions)
 * @param allowedCharsMiddle Characters allowed in the middle of the string
 * @returns True if the string is valid, false otherwise
 */
const validateString = (
    value: any,
    maxLength?: number,
    minLength?: number,
    allowedChars?: string,
    allowedCharsMiddle?: string
): boolean => {
    if (!maxLength)
        maxLength = Number.MAX_SAFE_INTEGER;
    if (!minLength)
        minLength = 0;
    
    if (typeof value !== 'string')
        return false;
    
    if (value.length > maxLength)
        return false;
    
    if (value.length < minLength)
        return false;
    
    if (allowedChars)
        for (let i = 0; i < value.length; i++)
            if (allowedChars.indexOf(value[i]) === -1)
                if (i === 0 || i === value.length-1)
                    return false;
                else if (allowedCharsMiddle && allowedCharsMiddle.indexOf(value[i]) === -1)
                    return false;
                    
    return true;
};

export default validateString;