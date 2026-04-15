
-- Migration #2: Insert Kassangas Music Shop Tenant
-- Date: 2026-02-05
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
  'Kassangas Music Shop',
  '254702245555',
  'alphadome-test-brand',
  'PHONE_NUMBER_ID_PLACEHOLDER',
  'ACCOUNT_ID_PLACEHOLDER',
  'ACCESS_TOKEN_PLACEHOLDER',
  'openai',
  'sk-YOUR_OPENAI_KEY_HERE', -- To be set separately after deployment
  'gpt-3.5-turbo',
  true,
  false, -- Will be set to true after webhook verification
  'c9a8c06ef82567cc2e6fbbce1d260dd1',
  'https://your-domain.com/webhook',
  '{
    "setup_date": "2026-02-05T23:07:19.127Z",
    "contact_person": "Gideon",
    "contact_phone": "254702245555",
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
    "created_at": "2026-02-05T23:07:19.127Z"
  }'::jsonb
FROM alphadome.bot_tenants
WHERE client_phone = '254702245555'
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
FROM alphadome.bot_tenants WHERE client_phone = '254702245555'
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
FROM alphadome.bot_tenants WHERE client_phone = '254702245555'
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
FROM alphadome.bot_tenants WHERE client_phone = '254702245555'
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
FROM alphadome.bot_tenants WHERE client_phone = '254702245555'
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
WHERE client_phone = '254702245555'
UNION ALL

-- Verify templates
SELECT
  'Templates Created' as check_name,
  COUNT(*) as count,
  'Should be >= 1' as expected
FROM alphadome.bot_templates
WHERE bot_tenant_id IN (SELECT id FROM alphadome.bot_tenants WHERE client_phone = '254702245555')
UNION ALL

-- Verify training data
SELECT
  'FAQ Entries Created' as check_name,
  COUNT(*) as count,
  'Should be >= 4' as expected
FROM alphadome.bot_training_data
WHERE bot_tenant_id IN (SELECT id FROM alphadome.bot_tenants WHERE client_phone = '254702245555')
UNION ALL

-- Verify control settings
SELECT
  'Control Settings Created' as check_name,
  COUNT(*) as count,
  'Should be 1' as expected
FROM alphadome.bot_control_settings
WHERE bot_tenant_id IN (SELECT id FROM alphadome.bot_tenants WHERE client_phone = '254702245555');

-- ============================================================================
-- NEXT STEPS
-- ============================================================================
-- 
-- 1. Set the actual OpenAI API key:
--    UPDATE alphadome.bot_tenants
--    SET ai_api_key = 'sk-YOUR_ACTUAL_KEY'
--    WHERE client_phone = '254702245555';
--
-- 2. Update webhook URL after deployment:
--    UPDATE alphadome.bot_tenants
--    SET webhook_url = 'https://your-deployed-domain.com/webhook'
--    WHERE client_phone = '254702245555';
--
-- 3. After webhook verification in Meta:
--    UPDATE alphadome.bot_tenants
--    SET is_verified = true
--    WHERE client_phone = '254702245555';
--
-- ============================================================================
