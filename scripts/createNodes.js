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

const nodes = ['echelon-node1', 'echelon-node2', 'echelon-node3', 'echelon-node4', 'echelon-node5']
const publicKeys = ['mxRB23vGuuj4YjJNApTrjJ1D4urDoGJPt5Bqht26ZXm6', 'mxRB23vGuuj4YjJNApTrjJ1D4urDoGJPt5Bqht26ZXm6', '29YugDTkCuz1L2sQ8SvknF89cUh9RzaPfhogXrzuTJ7YK', 'wKqHm9QWCbQnqNT2Vz2Pk6pPistXgzvANJm2jAXubuzP', 'onk2Dhko4JjxGL8arsP4F41vCq5UPDNZKBaCRTMhd51J']

const create = async () => {
    try {
        for (i = 0; i < nodes.length; i++) {
            const node = nodes[i]
            const pubkey = publicKeys[i]
            const pkey = privateKeys[i]
            // Define the custom_json operation
            const customJsonOperation = [
                'custom_json',
                {
                    required_auths: [], // For active authority
                    required_posting_auths: [node], // Or [] if using active authority
                    id: 'sidechain', // Use the correct ID for your system
                    json: JSON.stringify({
                        contract: 'enablenode',  // Based on what we saw in your codebase
                        contractPayload: {
                            pub: pubkey  // Or whatever properties your contract needs
                        }
                    })
                }
            ];

            // Send the operation with proper credentials
            const result = await client.broadcast.sendOperations(
                [customJsonOperation],
                PrivateKey.fromString(pkey)
            );

            console.log(`Operation sent for ${node}:`, result);
        }

        // Call vote function after create completes
        await vote();

    } catch (error) {
        console.error('Error broadcasting operation:', error);
    }
};

const vote = async () => {
    try {
        console.log("Starting voting process...");

        for (i = 1; i < nodes.length; i++) {
            const node = nodes[i]
            // Define the custom_json operation for voting
            const voteOperation = [
                'custom_json',
                {
                    required_auths: [],
                    required_posting_auths: ['echelon-node1'],
                    id: 'sidechain',
                    json: JSON.stringify({
                        contract: 'approvenode',
                        contractPayload: {
                            to: node
                        }
                    })
                }
            ];

            // Send the operation with proper credentials
            const result = await client.broadcast.sendOperations(
                [voteOperation],
                PrivateKey.fromString(privateKeys[0])
            );

            console.log(`Vote operation sent for ${node}:`, result);
        }

        console.log("Voting process completed.");
    } catch (error) {
        console.error('Error during voting process:', error);
    }
};

create()

