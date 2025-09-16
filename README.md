# Meeray Blockchain Node

A modular sidechain for Steem, written in TypeScript (ESM), using MongoDB for storage, Kafka for notifications, WebSocket for P2P networking, and Express for HTTP APIs.

## Sidechain Architecture

Meeray operates as a sidechain for Steem with these key characteristics:
- Processes only transactions that originate from Steem custom_json operations with our specific sidechain ID
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

## Documentation
- Coming soon

## Recovery and Sync Capabilities
- **Block Recovery**: Nodes can recover and replay blocks from any peers in the network
- **Chain Replay**: New nodes automatically replay the chain history until they catch up with the network head
- **Steem Sync Mode**: Accelerated catch-up mechanism with reduced block time when the network falls behind Steem




## Installation

### Dependencies
- NodeJS v20 or higher
- MongoDB v8 or higher
- PM2 (optional, for production)

### Prerequisites

1. Update package list and add MongoDB repo
```bash
sudo apt update
# Install prerequisites
sudo apt-get install -y gnupg curl
# Add MongoDB 8.0 PGP key
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
    sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
# Add MongoDB repository for the appropriate Ubuntu version (change `focal` if needed)
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/8.0 multiverse" | \
    sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
```

2. Install and start MongoDB after adding the repo
```bash
sudo apt-get update
# Install MongoDB
sudo apt-get install -y mongodb-org
# Start MongoDB service
sudo systemctl start mongod
# Enable MongoDB to start on boot
sudo systemctl enable mongod
```

3. (Optional) Install NVM (Node Version Manager) 
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash

# Ensure nvm is available in the current terminal session
source ~/.bashrc

# Install Node.js version 20.19.4
nvm install 20.19.4
```

4. (Optional) Install PM2 globally
```bash
npm install pm2 -g
```

5. (Optional) Download and restore the latest backup from https://meeray.com/backups/
```bash
mongorestore --uri="mongodb://127.0.0.1:27017" --archive=meeray-latest.gz --gzip
```

6. (Optional) Create a logrotate config for MongoDB (rotate logs daily, keep 14 days, compress, and create a new log file for each day)
```bash
sudo nano /etc/logrotate.d/mongodb
```
Paste the following content into the file:
```bash
/var/log/mongodb/mongod.log {
     daily
     rotate 14
     compress
     delaycompress
     missingok
     notifempty
     create 640 mongodb adm
     sharedscripts
     postrotate
          if pgrep mongod > /dev/null; then
                kill -USR1 $(pidof mongod)
          fi
     endscript
}

```

### Setup
1. Clone the repository
```bash
git clone https://github.com/FutureShockco/meeray.git
cd meeray
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
pm2 start scripts/start.sh --interpreter bash --name "meeray"
```

---

## Docker Setup (Alternative)

The easiest way to run a Meeray node and MongoDB is with Docker Compose. This will automatically build the app, set up MongoDB, and handle environment variables.

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) installed

### Quick Start
1. Clone the repository:
    ```bash
    git clone https://github.com/FutureShockco/meeray.git
    cd meeray
    ```
2. (Optional) Edit the `.env` file to customize your node settings.
3. Build and start the containers:
    ```powershell
    docker-compose build --no-cache
    docker-compose up
    ```
    This will start both the Meeray node and MongoDB. The node will connect to MongoDB using the correct Docker network.

4. (Optional) Restore the latest backup:
    - Download the backup file:
      ```powershell
      curl -o ./meeray-latest.gz https://meeray.com/backups/meeray-latest.gz
      ```
    - Restore into the running MongoDB container:
      ```powershell
      docker cp ./meeray-latest.gz meeray-mongo:/meeray-latest.gz
      docker exec -it meeray-mongo mongorestore --archive=/meeray-latest.gz --gzip --nsInclude=meeray.*
      ```

### Notes
- The node will use environment variables from `.env` and any overrides in `docker-compose.yml`.
- To run multiple nodes, duplicate the `node1` service in `docker-compose.yml` and adjust ports and environment variables as needed.
- For development, you can still use `npm run dev` locally if you have Node.js and MongoDB installed.

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## Credits & Acknowledgments

This project was originally forked from Avalon, but it has since undergone extensive modifications, improvements, a complete rewrite from JavaScript to TypeScript, and new features that make it a unique evolution of the original concept.

We appreciate the foundation laid by the Avalon developers and acknowledge their contributions to the open-source community.

## License

This project is licensed under the MIT License - see the LICENSE file for details.