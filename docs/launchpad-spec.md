### Echelon Launchpad: Transactions and HTTP API

This document fully specifies the Launchpad domain (transactions and HTTP endpoints) for building a complete Launchpad app on Echelon. All amounts are in smallest units unless stated otherwise. Tokens use `symbol@issuer` when applicable.

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
    "quoteAssetForPresaleIssuer": "echelon-node1",
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
- Rules: presale must be active; amount within min/max; not exceeding hard cap; user must have sufficient balance of `quoteAssetForPresaleSymbol@issuer`.
- Effects: deducts quote amount; updates `presale.totalQuoteRaised` and participant record `{ userId, quoteAmountContributed, tokensAllocated?, claimed }`.

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

## HTTP API
Base path: `/launchpad`
Handler: `src/modules/http/launchpad.ts`

### List launchpads
GET `/launchpad`
- Response: array of launchpads, numeric fields formatted with both human-readable and raw fields where relevant.

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
  "mainTokenId": "MYT@echelon-node1",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

## App-building notes
- Use `/launchpad` list to show projects and status; poll details on `GET /launchpad/:id`.
- For presale UI: read `presaleDetailsSnapshot` (limits, price, quote token), `presale.totalQuoteRaised`, and participants.
- For user views: join with `GET /launchpad/:id/user/:userId` and `GET /launchpad/:id/user/:userId/claimable`.
- Transactions to broadcast from the app:
  - Type 27: create project (admin/creator UX)
  - Type 28: contribute to presale
  - Type 29: claim tokens when claimable
- Amount formatting: when displaying, prefer formatted fields from API; when transacting, send raw smallest-unit strings.


