const fs = require('fs');
const path = require('path');
const { PrivateKey } = require('dsteem');
const { getClient, sendCustomJson } = require('./helpers.cjs');

async function main() {
    const { client, sscId } = await getClient();

    let privateKeys;
    try {
        // Load private keys from external file that will be gitignored
        const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
        privateKeys = JSON.parse(keysFile);
    } catch (err) {
        console.error('Error loading keys.json file:', err);
        process.exit(1);
    }

    //const nodes = ['meeray-node1', 'meeray-node2', 'meeray-node3', 'meeray-node4', 'meeray-node5'];
    //const publicKeys = ['e27B66QHwRLjnjxi5KAa9G7fLSDajtoB6CxuZ87oTdfS', 'mxRB23vGuuj4YjJNApTrjJ1D4urDoGJPt5Bqht26ZXm6', '29YugDTkCuz1L2sQ8SvknF89cUh9RzaPfhogXrzuTJ7YK', 'wKqHm9QWCbQnqNT2Vz2Pk6pPistXgzvANJm2jAXubuzP', 'onk2Dhko4JjxGL8arsP4F41vCq5UPDNZKBaCRTMhd51J'];

    const nodes = ['meeray-node1', 'meeray-node2', 'meeray-node3'];
    const publicKeys = ['e27B66QHwRLjnjxi5KAa9G7fLSDajtoB6CxuZ87oTdfS', 'mxRB23vGuuj4YjJNApTrjJ1D4urDoGJPt5Bqht26ZXm6', '29YugDTkCuz1L2sQ8SvknF89cUh9RzaPfhogXrzuTJ7YK'];


    const create = async () => {
        try {
            for (let i = 1; i < nodes.length; i++) {
                const node = nodes[i];
                const pubkey = publicKeys[i];
                const pkey = privateKeys[i];
                // Define the custom_json operation
                const customJsonOperation = [
                    'custom_json',
                    {
                        required_auths: [node], // For active authority
                        required_posting_auths: [], // Or [] if using active authority
                        id: 'sidechain', // Use the correct ID for your system
                        json: JSON.stringify({
                            contract: 'witness_register',
                            payload: {
                                pub: pubkey  // Or whatever properties your contract needs
                            }
                        })
                    }
                ];

                // Send the operation with proper credentials
                const result = await sendCustomJson(client, sscId,
                    'witness_register',
                    {
                        pub: pubkey
                    },
                    node,
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

            for (let i = 1; i < nodes.length; i++) {
                const node = nodes[i];
                // Define the custom_json operation for voting
                const voteOperation = [
                    'custom_json',
                    {
                        required_auths: ['meeray-node1'],
                        required_posting_auths: [],
                        id: 'sidechain',
                        json: JSON.stringify({
                            contract: 'witness_vote',
                            payload: {
                                target: node
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

    await create(); // Call the create function which then calls vote
}

main().catch(err => {
    console.error("Error in main execution:", err);
    process.exit(1);
});

