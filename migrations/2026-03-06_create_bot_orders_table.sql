-- Migration: Create bot_orders table for tenant order management
-- Date: 2026-03-06

CREATE TABLE IF NOT EXISTS alphadome.bot_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_tenant_id UUID REFERENCES alphadome.bot_tenants(id) ON DELETE CASCADE,
  customer_name TEXT,
  customer_phone TEXT,
  order_items JSONB NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL,
  currency TEXT DEFAULT 'KES',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup by tenant
CREATE INDEX IF NOT EXISTS idx_bot_orders_tenant ON alphadome.bot_orders(bot_tenant_id);

-- Enable RLS
ALTER TABLE alphadome.bot_orders ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role to read/write all orders
CREATE POLICY "Service role can access orders" ON alphadome.bot_orders
  FOR ALL USING (true);
