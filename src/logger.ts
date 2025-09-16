import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logsDir = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');

if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const validLogLevels = [
    'fatal',
    'error',
    'perf',
    'warn',
    'info',
    'http',
    'verbose',
    'debug',
    'silly',
    'trace',
    'cons'
];

let logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

if (!validLogLevels.includes(logLevel)) {
    console.warn(`Invalid LOG_LEVEL "${logLevel}" specified. Using "info" instead.`);
    console.warn(`Valid levels are: ${validLogLevels.join(', ')}`);
    logLevel = 'info';
}

const nodeIdentifier = process.env.STEEM_ACCOUNT || Math.random().toString(36).substring(7);
const logFile = path.join(logsDir, `output-${nodeIdentifier}.log`);

// Console format with timestamp first
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
        return `[${timestamp}] ${level}: ${message} ${metaStr}`;
    })
);

// Define custom levels
const customLevels = {
    levels: {
        fatal: 0,
        error: 1,
        perf: 2,
        warn: 3,
        info: 4,
        http: 5,
        verbose: 6,
        debug: 7,
        silly: 8,
        trace: 9,
        cons: 10
    },
    colors: {
        fatal: 'redBG white',
        error: 'red',
        perf: 'magenta',
        warn: 'yellow',
        info: 'green',
        http: 'cyan',
        verbose: 'blue',
        debug: 'white',
        silly: 'grey',
        trace: 'grey',
        cons: 'inverse'
    }
};

winston.addColors(customLevels.colors);

const logr = winston.createLogger({
    levels: customLevels.levels,
    level: logLevel,
    format: winston.format.errors({ stack: true }),
    transports: [
        new winston.transports.Console({ format: consoleFormat }),
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
    }
});

export default logger;
