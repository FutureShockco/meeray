import cache from '../cache.js';
import logger from '../logger.js';
import { ObjectId } from 'mongodb'; // Import ObjectId from mongodb

/**
 * Represents the structure of an event document to be stored.
 */
export interface EventDocument {
    _id: string; 
    type: string;
    timestamp: string;
    actor: string;
    data: any;
    transactionId?: string; // Optional: to link to the original transaction if available
}

/**
 * Centralized function to log a transaction event.
 *
 * @param eventType - The type of the event (e.g., 'tokenCreate', 'nftMint').
 * @param actor - The user or system entity that initiated the event.
 * @param eventData - The specific data associated with the event.
 * @param originalTransactionId - Optional: The ID of the blockchain transaction that this event relates to.
 */
export async function logTransactionEvent(
    eventType: string,
    actor: string,
    eventData: any,
    originalTransactionId?: string
): Promise<void> {
    try {
        const eventDocument: EventDocument = {
            _id: new ObjectId().toHexString(), // Use imported ObjectId
            type: eventType,
            timestamp: new Date().toISOString(),
            actor: actor,
            data: eventData,
        };

        if (originalTransactionId) {
            eventDocument.transactionId = originalTransactionId;
        }

        await new Promise<void>((resolve) => { 
            cache.insertOne('events', eventDocument, (err, result) => {
                if (err || !result) {
                    logger.error(`[event-logger] CRITICAL: Failed to log event type '${eventType}' for actor '${actor}': ${err || 'no result'}. Data: ${JSON.stringify(eventData)}`);
                    resolve(); 
                } else {
                    logger.debug(`[event-logger] Event logged: Type: ${eventType}, Actor: ${actor}, EventID: ${eventDocument._id}`);
                    resolve();
                }
            });
        });
    } catch (error) {
        logger.error(`[event-logger] Unexpected error while preparing to log event type '${eventType}': ${error instanceof Error ? error.message : String(error)}`);
    }
} 