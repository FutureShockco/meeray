# Echelon: Powering Steem's future

Echelon is a next generation sidechain designed to extend the capabilities of the Steem Blockchain with advanced features like tokens, NFTs, markets, and staking. It processes Steem custom_json operations to enable these additional functionalities while maintaining the security and decentralization of the Steem blockchain.

## Features

### Token System
- Create custom tokens
- Mint tokens
- Transfer tokens between accounts
- Query token information and holder balances

### NFT System
- Create NFT collections
- Mint NFTs
- Transfer NFTs
- Query NFT collections and ownership

### Market System
- Create trading pairs
- Place buy/sell orders
- View order books and market statistics
- Track trading history

### Staking System
- Create staking pools
- Stake tokens for rewards
- Unstake tokens
- Track staking rewards

## Installation

### Dependencies
- NodeJS v16 or higher
- MongoDB v4.4 or higher
- PM2 (optional, for production)

### Setup
1. Clone the repository
```bash
git clone https://github.com/hightouch67/echelon.git
cd echelon
```

2. Install dependencies
```bash
npm install
```

3. Configure your node
```bash
cp config.example.js config.js
# Edit config.js with your settings
```

4. Start MongoDB
```bash
mongod --dbpath /your/db/path
```

5. Start the node
```bash
node start.js
```

For production:
```bash
pm2 start start.js --name ava
```

## Testnet

### Nodes/Peers (Ports http:3001, p2p/ws:6001)
- Dusseldorf: [ws://ws.steemx.com]
- New York: [ws://157.230.212.22:6001]
- Amsterdam: [ws://157.245.66.84:6001]
- Singapour: [ws://188.166.190.109:6001]
- Sydney: [ws://134.199.149.13:6001]

## API Endpoints

### Account Endpoints
- GET `/account/:account` - Get account details
- GET `/accounts/:skip/:limit` - List accounts with pagination
- GET `/history/:account/:skip?/:limit?` - Get account transaction history

### Token Endpoints
- GET `/supply` - Get total token supply
- GET `/holders/:symbol` - Get token holders for a specific token
- GET `/distribution/:symbol` - Get token distribution statistics

### NFT Endpoints
- GET `/nft/collections` - List all NFT collections
- GET `/nft/collection/:symbol` - Get collection details
- GET `/nft/tokens/:collection` - List NFTs in a collection
- GET `/nft/token/:collection/:id` - Get NFT details
- GET `/nft/account/:account` - List NFTs owned by an account

### Market Endpoints
- GET `/market/pairs` - List all trading pairs
- GET `/market/:pair` - Get market details
- GET `/market/:pair/orderbook` - Get order book
- GET `/market/:pair/history` - Get trading history
- GET `/market/account/:account` - Get account's open orders

### Staking Endpoints
- GET `/staking/pools` - List all staking pools
- GET `/staking/pool/:id` - Get pool details
- GET `/staking/stakes/:account` - List account's stakes
- GET `/staking/rewards/:account` - Get pending rewards

### Transaction Endpoints
- GET `/tx/:txid` - Get transaction details
- POST `/tx` - Submit a new transaction

### Block Endpoints
- GET `/block/:block` - Get block details
- GET `/count` - Get current block count

### Node Endpoints
- GET `/peers` - List connected peers
- GET `/leader` - Get current leader info
- GET `/schedule` - Get block production schedule

## Transaction Types

The chain supports various transaction types through Steem's custom_json operations:

1. Base Operations
- TRANSFER (0)
- APPROVE_NODE (1)
- DISAPPROVE_NODE (2)
- ENABLE_NODE (3)
- USER_JSON (4)

2. DAO Operations (5-14)
- Chain updates
- Fund requests
- Proposals
- Metadata management

3. Token Operations (15-17)
- CREATE_TOKENS
- MINT_TOKENS
- TRANSFER_TOKENS

4. NFT Operations (18-20)
- CREATE_NFT_COLLECTION
- MINT_NFT
- TRANSFER_NFT

5. Market Operations (21-22)
- CREATE_MARKET
- PLACE_ORDER

6. Staking Operations (23-25)
- CREATE_STAKING_POOL
- STAKE_TOKENS
- UNSTAKE_TOKENS

## Running a Node

1. Sync from Genesis
```bash
node start.js --replay
```

2. Sync from Snapshot
```bash
# Download latest snapshot
wget https://snapshot.steemx.com/latest.tar.gz
tar -xzvf latest.tar.gz

# Start node with snapshot
node start.js
```

3. Monitor Node
```bash
pm2 logs echelon
```

4. Stop + Reset db + Git update + Restart
```bash
 pm2 stop echelon && mongo echelon --eval "db.dropDatabase()" && git pull && pm2 restart echelon && pm2 log echelon
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## Credits & Acknowledgments

This project was originally forked from Avalon, but it has since undergone extensive modifications, improvements, and new features that make it a unique evolution of the original concept.

We appreciate the foundation laid by the Avalon developers and acknowledge their contributions to the open-source community.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
