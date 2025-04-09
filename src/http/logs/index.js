const express = require('express')
const fs = require('fs')
const path = require('path')

let logs = {
    init: (app) => {
        const router = express.Router()
        
        // Get list of available log files
        router.get('/', (req, res) => {
            const logsDir = path.join(process.cwd(), 'logs')
            try {
                const files = fs.readdirSync(logsDir)
                    .filter(file => file.endsWith('.log'))
                    .map(file => ({
                        name: file,
                        size: fs.statSync(path.join(logsDir, file)).size
                    }))
                res.json(files)
            } catch (error) {
                res.status(500).json({ error: 'Failed to read logs directory' })
            }
        })

        // Download a specific log file
        router.get('/:filename', (req, res) => {
            const filename = req.params.filename
            const filePath = path.join(process.cwd(), 'logs', filename)
            
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'Log file not found' })
            }

            res.download(filePath, filename, (err) => {
                if (err) {
                    res.status(500).json({ error: 'Failed to download log file' })
                }
            })
        })

        app.use('/logs', router)
    }
}

module.exports = logs 