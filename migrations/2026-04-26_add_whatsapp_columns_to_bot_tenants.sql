-- Migration: Add WhatsApp columns to public.bot_tenants
ALTER TABLE public.bot_tenants
ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id text,
ADD COLUMN IF NOT EXISTS whatsapp_business_account_id text;
