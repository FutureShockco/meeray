let log4js = require('log4js')
const fs = require('fs')
const path = require('path')

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs')
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
}

// Use node owner or a random string for the log file name
const nodeIdentifier = process.env.NODE_OWNER || Math.random().toString(36).substring(7)
const logFile = path.join(logsDir, `output-${nodeIdentifier}.log`)

log4js.configure({
    levels: {
        CONS: { value: 9000, colour: 'magenta' },
        ECON: { value: 8000, colour: 'blue' },
        PERF: { value: 7000, colour: 'white' },
    },
    appenders: {
        out: { type: 'stdout', layout: {
            type: 'pattern',
            pattern: '%[%d{hh:mm:ss.SSS} [%p]%] %m',
        }},
        file: {
            type: 'file',
            filename: logFile,
            maxLogSize: 10485760,
            backups: 3,
            compress: true
        }
    },
    categories: { 
        default: { 
            appenders: ['out', 'file'],
            level: process.env.LOG_LEVEL || 'info'
        }
    }
})

let logger = log4js.getLogger()
logger.info('Logger initialized for node: ' + nodeIdentifier)
module.exports = logger