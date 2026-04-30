-- Register Alphadome as a context-aware tenant
INSERT INTO bot_tenants (
  client_name,
  client_phone,
  brand_id,
  is_active,
  is_verified,
  whatsapp_phone_number_id,
  whatsapp_business_account_id,
  whatsapp_access_token,
  metadata,
  created_at,
  updated_at
) VALUES (
  'Alphadome',
  '254786817637',
  '1af71403-b4c3-4eac-9aab-48ee2576a9bb',
  true,
  true,
  'ALPHADOME_PHONE_ID',
  'ALPHADOME_WABA_ID',
  'ALPHADOME_TOKEN',
  '{}',
  NOW(),
  NOW()
)
ON CONFLICT (client_phone) DO UPDATE SET
  is_active = EXCLUDED.is_active,
  is_verified = EXCLUDED.is_verified,
  updated_at = NOW();

-- Replace ALPHADOME_PHONE_ID, ALPHADOME_WABA_ID, and ALPHADOME_TOKEN with real values if available.
-- Add templates, training data, and control settings as needed for full context-aware features.
