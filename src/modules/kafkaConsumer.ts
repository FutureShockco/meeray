import { Kafka, logLevel, Consumer } from 'kafkajs';
import fs from 'fs';
import logger from '../logger.js';
import notifications from './notifications.js';
import settings from '../settings.js';

// Detect whether the process is running inside a container. Reuse same heuristic as producer module.
function isRunningInContainer(): boolean {
    if (process.env.KAFKA_FORCE_CONTAINER === 'true') return true;
    if (process.env.KAFKA_FORCE_HOST === 'true') return false;
    try {
        if (fs.existsSync('/.dockerenv')) return true;
    } catch (e) {}
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        if (/docker|kubepods|containerd/.test(cgroup)) return true;
    } catch (e) {}
    return false;
}

const defaultBroker = isRunningInContainer() ? 'kafka:9092' : 'localhost:29092';
const rawBrokers = process.env.KAFKA_BROKERS || process.env.KAFKA_BROKER || defaultBroker;
const KAFKA_BROKERS = rawBrokers.split(',').map(s => s.trim()).filter(Boolean);
const KAFKA_CLIENT_ID = process.env.KAFKA_CONSUMER_CLIENT_ID || `meeray-event-consumer-${Math.floor(Math.random() * 10000)}`;

let kafka: Kafka | null = null;
let consumer: Consumer | null = null;
// In-memory ring buffer of recently-received messages for debugging/inspection
const LAST_MESSAGES_BUFFER_SIZE = Number(process.env.KAFKA_LAST_MESSAGES_BUFFER_SIZE) || 200;
const lastMessages: any[] = [];

export async function initializeKafkaConsumer(): Promise<void> {
    if (!settings.useNotification) {
        logger.info('[kafka-consumer] USE_NOTIFICATION disabled; skipping Kafka consumer initialization.');
        return;
    }

    if (consumer) {
        logger.info('[kafka-consumer] Kafka consumer already initialized.');
        return;
    }

    try {
        kafka = new Kafka({
            clientId: KAFKA_CLIENT_ID,
            brokers: KAFKA_BROKERS,
            logLevel: logLevel.WARN,
        });

        // Increase sessionTimeout to be more tolerant of short blocking operations
        consumer = kafka.consumer({
            groupId: process.env.KAFKA_CONSUMER_GROUP || 'meeray-notifications-group',
            // 60s session timeout to allow transient delays; adjust if you have stricter SLAs
            sessionTimeout: Number(process.env.KAFKA_CONSUMER_SESSION_TIMEOUT) || 60000,
        });
        await consumer.connect();
        logger.info(`[kafka-consumer] Connected to Kafka brokers: ${KAFKA_BROKERS.join(',')}`);

        // Attach consumer event listeners for diagnostics (kafkajs exposes events via consumer.events)
        try {
            const events = (consumer as any).events;
            if (events) {
                if (events.GROUP_JOIN) {
                    consumer.on(events.GROUP_JOIN, (e: any) => {
                        logger.info('[kafka-consumer] GROUP_JOIN', {
                            generationId: e.payload?.generationId,
                            groupId: e.payload?.groupId,
                            memberId: e.payload?.memberId,
                            leaderId: e.payload?.leaderId,
                        });
                    });
                }
                if (events.HEARTBEAT) {
                    consumer.on(events.HEARTBEAT, (e: any) => {
                        logger.debug('[kafka-consumer] HEARTBEAT event');
                    });
                }
                if (events.REBALANCING) {
                    consumer.on(events.REBALANCING, (e: any) => {
                        logger.warn('[kafka-consumer] REBALANCING event', e.payload || e);
                    });
                }
                if (events.CRASH) {
                    consumer.on(events.CRASH, (e: any) => {
                        logger.error('[kafka-consumer] CRASH event', e.payload || e);
                    });
                }
            }
        } catch (err) {
            logger.warn('[kafka-consumer] Failed to attach consumer event listeners:', err);
        }

        const topics = [
            process.env.KAFKA_TOPIC_NOTIFICATIONS || 'notifications',
            process.env.KAFKA_TOPIC_MARKET_EVENTS || 'dex-market-updates',
        ];
        for (const t of topics) {
            await consumer.subscribe({ topic: t, fromBeginning: false });
            logger.info(`[kafka-consumer] Subscribed to topic '${t}'`);
        }

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                try {
                    const value = message.value ? message.value.toString() : null;
                    let parsed: any = value;
                    try {
                        parsed = value ? JSON.parse(value) : null;
                    } catch (e) {
                        // leave as string if not JSON
                    }

                    const payload = {
                        t: 'NOTIFICATION',
                        topic,
                        d: parsed,
                        kafka: {
                            partition,
                            offset: message.offset,
                            key: message.key ? message.key.toString() : undefined,
                        },
                    };

                    // store a compact record in the ring buffer for diagnostics
                    try {
                        lastMessages.push({ receivedAt: Date.now(), topic, partition, offset: message.offset, key: message.key ? message.key.toString() : undefined, payload: parsed });
                        if (lastMessages.length > LAST_MESSAGES_BUFFER_SIZE) lastMessages.shift();
                    } catch (e) {
                        // ignore
                    }

                    // Make broadcasting non-blocking to avoid delaying Kafka heartbeats
                    try {
                        setImmediate(() => {
                            try {
                                notifications.broadcastNotification(payload);
                                try {
                                    const connected = notifications.getConnectedCount();
                                    logger.debug(`[kafka-consumer] Broadcasted message from topic '${topic}' to ${connected} sockets`);
                                } catch (e) {
                                    logger.debug(`[kafka-consumer] Broadcasted message from topic '${topic}' (could not determine socket count)`);
                                }
                            } catch (err) {
                                logger.error('[kafka-consumer] Failed to broadcast Kafka message to notifications sockets (async):', err);
                            }
                        });
                    } catch (err) {
                        logger.error('[kafka-consumer] Failed to schedule broadcast for Kafka message:', err);
                    }
                } catch (err) {
                    logger.error('[kafka-consumer] Error processing Kafka message:', err);
                }
            },
        });
    } catch (error: any) {
        const errMsg = error instanceof Error ? `${error.message}${error.stack ? '\n' + error.stack : ''}` : String(error);
        logger.error('[kafka-consumer] Failed to initialize Kafka consumer:', errMsg);
        consumer = null;

        // If we're running on the host and the broker list looks like the Docker service name (e.g. 'kafka'),
        // attempt a one-time fallback to localhost:29092 which Docker advertises for host clients.
        const looksLikeDockerBroker = /\bkafka\b|kafka:\d+/i.test(rawBrokers || '');
        if (!isRunningInContainer() && looksLikeDockerBroker) {
            // Allow explicit host fallback via env for custom host ports (e.g. localhost:29093)
            const hostFallback = process.env.KAFKA_HOST_FALLBACK || process.env.KAFKA_BROKER || 'localhost:29092';
            if (!KAFKA_BROKERS.includes(hostFallback)) {
                try {
                    logger.info(`[kafka-consumer] Attempting host fallback broker '${hostFallback}' since initial brokers failed and we're on host.`);
                    const fallbackKafka = new Kafka({
                        clientId: KAFKA_CLIENT_ID + '-fallback',
                        brokers: [hostFallback],
                        logLevel: logLevel.WARN,
                    });
                    const fallbackConsumer = fallbackKafka.consumer({ groupId: process.env.KAFKA_CONSUMER_GROUP || 'meeray-notifications-group' });
                    await fallbackConsumer.connect();
                    // replace consumer/kafka with the fallback ones
                    kafka = fallbackKafka;
                    consumer = fallbackConsumer;

                    const topics = [
                        process.env.KAFKA_TOPIC_NOTIFICATIONS || 'notifications',
                        process.env.KAFKA_TOPIC_MARKET_EVENTS || 'dex-market-updates',
                    ];
                    for (const t of topics) {
                        await consumer.subscribe({ topic: t, fromBeginning: false });
                        logger.info(`[kafka-consumer] (fallback) Subscribed to topic '${t}'`);
                    }

                    await consumer.run({
                        eachMessage: async ({ topic, partition, message }) => {
                            try {
                                const value = message.value ? message.value.toString() : null;
                                let parsed: any = value;
                                try { parsed = value ? JSON.parse(value) : null; } catch (e) {}
                                const payload = {
                                    t: 'NOTIFICATION',
                                    topic,
                                    d: parsed,
                                    kafka: { partition, offset: message.offset, key: message.key ? message.key.toString() : undefined },
                                };
                                // store in ring buffer
                                try {
                                    lastMessages.push({ receivedAt: Date.now(), topic, partition, offset: message.offset, key: message.key ? message.key.toString() : undefined, payload: parsed });
                                    if (lastMessages.length > LAST_MESSAGES_BUFFER_SIZE) lastMessages.shift();
                                } catch (e) {}
                                notifications.broadcastNotification(payload);
                                try {
                                    const connected = notifications.getConnectedCount();
                                    logger.debug(`[kafka-consumer] Broadcasted fallback message from topic '${topic}' to ${connected} sockets`);
                                } catch (e) {
                                    logger.debug(`[kafka-consumer] Broadcasted fallback message from topic '${topic}' (could not determine socket count)`);
                                }
                            } catch (err) {
                                logger.error('[kafka-consumer] Error processing fallback Kafka message:', err);
                            }
                        },
                    });

                    logger.info('[kafka-consumer] Fallback Kafka consumer connected successfully to localhost:29092');
                    return; // success
                } catch (fallbackErr) {
                    logger.error('[kafka-consumer] Host fallback attempt failed:', fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
                }
            }
        }
    }
}

export async function disconnectKafkaConsumer(): Promise<void> {
    if (consumer) {
        try {
            await consumer.disconnect();
            logger.info('[kafka-consumer] Kafka consumer disconnected.');
        } catch (err) {
            logger.error('[kafka-consumer] Error disconnecting Kafka consumer:', err);
        } finally {
            consumer = null;
        }
    } else {
        logger.info('[kafka-consumer] No Kafka consumer to disconnect.');
    }
}

export function getConsumerStatus() {
    try {
        return {
            connected: !!consumer,
            brokers: KAFKA_BROKERS,
        };
    } catch (e) {
        return { connected: false, brokers: KAFKA_BROKERS };
    }
}

export function getLastMessages(count?: number) {
    if (!count) count = 50;
    return lastMessages.slice(-Math.max(0, Math.min(count, lastMessages.length)));
}

export default {
    initializeKafkaConsumer,
    disconnectKafkaConsumer,
    getConsumerStatus,
    getLastMessages,
};
