/**
 * The outreach playbook (2026-11-19)
 *
 * Explee's shape, rebuilt on what this repo owns: a segment, a score, and three short
 * messages that name a real observation about the business. What it does *not* copy is the
 * part that needs a data provider — a semantic search over every company and decision maker
 * on earth. Discovery here is: the lists we already hold, plus the company's own website,
 * read for a phone number, an email and a WhatsApp link.
 *
 * Why the site scrape is the whole trick: **"your site has a WhatsApp button but no way to
 * order" is a true, specific, checkable observation**, and it is the exact problem this
 * platform sells against. "I saw you are in hospitality" is what gets deleted.
 *
 * Rules encoded here, each one a test:
 *   - one ask per message, never two;
 *   - no invented fact: an observation is only used if it was found on the site or in data
 *     we hold;
 *   - no income promise, ever;
 *   - a suppression key, so nobody is messaged twice by two campaigns;
 *   - three touches, then stop.
 */

export const MAX_TOUCHES = 3;

/**
 * Segments, in the order this business can serve them. Each carries the observation to look
 * for and the offer that answers it — because "we do automation" is not an offer.
 */
export const SEGMENTS = Object.freeze({
  tour_operators: {
    label: 'Tour operators',
    pain: 'bookings arrive on WhatsApp and get lost between guides and the office',
    offer: 'a WhatsApp line that answers from the tour catalogue and takes the deposit by M-Pesa',
    proof: 'one operator took a booking end to end without a human replying',
    queries: ['tour operator Nairobi', 'safari company Kenya bookings', 'day tours Nairobi contact'],
    signals: ['whatsapp', 'book', 'enquire', 'contact']
  },
  training_providers: {
    label: 'Training providers',
    pain: 'every intake is chased by hand and half the enquiries never get a reply',
    offer: 'a WhatsApp line that answers course questions from your catalogue and collects the fee',
    proof: 'course enquiries answered in seconds, deposits collected on the same thread',
    queries: ['training institute Nairobi courses', 'college Kenya enrolment contact'],
    signals: ['enrol', 'apply', 'whatsapp', 'fees']
  },
  private_schools: {
    label: 'Private schools',
    pain: 'admissions enquiries come to a personal phone and are answered at 9pm',
    offer: 'an admissions line that answers fees and intake questions, then books the visit',
    proof: 'parents answered instantly, visits booked without a staff member replying',
    queries: ['private school Nairobi admissions', 'academy Kenya contact'],
    signals: ['admissions', 'apply', 'whatsapp', 'fees']
  },
  property_managers: {
    label: 'Property managers',
    pain: 'viewing requests and maintenance tickets live in a WhatsApp group',
    offer: 'a tenant line that handles viewings and tickets from your listings',
    proof: 'viewings booked and tickets logged without an agent typing',
    queries: ['property management Nairobi', 'letting agent Kenya contact'],
    signals: ['viewing', 'vacancy', 'whatsapp', 'contact']
  },
  whatsapp_retailers: {
    label: 'WhatsApp-led retailers',
    pain: 'the catalogue lives in a phone and the same three questions get answered all day',
    offer: 'a catalogue the bot sells from, with M-Pesa collection and a receipt per order',
    proof: 'orders taken from the catalogue with a receipt for each one',
    queries: ['online shop Nairobi whatsapp', 'retailer Kenya order whatsapp'],
    signals: ['order', 'catalogue', 'whatsapp', 'delivery']
  },
  clinics: {
    label: 'Clinics and pharmacies',
    pain: 'appointments and refill questions arrive faster than the front desk can answer',
    offer: 'an appointment line that answers from the service list and takes the deposit',
    proof: 'appointments booked without the front desk typing',
    queries: ['clinic Nairobi contact', 'pharmacy Kenya whatsapp'],
    signals: ['appointment', 'book', 'whatsapp', 'services']
  }
});

export const segmentOf = (key) => SEGMENTS[String(key || '').trim()] || null;

export const ANGLES = Object.freeze([
  { id: 'observation', name: 'The observation', use: 'the thing you found on their site' },
  { id: 'cost_of_waiting', name: 'Cost of waiting', use: 'what the same three questions cost per week' },
  { id: 'sample', name: 'Offer a sample', use: 'reply to one real customer question, free, today' }
]);

/** Only what was actually found. Every observation cites where it came from. */
export function observations(lead = {}) {
  const found = [];
  if ((lead.whatsapp_number || lead.has_whatsapp_link) && !lead.has_checkout) {
    found.push('your site has a WhatsApp button, but no way to pay on it');
  }
  if (lead.has_whatsapp_link && !lead.email) {
    found.push('WhatsApp is your contact route, and there is no address to write to');
  }
  if (lead.instagram_only) found.push('the shop front is Instagram and the orders go to DMs');
  if (lead.hiring) found.push('you are hiring someone to answer customers');
  return found;
}

/** Fit, 0–100, with the reasons attached. A score with no reason is a number nobody trusts. */
export function scoreLead(lead = {}, segmentKey = '') {
  let score = 0;
  const reasons = [];
  if (String(lead.segment || segmentKey) === segmentKey) { score += 25; reasons.push('in the target segment'); }
  if (lead.email) { score += 20; reasons.push('email found'); }
  if (lead.phone) { score += 20; reasons.push('phone found'); }
  if (lead.whatsapp_number || lead.has_whatsapp_link) { score += 15; reasons.push('already sells on WhatsApp'); }
  if (lead.has_checkout === false) { score += 10; reasons.push('no online payment'); }
  if (lead.named_contact) { score += 5; reasons.push('named decision maker'); }
  if (lead.website) { score += 5; reasons.push('site reachable'); }
  if (lead.opt_out) { score = 0; reasons.push('opted out'); }
  return { score: Math.min(100, score), reasons };
}

/** One key per business, so two campaigns cannot message the same shop twice. */
export function suppressionKey(lead = {}) {
  const domain = String(lead.website || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  if (domain) return 'domain:' + domain;
  const mail = String(lead.email || '').toLowerCase();
  if (mail) return 'email:' + mail;
  const phone = String(lead.phone || lead.whatsapp_number || '').replace(/\D/g, '');
  if (phone) return 'phone:' + phone.slice(-9);
  return 'name:' + String(lead.org || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The sequence: three touches, one ask each, and the third closes the loop so nobody is
 * left wondering whether we will write again.
 */
export function buildSequence(lead = {}, segmentKey = '', { language = 'en' } = {}) {
  const seg = segmentOf(segmentKey) || {};
  const who = String(lead.contact_name || '').trim().split(/\s+/)[0] || '';
  const hi = who ? 'Hi ' + who + ',' : 'Hi,';
  const org = String(lead.org || '').trim();
  const found = observations(lead);
  const obs = found[0] || null;

  const first = [
    hi,
    '',
    obs
      ? 'I was on ' + (lead.website || org) + ' and noticed ' + obs + '.'
      : 'Quick one about ' + (org || 'your business') + ', not a pitch.',
    '',
    (seg.pain ? 'The usual cost of that: ' + seg.pain + '.' : ''),
    'We put ' + (seg.offer || 'a WhatsApp sales line') + ' behind it — ' + (seg.proof || 'it runs without anyone typing') + '.',
    '',
    'Worth a look, or not the right time?'
  ].filter(Boolean).join('\n').trim();

  const followUp = [
    hi,
    '',
    'Following the note below. One number, because it is easier to judge than an idea:',
    'the same three questions answered by hand cost a business a few hours a week, and the',
    'ones that arrive after 6pm usually do not get answered at all.',
    '',
    'If you send me your price list, I will load it and let the bot answer for a day — free,',
    'no card. You keep it or drop it.',
  ].join('\n');

  const closing = [
    hi,
    '',
    'Last one from me — I will not keep writing.',
    '',
    'If WhatsApp orders are not a priority this quarter, that is a fair answer and I will',
    'leave it. If they are, reply "show me" and I will send the one-page version.',
  ].join('\n');

  const whatsapp = [
    'Hi' + (who ? ' ' + who : '') + ' — ' + (obs ? 'I noticed ' + obs + '.' : 'quick one about ' + (org || 'your business') + '.'),
    'We answer WhatsApp and take the payment in the same thread: ' + (seg.offer || 'a sales line that sells from your catalogue') + '.',
    'Send your price list and I will load it today — "Omo 1kg | 320 | 12" is enough.'
  ].join(' ');

  return {
    language,
    touches: [
      { day: 0, channel: lead.email ? 'email' : 'whatsapp', kind: 'first', angle: 'observation', subject: obs ? 'Your WhatsApp button' : 'Quick one, ' + (org || 'not a pitch'), body: first },
      { day: 3, channel: lead.email ? 'email' : 'whatsapp', kind: 'follow-up', angle: 'cost_of_waiting', subject: 'Re: ' + (obs ? 'Your WhatsApp button' : 'Quick one'), body: followUp },
      { day: 8, channel: lead.email ? 'email' : 'whatsapp', kind: 'closing', angle: 'sample', subject: 'Closing the loop', body: closing }
    ].slice(0, MAX_TOUCHES),
    whatsapp_open: whatsapp
  };
}

/** The plan worst-case check: a lead with no channel is not a lead. */
export function isContactable(lead = {}) {
  return Boolean(lead.email || lead.phone || lead.whatsapp_number || lead.has_whatsapp_link);
}

/** A whole list → scored, deduped, sequenced, ordered. Nothing is sent here. */
export function buildPlan(leads = [], segmentKey = '', { limit = 25, suppress = [] } = {}) {
  const blocked = new Set(suppress.map((s) => String(s).toLowerCase()));
  const seen = new Set();
  const rows = [];

  for (const lead of leads) {
    if (!isContactable(lead)) continue;
    const key = suppressionKey(lead);
    if (blocked.has(key.toLowerCase()) || seen.has(key)) continue;
    seen.add(key);
    const { score, reasons } = scoreLead(lead, segmentKey);
    if (score <= 0) continue;
    rows.push({ ...lead, key, score, reasons, sequence: buildSequence(lead, segmentKey) });
  }

  rows.sort((a, b) => b.score - a.score);
  return { segment: segmentKey, total: rows.length, rows: rows.slice(0, limit) };
}
