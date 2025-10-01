const { Kafka } = require('kafkajs');
const dns = require('dns');
const net = require('net');

function parseBroker(broker) {
    const parts = broker.split(':');
    const port = parts.length > 1 ? parseInt(parts.pop(), 10) : 9092;
    const host = parts.join(':');
    return { host, port };
}

async function checkDns(host) {
    return new Promise((resolve) => {
        dns.lookup(host, (err, address) => {
            if (err) return resolve({ ok: false, error: err });
            return resolve({ ok: true, address });
        });
    });
}

async function checkTcp(host, port, timeout = 2000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        socket.setTimeout(timeout);
        socket.once('connect', () => {
            settled = true;
            socket.destroy();
            resolve({ ok: true });
        });
        socket.once('timeout', () => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve({ ok: false, error: new Error('timeout') });
            }
        });
        socket.once('error', (err) => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve({ ok: false, error: err });
            }
        });
        socket.connect(port, host);
    });
}

(async () => {
    const brokers = (process.env.BROKERS || process.env.KAFKA_BROKER || process.env.KAFKA_BROKERS || 'host.docker.internal:29092').split(',').map(s => s.trim()).filter(Boolean);
    console.log('Testing brokers:', brokers);

    for (const b of brokers) {
        const { host, port } = parseBroker(b);
        console.log(`\nChecking broker ${b} -> host='${host}' port=${port}`);
        const dnsRes = await checkDns(host);
        if (dnsRes.ok) {
            console.log(`DNS lookup: ${host} -> ${dnsRes.address}`);
        } else {
            console.error(`DNS lookup failed for ${host}:`, dnsRes.error && dnsRes.error.message ? dnsRes.error.message : dnsRes.error);
        }

        const tcpRes = await checkTcp(host, port, 3000);
        if (tcpRes.ok) {
            console.log(`TCP connect OK to ${host}:${port}`);
        } else {
            console.error(`TCP connect FAILED to ${host}:${port}:`, tcpRes.error && tcpRes.error.message ? tcpRes.error.message : tcpRes.error);
        }
    }

    try {
        const kafka = new Kafka({ clientId: 'test', brokers });
        const admin = kafka.admin();
        console.log('\nAttempting Kafka admin.connect()...');
        await admin.connect();
        console.log('connected-host');
        await admin.disconnect();
    } catch (err) {
        console.error('\nconnect-failed');
        if (err && err.stack) console.error(err.stack);
        else console.error(err);
        process.exit(1);
    }
})();