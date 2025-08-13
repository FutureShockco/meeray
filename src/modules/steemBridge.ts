import settings from '../settings.js';
import SteemApiClient from '../steem/apiClient.js';
import { PrivateKey } from 'dsteem';
const client = new SteemApiClient();


async function transfer(to: string, amount: string, symbol: string, memo: string) {
    const operation = ['transfer', {
        required_auths: [settings.steemBridgeAccount],
        required_posting_auths: [],
        from: settings.steemBridgeAccount,
        to,
        amount: amount + ' ' + symbol,
        memo: memo
    }];

    try {
        console.log(`Broadcasting transfer from ${settings.steemBridgeAccount} to ${to} with amount: ${amount}`);
        const result = await client.sendOperations([operation], PrivateKey.fromString(settings.steemBridgeActiveKey));
        console.log(`Transfer successful: TX ID ${result.id}`);
        return result;
    } catch (error: any) {
        console.error(`Error in transfer:`, error);
        if (error?.data?.stack) {
            console.error('dsteem error data:', error.data.stack);
        }
        throw error;
    }
}

export default { transfer };