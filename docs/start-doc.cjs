// Simple test script to verify API documentation
const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api-docs',
  method: 'GET',
  headers: {
    'Accept': 'text/html'
  }
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  console.log(`Headers: ${JSON.stringify(res.headers)}`);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    if (data.includes('swagger') || data.includes('Swagger')) {
      console.log('✅ API Documentation is working!');
      console.log('📖 Visit http://localhost:3000/api-docs in your browser');
    } else {
      console.log('❌ API Documentation not found');
      console.log('Response preview:', data.substring(0, 200));
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Error:', error.message);
});

req.end();
