# MiniHack Module Integration Guide

This document explains how to integrate MiniHack bounty modules (like Trendjack Hunter) into the main WhatsApp bot server.

## Architecture Overview

```
whatsapp-bot/
├── server.js                          # Main application server
├── writers_flow/                      # Existing modular workflow
│   ├── index.js
│   └── orchestrator.js
├── minihack/                          # NEW: MiniHack bounties container
│   ├── bounty1-financial-controller/  # Bounty 1 (Future)
│   ├── bounty2-trendjack/             # Bounty 2 (Active)
│   │   ├── index.js
│   │   ├── orchestrator.js
│   │   ├── sources.js
│   │   ├── classifier.js
│   │   ├── contentBriefGenerator.js
│   │   ├── llmService.js
│   │   ├── config.js
│   │   └── README.md
│   ├── bounty3-boardy-ai/            # Bounty 3 (Future)
│   ├── bounty4-equity-docs/          # Bounty 4 (Future)
│   ├── bounty5-discovery-engine/     # Bounty 5 (Future)
│   ├── bounty6-knowledge-system/     # Bounty 6 (Future)
│   └── minihack-router.js            # Central router for all bounties
└── routes/                           # Existing route handlers
```

## Integration Steps

### Step 1: Update Intent Routing (server.js, line ~1838)

Add intent detection for each bounty:

```javascript
// Existing writers_flow detection
if (/(writersflow|pitch|opportunity|supply|product)/i.test(text)) return "writers_flow";

// NEW: Add minihack detections
if (/(trendjack|trend|viral|opportunity|what['']s trending)/i.test(text)) {
  return "minihack_trendjack";
}
if (/(financial|audit|books|accounting|cash flow)/i.test(text)) {
  return "minihack_financial";
}
if (/(boardy|match|connection|mentor|investor)/i.test(text)) {
  return "minihack_boardy";
}
if (/(legal|template|document|agreement|founder agreement)/i.test(text)) {
  return "minihack_equity";
}
if (/(hidden|champion|business|discover|profile)/i.test(text)) {
  return "minihack_discovery";
}
if (/(brain|know|answer|knowledge|faq)/i.test(text)) {
  return "minihack_knowledge";
}
```

### Step 2: Update Message Handler (server.js, line ~7192)

Add handlers for each minihack bounty:

```javascript
// TRENDJACK HUNTER (Bounty #2)
if (intent === "minihack_trendjack") {
  try {
    await sendMessage(from, "⏳ Analyzing trends across platforms...");
    
    const trendjackModule = await import('./minihack/bounty2-trendjack/orchestrator.js');
    const trendjack = trendjackModule.default;
    const { formatBriefsForWhatsApp } = trendjackModule;
    
    const result = await trendjack({
      userId: userData?.id || null,
      fromPhone: from,
      context: sessionContext,
      maxBriefs: 3,
      platforms: ["twitter", "tiktok", "reddit", "youtube", "news"],
    });
    
    if (result.ok && result.briefs.length > 0) {
      const briefMessage = formatBriefsForWhatsApp(result.briefs);
      await sendMessage(from, briefMessage);
    } else {
      await sendMessage(from, `⚠️ ${result.error || "No trends found at this moment. Try again later."}`);
    }
  } catch (err) {
    await sendMessage(from, `⚠️ Trendjack error: ${err.message}`);
  }
  return res.sendStatus(200);
}

// FINANCIAL CONTROLLER (Bounty #1) - Add similar pattern
if (intent === "minihack_financial") {
  try {
    // Import and execute financial controller
  } catch (err) {
    await sendMessage(from, `⚠️ Financial audit error: ${err.message}`);
  }
  return res.sendStatus(200);
}

// ... Similar patterns for other bounties
```

### Step 3: Create MiniHack Router (optional but recommended)

Create `minihack/minihack-router.js`:

```javascript
/**
 * Central router for all MiniHack bounty modules
 * Simplifies integration and provides unified interface
 */

import runTrendjack, { formatBriefsForWhatsApp as formatTrendjack } from './bounty2-trendjack/orchestrator.js';
// Import other bounties as they're implemented

const bounties = {
  trendjack: {
    intent: "minihack_trendjack",
    keywords: /(trendjack|trend|viral|what['']s trending)/i,
    module: runTrendjack,
    formatter: formatTrendjack,
    timeout: 30000,
  },
  // ... other bounties
};

export async function handleMiniHackIntent(intent, params) {
  for (const [key, bounty] of Object.entries(bounties)) {
    if (bounty.intent === intent) {
      return await executeBounty(key, bounty, params);
    }
  }
  return null;
}

async function executeBounty(key, bounty, params) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${key} timeout`)), bounty.timeout)
  );
  
  return Promise.race([
    bounty.module(params),
    timeoutPromise,
  ]);
}

export default { handleMiniHackIntent, bounties };
```

Then use in server.js:

```javascript
if (intent.startsWith("minihack_")) {
  const minihackRouter = await import('./minihack/minihack-router.js');
  const result = await minihackRouter.handleMiniHackIntent(intent, {
    userId: userData?.id,
    fromPhone: from,
    context: sessionContext,
  });
  // ... handle result
}
```

### Step 4: Add Admin Endpoints

Create endpoints for admin dashboard to monitor and configure bounties:

```javascript
// GET /admin/api/minihack/status
app.get('/admin/api/minihack/status', adminAuth, async (req, res) => {
  const minihackRouter = await import('./minihack/minihack-router.js');
  const stats = Object.entries(minihackRouter.bounties).map(([key, bounty]) => ({
    name: key,
    intent: bounty.intent,
    keywords: bounty.keywords.source,
    enabled: true,
    lastUsed: null,
    successRate: 0,
  }));
  res.json({ bounties: stats, generatedAt: new Date().toISOString() });
});

// POST /admin/api/minihack/test/:bounty
app.post('/admin/api/minihack/test/:bounty', adminAuth, async (req, res) => {
  const { bounty } = req.params;
  const minihackRouter = await import('./minihack/minihack-router.js');
  
  if (!minihackRouter.bounties[bounty]) {
    return res.status(404).json({ error: "Bounty not found" });
  }
  
  try {
    const result = await minihackRouter.bounties[bounty].module({
      userId: "admin-test",
      maxBriefs: 2,
    });
    res.json({ ok: true, bounty, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /admin/api/minihack/briefs (for Trendjack)
app.get('/admin/api/minihack/briefs', adminAuth, async (req, res) => {
  // Return cached briefs, analytics, etc.
  res.json({
    generatedAt: new Date().toISOString(),
    briefs: [], // Load from cache or DB
  });
});
```

### Step 5: Environment Variables

Add to `.env`:

```bash
# Trendjack Hunter (Bounty #2)
TWITTER_BEARER_TOKEN=your_token
REDDIT_CLIENT_ID=your_id
REDDIT_CLIENT_SECRET=your_secret
YOUTUBE_API_KEY=your_key
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4-turbo
TREND_CHECK_INTERVAL_MS=300000

# Financial Controller (Bounty #1)
ZOHO_BOOKS_CLIENT_ID=your_id
ZOHO_BOOKS_CLIENT_SECRET=your_secret

# Boardy.ai (Bounty #3)
BOARDY_API_KEY=your_key

# ... etc for other bounties
```

### Step 6: Update package.json

Ensure dependencies are included:

```json
{
  "dependencies": {
    "axios": "^1.6.0",
    "openai": "^4.0.0",
    // ... existing deps
  }
}
```

Run `npm install` to install any new dependencies.

## Testing

### Unit Test Each Bounty

```bash
# Test Trendjack Hunter
cd minihack/bounty2-trendjack
node -e "import('./orchestrator.js').then(m => m.testOrchestrator())"
```

### Integration Test

```bash
# Send test message via WhatsApp
# "What's trending?"
# Bot should respond with content briefs

# Or test programmatically:
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "254701234567",
            "text": {"body": "What is trending?"}
          }]
        }
      }]
    }]
  }'
```

## Dashboard Integration

Add to admin dashboard to display minihack module statuses:

```html
<!-- Admin Dashboard HTML -->
<section id="minihack-panel">
  <h2>MiniHack Bounties Status</h2>
  
  <div id="bounties-grid">
    <!-- Dynamically populated -->
  </div>
  
  <script>
    fetch('/admin/api/minihack/status')
      .then(r => r.json())
      .then(data => {
        // Render bounties
      });
  </script>
</section>
```

## Debugging

Enable debug logs:

```javascript
// In config.js of each module
export const DEBUG = process.env.DEBUG === "true";

// Use in modules
if (DEBUG) logger.log("Debug message", "DEBUG");
```

Then set in `.env`:

```bash
DEBUG=true
```

## Module Standards

All minihack bounty modules MUST follow this structure:

```
bountyN-name/
├── index.js                    # Entry point (exports default)
├── orchestrator.js             # Main logic
├── config.js                   # Configuration
├── [module1.js]               # Feature modules
├── [module2.js]
├── package.json               # Bounty-specific deps
├── README.md                  # Bounty documentation
└── test.js                    # Unit tests (optional)
```

### index.js template

```javascript
import runBounty, { ...exports } from './orchestrator.js';
export default runBounty;
export { ...exports };
```

### Orchestrator signature

```javascript
export default async function runBounty({
  userId = null,
  fromPhone = null,
  context = {},
  // bounty-specific params
} = {}) {
  return {
    ok: true/false,
    sessionId: "...",
    data: [...],
    error: null,
  };
}
```

## Monitoring

Track bounty usage and performance:

```javascript
// Log each bounty execution
await appendAdminAction({
  when: new Date().toISOString(),
  action: `minihack.${bountyName}`,
  status: result.ok ? "success" : "failed",
  actor: "system",
  metadata: {
    userId,
    sessionId: result.sessionId,
    duration_ms: result.summary?.durationMs,
  },
});
```

---

**MiniHack Module Integration Guide | Alphadome Whatsapp Bot**
