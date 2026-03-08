// seed_coachdawn3.js
// Script to insert Coach Dawn 3.0 tenant into alphadome.bot_tenants
// Run: node admin/seed_coachdawn3.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SB_URL,
  process.env.SB_SERVICE_ROLE_KEY
);

async function seedCoachDawn() {
  const { data, error } = await supabase
    .from('alphadome.bot_tenants')
    .upsert([
      {
        client_name: 'Coach Dawn 3.0',
        client_phone: '+254 748 621563',
        client_email: '',
        point_of_contact_name: 'Dawn Miracle Malingu',
        point_of_contact_phone: '+254 748 621563',
        is_active: true,
        is_verified: false,
        metadata: {
          business_address: 'Nairobi, Kenya',
          business_description: '',
          logo: '',
          industry: '',
          agent_description: `Revolutionizing chess with AI-powered coaching, tailored training, and game insights for learners, coaches, and industry stakeholders.\n\nVision for Coach Dawn 3.0\nFor Learners: Personalized training paths, in-depth game analysis, and tactical exercises to improve every aspect of your game.\nFor Coaches: Tools to monitor student progress, automate game reviews, and create customized lesson plans with ease.\nFor Industry Stakeholders: Enhanced tools for tournament organizers, streamers, content creators, and talent scouts, providing superior event management, player analysis, and real-time commentary.\n... (see full description in source)`
        }
      }
    ], { onConflict: ['client_phone'] });
  if (error) {
    console.error('Error inserting Coach Dawn 3.0:', error.message);
  } else {
    console.log('Coach Dawn 3.0 tenant seeded:', data);
  }
}

seedCoachDawn();
