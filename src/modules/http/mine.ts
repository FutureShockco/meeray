import express from 'express';
import p2p from '../../p2p/index.js';
import mining from '../../mining.js';
import { chain } from '../../chain.js';
import logger from '../../logger.js';

const router = express.Router();

router.get('/', async (req, res) => {
    mining.mineBlock((err, block) => {
        let didReplay = false;
        try {
            const localHead = chain.getLatestBlock()._id;
            let networkHead = localHead;
            for (const sock of p2p.sockets) {
                if (sock.node_status && typeof sock.node_status.head_block === 'number') {
                    if (sock.node_status.head_block > networkHead) {
                        networkHead = sock.node_status.head_block;
                    }
                }
            }
            if (localHead < networkHead) {
                // Drop all connections
                for (const sock of [...p2p.sockets]) {
                    try { p2p.closeConnection(sock); } catch (e) { }
                }
                // Reconnect to all peers and witnesses
                if (typeof p2p.keepAlive === 'function') {
                    p2p.keepAlive();
                }
                if (typeof p2p.discoveryWorker === 'function') {
                    p2p.discoveryWorker(true);
                }
                if (typeof p2p.requestPeerLists === 'function') {
                    p2p.requestPeerLists();
                }
                if (typeof p2p.recover === 'function') {
                    p2p.recover();
                }
                didReplay = true;
            }
        } catch (e) {
            logger.error(`Error during post-mine recovery check: ${e}`);
        }
        if (didReplay) {
            res.status(202).json({ success: false, replay: true, message: 'Node is behind network head, triggering recovery/replay.' });
        } else if (err) {
            res.status(500).json({ success: false, error: 'Failed to mine block', block });
        } else {
            res.json({ success: true, block });
        }
    });
});

export default router; 