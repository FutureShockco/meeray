export function generateListingId(collectionSymbol: string, instanceId: string, seller: string): string {
    return `${collectionSymbol}_${instanceId}_${seller}`;
}