const path = require('path');
const express = require('express');
const app = express();
const port = process.env.APIDOC_PORT || 3333;

const distPath = path.join(__dirname, 'api');

// Serve static files
app.use(express.static(distPath));

// Catch-all route
app.use((req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(port, () => {
  console.log(`✅ App running at http://localhost:${port}`);
});