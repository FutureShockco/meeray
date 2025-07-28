import cache from '../cache.js';
import logger from '../logger.js';
import { ObjectId } from 'mongodb'; // Import ObjectId from mongodb
import { initializeKafkaProducer, sendKafkaEvent } from '../modules/kafka.js'; // Added Kafka producer import

const KAFKA_NOTIFICATIONS_TOPIC = 'notifications';
const KAFKA_MARKET_EVENTS_TOPIC = 'dex-market-updates';

// List of event types considered market-specific
const MARKET_EVENT_TYPES = new Set([
    'TRADE_EXECUTED',
    'ORDER_CREATED',
    'ORDER_CANCELLED',
    'ORDERBOOK_SNAPSHOT',
    'ORDERBOOK_DELTA_UPDATE'
]);

/**
 * Represents the structure of an event document to be stored.
 */
export interface EventDocument {
    _id: string;
    type: string;
    timestamp: string;
    actor: string;
    data: any; // Should ideally be a more specific type, including marketId for market events
    transactionId?: string; // Optional: to link to the original transaction if available
}

/**
 * Centralized function to log a transaction event and publish it to Kafka.
 *
 * @param eventType - The type of the event (e.g., 'tokenCreate', 'nftMint', 'TRADE_EXECUTED').
 * @param actor - The user or system entity that initiated the event.
 * @param eventData - The specific data associated with the event. For market events, should contain 'marketId'.
 * @param originalTransactionId - Optional: The ID of the blockchain transaction that this event relates to.
 */
export async function logTransactionEvent(
    eventType: string,
    actor: string,
    eventData: any, // Consider defining a more specific type that includes marketId based on eventType
    originalTransactionId?: string
): Promise<void> {
    // Initialize Kafka producer (it will only run once)
    // We do this here to ensure it's ready before the first event might be sent.
    // If Kafka is optional, this could be moved or made conditional based on config.
    try {
        if (process.env.USE_NOTIFICATION === 'true') {
            await initializeKafkaProducer();
        }
    } catch (initError) {
        // Log and continue if Kafka initialization fails, as it's for notifications
        logger.error(`[event-logger] Kafka producer initialization failed: ${initError instanceof Error ? initError.message : String(initError)}. Event logging will continue without Kafka notifications.`);
    }

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

        await new Promise<void>((resolve, reject) => { // Changed to reject for clarity on promise handling
            cache.insertOne('events', eventDocument, (err, result) => {
                if (err || !result) {
                    logger.error(`[event-logger] CRITICAL: Failed to log event type '${eventType}' for actor '${actor}': ${err || 'no result'}. Data: ${JSON.stringify(eventData)}`);
                    // We might still want to try sending to Kafka or handle this more gracefully
                    reject(err || new Error('Failed to log event to cache'));
                    return;
                }

                logger.debug(`[event-logger] Event logged to cache: Type: ${eventType}, Actor: ${actor}, EventID: ${eventDocument._id}`);

                let kafkaTopic = KAFKA_NOTIFICATIONS_TOPIC;
                let kafkaKey: string | undefined = eventDocument._id; // Default key

                if (MARKET_EVENT_TYPES.has(eventType)) {
                    if (eventData && typeof eventData.marketId === 'string' && eventData.marketId.length > 0) {
                        kafkaTopic = KAFKA_MARKET_EVENTS_TOPIC;
                        kafkaKey = eventData.marketId;
                        logger.debug(`[event-logger] Identified market event '${eventType}' for market '${kafkaKey}'. Routing to topic '${kafkaTopic}'.`);
                    } else {
                        logger.warn(`[event-logger] Market event type '${eventType}' logged, but 'marketId' was missing or invalid in eventData. Falling back to default topic '${kafkaTopic}' and key '${kafkaKey}'. Data: ${JSON.stringify(eventData)}`);
                        // Optionally, could send to a specific "problem_market_events" topic or handle differently
                    }
                }
                if (process.env.USE_NOTIFICATION === 'true')
                    sendKafkaEvent(kafkaTopic, eventDocument, kafkaKey)
                        .then(() => {
                            logger.debug(`[event-logger] Event ${eventDocument._id} (Key: ${kafkaKey}) successfully queued to Kafka topic '${kafkaTopic}'.`);
                        })
                        .catch(kafkaError => {
                            // This error is for Kafka sending, the event is already in cache.
                            logger.error(`[event-logger] Failed to send event ${eventDocument._id} (Key: ${kafkaKey}) to Kafka topic '${kafkaTopic}': ${kafkaError instanceof Error ? kafkaError.message : String(kafkaError)}`);
                        })
                        .finally(() => {
                            resolve(); // Resolve the promise whether Kafka send succeeded or failed, as cache log was successful.
                        });
                else resolve()
            });
        });
    } catch (error) {
        logger.error(`[event-logger] Unexpected error in logTransactionEvent for type '${eventType}': ${error instanceof Error ? error.message : String(error)}`);
        // If this outer catch is hit, the event wasn't logged to cache or sent to Kafka.
    }
} 