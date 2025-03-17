#!/bin/bash

# Ports configuration
#export HTTP_PORT=3001
#export P2P_PORT=6001
#export HTTP_HOST=0.0.0.0
#export P2P_HOST=0.0.0.0

# MongoDB configuration
export DB_NAME=echelon
export DB_URL=mongodb://localhost:27017

# Directory to folder containing blocks.bson file
#export BLOCKS_DIR=

# Peering configuration
#export OFFLINE=1
#export NO_DISCOVERY=1
#export DISCOVERY_EXCLUDE=echelon-node1

# Enable more modules
#export NOTIFICATIONS=1
#export RANKINGS=1
#export TOKENS=1
#export LEADER_STATS=1
#export TX_HISTORY=1

# Cache warmup option
export WARMUP_ACCOUNTS=100000
export WARMUP_TOKENS=0

# Warn when a transactions takes more than X ms
export WARN_SLOW_VALID=5
export WARN_SLOW_EXEC=5

# trace / perf / econ / cons / debug / info / warn
export LOG_LEVEL=info

# groups blocks during replay output to lower screen spam
export REPLAY_OUTPUT=10000

# Rebuild chain state from dump, verifying every block and transactions
# Do not forget to comment this out after rebuild
#export REBUILD_STATE=1
#export REBUILD_WRITE_INTERVAL=10000
#export REBUILD_NO_VALIDATE=1
export STEEM_API="https://api.steemit.com"
# default peers to connect with on startup
export PEERS=
export MAX_PEERS=20

# your user and keys (only useful for active node owners)
export NODE_OWNER="echelon-node1"
export NODE_OWNER_PUB="e27B66QHwRLjnjxi5KAa9G7fLSDajtoB6CxuZ87oTdfS"
export NODE_OWNER_PRIV="AFW24kVuhjd4YRcK9qVJe72k3tQYJfGH7k45NRhupjLn"

# Memory limit for in-memory rebuild (in MB)
export NODE_OPTIONS=--max_old_space_size=8192

node --stack-size=65500 src/main
