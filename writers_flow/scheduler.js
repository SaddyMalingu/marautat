// Scheduler for Writer's Flow outreach
import cron from 'node-cron';
import runWritersFlow from './orchestrator.js';
import supabase from '../supabase/client.js'; // Adjust path if needed

const INDUSTRIES = [
  'Healthcare', 'Finance', 'Education', 'Retail', 'Technology',
  'Real Estate', 'Travel', 'Legal', 'Manufacturing', 'Marketing',
  'Logistics', 'Construction', 'Media', 'Nonprofit', 'Hospitality',
  'Automotive', 'Energy', 'Fashion', 'Food & Beverage', 'Consulting',
  'Sports', 'Entertainment', 'Agriculture', 'Telecommunications', 'Insurance'
];

const KEYWORDS = ['automation', 'ai agents', 'digital marketing', 'growth', 'success'];

const CAMPAIGN_ID = 'alphadome-outreach'; // Update as needed
const EMAILS_PER_RUN = 5;
const QUALITY_THRESHOLD = 70;

cron.schedule('0 * * * *', async () => {
  // Runs at minute 0 every hour
  const selectedIndustries = [];
  while (selectedIndustries.length < EMAILS_PER_RUN) {
    const idx = Math.floor(Math.random() * INDUSTRIES.length);
    if (!selectedIndustries.includes(INDUSTRIES[idx])) selectedIndustries.push(INDUSTRIES[idx]);
  }
  console.log(`[Scheduler] Running outreach for: ${selectedIndustries.join(', ')}`);
  await runWritersFlow({
    campaignId: CAMPAIGN_ID,
    keywords: KEYWORDS,
    industries: selectedIndustries,
    targetCount: EMAILS_PER_RUN,
    qualityThreshold: QUALITY_THRESHOLD,
    channels: ['email'],
    supabase,
    testMode: false,
  });
});

console.log('Writer\'s Flow scheduler started. Will send 5 emails per hour, 24 hours a day.');
