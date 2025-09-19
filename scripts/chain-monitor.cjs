const STATUS_URL = 'http://localhost:3001/blocks/latest'; // Change to your API status endpoint
const MINE_URL = 'http://localhost:3001/mine';     // Change to your API mine endpoint
const POLL_INTERVAL = 3000; // 3 seconds
const BLOCK_TIMEOUT = 12000; // 12 seconds

let lastBlock = null;
let lastBlockTime = Date.now();

async function checkChain() {
  try {
    const res = await fetch(STATUS_URL);
    const data = await res.json();
    // Adjust this to match your API's block height/ID field
    const currentBlock = data.block.blockNum;

    if (lastBlock === null || currentBlock !== lastBlock) {
      lastBlock = currentBlock;
      lastBlockTime = Date.now();
      console.log(`[${new Date().toISOString()}] Block: ${currentBlock}`);
    } else if (Date.now() - lastBlockTime > BLOCK_TIMEOUT) {
      console.warn(`[${new Date().toISOString()}] No new block for 12s. Triggering /mine...`);
      await fetch(MINE_URL, { method: 'POST' });
      lastBlockTime = Date.now(); // Reset timer after mining
    }
  } catch (err) {
    console.error('Error querying chain status:', err.message);
  }
}

setInterval(checkChain, POLL_INTERVAL);