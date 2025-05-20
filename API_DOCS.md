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