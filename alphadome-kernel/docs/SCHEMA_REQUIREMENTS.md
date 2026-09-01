# Schema Requirements

This document captures the minimum schema contracts currently required by kernel modules.

## Billing and Quotas

### user_credits

Required columns:
- `user_id` (uuid or text key used by auth layer)
- `balance` (numeric)
- `updated_at` (timestamp)

Usage:
- Read current credit balance.
- Initialize default balance when missing.
- Update balance after credit/debit operations.

### credit_transactions

Required columns:
- `id` (uuid)
- `user_id` (uuid or text)
- `amount` (numeric; positive for top-up, negative for usage)
- `type` (text; e.g. `top_up`, `usage`)
- `description` (text)
- `metadata` (jsonb, nullable)
- `created_at` (timestamp)

Usage:
- Append immutable transaction history per debit/top-up event.

### render_requests

Required columns:
- `user_id` (uuid or text)
- `created_at` (timestamp)

Usage:
- Count daily requests for quota enforcement in `src/billing/quota.ts`.

## Tenant Resolution and WhatsApp Ingress

### bot_tenants

Required columns:
- `id` (uuid)
- `client_name` (text)
- `client_phone` (text)
- `whatsapp_phone_number_id` (text)
- `is_active` (boolean, nullable)
- `status` (text, nullable)
- `updated_at` (timestamp)

Usage:
- Resolve tenant by incoming WhatsApp `phone_number_id` first.
- Fallback resolve by normalized business phone candidates.
- Prefer most recently updated records.
- If active filtering is enabled, keep only records considered active.

## Required RPC Functions

### get_tenant_by_wa

Input:
- `business_phone` (text)

Expected return payload shape:
- JSON object with `tenant` key.
- `tenant` should include at least `id`, `client_name`, and phone fields.

Usage:
- Fallback tenant resolution when direct table lookup does not return a tenant.

## Notes

- Current kernel code assumes these table and function names exactly as listed.
- If naming differs across environments, add mapping adapters before production rollout.
