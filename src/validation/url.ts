/**
 * Validates url value
 * @param value String value to validate
 * @param maxLength Maximum length of the string (optional)
 * @returns True if the string is valid, false otherwise
 */
const validateUrl = (value: string, maxLength = 2048): boolean => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        return false;
    }

    try {
        const parsed = new URL(value); // Throws if invalid
        // Only allow http or https
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }
        // Require a hostname
        if (!parsed.hostname || parsed.hostname.length === 0) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
};

/**
 * Validates logo URL
 * @param value String value to validate
 * @param maxLength Maximum length of the string (optional)
 * @returns True if the string is valid, false otherwise
 */
function validateLogoUrl(value: string, maxLength = 2048): boolean {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;

    try {
        const parsed = new URL(value);

        // Only HTTPS for logos
        if (parsed.protocol !== 'https:') return false;

        if (!parsed.hostname) return false;

        // Optional: check common image extensions
        if (!/\.(png|jpg|jpeg|svg|gif)$/i.test(parsed.pathname)) return false;

        return true;
    } catch {
        return false;
    }
}

export { validateLogoUrl, validateUrl };
