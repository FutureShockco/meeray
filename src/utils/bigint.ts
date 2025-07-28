// Maximum expected length for any BigInt value we'll handle
// This allows for numbers up to 999,999,999,999,999,999,999,999,999,999 (30 digits)
// Which is more than sufficient even for tokens with 18 decimal places
const MAX_INTEGER_LENGTH = 30;

// Mapping of token symbols to their decimal places for proper padding
const TOKEN_DECIMALS: { [symbol: string]: number } = {};

/**
 * Set decimal places for a token
 * @param symbol Token symbol
 * @param decimals Number of decimal places
 */
export function setTokenDecimals(symbol: string, decimals: number): void {
    TOKEN_DECIMALS[symbol] = decimals;
}

/**
 * Get decimal places for a token
 * @param symbol Token symbol
 * @returns Number of decimal places, defaults to 8 if not set
 */
export function getTokenDecimals(symbol: string): number {
    return TOKEN_DECIMALS[symbol] ?? 8; // Default to 8 decimals if not set
}

/**
 * Convert a value to BigInt, handling null, undefined, and string inputs
 */
export function toBigInt(value: string | bigint | number | null | undefined): bigint {
    if (value === null || value === undefined) return BigInt(0);
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.floor(value)); // Convert numbers safely
    // Remove padding before converting to BigInt
    return BigInt(value.replace(/^0+/, '') || '0');
}

/**
 * Convert a BigInt to padded string for database storage
 * This ensures correct lexicographical sorting in MongoDB
 * @param value The BigInt value to convert
 * @param padLength Optional custom pad length
 * @returns A zero-padded string representation
 */
export function toString(value: bigint, padLength: number = MAX_INTEGER_LENGTH): string {
    const str = value.toString();
    // Ensure positive numbers are properly padded for lexicographical sorting
    return str.startsWith('-')
        ? '-' + str.slice(1).padStart(padLength, '0')
        : str.padStart(padLength, '0');
}

/**
 * Format a token amount with proper decimal places
 * @param value The BigInt value to format
 * @param symbol The token symbol to determine decimal places
 * @returns A properly formatted string with decimal places
 */
export function formatTokenAmount(value: bigint, symbol: string): string {
    const decimals = getTokenDecimals(symbol);
    const str = value.toString().padStart(decimals + 1, '0');
    const integerPart = str.slice(0, -decimals) || '0';
    const decimalPart = str.slice(-decimals);
    return `${integerPart}.${decimalPart}`;
}

/**
 * Parse a token amount string to BigInt
 * @param value The decimal string to parse
 * @param symbol The token symbol to determine decimal places
 * @returns A BigInt value
 */
export function parseTokenAmount(value: string, symbol: string): bigint {
    const decimals = getTokenDecimals(symbol);
    const [integerPart = '0', decimalPart = ''] = value.split('.');
    const paddedDecimal = decimalPart.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(integerPart + paddedDecimal);
}

/**
 * Create a MongoDB query operator with proper padding
 * @param operator The MongoDB comparison operator ('$gt', '$lt', etc.)
 * @param value The BigInt value to compare against
 * @param padLength Optional custom pad length
 * @returns An object with the properly padded query operator
 */
export function createMongoQuery(operator: '$gt' | '$gte' | '$lt' | '$lte' | '$eq', value: bigint, padLength: number = MAX_INTEGER_LENGTH) {
    return { [operator]: toString(value, padLength) };
}

/**
 * Type utility for database conversions
 */
export type BigIntToString<T> = {
    [K in keyof T]: T[K] extends bigint ? string : T[K];
};

export type RecursiveBigIntToString<T> = {
    [P in keyof T]: T[P] extends bigint
    ? string
    : T[P] extends Array<infer U>
    ? Array<RecursiveBigIntToString<U>>
    : T[P] extends object | null | undefined
    ? T[P] extends null | undefined
    ? T[P]
    : RecursiveBigIntToString<T[P]>
    : T[P];
};

export type StringToBigInt<T> = {
    [K in keyof T]: T[K] extends string ? bigint : T[K];
};

/**
 * Convert an object's numeric fields from strings to BigInt
 */
export function convertToBigInt<T>(obj: BigIntToString<T>, numericFields: (keyof T)[]): T {
    const result = { ...obj };
    for (const field of numericFields) {
        if (obj[field] !== undefined && obj[field] !== null) {
            (result[field] as any) = toBigInt(obj[field]);
        }
    }
    return result as T;
}

/**
 * Convert an object's BigInt fields to strings for database storage
 */
export function convertToString<T>(obj: T, numericFields: (keyof T)[]): BigIntToString<T> {
    const result = { ...obj };
    for (const field of numericFields) {
        if (obj[field] !== undefined && obj[field] !== null && typeof obj[field] === 'bigint') {
            (result[field] as any) = toString(obj[field] as bigint);
        }
    }
    return result as BigIntToString<T>;
}

/**
 * Recursively convert all BigInt fields in an object (and its nested objects/arrays) to strings.
 */
export function convertAllBigIntToStringRecursive<T extends object>(obj: T): RecursiveBigIntToString<T> {
    if (obj === null || typeof obj !== 'object') {
        return obj as any; // Should not happen if T is constrained to object, but good for safety
    }

    const result: any = Array.isArray(obj) ? [] : {};

    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const value = obj[key];
            if (typeof value === 'bigint') {
                result[key] = toString(value);
            } else if (Array.isArray(value)) {
                result[key] = value.map(item =>
                    typeof item === 'object' && item !== null
                        ? convertAllBigIntToStringRecursive(item)
                        : item
                );
            } else if (typeof value === 'object' && value !== null) {
                result[key] = convertAllBigIntToStringRecursive(value as object);
            } else {
                result[key] = value;
            }
        }
    }
    return result as RecursiveBigIntToString<T>;
}

/**
 * Safely perform arithmetic with BigInt values
 */
export const BigIntMath = {
    max(...values: bigint[]): bigint {
        return values.reduce((max, val) => val > max ? val : max);
    },

    min(...values: bigint[]): bigint {
        return values.reduce((min, val) => val < min ? val : min);
    },

    abs(value: bigint): bigint {
        return value < BigInt(0) ? -value : value;
    },

    // For percentage calculations (e.g., fees)
    percentage(value: bigint, percent: number): bigint {
        return (value * BigInt(Math.floor(percent * 100))) / BigInt(100);
    },

    // Basic arithmetic operations with safe conversions
    add(a: bigint | string | number, b: bigint | string | number): bigint {
        return toBigInt(a) + toBigInt(b);
    },

    sub(a: bigint | string | number, b: bigint | string | number): bigint {
        return toBigInt(a) - toBigInt(b);
    },

    mul(a: bigint | string | number, b: bigint | string | number): bigint {
        return toBigInt(a) * toBigInt(b);
    },

    div(a: bigint | string | number, b: bigint | string | number): bigint {
        const divisor = toBigInt(b);
        if (divisor === 0n) throw new Error('Division by zero');
        return toBigInt(a) / divisor;
    },

    // Square root for BigInt using binary search
    sqrt(value: bigint): bigint {
        if (value < BigInt(0)) {
            throw new Error('Square root of negative numbers is not supported');
        }
        if (value < BigInt(2)) {
            return value;
        }

        let x0 = BigInt(0);
        let x1 = value;
        while (x0 !== x1) {
            x0 = x1;
            x1 = (x1 + value / x1) / BigInt(2);
        }
        return x0;
    },

    // Safe conversion helpers
    toBigInt(value: string | number | bigint | null | undefined): bigint {
        return toBigInt(value);
    },

    toNumber(value: bigint): number {
        // Only convert if the value fits in a safe integer
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
            throw new Error('BigInt value too large to convert to number');
        }
        return Number(value);
    },

    // Additional helper functions
    isZero(value: bigint | string | number): boolean {
        return toBigInt(value) === 0n;
    },

    isPositive(value: bigint | string | number): boolean {
        return toBigInt(value) > 0n;
    },

    isNegative(value: bigint | string | number): boolean {
        return toBigInt(value) < 0n;
    },

    // Format BigInt with decimal places for display
    formatWithDecimals(value: bigint, decimals: number): string {
        const str = value.toString().padStart(decimals + 1, '0');
        const integerPart = str.slice(0, -decimals) || '0';
        const decimalPart = str.slice(-decimals);
        return `${integerPart}.${decimalPart}`;
    },

    // Parse decimal string to BigInt with given decimal places
    parseFromDecimals(value: string, decimals: number): bigint {
        const [integerPart = '0', decimalPart = ''] = value.split('.');
        const paddedDecimal = decimalPart.padEnd(decimals, '0').slice(0, decimals);
        return BigInt(integerPart + paddedDecimal);
    },

    // Comparison functions for sorting
    compare(a: bigint | string | number, b: bigint | string | number): number {
        const bigA = toBigInt(a);
        const bigB = toBigInt(b);
        if (bigA === bigB) return 0;
        return bigA > bigB ? 1 : -1;
    },

    compareDesc(a: bigint | string | number, b: bigint | string | number): number {
        return this.compare(b, a); // Reverse the comparison for descending order
    },

    /**
     * Create a range query for MongoDB
     * @param min Minimum value (inclusive)
     * @param max Maximum value (inclusive)
     * @param padLength Optional custom pad length
     * @returns MongoDB range query object
     */
    createRangeQuery(min: bigint, max: bigint, padLength: number = MAX_INTEGER_LENGTH) {
        return {
            $gte: toString(min, padLength),
            $lte: toString(max, padLength)
        };
    },

    /**
     * Sort specification for MongoDB queries
     * @param field The field name to sort by
     * @param order 1 for ascending, -1 for descending
     * @returns MongoDB sort specification
     */
    createSortSpec(field: string, order: 1 | -1 = 1) {
        return { [field]: order };
    },

    /**
     * Format a token amount with proper decimal places
     */
    formatToken(value: bigint, symbol: string): string {
        return formatTokenAmount(value, symbol);
    },

    /**
     * Parse a token amount string
     */
    parseToken(value: string, symbol: string): bigint {
        return parseTokenAmount(value, symbol);
    }
}; 