/**
 * Writer's Flow — Orchestrator
 * Full pipeline: scrape → qualify → generate → send → persist to Supabase
 *
 * @param {object} options
 * @param {string}   options.campaignId      - wf_campaigns.id (must exist in DB)
 * @param {string[]} options.keywords
 * @param {string[]} [options.industries]
 * @param {string[]} [options.outreachTypes]
 * @param {string[]} [options.channels]      - ['email'] | ['whatsapp'] | ['email','whatsapp']
 * @param {number}   [options.targetCount]
 * @param {number}   [options.qualityThreshold] - min score to auto-send (0-100)
 * @param {object}   [options.smtpConfig]    - nodemailer SMTP config
 * @param {object}   [options.supabase]      - Supabase client instance
 * @param {boolean}  [options.testMode]
 */



import scrapeLeads from './scraper.js';
import { qualifyLead, generateOutreach, generateWhatsAppMessage } from './qualifier.js';
import { humanizeMessage, getLLMConfig } from './llmService.js';
import sendEmail from './emailSender.js';
import { generateSearchQueries } from './queryGenerator.js';
import { isStopCommand } from './intentHandler.js';

// Stop flag for NLP-based interruption
let STOP_REQUESTED = false;
export function requestStop() {
  STOP_REQUESTED = true;
  console.log('[WF] Stop requested by user command.');
}
export function resetStop() {
  STOP_REQUESTED = false;
}
export function isStopActive() {
  return STOP_REQUESTED;
}

const SEND_DELAY_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saveLead(supabase, campaignId, lead) {
  const { data, error } = await supabase.from('wf_leads').insert([{
    campaign_id: campaignId,
    name: lead.contact_name || null,
    organization: lead.org_name || lead.title || null,
    url: lead.url || null,
    email: lead.email || null,
    phone: lead.phone || null,
    industry: lead.industry || null,
    description: lead.snippet || null,
    relevance_score: lead.relevance_score || 0,
    outreach_type: lead.outreach_type || 'pitch',
    status: lead.should_skip ? 'skipped' : 'qualified',
    source_query: lead.sourceQuery || null,
    source_result_title: lead.title || null,
    raw_snippet: lead.snippet || null,
    country: lead.country || null,
    qualified_at: new Date().toISOString(),
  }]).select('id').single();
  if (error) throw error;
  return data.id;
}

async function saveOutreach(supabase, leadId, campaignId, outreach) {
  const { data, error } = await supabase.from('wf_outreach').insert([{
    lead_id: leadId,
    campaign_id: campaignId,
    channel: outreach.channel,
    outreach_type: outreach.outreach_type,
    subject: outreach.subject || null,
    body: outreach.body,
    quality_score: outreach.quality_score || 0,
    status: outreach.status,
    sent_at: outreach.status === 'sent' ? new Date().toISOString() : null,
    error_message: outreach.error_message || null,
  }]).select('id').single();
  if (error) throw error;
  return data.id;
}

async function updateCampaignStats(supabase, campaignId, stats) {
  if (!supabase || !campaignId) return;
  await supabase.from('wf_campaigns').update({
    total_leads_found: stats.leads_found,
    total_outreach_sent: stats.outreach_sent,
    status: stats.status || 'completed',
    last_run_at: new Date().toISOString(),
    error_log: stats.error_log || null,
  }).eq('id', campaignId);
}

/**
 * @param {object} options
 * @param {string} options.campaignId
 * @param {string[]} [options.keywords]
 * @param {string[]} [options.industries]
 * @param {string[]} [options.outreachTypes]
 * @param {string[]} [options.channels]
 * @param {number} [options.targetCount]
 * @param {number} [options.qualityThreshold]
 * @param {object} [options.smtpConfig]
 * @param {object} [options.supabase]
 * @param {boolean} [options.testMode]
 * @param {string} [options.userCommand] - The original user request (e.g. "find me 30 opportunities in healthcare")
 * @param {string} [options.sector] - The target sector (e.g. "healthcare")
 * @param {string} [options.valueProps] - Alphadome's value proposition summary
 */
export default async function runWritersFlow({
  campaignId,
  keywords = [],
  industries = [],
  industryPlan = [],
  outreachTypes = ['pitch'],
  channels = ['email'],
  targetCount = 20,
  qualityThreshold = 70,
  smtpConfig = {},
  supabase,
  testMode = false,
  userCommand = '',
  sector = '',
  valueProps = 'Alphadome automates operations, content, and digital engagement for businesses via AI agents.'
} = {}) {
  const stats = { leads_found: 0, leads_qualified: 0, outreach_sent: 0, outreach_failed: 0, skipped: 0 };
  resetStop();
  console.log('[WF] Writer\'s Flow started.');
  console.log('[WF] LLM config:', getLLMConfig());

  if (supabase && campaignId) {
    await supabase.from('wf_campaigns')
      .update({ status: 'running', last_run_at: new Date().toISOString() })
      .eq('id', campaignId);
  }

  try {
    // NLP stop command check at start
    if (userCommand && isStopCommand(userCommand)) {
      requestStop();
      console.log('[WF] Received stop command at start. Exiting.');
      return { ...stats, stopped: true };
    }
    const topIndustryPreview = (industryPlan || []).slice(0, 3).map((p) => p.industry || p.name).filter(Boolean).join(', ');
    let searchQueries = keywords;
    if (userCommand && sector) {
      try {
        searchQueries = await generateSearchQueries(userCommand, sector, valueProps);
        console.log(`[WF] LLM-generated search queries: ${searchQueries.join(' | ')}`);
      } catch (err) {
        console.warn('[WF] Query generation failed, falling back to keywords:', err.message);
      }
    }
    console.log(`[WF] Scraping: queries=${searchQueries.join(', ')} | industries=${industries.join(', ')} | target=${targetCount}`);
    if (topIndustryPreview) {
      console.log(`[WF] Research-prioritized industries: ${topIndustryPreview}`);
    }

    if (STOP_REQUESTED) {
      console.log('[WF] Stop requested before scraping. Exiting.');
      return { ...stats, stopped: true };
    }

    const rawLeads = await scrapeLeads({
      keywords: searchQueries,
      industries,
      industryPlan,
      outreachTypes,
      targetCount,
      testMode,
    });
    stats.leads_found = rawLeads.length;
    console.log(`[WF] Found ${rawLeads.length} raw leads`);

    for (const rawLead of rawLeads) {
      if (STOP_REQUESTED) {
        console.log('[WF] Stop requested during lead processing. Exiting.');
        return { ...stats, stopped: true };
      }
      // Qualify
      const lead = await qualifyLead(rawLead);
      // NLP stop command check on each lead
      if (lead && lead.userCommand && isStopCommand(lead.userCommand)) {
        requestStop();
        console.log('[WF] Stop command detected in lead. Exiting.');
        return { ...stats, stopped: true };
      }
      if (lead.should_skip || lead.relevance_score < 30) {
        stats.skipped++;
        if (supabase && campaignId) await saveLead(supabase, campaignId, lead).catch(() => {});
        continue;
      }
      stats.leads_qualified++;

      let leadId = null;
      if (supabase && campaignId) {
        leadId = await saveLead(supabase, campaignId, lead).catch(() => null);
      }

      // Generate
      const generated = await generateOutreach(lead);
      if (!generated.body) { stats.skipped++; continue; }

      let finalBody = generated.body;
      if (generated.quality_score < 80) {
        finalBody = await humanizeMessage(generated.body, `${lead.outreach_type} for ${lead.org_name || lead.title}`);
      }

      const doEmail = channels.includes('email') && lead.email;
      const doWhatsApp = channels.includes('whatsapp') && lead.phone;

      if (!doEmail && !doWhatsApp) {
        // No contact info — save draft
        if (supabase && leadId && campaignId) {
          await saveOutreach(supabase, leadId, campaignId, {
            channel: 'email', outreach_type: lead.outreach_type,
            subject: generated.subject, body: finalBody,
            quality_score: generated.quality_score, status: 'draft',
          }).catch(() => {});
        }
        stats.skipped++;
        continue;
      }

      // Email
      if (doEmail) {
        if (generated.quality_score >= qualityThreshold) {
          try {
            await sendEmail({ to: lead.email, subject: generated.subject, text: finalBody, smtpConfig });
            stats.outreach_sent++;
            if (supabase && leadId && campaignId) {
              await saveOutreach(supabase, leadId, campaignId, {
                channel: 'email', outreach_type: lead.outreach_type,
                subject: generated.subject, body: finalBody,
                quality_score: generated.quality_score, status: 'sent',
              }).catch(() => {});
              await supabase.from('wf_leads')
                .update({ status: 'contacted', contacted_at: new Date().toISOString() })
                .eq('id', leadId).catch(() => {});
            }
            await sleep(SEND_DELAY_MS);
          } catch (err) {
            stats.outreach_failed++;
            console.error(`[WF] Email failed → ${lead.email}: ${err.message}`);
            if (supabase && leadId && campaignId) {
              await saveOutreach(supabase, leadId, campaignId, {
                channel: 'email', outreach_type: lead.outreach_type,
                subject: generated.subject, body: finalBody,
                quality_score: generated.quality_score, status: 'failed',
                error_message: err.message,
              }).catch(() => {});
            }
          }
        } else {
          // Below quality threshold → draft
          if (supabase && leadId && campaignId) {
            await saveOutreach(supabase, leadId, campaignId, {
              channel: 'email', outreach_type: lead.outreach_type,
              subject: generated.subject, body: finalBody,
              quality_score: generated.quality_score, status: 'draft',
            }).catch(() => {});
          }
          console.log(`[WF] Below threshold (${generated.quality_score}) — draft saved for ${lead.email}`);
        }
      }

      // WhatsApp (queued for manual dispatch — Meta policy compliance)
      if (doWhatsApp) {
        const waText = await generateWhatsAppMessage(lead, finalBody);
        if (supabase && leadId && campaignId) {
          await saveOutreach(supabase, leadId, campaignId, {
            channel: 'whatsapp', outreach_type: lead.outreach_type,
            subject: null, body: waText,
            quality_score: generated.quality_score, status: 'queued',
          }).catch(() => {});
        }
        console.log(`[WF] WhatsApp queued for ${lead.phone}`);
      }
    }

    await updateCampaignStats(supabase, campaignId, { ...stats, status: STOP_REQUESTED ? 'stopped' : 'completed' });
    if (STOP_REQUESTED) {
      console.log('[WF] Writer\'s Flow stopped by user command.');
      return { ...stats, stopped: true };
    }
    console.log('[WF] Writer\'s Flow completed.');
    return stats;

  } catch (err) {
    console.error(`[WF] Pipeline error: ${err.message}`);
    await updateCampaignStats(supabase, campaignId, { ...stats, status: 'failed', error_log: err.message });
    throw err;
  }
}
