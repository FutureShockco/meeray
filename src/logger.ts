import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}
// Get the log level from environment or default to 'info'
// NOTE: Winston accepts these log levels (highest to lowest): error, warn, info, http, verbose, debug, silly
const validLogLevels = ['fatal', 'error', , 'perf', 'warn', 'info', 'http', 'verbose', 'debug', 'silly', 'trace', 'cons'];
let logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Validate the log level
if (!validLogLevels.includes(logLevel)) {
    console.warn(`Invalid LOG_LEVEL "${logLevel}" specified. Using "info" instead.`);
    console.warn(`Valid levels are: ${validLogLevels.join(', ')}`);
    logLevel = 'info';
}


// Use node owner or a random string for the log file name
const nodeIdentifier = process.env.STEEM_ACCOUNT || Math.random().toString(36).substring(7);
const logFile = path.join(logsDir, `output-${nodeIdentifier}.log`);

const logr = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            return `[${timestamp}] ${level}: ${message} ${metaStr}`;
        })
    ),
    transports: [
        new winston.transports.Console({ level: logLevel }),
        new winston.transports.File({ 
            filename: logFile,
            level: logLevel,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ) 
        })
    ]
});

const logger = Object.assign(logr, {
    setLogLevel: (level: string) => {
        const newLevel = level.toLowerCase();
        if (!validLogLevels.includes(newLevel)) {
            logr.warn(`Invalid log level: ${newLevel}. Valid levels are: ${validLogLevels.join(', ')}`);
            return;
        }
        logr.level = newLevel;
        logr.info(`Log level changed to: ${newLevel}`);
    },
    cons: (message: string, ...meta: any[]) => logr.info(`[CONS] ${message}`, ...meta),
    perf: (message: string, ...meta: any[]) => logr.debug(`[PERF] ${message}`, ...meta),
    fatal: (message: string, ...meta: any[]) => logr.error(`[FATAL] ${message}`, ...meta),
    trace: (message: string, ...meta: any[]) => logr.debug(`[TRACE] ${message}`, ...meta)
});

// Attach additionalMethods to logger

export default logger; 