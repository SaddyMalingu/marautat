# WhatsApp Bot Multi-Tenant API Documentation

## Overview

This is a multi-tenant WhatsApp bot system that allows multiple businesses (clients) to share a single server without code redeployment. Each tenant is identified by their WhatsApp phone number and has isolated configuration, templates, and conversation data.

**Key Features:**
- 🏢 Multi-tenant isolation (one server, many clients)
- 🔐 Secure credential storage (encrypted in database)
- 🤖 AI-powered responses (OpenAI → OpenRouter → HuggingFace fallback)
- 📚 FAQ matching before AI (reduce API costs)
- 📊 Per-tenant message logging and analytics
- ⚙️ Configurable per-tenant settings (rate limits, features, escalation)

---

## Webhook Endpoint

**Base URL:** `http://localhost:3000`

**Endpoint:** `POST /webhook`

### Webhook Verification (Setup)

Before Meta can send messages, verify the webhook is working:

**Request:**
```
GET /webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=CHALLENGE
```

**Parameters:**
- `hub.mode` (string): Always "subscribe"
- `hub.verify_token` (string): Must match `WEBHOOK_VERIFY_TOKEN` in `.env`
- `hub.challenge` (string): Random string from Meta, echo back in response

**Response (200 OK):**
```
CHALLENGE_VALUE
```

**Example (curl):**
```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=test123&hub.challenge=abc456"
# Response: abc456
```

---

## Incoming Messages

### Receive Text Message

**Request:**
```json
POST /webhook
Content-Type: application/json

{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "123456789",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "messages": [{
          "from": "254702245555",
          "id": "wamid.1234567890123456",
          "timestamp": "1234567890",
          "type": "text",
          "text": {
            "body": "Hello, what are your business hours?"
          }
        }],
        "contacts": [{
          "profile": { "name": "John Doe" },
          "wa_id": "254702245555"
        }],
        "metadata": {
          "display_phone_number": "254702245555",
          "phone_number_id": "119202345678901",
          "business_account_id": "108912345678901"
        }
      },
      "field": "messages"
    }]
  }]
}
```

**Response (200 OK):**
```json
{
  "status": "received",
  "message_id": "wamid.1234567890123456"
}
```

### Processing Flow

1. **Webhook Verification** - Meta verifies endpoint is online
2. **Extract Phone Number** - Get `metadata.display_phone_number`
3. **Find Tenant** - Query `bot_tenants` table by phone
4. **Load Configuration**:
   - Templates from `bot_templates`
   - FAQ data from `bot_training_data`
   - Settings from `bot_control_settings`
5. **Log Message** - Insert into `bot_message_logs`
6. **Process Message**:
   - Try FAQ match (exact keywords, embeddings)
   - If no match, call AI (OpenAI → OpenRouter → HuggingFace)
7. **Send Response** - Call Meta WhatsApp API
8. **Log Response** - Update `bot_message_logs` with AI response

---

## Supported Message Types

### Text Messages
```json
{
  "type": "text",
  "text": { "body": "User's text message" }
}
```

**Processing:**
- Check FAQ first (keywords/embeddings)
- Generate AI response if no FAQ match
- Support multi-line messages

---

### Image Messages
```json
{
  "type": "image",
  "image": {
    "mime_type": "image/jpeg",
    "sha256": "hash...",
    "id": "image_id"
  }
}
```

**Processing:**
- Download image from Meta servers
- If AI model supports vision: analyze image
- Return image description or answer

---

### Location Messages
```json
{
  "type": "location",
  "location": {
    "latitude": -1.2345,
    "longitude": 36.7890,
    "name": "Nairobi, Kenya",
    "address": "Main Street, Downtown"
  }
}
```

---

### Document Messages
```json
{
  "type": "document",
  "document": {
    "mime_type": "application/pdf",
    "sha256": "hash...",
    "id": "doc_id",
    "filename": "invoice.pdf"
  }
}
```

---

## Multi-Tenant Routing

### Tenant Identification

Tenants are uniquely identified by the **WhatsApp business phone number**:

```sql
SELECT * FROM alphadome.bot_tenants WHERE client_phone = '254702245555';
```

### Tenant Not Found

If phone number doesn't exist in database:
1. Uses DEFAULT_BRAND_ID from `.env`
2. Loads default templates and settings
3. Message still processed, fully backward compatible

### Example: Two Tenants

```sql
-- Tenant 1: Kassangas Music Shop
INSERT INTO bot_tenants (client_phone, client_name, ...)
VALUES ('254702245555', 'Kassangas Music Shop', ...);

-- Tenant 2: Another Business
INSERT INTO bot_tenants (client_phone, client_name, ...)
VALUES ('254711987654', 'Other Business Name', ...);
```

Both use the same server, same codebase, no redeployment needed.

---

## Database Schema

### bot_tenants
Stores per-client configuration:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| client_name | VARCHAR | Business name |
| **client_phone** | VARCHAR UNIQUE | WhatsApp number (routing key) |
| brand_id | UUID FK | Brand/team association |
| whatsapp_phone_number_id | VARCHAR | Meta phone ID |
| whatsapp_business_account_id | VARCHAR | Meta account ID |
| whatsapp_access_token | VARCHAR | API token (encrypted) |
| ai_provider | VARCHAR | "openai", "openrouter", "huggingface" |
| ai_api_key | VARCHAR | API key (encrypted) |
| ai_model | VARCHAR | Model name ("gpt-3.5-turbo", "mistral-large", etc) |
| is_active | BOOLEAN | Enable/disable tenant |
| is_verified | BOOLEAN | Meta webhook verified |
| webhook_verify_token | VARCHAR UNIQUE | Token for verification |
| webhook_url | VARCHAR | Callback URL for webhooks |
| metadata | JSONB | Custom tenant data |
| created_at, updated_at | TIMESTAMP | Audit |

---

### bot_templates
Conversation templates per tenant:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| bot_tenant_id | UUID FK | Tenant reference |
| template_name | VARCHAR | e.g., "Default Greeting", "Support" |
| **system_prompt** | TEXT | Instructions for AI (tenant-specific) |
| conversation_context | JSONB | Previous conversation summary |
| tone | VARCHAR | "friendly", "professional", "playful" |
| max_response_length | INTEGER | Character limit for responses |
| is_active | BOOLEAN | Use in conversations |
| is_default | BOOLEAN | Use if no specific template selected |
| metadata | JSONB | Custom instructions |
| created_at, updated_at | TIMESTAMP | Audit |

---

### bot_training_data
FAQ and training entries per tenant:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| bot_tenant_id | UUID FK | Tenant reference |
| data_type | VARCHAR | "faq", "example", "rule" |
| **question** | TEXT | User question pattern |
| **answer** | TEXT | Exact answer (FAQ) or example |
| category | VARCHAR | "general", "billing", "technical", etc |
| priority | INTEGER | 1-10, higher = match first |
| confidence_score | NUMERIC | 0.0-1.0, higher = better match |
| is_active | BOOLEAN | Include in FAQ matching |
| created_at, updated_at | TIMESTAMP | Audit |

**Example Matching Logic:**
```javascript
// Question: "What are your business hours?"
// Matches: priority 10, confidence 0.95
// Returns FAQ answer directly (no AI call, saves cost)
```

---

### bot_control_settings
Feature toggles and rate limits per tenant:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| **bot_tenant_id** | UUID FK UNIQUE | One setting per tenant |
| is_bot_enabled | BOOLEAN | Enable/disable conversations |
| max_messages_per_hour | INTEGER | Rate limit (100 = max 100/hour) |
| max_messages_per_user_per_day | INTEGER | Per user daily limit |
| enable_ai_responses | BOOLEAN | Use AI or FAQ only |
| enable_payment_flow | BOOLEAN | Enable payment collection |
| enable_training_mode | BOOLEAN | Record user feedback |
| enable_auto_reply | BOOLEAN | Auto-reply to messages |
| log_conversations | BOOLEAN | Store full conversation logs |
| log_errors | BOOLEAN | Store error logs |
| escalation_phone | VARCHAR | Phone to escalate if AI fails |
| escalation_email | VARCHAR | Email for escalations |
| metadata | JSONB | Custom settings |
| created_at, updated_at | TIMESTAMP | Audit |

---

### bot_message_logs
Complete conversation history per tenant:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| bot_tenant_id | UUID FK | Tenant reference (for isolation) |
| user_phone | VARCHAR | Customer WhatsApp number |
| user_id | UUID FK | User profile (optional) |
| **direction** | VARCHAR | "inbound" or "outbound" |
| message_text | TEXT | User or bot message |
| whatsapp_message_id | VARCHAR | Meta's message ID (idempotency) |
| message_type | VARCHAR | "text", "image", "document", etc |
| ai_processed | BOOLEAN | Was AI called for this message |
| ai_response | TEXT | Bot's reply |
| ai_model_used | VARCHAR | Which AI model processed |
| error_message | TEXT | Error if message failed |
| template_used | VARCHAR | Which template (if any) |
| training_data_id | UUID FK | FAQ matched (if any) |
| metadata | JSONB | Custom data |
| created_at | TIMESTAMP | Message timestamp |

---

## Error Handling

### Common Errors

**400 Bad Request**
```json
{
  "error": "Invalid message format",
  "details": "Missing 'messages' in payload"
}
```

**401 Unauthorized**
```json
{
  "error": "Invalid webhook token",
  "details": "hub.verify_token does not match"
}
```

**429 Too Many Requests**
```json
{
  "error": "Rate limit exceeded",
  "details": "Max 100 messages per hour for tenant"
}
```

**503 Service Unavailable**
```json
{
  "error": "AI service unavailable",
  "details": "All AI providers are offline, check bot_control_settings.escalation_phone"
}
```

---

## Examples

### Example 1: Setup New Tenant

**Step 1:** Insert tenant record
```sql
INSERT INTO alphadome.bot_tenants (
  client_name, client_phone, brand_id,
  whatsapp_phone_number_id, whatsapp_business_account_id,
  whatsapp_access_token, ai_provider, ai_api_key, ai_model,
  is_active, is_verified, webhook_verify_token
) VALUES (
  'Kassangas Music Shop', '254702245555', 'brand-001',
  '119202345678901', '108912345678901',
  'EAAX...encrypted...', 'openai', 'sk-...encrypted...',
  'gpt-3.5-turbo', true, true, 'verify_token_123'
);
```

**Step 2:** Insert templates
```sql
INSERT INTO bot_templates (bot_tenant_id, template_name, system_prompt, tone, is_default)
SELECT id, 'Default', 'You are a friendly customer service bot for Kassangas...',
       'friendly', true
FROM bot_tenants WHERE client_phone = '254702245555';
```

**Step 3:** Insert FAQ
```sql
INSERT INTO bot_training_data (bot_tenant_id, data_type, question, answer, priority, confidence_score)
SELECT id, 'faq',
  'What are your business hours?',
  'Open Monday-Friday 9AM-6PM, Saturday 10AM-4PM, Closed Sunday',
  10, 0.95
FROM bot_tenants WHERE client_phone = '254702245555';
```

---

### Example 2: Incoming Message Processing

**User sends:** "What are your business hours?"

**Server flow:**
```
1. Parse webhook payload
2. Extract phone: 254702245555
3. Query: SELECT * FROM bot_tenants WHERE client_phone = '254702245555'
   → Found: Kassangas Music Shop tenant
4. Load templates, FAQs, settings for this tenant
5. Log inbound message
6. Check FAQ: "business hours" keyword match
   → Found: priority 10, confidence 0.95, answer "Open Mon-Fri..."
7. Return FAQ answer (no AI call = $0 cost!)
8. Send via WhatsApp API
9. Log outbound message with FAQ reference
```

---

### Example 3: AI Fallback

**User sends:** "Can you recommend a guitar for a beginner?"

**Server flow:**
```
1. Parse and route to tenant (same as above)
2. Check FAQ keywords: no match
3. **AI Call #1:** OpenAI (gpt-3.5-turbo)
   → Timeout or rate limit? Continue...
4. **AI Call #2:** OpenRouter (mistral-large)
   → Error? Continue...
5. **AI Call #3:** HuggingFace (custom model)
   → Success! "For beginners, I recommend..."
6. Send response
7. Log with ai_model_used = "huggingface"
```

---

## Rate Limiting

Per-tenant rate limits (configurable):

```javascript
// From bot_control_settings
const limits = {
  max_messages_per_hour: 100,      // 100 messages/hour
  max_messages_per_user_per_day: 50 // Same user max 50/day
};

// Check: SELECT COUNT(*) FROM bot_message_logs
// WHERE bot_tenant_id = ? AND direction = 'inbound'
// AND created_at > NOW() - INTERVAL '1 hour';
```

If exceeded: escalate to `escalation_phone` via WhatsApp.

---

## Security Considerations

1. **Webhook Verification Token** - Verify every webhook request
2. **Encrypted Credentials** - Store tokens encrypted at rest
3. **Tenant Isolation** - Database queries always filter by `bot_tenant_id`
4. **No Data Leakage** - Tenant A cannot access Tenant B's FAQs, templates, logs
5. **API Key Rotation** - Credentials can be updated without redeployment
6. **Audit Logging** - All tenant modifications logged with timestamps

---

## Testing

### Webhook Verification Test
```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=test123&hub.challenge=test456"
```

### Message Test
```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{...message_payload...}'
```

### Automated Tests
```bash
npm run test:webhook    # Run webhook tests
npm run test:integration # Run full integration tests
npm run test:simulator   # Run webhook simulator (no server needed)
```

---

## Deployment Checklist

- [ ] Database migrations applied (Migration #1 complete)
- [ ] Tenant record created with real credentials
- [ ] webhook_verify_token set in Meta Business Manager
- [ ] Webhook URL registered in Meta: `https://your-domain.com/webhook`
- [ ] Rate limits configured in `bot_control_settings`
- [ ] AI provider credentials stored (encrypted)
- [ ] Escalation phone number set
- [ ] Test with real WhatsApp message
- [ ] Monitor `bot_message_logs` for errors
- [ ] Set up alerting on error spike

---

## Support

For issues:
1. Check `bot_message_logs` for error details
2. Verify tenant is `is_active = true`
3. Check AI credentials are valid
4. Review `bot_control_settings` rate limits
5. Test with webhook simulator: `node webhook_simulator.js`
