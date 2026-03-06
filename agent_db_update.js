// agent_db_update.js
// Automates updating agent (tenant) info in Supabase for Purity, Saleh, Tekla
// Run: node agent_db_update.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SB_URL,
  process.env.SB_SERVICE_ROLE_KEY
);

const agents = [
  {
    client_name: 'Agent Purity',
    client_email: 'EMAIL_PLACEHOLDER',
    whatsapp_access_token: 'PASSWORD_PLACEHOLDER',
    metadata: { gamma_site: 'SITE_PLACEHOLDER' }
  },
  {
    client_name: 'Agent Saleh',
    client_email: 'EMAIL_PLACEHOLDER',
    whatsapp_access_token: 'PASSWORD_PLACEHOLDER',
    metadata: { gamma_site: 'SITE_PLACEHOLDER' }
  },
  {
    client_name: 'Agent Tekla',
    client_email: 'scornful.beaver.tuwy@letterguard.net',
    whatsapp_access_token: 'SasaAchaTuoneKunaendaje@254',
    metadata: { gamma_site: 'https://agent-tekla-30-19w4spk.gamma.site/' }
  }
];

async function upsertAgents() {
  for (const agent of agents) {
    const { data, error } = await supabase
      .from('alphadome.bot_tenants')
      .upsert([
        {
          client_name: agent.client_name,
          client_email: agent.client_email,
          whatsapp_access_token: agent.whatsapp_access_token,
          metadata: agent.metadata
        }
      ], { onConflict: ['client_name'] });
    if (error) {
      console.error(`Error updating ${agent.client_name}:`, error.message);
    } else {
      console.log(`Updated ${agent.client_name}`);
    }
  }
}

upsertAgents();
