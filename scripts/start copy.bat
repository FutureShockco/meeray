@echo off
::!/bin/bash

:: Ports configuration
setx HTTP_PORT "3002"
setx P2P_PORT "6002"

:: MongoDB configuration
setx DB_NAME "avalon2"
setx DB_URL "mongodb://localhost:27017"

:: Peering configuration
::setx OFFLINE "1"
::setx NO_DISCOVERY "1"
::setx DISCOVERY_EXCLUDE "dtube"

:: Enable more modules
::setx NOTIFICATIONS "1"

:: Cache warmup option
setx WARMUP_ACCOUNTS "100000"
setx WARMUP_TOKENS "0"

:: Warn when a transactions takes more than X ms
setx WARN_SLOW_VALID "5"
setx WARN_SLOW_EXEC "5"

:: trace / perf / econ / cons / debug / info / warn
setx LOG_LEVEL "trace"

:: groups blocks during replay output to lower screen spam
setx REPLAY_OUTPUT "100"

setx RESET_CHAIN "1"

:: Rebuild chain state from dump, verifying every block and transactions
:: Do not forget to comment this out after rebuild
:: setx REBUILD_STATE "0"
::setx REBUILD_RESUME_BLK=

:: default peers to connect with on startup
setx PEERS "ws://localhost:6001"
setx MAX_PEERS "20"

:: your user and keys (only useful for active node owners)
setx NODE_OWNER "futureshock"
setx NODE_OWNER_PUB "h2pKuBA3LzBDyBgR8d6x9TuntE7UsKv6oK8QRUfhvEpw"
setx NODE_OWNER_PRIV "9yMf1Ed1uL7VYq5jQsUKxVzasDvkicKfgZyiKgjZ4YM9"

::src path
cd "C:\Users\hight\Desktop\ava\src"
start cmd /K node --stack-size=65500 main
