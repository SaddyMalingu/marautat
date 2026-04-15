/**
 * Migration #2: Insert Kassangas Music Shop Tenant
 * 
 * This script creates a SQL migration file to insert Gideon's tenant record
 * after he provides the required Meta credentials.
 * 
 * Usage:
 * 1. Get credentials from Gideon:
 *    - WhatsApp Phone Number ID
 *    - WhatsApp Access Token
 *    - WhatsApp Business Account ID
 * 
 * 2. Run this script with credentials:
 *    node migrations/setup_kassangas_tenant.js
 * 
 * 3. Copy the generated SQL to Supabase SQL Editor and run
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);

// Parse command-line arguments
const config = {
  phoneNumberId: args[0] || 'PHONE_NUMBER_ID_PLACEHOLDER',
  accessToken: args[1] || 'ACCESS_TOKEN_PLACEHOLDER',
  businessAccountId: args[2] || 'ACCOUNT_ID_PLACEHOLDER',
  clientPhone: '254702245555', // Gideon's WhatsApp number
  clientName: 'Kassangas Music Shop',
  brandId: 'alphadome-test-brand'
};

// Generate secure tokens
const webhookVerifyToken = crypto.randomBytes(32).toString('hex').substring(0, 32);
const webhookUrl = 'https://your-domain.com/webhook'; // Will be updated after deployment

// Generate the migration SQL
const migrationSQL = `
-- Migration #2: Insert Kassangas Music Shop Tenant
-- Date: ${new Date().toISOString().split('T')[0]}
-- Description: Add multi-tenant support for Kassangas Music Shop (Gideon)

-- ============================================================================
-- STEP 1: Insert Tenant Record
-- ============================================================================

INSERT INTO alphadome.bot_tenants (
  client_name,
  client_phone,
  brand_id,
  whatsapp_phone_number_id,
  whatsapp_business_account_id,
  whatsapp_access_token,
  ai_provider,
  ai_api_key,
  ai_model,
  is_active,
  is_verified,
  webhook_verify_token,
  webhook_url,
  metadata
) VALUES (
  '${config.clientName}',
  '${config.clientPhone}',
  '${config.brandId}',
  '${config.phoneNumberId}',
  '${config.businessAccountId}',
  '${config.accessToken}',
  'openai',
  'sk-YOUR_OPENAI_KEY_HERE', -- To be set separately after deployment
  'gpt-3.5-turbo',
  true,
  false, -- Will be set to true after webhook verification
  '${webhookVerifyToken}',
  '${webhookUrl}',
  '{
    "setup_date": "${new Date().toISOString()}",
    "contact_person": "Gideon",
    "contact_phone": "${config.clientPhone}",
    "notes": "Multi-tenant bot for music shop customer support"
  }'::jsonb
) ON CONFLICT (client_phone) DO UPDATE SET
  is_active = true,
  updated_at = NOW()
RETURNING id, client_name, client_phone;

-- ============================================================================
-- STEP 2: Insert Default Conversation Template
-- ============================================================================

INSERT INTO alphadome.bot_templates (
  bot_tenant_id,
  template_name,
  system_prompt,
  tone,
  is_active,
  is_default,
  metadata
)
SELECT
  id,
  'Kassangas Default',
  'You are a friendly and helpful customer service bot for Kassangas Music Shop. '
  'You help customers with product inquiries, orders, delivery status, and general questions. '
  'Be warm, professional, and knowledgeable about music instruments. '
  'If you cannot answer, offer to escalate to Gideon or provide his contact number.',
  'friendly',
  true,
  '{
    "purpose": "default",
    "version": "1.0",
    "created_at": "${new Date().toISOString()}"
  }'::jsonb
FROM alphadome.bot_tenants
WHERE client_phone = '${config.clientPhone}'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 3: Insert Common FAQs for Music Shop
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'faq',
  'What are your business hours?',
  'Kassangas Music Shop is open Monday to Friday from 10 AM to 6 PM, Saturday 10 AM to 4 PM, and closed on Sundays. '
  'You can also reach us via WhatsApp anytime for inquiries.',
  'general',
  10,
  0.95,
  true
FROM alphadome.bot_tenants WHERE client_phone = '${config.clientPhone}'
UNION ALL
SELECT
  id,
  'faq',
  'Do you deliver?',
  'Yes! We offer delivery to Nairobi and surrounding areas. Delivery charges vary by location. '
  'Orders over 10,000 KES get free delivery. Ask for delivery details when ordering.',
  'orders',
  9,
  0.93,
  true
FROM alphadome.bot_tenants WHERE client_phone = '${config.clientPhone}'
UNION ALL
SELECT
  id,
  'faq',
  'What payment methods do you accept?',
  'We accept M-Pesa, Mpesa, bank transfers, and cash on delivery. '
  'For online orders, M-Pesa is fastest. Send payment confirmation screenshot for faster processing.',
  'billing',
  9,
  0.92,
  true
FROM alphadome.bot_tenants WHERE client_phone = '${config.clientPhone}'
UNION ALL
SELECT
  id,
  'faq',
  'Do you offer warranties?',
  'Yes, all instruments come with a 1-year warranty on manufacturing defects. '
  'Warranty covers parts and labor but excludes damage from misuse or accidents.',
  'policies',
  8,
  0.90,
  true
FROM alphadome.bot_tenants WHERE client_phone = '${config.clientPhone}'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 4: Insert Control Settings
-- ============================================================================

INSERT INTO alphadome.bot_control_settings (
  bot_tenant_id,
  is_bot_enabled,
  max_messages_per_hour,
  max_messages_per_user_per_day,
  enable_ai_responses,
  enable_payment_flow,
  enable_training_mode,
  enable_auto_reply,
  log_conversations,
  log_errors,
  escalation_phone,
  escalation_email,
  metadata
)
SELECT
  id,
  true,
  200,
  100,
  true,
  false,
  true,
  true,
  true,
  true,
  '+254702245555', -- Gideon's direct line
  'gideon@kassangas.co.ke',
  '{
    "description": "Kassangas Music Shop settings",
    "max_response_length": 500,
    "auto_reply_message": "Thanks for reaching out! Our team will respond shortly."
  }'::jsonb
)
ON CONFLICT (bot_tenant_id) DO UPDATE SET
  is_bot_enabled = true,
  updated_at = NOW();

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Verify tenant was created
SELECT
  'Tenant Created' as check_name,
  COUNT(*) as count,
  'Should be 1' as expected
FROM alphadome.bot_tenants
WHERE client_phone = '${config.clientPhone}'
UNION ALL

-- Verify templates
SELECT
  'Templates Created' as check_name,
  COUNT(*) as count,
  'Should be >= 1' as expected
FROM alphadome.bot_templates
WHERE bot_tenant_id IN (SELECT id FROM alphadome.bot_tenants WHERE client_phone = '${config.clientPhone}')
UNION ALL

-- Verify training data
SELECT
  'FAQ Entries Created' as check_name,
  COUNT(*) as count,
  'Should be >= 4' as expected
FROM alphadome.bot_training_data
WHERE bot_tenant_id IN (SELECT id FROM alphadome.bot_tenants WHERE client_phone = '${config.clientPhone}')
UNION ALL

-- Verify control settings
SELECT
  'Control Settings Created' as check_name,
  COUNT(*) as count,
  'Should be 1' as expected
FROM alphadome.bot_control_settings
WHERE bot_tenant_id IN (SELECT id FROM alphadome.bot_tenants WHERE client_phone = '${config.clientPhone}');

-- ============================================================================
-- NEXT STEPS
-- ============================================================================
-- 
-- 1. Set the actual OpenAI API key:
--    UPDATE alphadome.bot_tenants
--    SET ai_api_key = 'sk-YOUR_ACTUAL_KEY'
--    WHERE client_phone = '${config.clientPhone}';
--
-- 2. Update webhook URL after deployment:
--    UPDATE alphadome.bot_tenants
--    SET webhook_url = 'https://your-deployed-domain.com/webhook'
--    WHERE client_phone = '${config.clientPhone}';
--
-- 3. After webhook verification in Meta:
--    UPDATE alphadome.bot_tenants
--    SET is_verified = true
--    WHERE client_phone = '${config.clientPhone}';
--
-- ============================================================================
`;

// Create migration file
const migrationDir = 'migrations';
const timestamp = new Date().toISOString().split('T')[0];
const filename = path.join(migrationDir, `${timestamp}_setup_kassangas_tenant.sql`);

if (!fs.existsSync(migrationDir)) {
  fs.mkdirSync(migrationDir, { recursive: true });
}

fs.writeFileSync(filename, migrationSQL);

// Also create a JSON config file for reference
const configFile = {
  migration: 'Migration #2: Kassangas Tenant Setup',
  date: new Date().toISOString(),
  tenant: {
    name: config.clientName,
    phone: config.clientPhone,
    contact: 'Gideon',
    contact_phone: config.clientPhone
  },
  meta_credentials: {
    phone_number_id: config.phoneNumberId,
    business_account_id: config.businessAccountId,
    access_token_placeholder: 'KEEP SECURE - DO NOT COMMIT'
  },
  webhook: {
    verify_token: webhookVerifyToken,
    url: webhookUrl
  },
  next_steps: [
    'Review the generated SQL migration file',
    'Copy contents to Supabase SQL Editor',
    'Run the migration',
    'Update OpenAI API key',
    'Verify in Meta Business Manager',
    'Test with real WhatsApp messages'
  ]
};

const configPath = path.join(migrationDir, `${timestamp}_kassangas_config.json`);
fs.writeFileSync(configPath, JSON.stringify(configFile, null, 2));

console.log('\n✅ Migration files generated:\n');
console.log(`📄 SQL: ${filename}`);
console.log(`📋 Config: ${configPath}`);
console.log(`\n📌 Webhook Verify Token: ${webhookVerifyToken}`);
console.log(`   (Use this in Meta Business Manager webhook settings)`);
console.log(`\n📌 Credentials Provided:`);
console.log(`   Phone Number ID: ${config.phoneNumberId}`);
console.log(`   Business Account ID: ${config.businessAccountId}`);
console.log(`\n✨ Next steps:`);
console.log(`   1. Review the SQL file`);
console.log(`   2. Copy to Supabase SQL Editor`);
console.log(`   3. Run the migration`);
console.log(`   4. Update OpenAI key`);
console.log(`   5. Verify webhook in Meta\n`);
