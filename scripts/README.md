# Scripts Usage Guide

## Pool Operations

### 1. Create a Liquidity Pool
```bash
node pool_create.cjs
```
Creates a new liquidity pool with random token pairs and fee tiers.

### 2. List All Available Pools
```bash
node list_pools.cjs
```
Shows all existing liquidity pools with their details including:
- Pool ID
- Token pairs
- Fee tiers
- Current reserves
- Status

### 3. Find Pool for Specific Tokens
```bash
node get_pool_for_tokens.cjs <tokenA> <tokenB>
```
Example:
```bash
node get_pool_for_tokens.cjs TKA TKB
```
Finds pools containing the specified token pair.

### 4. Add Liquidity to Pool
```bash
node pool_add_liquidity.cjs
```
Adds liquidity to an existing pool (requires pool ID).

### 5. Swap Tokens
```bash
node pool_swap.cjs
```
**Important**: This script now automatically finds an existing pool instead of using a placeholder poolId.

### 6. Remove Liquidity
```bash
node pool_remove_liquidity.cjs
```
Removes liquidity from a pool (requires pool ID).

## Token Operations

### 1. Create and Mint Tokens
```bash
node token_create.cjs
```
This script now includes a token symbol tracking system:

1. **Creates** a new token with random data
2. **Writes** the token symbol to `lastTokenSymbol.txt`
3. **Reads** the symbol back from the file
4. **Mints** tokens using the retrieved symbol

The symbol is automatically saved and retrieved, ensuring consistency between creation and minting operations.

## Workflow for Pool Swapping

1. **Create tokens first**:
   ```bash
   node token_create.cjs
   ```

2. **Create a pool**:
   ```bash
   node pool_create.cjs
   ```

3. **Add liquidity** (optional but recommended):
   ```bash
   node pool_add_liquidity.cjs
   ```

4. **List available pools**:
   ```bash
   node list_pools.cjs
   ```

5. **Perform swaps**:
   ```bash
   node pool_swap.cjs
   ```

## Troubleshooting

### "poolId is null" Error
- **Cause**: No pools exist in the system
- **Solution**: Run `pool_create.cjs` first, then `pool_swap.cjs`

### Token Symbol Issues
- **Cause**: Token creation failed or symbol file is corrupted
- **Solution**: Check `lastTokenSymbol.txt` exists and contains valid data
- **Prevention**: Always run `token_create.cjs` before `token_mint.cjs`

### Pool Not Found
- **Cause**: Pool ID doesn't exist or is incorrect
- **Solution**: Use `list_pools.cjs` to see available pools
- **Alternative**: Use `get_pool_for_tokens.cjs` to find specific token pairs

## Environment Variables

Make sure these are set:
- `SSC_ACCOUNT`: Your sidechain account (default: 'echelon-ssc')
- `TOKEN_ISSUER`: Token issuer account (default: 'echelon-token-issuer')

## File Dependencies

- `lastTokenSymbol.txt`: Created by `token_create.cjs`, used by `token_mint.cjs`
- `helpers.cjs`: Contains utility functions for all scripts
- Database collections: `liquidityPools`, `tokens`, `accounts`

## Running All Scripts

Use the batch file to run all scripts in sequence:
```bash
run_all_scripts.bat
```

This will execute all scripts in the correct order, including the new pool management scripts.

