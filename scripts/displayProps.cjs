const { getClient, getGlobalProperties } = require('./helpers.cjs');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') }); // Load .env from scripts folder

const main = async () => {
    const { client } = await getClient();
    const props = await getGlobalProperties(client);
    console.log(props.last_irreversible_block_num);
    const block = await client.database.getBlock(3914250);
    console.log(block.transactions[0]);
}

main();