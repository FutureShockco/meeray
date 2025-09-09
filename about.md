Complete Workflow Diagram for MeeRay Blockchain Project
Overview
MeeRay is a Layer 2 sidechain that bridges to the Steem blockchain, providing DeFi functionality including DEX (AMM+Orderbook), NFT marketplace, farming, pools, and launchpad services.
 
═══════════════════════════════════════════════════════════════════════════════════
                              MEERAY BLOCKCHAIN ARCHITECTURE
═══════════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────────┐
│                                  STARTUP PHASE                                   │
└─────────────────────────────────────────────────────────────────────────────────┘

1. NODE INITIALIZATION
   ├── main.ts entry point
   ├── Version check (Node.js 18/20/22 only)
   ├── Global error handlers (unhandledRejection, uncaughtException)
   ├── MongoDB initialization
   │   ├── SUCCESS → Continue
   │   └── FAILURE → Process exit(1)
   ├── Cache warmup (accounts, tokens, witnesses)
   ├── Module initialization (transaction handlers discovery)
   └── Chain state determination
       ├── REBUILD_STATE=1 → State Rebuild Flow
       └── Normal startup → Daemon Mode

2. STATE REBUILD FLOW (if REBUILD_STATE=1)
   ├── Load blocks from storage (LevelDB or MongoDB)
   ├── Process each block sequentially
   │   ├── Execute all transactions in block
   │   ├── Validate distribution amounts
   │   ├── Update witness schedule every N blocks
   │   └── Write state to disk periodically
   ├── ON SUCCESS → Continue to daemon
   ├── ON FAILURE → Log error and exit
   └── ON INTERRUPTION → Save progress for resumption

3. DAEMON STARTUP
   ├── Initialize witness schedule
   ├── Start HTTP API server
   ├── Initialize P2P networking
   ├── Connect to configured peers
   ├── Start Steem bridge worker (if enabled)
   └── Begin mining/consensus operations

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              P2P NETWORKING LAYER                                │
└─────────────────────────────────────────────────────────────────────────────────┘

P2P NETWORK TOPOLOGY
├── Node Discovery
│   ├── Bootstrap from environment PEERS
│   ├── Witness endpoint discovery
│   ├── Peer list exchange (gossip protocol)
│   └── Emergency discovery (when below consensus threshold)
├── Connection Management
│   ├── Max 15 peers by default
│   ├── Handshake with challenge-response (ECDSA signatures)
│   ├── Duplicate connection prevention
│   └── Self-connection prevention
└── Message Types
    ├── NODE_STATUS (0) - Peer capability exchange
    ├── BLOCK queries/responses (2,3)
    ├── NEW_BLOCK broadcasts (4)
    ├── CONSENSUS rounds (5)
    ├── STEEM_SYNC_STATUS (6)
    └── PEER_LIST exchange (7,8)

P2P RECOVERY MECHANISMS
├── Block Recovery
│   ├── Detect peers ahead in chain
│   ├── Request missing blocks sequentially
│   ├── Validate and apply blocks recursively
│   └── Handle recovery failures (max 25 attempts)
├── Network Partitions
│   ├── Emergency peer discovery
│   ├── Consensus threshold monitoring (60% of witnesses)
│   └── Rate-limited reconnection attempts
└── Sync Mode Coordination
    ├── Broadcast sync status every N blocks
    ├── Network-wide sync entry/exit decisions
    └── Collision detection during sync

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              STEEM BRIDGE LAYER                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

STEEM BLOCKCHAIN INTEGRATION
├── Block Processing
│   ├── Monitor Steem blockchain for new blocks
│   ├── Extract relevant transactions (custom_json with chainId)
│   ├── Parse and validate transaction formats
│   └── Queue transactions for sidechain processing
├── Sync Management
│   ├── Track blocks behind Steem head
│   ├── Enter SYNC mode when significantly behind
│   ├── Accelerated block processing (faster intervals)
│   └── Exit sync mode when caught up
└── API Management
    ├── Multiple RPC endpoints with failover
    ├── Circuit breaker for failing endpoints
    ├── Exponential backoff on errors
    └── Connection pooling and rate limiting

STEEM BRIDGE OPERATIONS
├── Deposits (Steem → Sidechain)
│   ├── Monitor Steem transfers to bridge account
│   ├── Validate transfer format and memo
│   ├── Queue TOKEN_MINT operations
│   └── Broadcast mint transactions to sidechain
├── Withdrawals (Sidechain → Steem)
│   ├── Process TOKEN_WITHDRAW transactions
│   ├── Queue Steem transfer operations
│   ├── Execute transfers from bridge account
│   └── Handle failures with retry mechanism
└── Error Handling
    ├── Failed operations retry with exponential backoff
    ├── Manual intervention for persistent failures
    └── Status tracking (pending/processing/done/failed)

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              TRANSACTION PROCESSING                              │
└─────────────────────────────────────────────────────────────────────────────────┘

TRANSACTION LIFECYCLE
1. SUBMISSION
   ├── Receive from Steem bridge (custom_json operations)
   ├── Receive from P2P peers (relayed transactions)
   ├── Basic format validation
   ├── Hash calculation and signature verification
   └── Add to transaction pool (mempool)

2. MEMPOOL MANAGEMENT
   ├── Pool size limit (2000 transactions default)
   ├── Duplicate detection by hash
   ├── Expiration cleanup (old transactions removed)
   └── Priority ordering (timestamp-based)

3. VALIDATION PIPELINE
   ├── Type-specific validation (per transaction type)
   ├── Account existence verification
   ├── Balance and permission checks
   ├── Business logic validation
   └── FAIL → Reject transaction

4. EXECUTION PIPELINE
   ├── Execute transactions in block order
   ├── Update account states and balances
   ├── Update contract states (farms, pools, NFTs, etc.)
   ├── Calculate and distribute rewards
   └── FAIL → Rollback all changes

TRANSACTION TYPES (37 types total)
├── TOKEN OPERATIONS
│   ├── TOKEN_CREATE (20) - Create new token
│   ├── TOKEN_MINT (21) - Mint tokens to account
│   ├── TOKEN_TRANSFER (22) - Transfer between accounts
│   ├── TOKEN_UPDATE (23) - Update token metadata
│   └── TOKEN_WITHDRAW (38) - Bridge withdrawal to Steem
├── POOL OPERATIONS (AMM DEX)
│   ├── POOL_CREATE (16) - Create liquidity pool
│   ├── POOL_ADD_LIQUIDITY (17) - Add liquidity (LP tokens)
│   ├── POOL_REMOVE_LIQUIDITY (18) - Remove liquidity
│   └── POOL_SWAP (19) - Token swaps with routing
├── FARM OPERATIONS (Yield Farming)
│   ├── FARM_CREATE (12) - Create staking farm
│   ├── FARM_STAKE (13) - Stake LP tokens
│   ├── FARM_UNSTAKE (14) - Unstake tokens
│   └── FARM_CLAIM_REWARDS (15) - Claim farming rewards
├── MARKET OPERATIONS (Hybrid AMM+Orderbook)
│   ├── MARKET_TRADE (11) - Hybrid trading with routing
│   └── MARKET_CANCEL_ORDER (10) - Cancel limit orders
├── NFT OPERATIONS
│   ├── NFT_CREATE_COLLECTION (1) - Create NFT collection
│   ├── NFT_MINT (2) - Mint NFT items
│   ├── NFT_TRANSFER (3) - Transfer ownership
│   ├── NFT_LIST_ITEM (4) - List for sale
│   ├── NFT_DELIST_ITEM (5) - Remove from sale
│   ├── NFT_BUY_ITEM (6) - Purchase NFT
│   ├── NFT_UPDATE (7) - Update NFT metadata
│   ├── NFT_UPDATE_COLLECTION (8) - Update collection
│   ├── NFT_ACCEPT_BID (30) - Accept auction bid
│   ├── NFT_CLOSE_AUCTION (31) - Close auction
│   └── NFT_BATCH_OPERATIONS (32) - Batch operations
├── LAUNCHPAD OPERATIONS
│   ├── LAUNCHPAD_LAUNCH_TOKEN (27) - Create token presale
│   ├── LAUNCHPAD_PARTICIPATE_PRESALE (28) - Join presale
│   ├── LAUNCHPAD_CLAIM_TOKENS (29) - Claim after TGE
│   ├── LAUNCHPAD_UPDATE_STATUS (33) - Update presale status
│   ├── LAUNCHPAD_FINALIZE_PRESALE (34) - Finalize presale
│   ├── LAUNCHPAD_SET_MAIN_TOKEN (35) - Set main token
│   ├── LAUNCHPAD_REFUND_PRESALE (36) - Refund failed presale
│   └── LAUNCHPAD_UPDATE_WHITELIST (37) - Update whitelist
└── WITNESS OPERATIONS
    ├── WITNESS_REGISTER (24) - Register as witness
    ├── WITNESS_VOTE (25) - Vote for witness
    └── WITNESS_UNVOTE (26) - Remove witness vote

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CONSENSUS MECHANISM                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

WITNESS-BASED CONSENSUS (DPOS-style)
├── Witness Scheduling
│   ├── Round-robin witness rotation
│   ├── Schedule updates every N witnesses
│   ├── Backup witness system (2x witness count)
│   └── Missed block penalty tracking
├── Block Mining Process
│   ├── Primary witness mines at exact time slot
│   ├── Backup witnesses mine if primary misses
│   ├── Block time: 3s normal, 1s sync mode
│   └── Transaction collection from mempool
└── Consensus Rounds
    ├── Multi-round confirmation (default 2 rounds)
    ├── Threshold: majority of active witnesses
    ├── Block validation and propagation
    └── Finalization and chain advancement

SYNC MODE OPERATIONS
├── Entry Conditions
│   ├── Local node behind by configured threshold
│   ├── Network median lag exceeds threshold
│   ├── Sufficient witnesses reporting lag
│   └── Network consensus for entry
├── Sync Mode Behavior
│   ├── Faster block intervals (1s vs 3s)
│   ├── Accelerated Steem block processing
│   ├── Collision window for block conflicts
│   └── Deterministic conflict resolution
└── Exit Conditions
    ├── Local lag below exit threshold
    ├── Network consensus for exit
    ├── Graceful transition to normal mode
    └── Reset to normal block timing

COLLISION HANDLING
├── Normal Mode
│   ├── Standard consensus rounds
│   ├── Timestamp-based conflict resolution
│   └── Lexicographic hash tie-breaking
├── Sync Mode
│   ├── Collision detection window (200ms)
│   ├── Collect multiple blocks per height
│   ├── Deterministic selection (earliest timestamp)
│   └── Network-wide consistency
└── Recovery Scenarios
    ├── Network partition recovery
    ├── Conflicting chain resolution
    └── Emergency rollback procedures

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              BUSINESS LOGIC MODULES                              │
└─────────────────────────────────────────────────────────────────────────────────┘

1. DEFI AMM POOLS
   ├── Liquidity Provision
   │   ├── Add liquidity (balanced deposits)
   │   ├── LP token minting (√(x*y) formula)
   │   ├── Fee collection (0.3% default)
   │   └── Impermanent loss calculations
   ├── Token Swaps
   │   ├── Constant product formula (x*y=k)
   │   ├── Slippage protection
   │   ├── Multi-hop routing
   │   └── Price impact calculations
   └── Pool Management
       ├── Pool creation with initial liquidity
       ├── Fee tier configuration
       ├── Pool statistics tracking
       └── Liquidity mining rewards

2. HYBRID MARKET (AMM + ORDERBOOK)
   ├── Route Optimization
   │   ├── Compare AMM vs Orderbook prices
   │   ├── Split orders across venues
   │   ├── Minimize slippage and fees
   │   └── Dynamic allocation strategies
   ├── Orderbook Engine
   │   ├── Limit order matching
   │   ├── Price-time priority
   │   ├── Partial fill support
   │   └── Order cancellation
   └── Market Making
       ├── Automated market making via AMM
       ├── Professional market makers via orderbook
       └── Arbitrage opportunities

3. YIELD FARMING
   ├── Farm Creation
   │   ├── Specify reward tokens and rates
   │   ├── Set staking requirements (LP tokens)
   │   ├── Configure time periods
   │   └── Set minimum/maximum stakes
   ├── Staking Operations
   │   ├── Stake LP tokens from pools
   │   ├── Time-based reward accumulation
   │   ├── Compound reward calculations
   │   └── Early withdrawal penalties
   └── Reward Distribution
       ├── Linear vesting schedules
       ├── Bonus multipliers
       ├── Anti-whale mechanisms
       └── Emergency withdrawal options

4. NFT MARKETPLACE
   ├── Collection Management
   │   ├── Create collections with metadata
   │   ├── Set royalty percentages
   │   ├── Configure minting permissions
   │   └── Update collection settings
   ├── NFT Operations
   │   ├── Mint with metadata and rarity
   │   ├── Transfer ownership
   │   ├── List for fixed price sale
   │   └── Auction with bidding
   ├── Marketplace Features
   │   ├── Commission-based trading
   │   ├── Royalty enforcement
   │   ├── Batch operations support
   │   └── Rarity and trait filtering
   └── Auction System
       ├── Time-based auctions
       ├── Reserve price protection
       ├── Automatic bid extensions
       └── Escrow during auctions

5. LAUNCHPAD (IDO PLATFORM)
   ├── Token Launch Setup
   │   ├── Define tokenomics (supply, decimals)
   │   ├── Set allocation percentages
   │   ├── Configure vesting schedules
   │   └── Upload project metadata
   ├── Presale Management
   │   ├── Whitelist-based participation
   │   ├── Contribution limits (min/max)
   │   ├── Hard cap and soft cap
   │   └── Time-based presale periods
   ├── Token Generation Events
   │   ├── Automatic token creation post-presale
   │   ├── Liquidity pool seeding
   │   ├── Vesting schedule activation
   │   └── Claim functionality
   └── Lifecycle States
       ├── UPCOMING → PRESALE_ACTIVE → PRESALE_ENDED
       ├── SUCCESS → TOKEN_GENERATION → LIQUIDITY_PROVISION
       ├── FAILURE → REFUND_PHASE
       └── COMPLETED → TRADING_LIVE

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DATA PERSISTENCE LAYER                              │
└─────────────────────────────────────────────────────────────────────────────────┘

STORAGE ARCHITECTURE
├── Primary Storage: MongoDB
│   ├── Collections: accounts, tokens, pools, farms, nfts, launchpads
│   ├── Indexes for performance optimization
│   ├── Atomic operations for consistency
│   └── Backup and restoration procedures
├── Block Storage: LevelDB (optional) + MongoDB
│   ├── High-performance block retrieval
│   ├── Fallback to MongoDB if LevelDB unavailable
│   ├── Block compression and archival
│   └── Fast sync capabilities
├── Cache Layer: In-Memory
│   ├── Account balances and metadata
│   ├── Token information
│   ├── Witness data and voting weights
│   └── Write-through caching with rollback support
└── State Management
    ├── Write queues for batch operations
    ├── Rollback capabilities for failed transactions
    ├── State snapshots for recovery
    └── Garbage collection for old data

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              ERROR HANDLING & RECOVERY                           │
└─────────────────────────────────────────────────────────────────────────────────┘

SYSTEM-LEVEL ERROR HANDLING
├── Process Management
│   ├── Unhandled promise rejection handlers
│   ├── Uncaught exception handlers
│   ├── Graceful shutdown procedures (SIGINT)
│   └── 30-second forced shutdown timeout
├── Database Errors
│   ├── MongoDB connection failure → Exit(1)
│   ├── Write operation failures → Transaction rollback
│   ├── Connection pooling and retry logic
│   └── Backup storage fallback (LevelDB)
└── Memory Management
    ├── Cache size limits and cleanup
    ├── Memory leak prevention
    └── Out-of-memory protection

NETWORK ERROR HANDLING
├── P2P Network Issues
│   ├── Peer disconnection detection
│   ├── Emergency peer discovery
│   ├── Consensus threshold monitoring
│   └── Network partition recovery
├── Steem Bridge Failures
│   ├── RPC endpoint failover
│   ├── Circuit breaker pattern
│   ├── Exponential backoff retries
│   └── Manual intervention alerts
└── API Endpoint Errors
    ├── Rate limiting and throttling
    ├── Input validation and sanitization
    ├── Error response standardization
    └── Request timeout handling

TRANSACTION ERROR SCENARIOS
├── Validation Failures
│   ├── Invalid transaction format → Reject
│   ├── Insufficient balance → Reject
│   ├── Permission denied → Reject
│   └── Business logic violation → Reject
├── Execution Failures
│   ├── State inconsistency → Rollback block
│   ├── Timeout during execution → Retry
│   ├── External service failure → Fail gracefully
│   └── Partial execution → Complete rollback
└── Consensus Failures
    ├── Block validation failure → Reject block
    ├── Consensus timeout → Re-attempt
    ├── Fork detection → Chain reorganization
    └── Witness unavailability → Backup mining

RECOVERY PROCEDURES
├── Chain Recovery
│   ├── State rebuilding from genesis
│   ├── Checkpoint restoration
│   ├── Incremental state sync
│   └── Manual state correction
├── Data Recovery
│   ├── Database backup restoration
│   ├── Transaction replay
│   ├── State verification procedures
│   └── Consistency checks
└── Service Recovery
    ├── Service restart procedures
    ├── Health check mechanisms
    ├── Dependency restoration
    └── Performance monitoring

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              OPERATIONAL WORKFLOWS                               │
└─────────────────────────────────────────────────────────────────────────────────┘

NORMAL OPERATION FLOW
1. Steem Block Processing
   ├── Monitor Steem for new blocks
   ├── Extract and validate transactions
   ├── Add to sidechain transaction pool
   └── Trigger mining if transactions available

2. Block Mining
   ├── Witness determines mining slot
   ├── Collect transactions from mempool
   ├── Execute transactions and calculate state
   ├── Create and sign block
   └── Broadcast to network

3. Block Consensus
   ├── Receive block from peer
   ├── Validate block structure and signatures
   ├── Execute transactions for verification
   ├── Participate in consensus rounds
   └── Finalize block if consensus reached

4. State Updates
   ├── Apply state changes to cache
   ├── Update database asynchronously
   ├── Clean up old data and caches
   └── Broadcast state updates via notifications

EMERGENCY SCENARIOS
├── Network Partition
│   ├── Detect peer count below threshold
│   ├── Activate emergency peer discovery
│   ├── Attempt reconnection to known witnesses
│   └── Continue operating with available peers
├── Steem Bridge Failure
│   ├── Switch to backup RPC endpoints
│   ├── Circuit breaker with exponential backoff retries
│   ├── Keep retrying to process next Steem block (1-5s intervals)
│   ├── **HALT sidechain block mining** until Steem connectivity restored
│   └── Alert operators for manual intervention
├── Consensus Failure
│   ├── Detect missing blocks or forks
│   ├── Request blocks from peers
│   ├── Validate and apply missing blocks
│   └── Rejoin consensus process
└── Database Corruption
    ├── Detect data inconsistencies
    ├── Stop processing new transactions
    ├── Restore from latest backup
    └── Rebuild state if necessary

MONITORING & ALERTING
├── Performance Metrics
│   ├── Block processing time
│   ├── Transaction throughput
│   ├── Peer connectivity
│   └── Resource utilization
├── Health Checks
│   ├── Database connectivity
│   ├── Cache consistency
│   ├── Service availability
│   └── External dependencies
└── Alert Conditions
    ├── High error rates
    ├── Performance degradation
    ├── Service unavailability
    └── Security incidents

═══════════════════════════════════════════════════════════════════════════════════
                                    SUMMARY
═══════════════════════════════════════════════════════════════════════════════════

The MeeRay blockchain is a sophisticated Layer 2 solution that provides:

• **Bridge Integration**: Seamless connection to Steem blockchain for token transfers
• **DeFi Ecosystem**: AMM pools, hybrid orderbook trading, yield farming
• **NFT Platform**: Full marketplace with auctions, royalties, and collections  
• **Launchpad**: Complete IDO platform with presales and token generation
• **Robust Consensus**: DPOS-style witness system with sync mode for catch-up
• **Error Recovery**: Comprehensive error handling and recovery mechanisms
• **Scalability**: Fast block times (1-3s) with high transaction throughput

The system handles failures gracefully through redundancy, retries, rollbacks, and 
manual intervention capabilities, ensuring high availability and data integrity.