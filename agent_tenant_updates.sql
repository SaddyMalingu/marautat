-- SQL script to insert or update agent (tenant) info for Purity, Saleh, and Tekla
-- Replace placeholder values as needed for your environment

-- Agent Purity 3.0
INSERT INTO alphadome.bot_tenants (
  client_name, client_email, whatsapp_access_token, metadata
) VALUES (
  'Agent Purity', 'EMAIL_PLACEHOLDER', 'PASSWORD_PLACEHOLDER', '{"gamma_site": "SITE_PLACEHOLDER"}'
)
ON CONFLICT (client_name) DO UPDATE SET
  client_email = EXCLUDED.client_email,
  whatsapp_access_token = EXCLUDED.whatsapp_access_token,
  metadata = EXCLUDED.metadata;

-- Agent Saleh 3.0
INSERT INTO alphadome.bot_tenants (
  client_name, client_email, whatsapp_access_token, metadata
) VALUES (
  'Agent Saleh', 'EMAIL_PLACEHOLDER', 'PASSWORD_PLACEHOLDER', '{"gamma_site": "SITE_PLACEHOLDER"}'
)
ON CONFLICT (client_name) DO UPDATE SET
  client_email = EXCLUDED.client_email,
  whatsapp_access_token = EXCLUDED.whatsapp_access_token,
  metadata = EXCLUDED.metadata;

-- Agent Tekla 3.0
INSERT INTO alphadome.bot_tenants (
  client_name, client_email, whatsapp_access_token, metadata
) VALUES (
  'Agent Tekla', 'scornful.beaver.tuwy@letterguard.net', 'SasaAchaTuoneKunaendaje@254', '{"gamma_site": "https://agent-tekla-30-19w4spk.gamma.site/"}'
)
ON CONFLICT (client_name) DO UPDATE SET
  client_email = EXCLUDED.client_email,
  whatsapp_access_token = EXCLUDED.whatsapp_access_token,
  metadata = EXCLUDED.metadata;
