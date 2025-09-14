### Echelon Launchpad: Complete Spec (Transactions + HTTP API)

This document fully specifies the Launchpad domain for building a complete Launchpad app on Echelon. It is self-contained; you do not need access to the codebase.

Includes all current transaction, complete HTTP API endpoints, vesting support, whitelist management, airdrop functionality, and settlement preview capabilities.

Conventions
- All on-chain amounts are provided/accepted in smallest units unless stated otherwise.
- API responses include both human-readable and raw smallest-unit amounts where relevant.elon Launchpad: Complete Spec (Transactions + HTTP API)

This document fully specifies the Launchpad domain for building a complete Launchpad app on Meeray. It is self-contained; you do not need access to the codebase.

Conventions
- All on-chain amounts are provided/accepted in smallest units unless stated otherwise.
- API responses include both human-readable and raw smallest-unit amounts where relevant.

Base URLs and Auth
- HTTP base path for launchpad: `/launchpad`
- No authentication headers are required for these read-only endpoints.
- Transactions are broadcast via the chain’s custom_json mechanism (see Broadcasting section).

## Concepts
- **Launchpad**: A project that launches a token with optional presale.
- **Statuses**: `PENDING_VALIDATION`, `VALIDATION_FAILED`, `UPCOMING`, `PRESALE_SCHEDULED`, `PRESALE_ACTIVE`, `PRESALE_PAUSED`, `PRESALE_ENDED`, `PRESALE_SUCCEEDED_SOFTCAP_MET`, `PRESALE_SUCCEEDED_HARDCAP_MET`, `PRESALE_FAILED_SOFTCAP_NOT_MET`, `TOKEN_GENERATION_EVENT`, `TRADING_LIVE`, `COMPLETED`, `CANCELLED`.
- **Allocations** recipients enum: `PROJECT_TEAM`, `ADVISORS`, `MARKETING_OPERATIONS`, `ECOSYSTEM_DEVELOPMENT`, `LIQUIDITY_POOL`, `PRESALE_PARTICIPANTS`, `PUBLIC_SALE`, `AIRDROP_REWARDS`, `TREASURY_RESERVE`, `STAKING_REWARDS`.
- **Vesting types**: `NONE`, `LINEAR_MONTHLY`, `LINEAR_DAILY`, `CLIFF`, `CUSTOM`.

## Transactions

### 1) Launchpad Launch Token (Type 29)
- File: `src/transactions/launchpad/launchpad-launch-token.ts`
- Purpose: Create a basic launchpad project with minimal required information. Complex configuration can be added later.
- Fee: 100 MRY automatically deducted from sender's account (no need to specify fee token).
- Data:
```json
{
  "userId": "alice",
  "tokenName": "My Token",
  "tokenSymbol": "MYT",
  "totalSupply": "100000000000000000",
  "tokenDecimals": 8
}
```
- Optional fields (can be set via configuration transactions later):
  - `tokenDescription` - Set via (launchpad_update_metadata)
  - `tokenLogoUrl` - Set via (launchpad_update_metadata)  
  - `projectWebsite` - Set via (launchpad_update_metadata)
  - `projectSocials` - Set via (launchpad_update_metadata)
  - `tokenomics` - Set via (launchpad_configure_tokenomics)
  - `presaleDetails` - Set (launchpad_configure_presale)
- Effects: creates basic `launchpads` doc with `_id`, `status: UPCOMING`, basic `tokenToLaunch` info, timestamps, and `launchedByUserId`.
- Fee: Automatically deducts 100 MRY (configured in `config.launchPadCreationFee`) from sender's account. Transaction fails if insufficient balance.

Broadcast example (custom_json)
```json
{
  "type": 29,
  "sender": "alice",
  "data": { /* payload as defined above */ }
}
```

### 2) Launchpad Participate Presale (Type 30)
- File: `src/transactions/launchpad/launchpad-participate-presale.ts`
- Purpose: Contribute quote asset to presale while active.
- Data:
```json
{
  "userId": "bob",
  "launchpadId": "lp-abc123...",
  "contributionAmount": "5000000"
}
```
- Rules: presale must be active; amount within min/max; not exceeding hard cap; user must have sufficient balance of `quoteAssetForPresaleSymbol`.
- Effects: deducts quote amount; updates `presale.totalQuoteRaised` and participant record `{ userId, quoteAmountContributed, tokensAllocated?, claimed }`.

Broadcast example (custom_json)
```json
{
  "type": 30,
  "sender": "bob",
  "data": {
    "userId": "bob",
    "launchpadId": "lp-abc123...",
    "contributionAmount": "5000000"
  }
}
```

### 3) Launchpad Claim Tokens (Type 31)
- File: `src/transactions/launchpad/launchpad-claim-tokens.ts`
- Purpose: Claim allocated tokens (supports `PRESALE_PARTICIPANTS`, `AIRDROP_REWARDS`, and other allocation types with vesting).
- Data:
```json
{
  "userId": "bob",
  "launchpadId": "lp-abc123...",
  "allocationType": "PRESALE_PARTICIPANTS"
}
```
- Rules: Launchpad status must be claimable; user must have allocation not yet claimed; `mainTokenId` must be set.
- Effects: mints/transfers allocated amount to `userId`; marks participant `claimed = true`.

Broadcast example (custom_json)
```json
{
  "type": 31,
  "sender": "bob",
  "data": {
    "userId": "bob",
    "launchpadId": "lp-abc123...",
    "allocationType": "PRESALE_PARTICIPANTS"
  }
}
```

### 4) Launchpad Update Status (Type 35)
- File: `src/transactions/launchpad/launchpad-update-status.ts`
- Purpose: Update launchpad lifecycle status (activate/schedule, pause/resume, end, cancel).
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123...",
  "newStatus": "PRESALE_ACTIVE"
}
```

### 5) Launchpad Finalize Presale (Type 36)
- File: `src/transactions/launchpad/launchpad-finalize-presale.ts`
- Purpose: Compute `tokensAllocated` for participants and set success/failed status.
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123..."
}
```

### 6) Launchpad Set Main Token (Type 37)
- File: `src/transactions/launchpad/launchpad-set-main-token.ts`
- Purpose: Attach main token ID after Token Generation Event.
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123...",
  "mainTokenId": "MYT"
}
```

### 7) Launchpad Refund Presale (Type 38)
- File: `src/transactions/launchpad/launchpad-refund-presale.ts`
- Purpose: Refund contributors when presale fails or is cancelled.
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123..."
}
```

### 8) Launchpad Update Whitelist (Type 39)
- File: `src/transactions/launchpad/launchpad-update-whitelist.ts`
- Purpose: Manage presale whitelist (add/remove/enable/disable/replace).
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123...",
  "action": "ADD_USERS",
  "users": ["bob", "charlie"]
}
```

### 9) Launchpad Configure Presale (Type 44)
- File: `src/transactions/launchpad/launchpad-configure-presale.ts`
- Purpose: Configure presale details and parameters.
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123...",
  "presaleDetails": {
    "pricePerToken": "1000000",
    "quoteAssetForPresaleSymbol": "STEEM",
    "minContributionPerUser": "1000000",
    "maxContributionPerUser": "100000000",
    "hardCap": "10000000000",
    "softCap": "1000000000"
  }
}
```

### 10) Launchpad Configure Tokenomics (Type 45)
- File: `src/transactions/launchpad/launchpad-configure-tokenomics.ts`
- Purpose: Configure token distribution and allocations.
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123...",
  "tokenomics": {
    "totalSupply": "100000000000000000",
    "tokenDecimals": "8",
    "allocations": [
      {"recipient": "PRESALE_PARTICIPANTS", "percentage": 20},
      {"recipient": "LIQUIDITY_POOL", "percentage": 10}
    ]
  }
}
```

### 11) Launchpad Configure Airdrop (Type 46)
- File: `src/transactions/launchpad/launchpad-configure-airdrop.ts`
- Purpose: Configure airdrop recipients and amounts.
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123...",
  "airdropRecipients": [
    {"username": "bob", "amount": "1000000000"},
    {"username": "charlie", "amount": "2000000000"}
  ]
}
```

### 12) Launchpad Update Metadata (Type 47)
- File: `src/transactions/launchpad/launchpad-update-metadata.ts`
- Purpose: Update project metadata and information.
- Data:
```json
{
  "userId": "alice",
  "launchpadId": "lp-abc123...",
  "tokenDescription": "Updated description",
  "tokenLogoUrl": "https://newlogo.com/logo.png",
  "projectSocials": {"twitter": "newhandle"}
}
```

## HTTP API
Base path: `/launchpad`
Handler: `src/modules/http/launchpad.ts`

### List launchpads
GET `/launchpad`
- Query Parameters: 
  - `status` (optional): Filter by status
- Response: array of launchpads. Selected numeric fields include human-readable and raw forms.

Example response item
```json
{
  "id": "lp-abc123...",
  "projectId": "MYT-launch-lp-abc123",
  "status": "UPCOMING",
  "tokenToLaunch": {
    "name": "My Token",
    "symbol": "MYT",
    "decimals": 8,
    "totalSupply": "100000000000000000"  
  },
  "tokenomicsSnapshot": {
    "totalSupply": "100000000000000000",
    "rawTotalSupply": "100000000000000000",
    "tokenDecimals": "8",
    "allocations": [
      { "recipient": "PRESALE_PARTICIPANTS", "percentage": 20 },
      { "recipient": "LIQUIDITY_POOL", "percentage": 10 }
    ]
  },
  "presaleDetailsSnapshot": {
    "pricePerToken": "1000000",
    "rawPricePerToken": "1000000",
    "quoteAssetForPresaleSymbol": "STEEM",
    "minContributionPerUser": "1000000",
    "rawMinContributionPerUser": "1000000",
    "maxContributionPerUser": "100000000",
    "rawMaxContributionPerUser": "100000000",
    "hardCap": "10000000000",
    "rawHardCap": "10000000000"
  },
  "presale": {
    "totalQuoteRaised": "0",
    "participants": [],
    "status": "NOT_STARTED"
  },
  "createdAt": "2025-01-18T12:00:00.000Z",
  "updatedAt": "2025-01-18T12:00:00.000Z"
}
```

### Get launchpad details
GET `/launchpad/:launchpadId`
- Response: full launchpad doc with formatted numeric fields.

### Get user participation
GET `/launchpad/:launchpadId/user/:userId`
- Response: participant details:
```json
{
  "userId": "bob",
  "amountContributed": "5.000000",
  "rawAmountContributed": "5000000",
  "tokensAllocated": "100.00000000",
  "rawTokensAllocated": "100000000",
  "claimedAmount": "0.00000000",
  "rawClaimedAmount": "0"
}
```

### Get user claimable amount
GET `/launchpad/:launchpadId/user/:userId/claimable`
- Response:
```json
{
  "launchpadId": "lp-abc123...",
  "userId": "bob",
  "totalAllocated": "100.00000000",
  "rawTotalAllocated": "100000000",
  "claimed": "0.00000000",
  "rawClaimed": "0",
  "claimable": "100.00000000",
  "rawClaimable": "100000000"
}
```

### List participants with pagination
GET `/launchpad/:launchpadId/participants`
- Query Parameters:
  - `limit` (optional): Number of participants to return (default: 10)
  - `offset` (optional): Number of participants to skip (default: 0)
- Response:
```json
{
  "data": [
    {
      "userId": "bob",
      "quoteAmountContributed": "5000000",
      "tokensAllocated": "100000000",
      "claimed": false
    }
  ],
  "total": 25,
  "limit": 10,
  "offset": 0
}
```

### Get whitelist status and members
GET `/launchpad/:launchpadId/whitelist`
- Response:
```json
{
  "whitelistEnabled": true,
  "whitelist": ["alice", "bob", "charlie"]
}
```

### Get settlement preview
GET `/launchpad/:launchpadId/settlement-preview`
- Purpose: Preview token allocation calculations before finalization
- Response:
```json
{
  "data": [
    {
      "userId": "bob",
      "contributed": "5000000",
      "tokensAllocatedPreview": "100000000"
    }
  ]
}
```

Errors
- 404: `{ "message": "Launchpad with ID ... not found" }`
- 500: `{ "error": "Internal server error", "details": "..." }`

## Data model snapshot (stored fields)
- Collection `launchpads` (subset):
```json
{
  "_id": "lp-...",
  "projectId": "MYT-launch-lp-...",
  "status": "UPCOMING|PRESALE_ACTIVE|...",
  "tokenToLaunch": {"name":"","symbol":"","decimals":8,"totalSupply":"...","description":"...","website":"..."},
  "tokenomicsSnapshot": {"totalSupply":"...","tokenDecimals":"...","allocations":[{"recipient":"...","percentage":10,"vestingSchedule":{"type":"LINEAR_MONTHLY","durationMonths":12}}]},
  "presaleDetailsSnapshot": {"pricePerToken":"...","quoteAssetForPresaleSymbol":"STEEM", "minContributionPerUser":"...","maxContributionPerUser":"...","hardCap":"...","softCap":"...","startTime":"ISO","endTime":"ISO","whitelistRequired":false},
  "presale": {"totalQuoteRaised":"0","participants":[{"userId":"bob","quoteAmountContributed":"...","tokensAllocated":"...","claimed":false}],"status":"NOT_STARTED|ACTIVE|ENDED_PENDING_CLAIMS|...","whitelist":["alice","bob"],"whitelistEnabled":false},
  "airdropRecipients": [{"username":"bob","amount":"1000000000","claimed":false}],
  "mainTokenId": "MYT",
  "dexPairAddress": "...",
  "launchedByUserId": "alice",
  "relatedTxIds": ["tx123","tx456"],
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

- Collection `vesting_states` (for allocation vesting):
```json
{
  "userId": "bob",
  "launchpadId": "lp-...",
  "allocationType": "PROJECT_TEAM",
  "totalAllocated": "10000000000",
  "totalClaimed": "0",
  "vestingStartTimestamp": 1640995200,
  "lastClaimedTimestamp": 0,
  "isFullyClaimed": false
}
```

## Calculations and Allocation Logic
- Price per token is specified in presale details as smallest units of quote asset per one smallest unit of project token. A common scheme is:
  - tokensAllocated = floor(contributionAmount * 10^projectTokenDecimals / pricePerToken)
- In the current implementation, presale participation records only contributions; `tokensAllocated` can be computed and set at or after presale end (e.g., settlement step or TGE). Claims require `tokensAllocated` to be present.
- **Vesting Logic**: Allocations with vesting schedules create entries in `vesting_states` collection. Vested amounts are calculated based on:
  - LINEAR_MONTHLY: `vestedAmount = totalAllocated * monthsElapsed / totalMonths`
  - LINEAR_DAILY: Similar but daily intervals
  - CLIFF: No vesting until cliff period, then full amount
- Claimable = max(vestedAmount - claimedAmount, 0) for vested allocations
- Claimable = max(totalAllocated - claimedAmount, 0) for non-vested allocations (e.g., presale participants)

## Status Machine (typical)
- UPCOMING → PRESALE_SCHEDULED → PRESALE_ACTIVE → PRESALE_ENDED
- If soft cap met → PRESALE_SUCCEEDED_SOFTCAP_MET (or HARDCAP_MET)
- Then → TOKEN_GENERATION_EVENT → TRADING_LIVE → COMPLETED
- If soft cap not met → PRESALE_FAILED_SOFTCAP_NOT_MET → (project may refund off-chain)

## Broadcasting Transactions
Send a sidechain transaction as JSON with fields:
```json
{ "type": <number>, "sender": "<account>", "data": { ... } }
```
Where `type` is:
- 29 = launchpad_launch_token
- 30 = launchpad_participate_presale  
- 31 = launchpad_claim_tokens
- 35 = launchpad_update_status
- 36 = launchpad_finalize_presale
- 37 = launchpad_set_main_token
- 38 = launchpad_refund_presale
- 39 = launchpad_update_whitelist
- 44 = launchpad_configure_presale
- 45 = launchpad_configure_tokenomics
- 46 = launchpad_configure_airdrop
- 47 = launchpad_update_metadata

## Typical App Flows
- Creator:
  1) Submit Type 29 with tokenomics/presale; show project detail via GET `/launchpad/:id`.
  2) When ready, update status via Type 35 to activate presale; participants can contribute.
  3) After presale, finalize via Type 36 to compute `tokensAllocated` for participants.
  4) Set main token via Type 37; open claims.

- Participant:
  1) View project → read `presaleDetailsSnapshot`, `presale.totalQuoteRaised`.
  2) Contribute via Type 30 within min/max, respecting hard cap.
  3) After TGE/claimable status, check `/claimable` and claim via Type 31.

## Display and Units
- Always display amounts using formatted fields from API where present.
- When sending transactions, use smallest-unit strings. Respect token decimals for UI conversions.

## App-building notes
- Use `/launchpad` list to show projects and status; poll details on `GET /launchpad/:id`.
- For presale UI: read `presaleDetailsSnapshot` (limits, price, quote token), `presale.totalQuoteRaised`, and participants.
- For user views: join with `GET /launchpad/:id/user/:userId` and `GET /launchpad/:id/user/:userId/claimable`.
- Use `/launchpad/:id/participants` for participant lists with pagination.
- Use `/launchpad/:id/whitelist` to check whitelist status and members.
- Use `/launchpad/:id/settlement-preview` to preview token allocations before finalization.
- Transactions to broadcast from the app:
  - Type 29: create project (creator UX)
  - Type 30: contribute to presale (participant UX)
  - Type 31: claim tokens when claimable (participant UX)
  - Type 35: update status (admin/creator UX)
  - Type 36: finalize presale (admin/creator UX)
  - Type 37: set main token (admin/creator UX)
  - Type 38: refund presale (admin UX)
  - Type 39: manage whitelist (admin/creator UX)
  - Type 44-47: configure project details (creator UX)
- Amount formatting: when displaying, prefer formatted fields from API; when transacting, send raw smallest-unit strings.


