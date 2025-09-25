import express, { Request, Response } from 'express';

import p2p from '../../p2p/index.js';

const router = express.Router();

/**
 * @api {get} /peers Get connected peers
 * @apiName GetPeers
 * @apiGroup Network
 * @apiDescription Returns a list of currently connected P2P peers (URLs).
 *
 * @apiSuccess {Boolean} success Success status
 * @apiSuccess {String[]} peers Array of peer URLs
 *
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *       "success": true,
 *       "peers": ["ws://127.0.0.1:6001", "ws://192.168.1.5:6001"]
 *     }
 *
 * @apiError {Boolean} success Success status (false)
 * @apiError {String} error Error message
 */
router.get('/', async (req: Request, res: Response) => {
    const peers: string[] = [];
    p2p.sockets.forEach(socket => {
        peers.push(socket._peerUrl || `ws://${socket._socket.remoteAddress}:${socket._socket.remotePort}`);
    });
    res.json({ success: true, peers });
});

export default router;
