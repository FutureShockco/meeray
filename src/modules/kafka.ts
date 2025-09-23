import { Kafka, Producer, logLevel } from 'kafkajs';

import logger from '../logger.js';

// Assuming logger is in the parent directory

// Configuration for Kafka - replace with your actual broker details
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'];
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
    if (producer || isInitializing) {
        if (producer && isConnected) {
            logger.info('[kafka-producer] Kafka producer already initialized and connected.');
        } else if (isInitializing) {
            logger.info('[kafka-producer] Kafka producer initialization already in progress.');
        }
        return;
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
        isInitializing = false;
        logger.info('[kafka-producer] Kafka producer connected successfully.');

        // Optional: Handle disconnects and other events
        producer.on('producer.disconnect', () => {
            logger.warn('[kafka-producer] Kafka producer disconnected.');
            isConnected = false;
            // Potentially try to reconnect or handle this scenario
        });
    } catch (error) {
        isInitializing = false;
        isConnected = false;
        logger.error(
            `[kafka-producer] Failed to initialize or connect Kafka producer: ${error instanceof Error ? error.message : String(error)}`
        );
        // Depending on the application's needs, you might want to throw the error
        // or implement a retry mechanism here.
        // For now, we'll just log it and the producer will remain null.
        producer = null; // Ensure producer is null if connection failed
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
            logger.error(
                `[kafka-producer] Failed to send event after re-initialization attempt. Producer unavailable. Topic: ${topic}`
            );
            // Optionally, you could queue this message or handle the failure in another way
            return;
        }
    }

    try {
        const stringMessage = JSON.stringify(message);
        logger.debug(
            `[kafka-producer] Sending event to Kafka topic '${topic}'. Key: '${key || 'none'}', Message: ${stringMessage}`
        );
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
            logger.error(
                `[kafka-producer] Error disconnecting Kafka producer: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            producer = null;
            isConnected = false;
        }
    } else {
        logger.info('[kafka-producer] Kafka producer was not connected or already disconnected.');
    }
}

// Optional: Initialize Kafka when this module is loaded if desired,
// or call initializeKafkaProducer() explicitly from your application's entry point.
// For an optional module, it's often better to initialize explicitly when needed.
// initializeKafkaProducer().catch(err => {
//    logger.error('[kafka-producer] Auto-initialization failed on module load.', err);
// });
