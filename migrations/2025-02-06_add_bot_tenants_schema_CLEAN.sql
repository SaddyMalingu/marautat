-- ============================================================================
-- ALPHADOME MULTI-TENANT BOT SYSTEM - MIGRATION (Simplified for Supabase)
-- ============================================================================

-- Step 1: Ensure schema exists
CREATE SCHEMA IF NOT EXISTS alphadome;

-- Step 2: Ensure pgcrypto extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Step 3: Create bot_tenants table
CREATE TABLE IF NOT EXISTS alphadome.bot_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name text NOT NULL,
  client_phone text UNIQUE NOT NULL,
  client_email text,
  brand_id uuid REFERENCES public.brands(id) ON DELETE CASCADE,
  point_of_contact_name text,
  point_of_contact_phone text,
  whatsapp_phone_number_id text NOT NULL,
  whatsapp_business_account_id text,
  whatsapp_access_token text NOT NULL,
  whatsapp_token_expires_at timestamp with time zone,
  ai_provider text DEFAULT 'openai',
  ai_api_key text,
  ai_model text DEFAULT 'gpt-4o-mini',
  is_active boolean DEFAULT false,
  is_verified boolean DEFAULT false,
  webhook_verify_token text UNIQUE,
  webhook_url text,
  -- Per-tenant SMTP config for Writer's Flow
  smtp_host text,
  smtp_port integer,
  smtp_user text,
  smtp_pass text,
  smtp_from_name text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_tenants_brand ON alphadome.bot_tenants(brand_id);
CREATE INDEX IF NOT EXISTS idx_bot_tenants_phone ON alphadome.bot_tenants(client_phone);
CREATE INDEX IF NOT EXISTS idx_bot_tenants_active ON alphadome.bot_tenants(is_active);

-- Step 4: Create bot_templates table
CREATE TABLE IF NOT EXISTS alphadome.bot_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_tenant_id uuid NOT NULL REFERENCES alphadome.bot_tenants(id) ON DELETE CASCADE,
  template_name text NOT NULL,
  description text,
  system_prompt text NOT NULL,
  conversation_context jsonb DEFAULT '[]'::jsonb,
  tone text DEFAULT 'professional',
  max_response_length integer DEFAULT 1000,
  is_active boolean DEFAULT true,
  is_default boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_templates_tenant ON alphadome.bot_templates(bot_tenant_id);
CREATE INDEX IF NOT EXISTS idx_bot_templates_active ON alphadome.bot_templates(is_active);

-- Step 5: Create bot_training_data table
CREATE TABLE IF NOT EXISTS alphadome.bot_training_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_tenant_id uuid NOT NULL REFERENCES alphadome.bot_tenants(id) ON DELETE CASCADE,
  data_type text NOT NULL,
  question text,
  answer text NOT NULL,
  category text,
  priority integer DEFAULT 0,
  confidence_score numeric DEFAULT 1.0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_tenant ON alphadome.bot_training_data(bot_tenant_id);
CREATE INDEX IF NOT EXISTS idx_training_active ON alphadome.bot_training_data(is_active);
CREATE INDEX IF NOT EXISTS idx_training_type ON alphadome.bot_training_data(data_type);

-- Step 6: Create bot_control_settings table
CREATE TABLE IF NOT EXISTS alphadome.bot_control_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_tenant_id uuid NOT NULL UNIQUE REFERENCES alphadome.bot_tenants(id) ON DELETE CASCADE,
  is_bot_enabled boolean DEFAULT true,
  max_messages_per_hour integer DEFAULT 100,
  max_messages_per_user_per_day integer DEFAULT 50,
  enable_ai_responses boolean DEFAULT true,
  enable_payment_flow boolean DEFAULT false,
  enable_training_mode boolean DEFAULT false,
  enable_auto_reply boolean DEFAULT true,
  log_conversations boolean DEFAULT true,
  log_errors boolean DEFAULT true,
  escalation_phone text,
  escalation_email text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_control_tenant ON alphadome.bot_control_settings(bot_tenant_id);

-- Step 7: Create bot_message_logs table
CREATE TABLE IF NOT EXISTS alphadome.bot_message_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_tenant_id uuid NOT NULL REFERENCES alphadome.bot_tenants(id) ON DELETE CASCADE,
  user_phone text NOT NULL,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  direction text NOT NULL,
  message_text text NOT NULL,
  whatsapp_message_id text,
  ai_processed boolean DEFAULT false,
  ai_response text,
  error_message text,
  template_used text,
  training_data_id uuid REFERENCES alphadome.bot_training_data(id) ON DELETE SET NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_logs_tenant ON alphadome.bot_message_logs(bot_tenant_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_phone ON alphadome.bot_message_logs(user_phone);
CREATE INDEX IF NOT EXISTS idx_message_logs_created ON alphadome.bot_message_logs(created_at);

-- Done!
SELECT 'Migration complete. Tables created:' as status;
SELECT table_name FROM information_schema.tables WHERE table_schema = 'alphadome' ORDER BY table_name;
