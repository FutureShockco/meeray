// Import ObjectId from mongodb
import cache from '../cache.js';
import logger from '../logger.js';
import { initializeKafkaProducer, sendKafkaEvent } from '../modules/kafka.js';
// Added Kafka producer import
import settings from '../settings.js';
import { deterministicIdFrom } from '../utils/deterministic-id.js';

const KAFKA_NOTIFICATIONS_TOPIC = 'notifications';
const KAFKA_MARKET_EVENTS_TOPIC = 'dex-market-updates';

// List of event types considered market-specific
const MARKET_EVENT_TYPES = new Set(['TRADE_EXECUTED', 'ORDER_CREATED', 'ORDER_CANCELLED', 'ORDERBOOK_SNAPSHOT', 'ORDERBOOK_DELTA_UPDATE']);

/**
 * Represents the structure of an event document to be stored.
 */
export interface EventDocument {
    _id: string;
    category: string; // High-level category: 'nft', 'token', 'defi', 'launchpad', 'market'
    action: string; // Specific action: 'mint', 'transfer', 'swap', 'listed', etc.
    type: string; // Legacy field: category_action (for backward compatibility)
    timestamp: string;
    actor: string;
    data: any; // Should ideally be a more specific type, including marketId for market events
    transactionId?: string; // Optional: to link to the original transaction if available
}

/**
 * Centralized function to log a transaction event with two-level structure and publish it to Kafka.
 *
 * @param category - High-level category ('nft', 'token', 'defi', 'launchpad', 'market') OR legacy eventType string
 * @param action - Specific action ('mint', 'transfer', 'swap', 'listed') OR actor if using legacy format
 * @param eventDataOrActor - Event data if using new format, OR actor if using legacy format
 * @param originalTransactionIdOrEventData - TransactionId if new format, OR eventData if legacy format
 * @param legacyTransactionId - TransactionId if using legacy format (5th parameter)
 */
export async function logTransactionEvent(
    category: string,
    action: string,
    eventDataOrActor: any,
    originalTransactionIdOrEventData?: string | any,
    legacyTransactionId?: string
): Promise<void> {
    // Initialize Kafka producer (it will only run once)
    // We do this here to ensure it's ready before the first event might be sent.
    // If Kafka is optional, this could be moved or made conditional based on config.
    try {
        if (settings.useNotification) {
            await initializeKafkaProducer();
        }
    } catch (initError) {
        // Log and continue if Kafka initialization fails, as it's for notifications
        logger.error(
            `[event-logger] Kafka producer initialization failed: ${initError instanceof Error ? initError.message : String(initError)}. Event logging will continue without Kafka notifications.`
        );
    }

    try {
        // Determine if this is new format (category + action) or legacy format (eventType)
        let finalCategory: string;
        let finalAction: string;
        let finalActor: string;
        let finalEventData: any;
        let finalTransactionId: string | undefined;

        // Detect legacy format: if action looks like an account name and eventDataOrActor is event data
        const isLegacyFormat =
            action.length >= 3 &&
            action.length <= 16 &&
            typeof eventDataOrActor === 'object' &&
            !originalTransactionIdOrEventData?.startsWith?.('token') &&
            !originalTransactionIdOrEventData?.startsWith?.('nft');

        if (isLegacyFormat) {
            // Legacy format: logTransactionEvent('nft_mint', 'user123', {...data}, 'tx123')
            const legacyEventType = category;
            finalActor = action;
            finalEventData = eventDataOrActor;
            finalTransactionId = typeof originalTransactionIdOrEventData === 'string' ? originalTransactionIdOrEventData : legacyTransactionId;

            // Parse legacy event type into category + action
            const parts = legacyEventType.split('_');
            if (parts.length >= 2) {
                finalCategory = parts[0];
                finalAction = parts.slice(1).join('_');
            } else {
                finalCategory = 'unknown';
                finalAction = legacyEventType;
            }
        } else {
            // New format: logTransactionEvent('nft', 'mint', 'user123', {...data}, 'tx123')
            finalCategory = category;
            finalAction = action;
            finalActor = eventDataOrActor;
            finalEventData = originalTransactionIdOrEventData && typeof originalTransactionIdOrEventData === 'object' ? originalTransactionIdOrEventData : {};
            finalTransactionId = typeof originalTransactionIdOrEventData === 'string' ? originalTransactionIdOrEventData : legacyTransactionId;
        }

        const deterministicParts = [finalCategory, finalAction, finalActor || 'anon', finalTransactionId || '', Date.now()];
        const eventId = deterministicIdFrom(deterministicParts, 24);

        const eventDocument: EventDocument = {
            _id: eventId,
            category: finalCategory,
            action: finalAction,
            type: `${finalCategory}_${finalAction}`, // Legacy compatibility
            timestamp: new Date().toISOString(),
            actor: finalActor,
            data: finalEventData,
        };

        // Ensure transactionId is present on the event document when possible
        if (finalTransactionId) {
            eventDocument.transactionId = finalTransactionId;
        } else if (finalEventData && typeof finalEventData === 'object') {
            const inferred = finalEventData.transactionId || finalEventData.txId || finalEventData.tx || finalEventData.transaction || undefined;
            if (inferred) {
                eventDocument.transactionId = inferred;
                logger.debug(`[event-logger] Inferred transactionId for event ${eventDocument._id}: ${inferred}`);
            }
        }

        await new Promise<void>((resolve, reject) => {
            // Changed to reject for clarity on promise handling
            cache.insertOne('events', eventDocument, (err, result) => {
                if (err || !result) {
                    logger.error(
                        `[event-logger] CRITICAL: Failed to log event ${finalCategory}_${finalAction} for actor '${finalActor}': ${err || 'no result'}. Data: ${JSON.stringify(finalEventData)}`
                    );
                    // We might still want to try sending to Kafka or handle this more gracefully
                    reject(err || new Error('Failed to log event to cache'));
                    return;
                }

                logger.debug(
                    `[event-logger] Event logged to cache: Category: ${finalCategory}, Action: ${finalAction}, Actor: ${finalActor}, EventID: ${eventDocument._id}`
                );

                let kafkaTopic = KAFKA_NOTIFICATIONS_TOPIC;
                let kafkaKey: string | undefined = eventDocument._id; // Default key

                if (MARKET_EVENT_TYPES.has(eventDocument.type)) {
                    if (finalEventData && typeof finalEventData.marketId === 'string' && finalEventData.marketId.length > 0) {
                        kafkaTopic = KAFKA_MARKET_EVENTS_TOPIC;
                        kafkaKey = finalEventData.marketId;
                        logger.debug(
                            `[event-logger] Identified market event '${eventDocument.type}' for market '${kafkaKey}'. Routing to topic '${kafkaTopic}'.`
                        );
                    } else {
                        logger.warn(
                            `[event-logger] Market event type '${eventDocument.type}' logged, but 'marketId' was missing or invalid in eventData. Falling back to default topic '${kafkaTopic}' and key '${kafkaKey}'. Data: ${JSON.stringify(finalEventData)}`
                        );
                        // Optionally, could send to a specific "problem_market_events" topic or handle differently
                    }
                }
                if (settings.useNotification) {
                    // Send to specific topic (notifications or market-updates)
                    // The WebSocket server will broadcast to clients subscribed to 'all-events'
                    sendKafkaEvent(kafkaTopic, eventDocument, kafkaKey)
                        .then(() => {
                            logger.debug(`[event-logger] Event ${eventDocument._id} (Key: ${kafkaKey}) successfully queued to Kafka topic '${kafkaTopic}'.`);
                        })
                        .catch(kafkaError => {
                            // This error is for Kafka sending, the event is already in cache.
                            logger.error(
                                `[event-logger] Failed to send event ${eventDocument._id} (Key: ${kafkaKey}) to Kafka topic '${kafkaTopic}': ${kafkaError instanceof Error ? kafkaError.message : String(kafkaError)}`
                            );
                        })
                        .finally(() => {
                            resolve(); // Resolve the promise whether Kafka send succeeded or failed, as cache log was successful.
                        });
                } else {
                    resolve();
                }
            });
        });
    } catch (error) {
        logger.error(`[event-logger] Unexpected error in logTransactionEvent: ${error instanceof Error ? error.message : String(error)}`);
        // If this outer catch is hit, the event wasn't logged to cache or sent to Kafka.
    }
}

/**
 * Modern helper function for logging events with the new two-level structure.
 *
 * @param category - High-level category: 'nft', 'token', 'defi', 'launchpad', 'market'
 * @param action - Specific action: 'mint', 'transfer', 'swap', 'listed', etc.
 * @param actor - The user or system entity that initiated the event
 * @param eventData - The specific data associated with the event
 * @param transactionId - Optional: The ID of the blockchain transaction
 */
export async function logEvent(category: string, action: string, actor: string, eventData: any, transactionId?: string): Promise<void> {
    logger.info(`${category}:${action} transaction: ${JSON.stringify(eventData)} created successfully by ${actor}.`);
    return logTransactionEvent(category, action, actor, eventData, transactionId);
}
