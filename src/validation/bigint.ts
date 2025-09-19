const maxValue: bigint = BigInt('1000000000000000000000000000000');
/**
 * Validates a BigInt value against specified constraints
 * @param value - The value to validate (string or bigint)
 * @param allowZero - Whether to allow zero value
 * @param allowNegative - Whether to allow negative values
 * @param maxValue - Optional maximum value
 * @param minValue - Optional minimum value
 * @returns boolean indicating if value meets all constraints
 */
export default function validateBigInt(value: string | bigint, allowZero = false, allowNegative = false, minValue: bigint = BigInt(0)): boolean {
    let numValue: bigint;
    try {
        numValue = typeof value === 'bigint' ? value : BigInt(value);
    } catch {
        return false;
    }

    if (!allowZero && numValue === BigInt(0)) return false;
    if (!allowNegative && numValue < BigInt(0)) return false;
    if (numValue > maxValue) return false;
    if (minValue !== undefined && numValue < minValue) return false;

    return true;
} 