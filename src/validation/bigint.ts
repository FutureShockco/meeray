import config from '../config.js';
import { toBigInt } from '../utils/bigint.js';

const maxValue: bigint = toBigInt(config.maxValue);
/**
 * Validates a BigInt value against specified constraints
 * @param value - The value to validate (string or bigint)
 * @param allowZero - Whether to allow zero value
 * @param allowNegative - Whether to allow negative values
 * @param maxValue - Optional maximum value
 * @param minValue - Optional minimum value
 * @returns boolean indicating if value meets all constraints
 */
export default function validateBigInt(
    value: string | bigint,
    allowZero = false,
    allowNegative = false,
    minValue: bigint = toBigInt(0)
): boolean {
    let numValue: bigint;
    try {
        numValue = typeof value === 'bigint' ? value : toBigInt(value);
    } catch {
        return false;
    }

    if (!allowZero && numValue === toBigInt(0)) return false;
    if (!allowNegative && numValue < toBigInt(0)) return false;
    if (numValue > maxValue) return false;
    if (minValue !== undefined && numValue < minValue) return false;

    return true;
}
