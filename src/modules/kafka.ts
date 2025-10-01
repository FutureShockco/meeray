import { Kafka, Producer, logLevel } from 'kafkajs';
import fs from 'fs';

import logger from '../logger.js';

// Assuming logger is in the parent directory

// Detect whether the process is running inside a container.
function isRunningInContainer(): boolean {
    // Allow explicit overrides for testing
    if (process.env.KAFKA_FORCE_CONTAINER === 'true') return true;
    if (process.env.KAFKA_FORCE_HOST === 'true') return false;

    try {
        if (fs.existsSync('/.dockerenv')) return true;
    } catch (e) {
        // ignore
    }

    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        if (/docker|kubepods|containerd/.test(cgroup)) return true;
    } catch (e) {
        // ignore
    }

    return false;
}

// Default broker depends on runtime: inside containers use compose DNS, on host prefer localhost mapped port
const defaultBroker = isRunningInContainer() ? 'kafka:9092' : 'localhost:29092';
logger.info(`[kafka-producer] Runtime detection: ${isRunningInContainer() ? 'container' : 'host'}, default broker: ${defaultBroker}`);

// Configuration for Kafka - normalize broker list and accept either
// KAFKA_BROKERS (comma-separated) or the single KAFKA_BROKER env var.
const rawBrokers = process.env.KAFKA_BROKERS || process.env.KAFKA_BROKER || defaultBroker;
const KAFKA_BROKERS = rawBrokers
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'meeray-event-producer';

let kafka: Kafka | null = null;
let producer: Producer | null = null;
let isInitializing = false;
let isConnected = false;

/**
 * Initializes the Kafka client and producer.
 * Handles singleton pattern to ensure only one instance is created.
 */
export async function initializeKafkaProducer(): Promise<void> {
    // If already connected, nothing to do
    if (producer && isConnected) {
        logger.info('[kafka-producer] Kafka producer already initialized and connected.');
    }

    // If initialization is already in progress, return the same promise so callers wait
    if (isInitializing) {
        logger.info('[kafka-producer] Kafka producer initialization already in progress; awaiting existing init.');
    }

    isInitializing = true;
    logger.info(`[kafka-producer] Initializing Kafka producer with brokers: ${KAFKA_BROKERS.join(',')}`);

    try {
        kafka = new Kafka({
            clientId: KAFKA_CLIENT_ID,
            brokers: KAFKA_BROKERS,
            logLevel: logLevel.WARN, // Adjust log level as needed (ERROR, WARN, INFO, DEBUG)
            retry: {
                initialRetryTime: 300,
                retries: 5,
            },
        });

        const newProducer = kafka.producer({
            allowAutoTopicCreation: true, // Set to false in production if you manage topics manually
        });

        await newProducer.connect();
        producer = newProducer; // Assign to singleton after successful connection
        isConnected = true;
        logger.info('[kafka-producer] Kafka producer connected successfully.');

        // Optional: Handle disconnects and other events
        producer.on('producer.disconnect', () => {
            logger.warn('[kafka-producer] Kafka producer disconnected.');
            isConnected = false;
            // Potentially try to reconnect or handle this scenario
        });
    } catch (error: any) {
        isConnected = false;
        // Log full error including stack when available to make container diagnostics easier
        const errMsg = error instanceof Error ? `${error.message}${error.stack ? '\n' + error.stack : ''}` : String(error);
        logger.error(`[kafka-producer] Failed to initialize or connect Kafka producer: ${errMsg}`);
        // Ensure producer is null if connection failed
        producer = null;
        // rethrow? we swallow to let callers handle null producer
    } finally {
        isInitializing = false;
    }

}

/**
 * Sends an event (message) to a specified Kafka topic.
 *
 * @param topic - The Kafka topic to send the message to.
 * @param message - The message object to send. Must be serializable to JSON.
 * @param key - Optional key for the Kafka message, for partitioning.
 */
export async function sendKafkaEvent(topic: string, message: any, key?: string): Promise<void> {
    if (!producer || !isConnected) {
        logger.warn(`[kafka-producer] Kafka producer not initialized or not connected. Attempting to initialize...`);
        await initializeKafkaProducer(); // Attempt to initialize if not already
        if (!producer || !isConnected) {
            logger.error(`[kafka-producer] Failed to send event after re-initialization attempt. Producer unavailable. Topic: ${topic}`);
            // Optionally, you could queue this message or handle the failure in another way
            return;
        }
    }

    try {
        const stringMessage = JSON.stringify(message);
        logger.debug(`[kafka-producer] Sending event to Kafka topic '${topic}'. Key: '${key || 'none'}', Message: ${stringMessage}`);
        await producer.send({
            topic: topic,
            messages: [{ key: key, value: stringMessage }],
        });
        logger.info(`[kafka-producer] Event successfully sent to Kafka topic '${topic}'. EventID: ${message?._id || 'N/A'}`);
    } catch (error) {
        logger.error(
            `[kafka-producer] Failed to send event to Kafka topic '${topic}': ${error instanceof Error ? error.message : String(error)}. Message: ${JSON.stringify(message)}`
        );
        // Handle send errors (e.g., retries, dead-letter queue)
    }
}

/**
 * Disconnects the Kafka producer.
 * Call this on application shutdown to ensure graceful disconnection.
 */
export async function disconnectKafkaProducer(): Promise<void> {
    if (producer && isConnected) {
        try {
            await producer.disconnect();
            logger.info('[kafka-producer] Kafka producer disconnected successfully.');
        } catch (error) {
            logger.error(`[kafka-producer] Error disconnecting Kafka producer: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            producer = null;
            isConnected = false;
        }
    } else {
        logger.info('[kafka-producer] Kafka producer was not connected or already disconnected.');
    }
}
