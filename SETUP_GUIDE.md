# WhatsApp Bot - Multi-Tenant Setup Guide

> Deploy a WhatsApp bot to multiple business clients with **zero redeployment**

---

## 🚀 Quick Start

### 1. Clone & Setup
```bash
git clone <repo>
cd whatsapp-bot
npm install
```

### 2. Environment Configuration
Create `.env` file:
```bash
# Supabase
SB_URL=https://twxmfdwemchrswxzjstp.supabase.co
SB_SERVICE_ROLE_KEY=your_service_role_key
DATABASE_URL=postgresql://postgres:password@db.supabase.co:5432/postgres

# Server
PORT=3000
DEFAULT_BRAND_ID=alphadome-test-brand
WEBHOOK_VERIFY_TOKEN=your_random_webhook_token

# AI (Optional - will use fallback)
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=...
HUGGINGFACE_API_KEY=...
```

### 3. Run Database Migration
```bash
# Migration #1: Create schema and tables
# Already applied to production database
# Contains: bot_tenants, bot_templates, bot_training_data, bot_control_settings, bot_message_logs
```

### 4. Start Server
```bash
npm start
# Server listens on http://localhost:3000
```

---

## 🧪 Testing

### Option A: Webhook Simulator (No Server Required)
```bash
node webhook_simulator.js
```
Shows complete message flow for:
- Text message → FAQ matching → Response
- Image message → AI analysis
- Webhook verification

**Output:** Visual flow diagram with all steps ✅

---

### Option B: Integration Tests (Database Tests)
```bash
node test_integration_sql.js
```
Tests multi-tenant database operations:
- Insert test tenant
- Load templates & FAQ
- Verify tenant isolation
- Test message logging

**Output:** Database health check ✅

---

### Option C: Webhook Tests (Requires Running Server)
```bash
npm start &              # Start server in background
node test_webhook.js     # Run HTTP endpoint tests
```
Tests webhook endpoints:
- Webhook verification (GET)
- Message receipt (POST)
- Unknown tenant fallback
- Concurrency handling
- Error scenarios

**Output:** 5/5 endpoint tests passing ✅

---

### Option D: Quick Database Verification
```bash
node verify_db.js
```
Confirms all 5 tables accessible:
- bot_tenants
- bot_templates
- bot_training_data
- bot_control_settings
- bot_message_logs

**Output:** ✅ 5/5 tables accessible

---

## 📋 Multi-Tenant Setup

### Insert New Tenant (Manual)

```sql
-- 1. Insert tenant record
INSERT INTO alphadome.bot_tenants (
  client_name, client_phone, brand_id,
  whatsapp_phone_number_id, whatsapp_business_account_id,
  whatsapp_access_token, ai_provider, ai_api_key, ai_model,
  is_active, is_verified, webhook_verify_token
) VALUES (
  'Business Name', '254702245555', 'brand-001',
  'PHONE_ID_123', 'ACCOUNT_ID_456',
  'ACCESS_TOKEN_XXX', 'openai', 'sk-...', 'gpt-3.5-turbo',
  true, false, 'webhook_verify_token'
);

-- 2. Insert conversation template
INSERT INTO bot_templates (bot_tenant_id, template_name, system_prompt, tone, is_default)
SELECT id, 'Default', 'You are a helpful bot for...', 'friendly', true
FROM bot_tenants WHERE client_phone = '254702245555';

-- 3. Insert FAQ entries
INSERT INTO bot_training_data (bot_tenant_id, data_type, question, answer, priority, confidence_score)
SELECT id, 'faq', 'Question?', 'Answer.', 10, 0.95
FROM bot_tenants WHERE client_phone = '254702245555';

-- 4. Insert control settings
INSERT INTO bot_control_settings (bot_tenant_id, is_bot_enabled, max_messages_per_hour, ...)
SELECT id, true, 100, ...
FROM bot_tenants WHERE client_phone = '254702245555';
```

### Or Use Migration Generator

```bash
node generate_migration_2.js \
  "PHONE_NUMBER_ID" \
  "ACCESS_TOKEN" \
  "BUSINESS_ACCOUNT_ID"
```

Outputs SQL migration ready to run in Supabase.

---

## 🔌 Webhook Integration

### Set Up in Meta Business Manager

1. **Register Webhook URL:**
   - Webhook URL: `https://your-domain.com/webhook`
   - Verify Token: `webhook_verify_token` from .env
   - Subscribe to: `messages` field

2. **Test Webhook Verification:**
   ```bash
   curl "https://your-domain.com/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=TEST_123"
   # Should return: TEST_123
   ```

3. **Start Receiving Messages:**
   - Customer sends WhatsApp message
   - Meta sends POST to your webhook
   - Server identifies tenant by phone
   - Message processed and response sent

---

## 📊 Message Flow

```
Customer WhatsApp Message
    ↓
Meta Webhook POST /webhook
    ↓
Extract: display_phone_number (routing key)
    ↓
Query: SELECT * FROM bot_tenants WHERE client_phone = ?
    ↓
Tenant Found? Load:
  • Templates
  • FAQ training data
  • Control settings
    ↓
Log inbound message
    ↓
Check FAQ match (fast, cost-free)
    ↓
FAQ match?
  ├─ YES → Return answer immediately
  └─ NO → Call AI
       → OpenAI? 
       → OpenRouter?
       → HuggingFace?
    ↓
Send response via WhatsApp API
    ↓
Log outbound message
    ↓
Done!
```

---

## 🗄️ Database Schema

### bot_tenants
Per-client configuration
```sql
id, client_name, client_phone (UNIQUE),
whatsapp_phone_number_id, whatsapp_business_account_id,
whatsapp_access_token (encrypted), ai_provider, ai_api_key (encrypted),
is_active, is_verified, webhook_verify_token
```

### bot_templates
Conversation templates
```sql
id, bot_tenant_id, template_name, system_prompt, tone,
is_active, is_default
```

### bot_training_data
FAQ entries
```sql
id, bot_tenant_id, data_type, question, answer, category,
priority, confidence_score, is_active
```

### bot_control_settings
Feature toggles per tenant
```sql
id, bot_tenant_id (UNIQUE), is_bot_enabled, max_messages_per_hour,
enable_ai_responses, enable_payment_flow, log_conversations,
escalation_phone, escalation_email
```

### bot_message_logs
Complete conversation history
```sql
id, bot_tenant_id, user_phone, direction, message_text,
ai_processed, ai_response, error_message, created_at
```

---

## 🔐 Security

- ✅ **Webhook Verification:** Every request validated with token
- ✅ **Tenant Isolation:** Database queries always filter by `bot_tenant_id`
- ✅ **Encrypted Credentials:** API keys stored encrypted at rest
- ✅ **No Data Leakage:** Tenant A cannot access Tenant B's data
- ✅ **Audit Logging:** All tenant modifications timestamped
- ✅ **Rate Limiting:** Per-tenant message limits enforced

---

## 📈 Monitoring

### Check Message Processing
```sql
-- Last 10 messages for a tenant
SELECT * FROM bot_message_logs
WHERE bot_tenant_id = (SELECT id FROM bot_tenants WHERE client_phone = '254702245555')
ORDER BY created_at DESC
LIMIT 10;

-- Error count
SELECT COUNT(*) FROM bot_message_logs
WHERE error_message IS NOT NULL
AND created_at > NOW() - INTERVAL '1 hour';

-- AI usage
SELECT ai_model_used, COUNT(*) as count
FROM bot_message_logs
WHERE ai_processed = true
GROUP BY ai_model_used;
```

---

## 🆘 Troubleshooting

### Webhook Not Receiving Messages
1. Check `is_verified = true` in bot_tenants
2. Verify webhook URL in Meta Business Manager
3. Check firewall/network access
4. Run: `node test_webhook.js` to test endpoint

### Messages Not Routing to Tenant
1. Verify `client_phone` matches Meta's `display_phone_number`
2. Check `is_active = true` in bot_tenants
3. Review `bot_message_logs` for errors
4. Ensure no duplicate phone numbers

### AI Response Failing
1. Check AI provider credentials
2. Verify rate limits in `bot_control_settings`
3. Check error_message in `bot_message_logs`
4. Fallback chain: OpenAI → OpenRouter → HuggingFace

### Rate Limit Exceeded
1. Check `max_messages_per_hour` setting
2. Review message count: `SELECT COUNT(*) FROM bot_message_logs WHERE created_at > NOW() - INTERVAL '1 hour'`
3. Escalation triggered → message sent to `escalation_phone`

---

## 📚 Documentation

- **[API_DOCUMENTATION.md](./API_DOCUMENTATION.md)** - Complete webhook API reference
- **[WAITING_PERIOD_SUMMARY.md](./WAITING_PERIOD_SUMMARY.md)** - Tests & tools built
- **[CREDENTIAL_REQUEST_FOR_GIDEON.md](./CREDENTIAL_REQUEST_FOR_GIDEON.md)** - Tenant setup instructions

---

## 🚀 Deployment Checklist

- [ ] Database migrations applied
- [ ] `.env` configured with credentials
- [ ] Webhook URL registered in Meta
- [ ] Webhook verification passed (`node test_webhook.js`)
- [ ] AI provider credentials set
- [ ] Rate limits configured
- [ ] Escalation phone set
- [ ] Test with real WhatsApp message
- [ ] Monitor `bot_message_logs` for success
- [ ] Alert system configured

---

## 📞 Support

For issues:
1. Check [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) troubleshooting section
2. Review `bot_message_logs` for error messages
3. Run tests: `node test_webhook.js`
4. Check server logs: `npm start`

---

**Last Updated:** February 6, 2026  
**Status:** Production Ready ✨
