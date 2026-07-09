-- Kassangas Phase 1: Payment Template System Schema
-- This migration creates the tables needed for the QR-based payment template feature

-- Table 1: Payment Templates (created by merchants, scanned by customers)
CREATE TABLE IF NOT EXISTS kassangas_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id VARCHAR(255) UNIQUE NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  reusable BOOLEAN DEFAULT true,
  merchant_name VARCHAR(80),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB,
  status VARCHAR(50) DEFAULT 'active'
);

COMMENT ON COLUMN kassangas_templates.template_id IS 'Human-readable template identifier (e.g. TMPL-ABC123)';
COMMENT ON COLUMN kassangas_templates.item_name IS 'Description of item/service (e.g. "Trip No. 1 Town→Kayole")';
COMMENT ON COLUMN kassangas_templates.amount IS 'Amount in KES';
COMMENT ON COLUMN kassangas_templates.reusable IS 'Allow repeated use of this template';
COMMENT ON COLUMN kassangas_templates.status IS 'active, archived, etc';

CREATE INDEX idx_kassangas_templates_id ON kassangas_templates(template_id);
CREATE INDEX idx_kassangas_templates_merchant ON kassangas_templates(merchant_name);
CREATE INDEX idx_kassangas_templates_created ON kassangas_templates(created_at DESC);

-- Table 2: Payment Intents (one per transaction)
-- Note: Current schema uses existing 'subscriptions' table with metadata
-- This alternative table structure is documented here for reference:

/*
CREATE TABLE IF NOT EXISTS kassangas_payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id VARCHAR(255) REFERENCES kassangas_templates(template_id) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  item_name VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  mpesa_checkout_request_id VARCHAR(255),
  account_ref VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_intents_phone ON kassangas_payment_intents(phone);
CREATE INDEX idx_intents_template ON kassangas_payment_intents(template_id);
CREATE INDEX idx_intents_status ON kassangas_payment_intents(status);
CREATE INDEX idx_intents_created ON kassangas_payment_intents(created_at DESC);
*/

-- RECOMMENDED: Use existing 'subscriptions' table with plan_type='kassangas_template'
-- This avoids schema migration conflicts and reuses proven infrastructure

-- Indexes for performance on subscriptions used for Kassangas
CREATE INDEX IF NOT EXISTS idx_subscriptions_kassangas_plan_type 
  ON subscriptions(plan_type) 
  WHERE plan_type = 'kassangas_template';

CREATE INDEX IF NOT EXISTS idx_subscriptions_kassangas_created 
  ON subscriptions(created_at DESC) 
  WHERE plan_type = 'kassangas_template';

-- Execute this migration in Supabase SQL editor to set up Phase 1
