// REST API endpoint for Writer's Flow
const express = require('express');
const writersFlow = require('./orchestrator');
const router = express.Router();

router.post('/writers-flow', async (req, res) => {
  const { keywords, userId, fromEmail } = req.body;
  try {
    const result = await writersFlow({ keywords, userId, fromEmail });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
