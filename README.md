# Echelon Blockchain Node

A modular sidechain for Steem, written in TypeScript (ESM), using MongoDB for storage, Kafka for notifications, WebSocket for P2P networking, and Express for HTTP APIs.

## Sidechain Architecture

Echelon operates as a sidechain for Steem with these key characteristics:
- Processes only transactions that originate from Steem custom_json operations with our specific sidechain ID
- Does not accept transactions from outside the scope of Steem blocks
- Implements block recovery/replay mechanisms to allow nodes to synchronize with peers
- Supports special sync mode to rapidly catch up with Steem blockchain when behind

## Features
- Steem custom_json transaction listener
- Hardcoded operations (transaction logic)
- DPoS consensus with witness scheduling and rewards
- P2P networking via WebSocket
- MongoDB for accounts, tokens, and blockchain state
- Kafka for event notifications
- Express HTTP API for querying accounts, tokens, etc.

## Recovery and Sync Capabilities
- **Block Recovery**: Nodes can recover and replay blocks from any peers in the network
- **Chain Replay**: New nodes automatically replay the chain history until they catch up with the network head
- **Steem Sync Mode**: Accelerated catch-up mechanism with reduced block time when the network falls behind Steem

## Project Structure
```
/src
  /api         # HTTP endpoints
  /operations  # Operations (transaction logic)
  /consensus   # DPoS logic
  /db          # MongoDB models
  /kafka       # Kafka logic
  /p2p         # WebSocket networking
  /steem       # Steem custom_json handler
  /utils       # Utilities
  index.ts     # Main entry point
```

## Setup
1. Install dependencies:
   ```sh
   npm install
   ```
2. Configure environment variables in `.env` (see template below):
   ```env
   MONGO_URI=mongodb://localhost:27017/steem_sidechain
   KAFKA_BROKER=localhost:9092
   KAFKA_CLIENT_ID=steem-sidechain
   STEEM_ACCOUNT=your_steem_account
   STEEM_POSTING_KEY=your_posting_key
   ```
3. Build and run:
   ```sh
   npm run build
   npm start
   # or for development
   npm run dev
   ```

## License
MIT 