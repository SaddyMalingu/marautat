/**
 * Writer's Flow — Qualifier + Outreach Generator
 * Uses OpenAI GPT-4o to:
 *  1. Score lead relevance and extract enriched info
 *  2. Generate fully humanized, type-specific outreach messages
 *  3. Self-evaluate message quality (returns score 0-100)
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALPHADOME_CONTEXT = `
Alphadome is a WhatsApp-native AI sales and customer engagement platform for small and medium businesses.
It automates product catalogues, order processing, payment collection, and customer follow-up via WhatsApp.
Key value propositions:
- Zero app required: customers interact via WhatsApp
- AI-powered: automated responses, upselling, cart recovery
- Multi-tenant: serves restaurants, retail shops, services, e-commerce, NGOs, and more
- Affordable subscription with free trial
- Built for Africa and global emerging markets but applicable worldwide
Contact/pitch from: Alphadome team (contact@alphadome.co or via WhatsApp)
`.trim();

const OUTREACH_TONES = {
  pitch: 'confident, concise, value-focused, B2B sales pitch to a potential client',
  proposal: 'professional, detailed, solution-oriented project proposal',
  partnership: 'collaborative, warm, mutual-benefit focused partnership outreach',
  employment: 'proactive, skills-forward, enthusiastic job/collaboration inquiry',
};

// ──────────────────────────────────────────────
// STEP 1: Qualify a lead (score + enrich)
// ──────────────────────────────────────────────

/**
 * @param {object} lead - raw lead from scraper
 * @returns {Promise<object>} enriched lead with relevance_score, skip reason, outreach_type, etc.
 */
export async function qualifyLead(lead) {
  const prompt = `
You are a business development analyst for Alphadome.

${ALPHADOME_CONTEXT}

Analyze this lead and respond in JSON only (no markdown, no explanation):
{
  "relevance_score": <0-100>,
  "should_skip": <true|false>,
  "skip_reason": "<string or null>",
  "recommended_outreach_type": "<pitch|proposal|partnership|employment>",
  "org_name": "<best guess for organization name or null>",
  "contact_name": "<best guess for contact person name or null>",
  "industry": "<industry/sector>",
  "country": "<country if detectable or null>",
  "why_relevant": "<1-sentence reason or null if skip=true>"
}

Lead data:
Title: ${lead.title || 'N/A'}
URL: ${lead.url || 'N/A'}
Snippet: ${lead.snippet || 'N/A'}
Email found: ${lead.email || 'none'}
Phone found: ${lead.phone || 'none'}
Suggested type: ${lead.outreachType || 'pitch'}
Industry hint: ${lead.industry || 'unknown'}
`.trim();

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 300,
    });
    const parsed = JSON.parse(res.choices[0].message.content);
    return {
      ...lead,
      relevance_score: parsed.relevance_score ?? 0,
      should_skip: parsed.should_skip ?? false,
      skip_reason: parsed.skip_reason ?? null,
      outreach_type: parsed.recommended_outreach_type || lead.outreachType || 'pitch',
      org_name: parsed.org_name || null,
      contact_name: parsed.contact_name || null,
      industry: parsed.industry || lead.industry || null,
      country: parsed.country || null,
      why_relevant: parsed.why_relevant || null,
    };
  } catch (err) {
    console.error(`[Qualifier] Error qualifying lead ${lead.url}: ${err.message}`);
    return { ...lead, relevance_score: 0, should_skip: true, skip_reason: 'AI qualification failed' };
  }
}

// ──────────────────────────────────────────────
// STEP 2: Generate outreach message
// ──────────────────────────────────────────────

/**
 * @param {object} lead - qualified lead
 * @returns {Promise<{subject: string, body: string, quality_score: number}>}
 */
export async function generateOutreach(lead) {
  const tone = OUTREACH_TONES[lead.outreach_type] || OUTREACH_TONES.pitch;
  const recipientLine = lead.contact_name
    ? `Contact person: ${lead.contact_name}`
    : `No specific contact known — address to the team/hiring manager/decision-maker`;

  const prompt = `
You are a senior business development writer for Alphadome.

${ALPHADOME_CONTEXT}

Write a ${tone} email for the following lead. The email must:
- Sound completely human — natural flow, varied sentence lengths, no corporate buzzwords
- Be specific to this lead's industry/context — NOT generic
- Be concise (150-250 words maximum for the body)
- Include a clear, natural call to action
- NOT mention AI writing it
- For pitch/proposal: emphasize ROI and specific WhatsApp business benefits for their sector
- For partnership: focus on mutual audience overlap and collaboration potential
- For employment: highlight relevant skills and genuine interest in their work

Lead details:
Organization: ${lead.org_name || lead.title || 'Unknown'}
${recipientLine}
Industry: ${lead.industry || 'unknown'}
Why relevant: ${lead.why_relevant || 'potential fit for Alphadome services'}
Outreach type: ${lead.outreach_type || 'pitch'}
Country: ${lead.country || 'unknown'}

Respond in JSON only:
{
  "subject": "<email subject line>",
  "body": "<full email body, use \\n for line breaks>",
  "quality_score": <0-100 self-evaluation: 100=highly personalized, compelling; 0=generic/weak>
}
`.trim();

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_tokens: 700,
    });
    const parsed = JSON.parse(res.choices[0].message.content);
    return {
      subject: parsed.subject || 'Hello from Alphadome',
      body: parsed.body || '',
      quality_score: typeof parsed.quality_score === 'number' ? parsed.quality_score : 70,
    };
  } catch (err) {
    console.error(`[Generator] Error generating outreach for ${lead.url}: ${err.message}`);
    return { subject: 'Hello from Alphadome', body: '', quality_score: 0 };
  }
}

// ──────────────────────────────────────────────
// STEP 3: Generate WhatsApp message variant
// ──────────────────────────────────────────────

/**
 * @param {object} lead - qualified lead
 * @param {string} emailBody - the generated email body (for consistency)
 * @returns {Promise<string>} WhatsApp message text (max 1000 chars)
 */
export async function generateWhatsAppMessage(lead, emailBody) {
  const prompt = `
Condense the following email pitch into a WhatsApp message (max 200 words, conversational tone, no formal salutations).
Keep it warm, human, and end with a specific call to action.

Email:
${emailBody}

Lead: ${lead.org_name || lead.title}
Outreach type: ${lead.outreach_type}

Return only the WhatsApp message text, no JSON wrapper.
`.trim();

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 400,
    });
    return res.choices[0].message.content.trim();
  } catch (err) {
    console.error(`[Generator] WhatsApp message failed: ${err.message}`);
    return emailBody.slice(0, 800);
  }
}
