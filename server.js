const express = require('express');
const { runFullCorridorScan } = require('./zone-scraper-system');

const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Trigger scan manually
app.post('/scan', async (req, res) => {
  try {
    const result = await runFullCorridorScan('Route 17 NY');
    res.json({ status: 'success', result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Run scan on startup
  console.log('Starting initial scan...');
  runFullCorridorScan('Route 17 NY').catch(console.error);
});
