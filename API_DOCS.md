# API and Transaction Documentation

## Submitting Launchpad Transactions (via Steem `custom_json`)

To interact with the Echelon launchpad module (creating launchpads, participating, claiming), transactions must be broadcast as `custom_json` operations on the Steem blockchain. The Echelon sidechain nodes will parse these operations.

**Common `custom_json` Structure:**

*   `id`: Must be `"sidechain"`
*   `required_auths`: An array containing the Steem username of the account authorizing the transaction (e.g., `["username"]`).
*   `required_posting_auths`: Typically empty `[]` unless posting authority is sufficient (usually active or owner authority is needed for financial transactions).
*   `json`: A stringified JSON object with the following structure:
    *   `contract`: A string identifying the Echelon contract/transaction name (see below).
    *   `payload`: An object containing the specific data for that contract (see below).

--- 

### 1. Launch New Token (`launchpad_launch_token`)

*   **`json.contract`**: `"launchpad_launch_token"`
*   **`json.payload` Structure (LaunchpadLaunchTokenData):**
    ```json
    {
        "userId": "string (Steem username of the initiator, must match one of required_auths)",
        "tokenName": "string",
        "tokenSymbol": "string",
        "tokenStandard": "NATIVE | WRAPPED_NATIVE_LIKE", // Enum: TokenStandard
        "tokenDescription": "string (optional)",
        "tokenLogoUrl": "string (optional)",
        "projectWebsite": "string (optional)",
        "projectSocials": {
            "platform": "string (optional)" 
        },
        "tokenomics": {
            "totalSupply": "number",
            "tokenDecimals": "number",
            "allocations": [
                {
                    "recipient": "PROJECT_TEAM | ADVISORS | ...", // Enum: TokenDistributionRecipient
                    "percentage": "number (0-100)",
                    "vestingSchedule": { // (optional)
                        "type": "NONE | LINEAR_MONTHLY | ...", // Enum: VestingType
                        "cliffMonths": "number (optional)",
                        "durationMonths": "number",
                        "initialUnlockPercentage": "number (0-100, optional)"
                    },
                    "lockupMonths": "number (optional)",
                    "customRecipientAddress": "string (optional)"
                }
            ]
        },
        "presaleDetails": { // (optional)
            "presaleTokenAllocationPercentage": "number",
            "pricePerToken": "number",
            "quoteAssetForPresaleSymbol": "string",
            "quoteAssetForPresaleIssuer": "string (optional)",
            "minContributionPerUser": "number",
            "maxContributionPerUser": "number",
            "startTime": "string (ISO Date)",
            "endTime": "string (ISO Date)",
            "hardCap": "number",
            "softCap": "number (optional)",
            "whitelistRequired": "boolean (optional)",
            "fcfsAfterReservedAllocation": "boolean (optional)"
        },
        "liquidityProvisionDetails": { // (optional)
            "dexIdentifier": "string",
            "liquidityTokenAllocationPercentage": "number",
            "quoteAssetForLiquiditySymbol": "string",
            "quoteAssetForLiquidityIssuer": "string (optional)",
            "initialQuoteAmountProvidedByProject": "number (optional)",
            "lpTokenLockupMonths": "number (optional)"
        },
        "launchFeeTokenSymbol": "string",
        "launchFeeTokenIssuer": "string (optional)"
    }
    ```

--- 

### 2. Participate in Presale (`launchpad_participate_presale`)

*   **`json.contract`**: `"launchpad_participate_presale"`
*   **`json.payload` Structure (LaunchpadParticipatePresaleData):**
    ```json
    {
        "userId": "string (Steem username of the participant, must match one of required_auths)",
        "launchpadId": "string (ID of the launchpad project)",
        "contributionAmount": "number (amount of quote currency user is contributing)"
    }
    ```

---

### 3. Claim Tokens (`launchpad_claim_tokens`)

*   **`json.contract`**: `"launchpad_claim_tokens"`
*   **`json.payload` Structure (LaunchpadClaimTokensData):**
    ```json
    {
        "userId": "string (Steem username of the claimant, must match one of required_auths)",
        "launchpadId": "string (ID of the launchpad project)",
        "allocationType": "PRESALE_PARTICIPANTS | AIRDROP_REWARDS | ..." // Enum: TokenDistributionRecipient
    }
    ```

---

## Query Endpoints (HTTP GET)

These endpoints allow querying information from the Echelon sidechain.

Base path: `/launchpad`

---

### 1. List Launchpad Projects

*   **Method:** `GET`
*   **Path:** `/launchpad/`
*   **Description:** Retrieves a list of launchpad projects. (Further pagination/filtering may be added).
*   **Query Parameters:** (None currently, future: for pagination, status filtering, etc.)
*   **Success Response (200 OK):**
    An array of Launchpad objects. The structure of a Launchpad object is defined in `src/transactions/launchpad/launchpad-launch-token.ts` (see `Launchpad` interface).
    ```json
    [
        {
            "_id": "string (launchpadId)",
            "projectId": "string",
            "status": "PENDING_VALIDATION | UPCOMING | ...", // Enum: LaunchpadStatus
            "tokenToLaunch": {
                "name": "string",
                "symbol": "string",
                "standard": "NATIVE | ...",
                "decimals": "number",
                "totalSupply": "number"
            },
            "tokenomicsSnapshot": { /* Tokenomics object */ },
            "presaleDetailsSnapshot": { /* PresaleDetails object, optional */ },
            "liquidityProvisionDetailsSnapshot": { /* LiquidityProvisionDetails object, optional */ },
            "launchedByUserId": "string",
            "createdAt": "string (ISO Date)",
            "updatedAt": "string (ISO Date)",
            "presale": { // (optional)
                "totalQuoteRaised": "number",
                "participants": [
                    {
                        "userId": "string",
                        "quoteAmountContributed": "number",
                        "tokensAllocated": "number (optional)",
                        "claimed": "boolean"
                    }
                ],
                "status": "NOT_STARTED | ACTIVE | ..."
            },
            "mainTokenId": "string (optional)",
            "feePaid": "boolean",
            // ... other Launchpad fields ...
        }
        // ... more launchpad objects
    ]
    ```
*   **Error Responses:**
    *   `404 Not Found`: If no launchpads exist (or if a specific query yields no results in the future).
    *   `500 Internal Server Error`: Server-side processing error.

---

**TODO: Add more query endpoints as needed:**
*   `GET /launchpad/{launchpadId}`: Get details of a specific launchpad project.
*   `GET /launchpad/{launchpadId}/participation/{userId}`: Get a user's participation details for a specific launchpad.
*   `GET /launchpad/{launchpadId}/claimable/{userId}`: Get a user's claimable token details for a specific launchpad.

# AMM DEX API Documentation (Updated)

## Liquidity Pools

### GET /pools
Returns a paginated list of all liquidity pools.

#### Response fields (per pool):
- `id`: Pool ID (e.g., "TOKENA-TOKENB")
- `tokenA_symbol`, `tokenB_symbol`: Token symbols
- `tokenA_reserve`, `tokenB_reserve`: Formatted reserves (string, human-readable)
- `rawTokenA_reserve`, `rawTokenB_reserve`: Raw reserves (string, smallest units)
- `feeRateBasisPoints`: Fee rate in basis points (e.g., 30 = 0.3%)
- `totalLpTokens`, `rawTotalLpTokens`: Total LP tokens (formatted/raw)
- **New:** `feeGrowthGlobalA`, `feeGrowthGlobalB`: Global fee growth accumulators for each token (string, 1e18 precision)
- `aprA`: Annualized fee APR for tokenA (number, e.g., 0.12 for 12%).
- `aprB`: Annualized fee APR for tokenB (number, e.g., 0.10 for 10%).

> **Note:**
> - `aprA` and `aprB` represent the yield for each token in the pool, calculated as (fees accrued in that token over the last year) / (current reserve of that token).
> - The backend does **not** provide a combined APR in USD/STEEM, as it does not have access to token price data. The frontend should convert these to a common value (e.g., STEEM or USD) using its own price logic if a single APR is desired.
> - If you want to display a simple combined APR, you may sum `aprA` and `aprB`, but this is only meaningful if both tokens have similar value or you convert them to a common unit.

### GET /pools/:poolId
Returns details for a specific pool. Same fields as above.

### GET /pools/token/:tokenSymbol
Returns all pools containing the given token.

---

## User Liquidity Positions

### GET /pools/positions/user/:userId
Returns all liquidity positions for a user.

### GET /pools/positions/pool/:poolId
Returns all user positions in a pool.

### GET /pools/positions/:positionId
Returns a specific user position by composite ID.

### GET /pools/positions/user/:userId/pool/:poolId
Returns a user's position in a specific pool.

#### Response fields (per position):
- `id`: Position ID (userId-poolId)
- `provider`: User ID
- `poolId`: Pool ID
- `lpTokenBalance`, `rawLpTokenBalance`: LP token balance (formatted/raw)
- **New:**
  - `feeGrowthEntryA`, `feeGrowthEntryB`: User's fee growth checkpoint for each token (string, 1e18 precision)
  - `unclaimedFeesA`, `unclaimedFeesB`: Fees accrued but not yet claimed (string, smallest units)
  - `claimableFeesA`, `claimableFeesB`: Total claimable fees for the user (computed as `(feeGrowthGlobalX - feeGrowthEntryX) * lpTokenBalance / 1e18 + unclaimedFeesX`)

---

## Pool Analytics

### GET /pools/:poolId/analytics?period=hour|day|week|month|year
Returns analytics for a pool over a specified period.

#### Query Parameters:
- `period`: One of `hour`, `day`, `week`, `month`, `year` (default: `day`).

#### Response fields:
- `poolId`: Pool ID
- `period`: Period used
- `from`, `to`: ISO timestamps for the analytics window
- `totalVolumeA`, `totalVolumeB`: Total swap volume for each token (string, smallest units)
- `totalFeesA`, `totalFeesB`: Total swap fees accrued for each token (string, smallest units)
- `tvlA`, `tvlB`: Current pool reserves (string, smallest units)
- `aprA`, `aprB`: Annualized fee APR for tokenA (number).
- `aprB`: Annualized fee APR for tokenB (number).

> **Note:**
> - These APRs are per-token and not combined. The frontend should convert to STEEM or USD if a single APR is needed.

---

## Swap Routing

### POST /pools/route-swap
Finds the best swap route between two tokens. (No changes to request, but response may include more detailed hop/fee info.)

---

## Fee Accounting Details
- **Fee Growth Fields:**
  - `feeGrowthGlobalA/B` (pool): Cumulative per-LP-token fee growth for each token (1e18 precision, string).
  - `feeGrowthEntryA/B` (user position): User's checkpoint of fee growth at last liquidity action.
  - `unclaimedFeesA/B` (user position): Fees accrued but not yet claimed (string, smallest units).
  - `claimableFeesA/B` (user position): Total claimable fees, including unclaimed and newly accrued since last checkpoint.
- **All fee and volume fields are strings representing integer values in the token's smallest unit.**

---

## Changelog (Recent)
- Added per-user fee accounting and claimable fee tracking.
- Added pool-level analytics endpoint with period filtering and APR.
- Exposed all fee accounting fields in pool and user position endpoints.
- Documented all new/changed fields and endpoints above.