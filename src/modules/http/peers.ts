import express, { Request, Response } from 'express';

import p2p from '../../p2p/index.js';

const router = express.Router();

router.get('/', async (req: Request, res: Response) => {
    const peers: string[] = [];
    p2p.sockets.forEach(socket => {
        peers.push(socket._peerUrl || `ws://${socket._socket.remoteAddress}:${socket._socket.remotePort}`);
    });
    res.json({ success: true, peers });
});

export default router;
