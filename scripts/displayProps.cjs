const { getClient, getGlobalProperties } = require('./helpers.cjs');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') }); // Load .env from scripts folder

const main = async () => {
    const { client } = await getClient();
    const props = await getGlobalProperties(client);
    console.log(props.last_irreversible_block_num);
}

main();