/**
 * Generates a deterministic, human-readable ID by sorting string components and joining them.
 * @param components An array of strings to be included in the ID.
 * @returns A string ID with components sorted alphabetically and joined by an underscore.
 */
export function generateDeterministicId(...components: string[]): string {
    if (!components || components.length === 0) {
        throw new Error('Cannot generate ID from empty components.');
    }
    // Filter out any null, undefined, or empty strings to prevent issues like "__" or trailing/leading underscores.
    const validComponents = components.filter(c => c && c.trim() !== '');
    if (validComponents.length === 0) {
        throw new Error('Cannot generate ID from only empty or invalid components.');
    }
    return validComponents.sort().join('_');
}
