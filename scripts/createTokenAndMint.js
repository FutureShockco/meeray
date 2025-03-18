const dsteem = require('dsteem')
const client = new dsteem.Client('https://api.justyy.com')
const PrivateKey = require('dsteem').PrivateKey
const fs = require('fs')
let privateKeys
try {
    // Load private keys from external file that will be gitignored
    const keysFile = fs.readFileSync('./keys.json')
    privateKeys = JSON.parse(keysFile)
} catch (err) {
    console.error('Error loading keys.json file:', err)
    process.exit(1)
}

const tokens = ['OZT', 'ODT']
const receivers = ['echelon-node1', 'echelon-node2', 'echelon-node3', 'echelon-node4', 'echelon-node5']

const create = async () => {
    try {
        for (i = 0; i < tokens.length; i++) {
            const token = tokens[i]
            const customJsonOperation = [
                'custom_json',
                {
                    required_auths: [], 
                    required_posting_auths: ['echelon-node1'], 
                    id: 'sidechain',
                    json: JSON.stringify({
                        contract: 'createtoken', 
                        contractPayload: {
                            symbol: token,
                            name: "OzToken",
                            precision: 8,
                            maxSupply: 10000000
                        }
                    })
                }
            ];

            // Send the operation with proper credentials
            const result = await client.broadcast.sendOperations(
                [customJsonOperation],
                PrivateKey.fromString(privateKeys[0])
            );

            console.log(`Operation sent for ${token}:`, result);
        }

        // Call vote function after create completes
        await mint();

    } catch (error) {
        console.error('Error broadcasting operation:', error);
    }
};

const mint = async () => {
    try {
        console.log("Starting minting process...");

        for (t = 0; t < tokens.length; t++) {
            for (i = 0; i < receivers.length; i++) {
                const receiver = receivers[i]
                // Define the custom_json operation for voting
                const voteOperation = [
                    'custom_json',
                    {
                        required_auths: [],
                        required_posting_auths: ['echelon-node1'],
                        id: 'sidechain',
                        json: JSON.stringify({
                            contract: 'minttoken',
                            contractPayload: {
                                to: receiver,
                                symbol: tokens[t],
                                amount: 10000
                            }
                        })
                    }
                ];
    
                // Send the operation with proper credentials
                const result = await client.broadcast.sendOperations(
                    [voteOperation],
                    PrivateKey.fromString(privateKeys[0])
                );
    
                console.log(`Mint operation ${tokens[t]} sent for ${receiver}:`, result);
            }
        }
       

        console.log("Minting process completed.");
    } catch (error) {
        console.error('Error during minting process:', error);
    }
};

create()

