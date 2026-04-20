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
import { humanizeMessage } from './llmService.js';
import sendEmail from './emailSender.js';

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

export default async function runWritersFlow({
  campaignId,
  keywords = [],
  industries = [],
  outreachTypes = ['pitch'],
  channels = ['email'],
  targetCount = 20,
  qualityThreshold = 70,
  smtpConfig = {},
  supabase,
  testMode = false,
} = {}) {
  const stats = { leads_found: 0, leads_qualified: 0, outreach_sent: 0, outreach_failed: 0, skipped: 0 };

  if (supabase && campaignId) {
    await supabase.from('wf_campaigns')
      .update({ status: 'running', last_run_at: new Date().toISOString() })
      .eq('id', campaignId);
  }

  try {
    console.log(`[WF] Scraping: ${keywords.join(', ')} | target=${targetCount}`);
    const rawLeads = await scrapeLeads({ keywords, industries, outreachTypes, targetCount, testMode });
    stats.leads_found = rawLeads.length;
    console.log(`[WF] Found ${rawLeads.length} raw leads`);

    for (const rawLead of rawLeads) {
      // Qualify
      const lead = await qualifyLead(rawLead);
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

    await updateCampaignStats(supabase, campaignId, { ...stats, status: 'completed' });
    return stats;

  } catch (err) {
    console.error(`[WF] Pipeline error: ${err.message}`);
    await updateCampaignStats(supabase, campaignId, { ...stats, status: 'failed', error_log: err.message });
    throw err;
  }
}
