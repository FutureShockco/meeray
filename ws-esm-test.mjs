import WebSocket from 'ws';

const ws = new WebSocket('ws://echo.websocket.org');

ws.on('open', () => {
  console.log('WebSocket connection opened!');
  ws.send('Hello, world!');
});

ws.on('message', (msg) => {
  console.log('Received:', msg);
  ws.close();
});

ws.on('close', () => {
  console.log('WebSocket connection closed.');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err);
  process.exit(1);
}); 