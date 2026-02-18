// utils/tenantSmtpConfig.js
// Utility for fetching and updating per-tenant SMTP config

import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SB_URL, process.env.SB_SERVICE_ROLE_KEY);

/**
 * Fetch SMTP config for a given tenant (by tenantId or brandId)
 */
export async function fetchTenantSmtpConfig({ tenantId, brandId }) {
  let query = supabase.from('bot_tenants').select('smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name').limit(1);
  if (tenantId) query = query.eq('id', tenantId);
  else if (brandId) query = query.eq('brand_id', brandId);
  else throw new Error('Must provide tenantId or brandId');
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Update SMTP config for a tenant (admin/dashboard or WhatsApp command)
 */
export async function updateTenantSmtpConfig({ tenantId, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name }) {
  if (!tenantId) throw new Error('tenantId required');
  const { error } = await supabase.from('bot_tenants').update({
    smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name
  }).eq('id', tenantId);
  if (error) throw error;
  return true;
}
