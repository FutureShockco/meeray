### Echelon Launchpad: Complete Spec (Transactions + HTTP API)

This document fully specifies the Launchpad domain for building a complete Launchpad app on Echelon. It is self-contained; you do not need access to the codebase.

Conventions
- All on-chain amounts are provided/accepted in smallest units unless stated otherwise.
- API responses include both human-readable and raw smallest-unit amounts where relevant.

Base URLs and Auth
- HTTP base path for launchpad: `/launchpad`
- No authentication headers are required for these read-only endpoints.
- Transactions are broadcast via the chain’s custom_json mechanism (see Broadcasting section).

## Concepts
- **Launchpad**: A project that launches a token with optional presale and liquidity provisioning.
- **Statuses**: `PENDING_VALIDATION`, `VALIDATION_FAILED`, `UPCOMING`, `PRESALE_SCHEDULED`, `PRESALE_ACTIVE`, `PRESALE_PAUSED`, `PRESALE_ENDED`, `PRESALE_SUCCEEDED_SOFTCAP_MET`, `PRESALE_SUCCEEDED_HARDCAP_MET`, `PRESALE_FAILED_SOFTCAP_NOT_MET`, `TOKEN_GENERATION_EVENT`, `LIQUIDITY_PROVISIONING`, `TRADING_LIVE`, `COMPLETED`, `CANCELLED`.
- **Allocations** recipients enum: `PROJECT_TEAM`, `ADVISORS`, `MARKETING_OPERATIONS`, `ECOSYSTEM_DEVELOPMENT`, `LIQUIDITY_POOL`, `PRESALE_PARTICIPANTS`, `PUBLIC_SALE`, `AIRDROP_REWARDS`, `TREASURY_RESERVE`, `STAKING_REWARDS`.
- **Vesting types**: `NONE`, `LINEAR_MONTHLY`, `LINEAR_DAILY`, `CLIFF`, `CUSTOM`.

## Transactions

### 1) Launchpad Launch Token (Type 27)
- File: `src/transactions/launchpad/launchpad-launch-token.ts`
- Purpose: Create a launchpad project with tokenomics, optional presale, and liquidity details.
- Data:
```json
{
  "userId": "alice",
  "tokenName": "My Token",
  "tokenSymbol": "MYT",
  "tokenStandard": "NATIVE", // or WRAPPED_NATIVE_LIKE
  "tokenDescription": "...",
  "tokenLogoUrl": "https://...",
  "projectWebsite": "https://...",
  "projectSocials": { "twitter": "..." },
  "tokenomics": {
    "totalSupply": "100000000000000000",   
    "tokenDecimals": "8",                  
    "allocations": [
      { "recipient": "PRESALE_PARTICIPANTS", "percentage": 20 },
      { "recipient": "LIQUIDITY_POOL", "percentage": 10 },
      { "recipient": "PROJECT_TEAM", "percentage": 15, "vestingSchedule": {"type":"LINEAR_MONTHLY", "durationMonths": 12} }
    ]
  },
  "presaleDetails": {
    "presaleTokenAllocationPercentage": 20,
    "pricePerToken": "1000000",
    "quoteAssetForPresaleSymbol": "STEEM",
    "minContributionPerUser": "1000000",
    "maxContributionPerUser": "100000000",
    "startTime": "2025-01-20T00:00:00.000Z",
    "endTime": "2025-01-27T00:00:00.000Z",
    "hardCap": "10000000000",
    "softCap": "1000000000",
    "whitelistRequired": false
  },
  "liquidityProvisionDetails": {
    "dexIdentifier": "echelon-amm",
    "liquidityTokenAllocationPercentage": 10,
    "quoteAssetForLiquiditySymbol": "STEEM",
    "quoteAssetForLiquidityIssuer": "echelon-node1",
    "initialQuoteAmountProvidedByProject": 100000000,
    "lpTokenLockupMonths": 6
  },
  "launchFeeTokenSymbol": "ECH",
  "launchFeeTokenIssuer": "echelon-node1"
}
```
- Effects (storage snapshot fields): creates `launchpads` doc with `_id`, `status`, `tokenToLaunch`, `tokenomicsSnapshot`, `presaleDetailsSnapshot?`, `liquidityProvisionDetailsSnapshot?`, `presale?`, timestamps, and `launchedByUserId`.

Broadcast example (custom_json)
```json
{
  "type": 27,
  "sender": "alice",
  "data": { /* payload as defined above */ }
}
```

### 2) Launchpad Participate Presale (Type 28)
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
  "type": 28,
  "sender": "bob",
  "data": {
    "userId": "bob",
    "launchpadId": "lp-abc123...",
    "contributionAmount": "5000000"
  }
}
```

### 3) Launchpad Claim Tokens (Type 29)
- File: `src/transactions/launchpad/launchpad-claim-tokens.ts`
- Purpose: Claim allocated tokens (currently supports `PRESALE_PARTICIPANTS`).
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
  "type": 29,
  "sender": "bob",
  "data": {
    "userId": "bob",
    "launchpadId": "lp-abc123...",
    "allocationType": "PRESALE_PARTICIPANTS"
  }
}
```

## HTTP API
Base path: `/launchpad`
Handler: `src/modules/http/launchpad.ts`

### List launchpads
GET `/launchpad`
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
    "standard": "NATIVE",
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

Errors
- 404: `{ "message": "Launchpad with ID ... not found" }`
- 500: `{ "error": "Internal server error", "details": "..." }`

## Data model snapshot (stored fields)
- Collection `launchpads` (subset):
```json
{
  "_id": "lp-...",
  "status": "UPCOMING|...",
  "tokenToLaunch": {"name":"","symbol":"","standard":"","decimals":8,"totalSupply":"..."},
  "tokenomicsSnapshot": {"totalSupply":"...","tokenDecimals":"...","allocations":[{"recipient":"...","percentage":10}]},
  "presaleDetailsSnapshot": {"pricePerToken":"...","quoteAssetForPresaleSymbol":"STEEM", "minContributionPerUser":"...","maxContributionPerUser":"...","hardCap":"...","softCap":"..."},
  "presale": {"totalQuoteRaised":"0","participants":[{"userId":"bob","quoteAmountContributed":"...","tokensAllocated":"...","claimed":false}],"status":"NOT_STARTED|ACTIVE|..."},
  "mainTokenId": "MYT",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

## Calculations and Allocation Logic
- Price per token is specified in presale details as smallest units of quote asset per one smallest unit of project token. A common scheme is:
  - tokensAllocated = floor(contributionAmount * 10^projectTokenDecimals / pricePerToken)
- In the current implementation, presale participation records only contributions; `tokensAllocated` can be computed and set at or after presale end (e.g., settlement step or TGE). Claims require `tokensAllocated` to be present.
- Claimable = max(totalAllocated - claimedAmount, 0).

## Status Machine (typical)
- UPCOMING → PRESALE_SCHEDULED → PRESALE_ACTIVE → PRESALE_ENDED
- If soft cap met → PRESALE_SUCCEEDED_SOFTCAP_MET (or HARDCAP_MET)
- Then → TOKEN_GENERATION_EVENT → LIQUIDITY_PROVISIONING → TRADING_LIVE → COMPLETED
- If soft cap not met → PRESALE_FAILED_SOFTCAP_NOT_MET → (project may refund off-chain)

## Broadcasting Transactions
Send a sidechain transaction as JSON with fields:
```json
{ "type": <number>, "sender": "<account>", "data": { ... } }
```
Where `type` is:
- 27 = launchpad_launch_token
- 28 = launchpad_participate_presale
- 29 = launchpad_claim_tokens

## Typical App Flows
- Creator:
  1) Submit Type 27 with tokenomics/presale; show project detail via GET `/launchpad/:id`.
  2) When ready, update status off-chain/admin to activate presale; participants can contribute.
  3) After presale, compute and set `tokensAllocated` for participants; set `mainTokenId`; open claims.

- Participant:
  1) View project → read `presaleDetailsSnapshot`, `presale.totalQuoteRaised`.
  2) Contribute via Type 28 within min/max, respecting hard cap.
  3) After TGE/claimable status, check `/claimable` and claim via Type 29.

## Display and Units
- Always display amounts using formatted fields from API where present.
- When sending transactions, use smallest-unit strings. Respect token decimals for UI conversions.

## App-building notes
- Use `/launchpad` list to show projects and status; poll details on `GET /launchpad/:id`.
- For presale UI: read `presaleDetailsSnapshot` (limits, price, quote token), `presale.totalQuoteRaised`, and participants.
- For user views: join with `GET /launchpad/:id/user/:userId` and `GET /launchpad/:id/user/:userId/claimable`.
- Transactions to broadcast from the app:
  - Type 27: create project (admin/creator UX)
  - Type 28: contribute to presale
  - Type 29: claim tokens when claimable
- Amount formatting: when displaying, prefer formatted fields from API; when transacting, send raw smallest-unit strings.


