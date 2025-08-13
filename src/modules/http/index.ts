import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../logger.js';
import settings from '../../settings.js';

const http_port = settings.apiPort;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(bodyParser.json());

/**
 * HTTP server module
 */
export function init(): void {
    try {
        const app = express();
        app.use(cors());
        app.use(express.json());
        
        logger.trace('Setting up HTTP endpoints...');

        const files = fs.readdirSync(__dirname)
            .filter(file =>
                file !== 'index.ts' &&
                file !== 'index.js' &&
                file.match(/\.(ts|js)$/) &&
                !file.startsWith('.')
            );

        const endpointPromises = files.map(async (file) => {
            const filePath = path.join(__dirname, file);
            const importUrl = new URL(`file:///${filePath.replace(/\\/g, '/')}`).href;
            logger.trace(`Importing endpoint module from: ${importUrl}`);
            try {
                const endpointModule = await import(/* webpackIgnore: true */ importUrl);
                if (!endpointModule.default) {
                    logger.error(`API endpoint ${file} does not export default router`);
                    return;
                }
                // Use the filename (without extension) as the route
                const routeName = '/' + file.replace(/\.(ts|js)$/, '');
                app.use(routeName, endpointModule.default);
                logger.trace('Initialized API endpoint ' + routeName);
            } catch (error) {
                logger.error('Failed to load API endpoint ' + file, error);
            }
        });
        
        // Wait for all endpoints to initialize
        Promise.allSettled(endpointPromises).then(() => {
            logger.info('All available API endpoints initialized');
            
            // Set host for Linux platform
            if (process.platform === 'linux') {
                process.env.HOST = '0.0.0.0';
                logger.debug('Linux platform detected, binding to all interfaces (0.0.0.0)');
            }
            
            const port = http_port;
            
            logger.debug(`Starting HTTP server on port ${port}`);
            
            // Create the server 
            const server = app.listen(port, () => {
                const addr = server.address();
                if (addr && typeof addr !== 'string') {
                    logger.info(`HTTP server listening on ${addr.address}:${addr.port}`);
                } else {
                    logger.info(`HTTP server listening on port ${port}`);
                }
            });
            
            server.on('error', (error: any) => {
                if (error.code === 'EADDRINUSE') {
                    logger.error(`HTTP port ${port} is already in use. Please use a different port by setting the API_PORT environment variable.`);
                } else if (error.code === 'EACCES') {
                    logger.error(`Permission denied to use port ${port}. Try using a port number > 1024 or running with elevated privileges.`);
                } else {
                    logger.error('HTTP server error:', error);
                }
            });
        });
    } catch (error) {
        logger.error('Failed to initialize HTTP server:', error);
    }
}

export default {
    init
}; 