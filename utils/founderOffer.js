/**
 * The Founder's Package, and the words that ask for it (2026-11-19)
 *
 * Two facts shape every message here:
 *
 * 1. **The tenants are people the founder invited personally.** They applied through
 *    the discovery form, they are acquaintances, and the highest honest price is the
 *    founder's rate: KES 1,000 a month, against KES 3,000 for a new client. A message
 *    that quotes the walk-up price to a friend is a message that is never answered.
 * 2. **They have nothing to sell yet.** Eleven of twelve active tenants have an empty
 *    catalogue (`npm run money:routine` lists them). So the first message cannot be an
 *    invoice; it has to be the thing that makes the fee worth paying — the catalogue,
 *    one order end to end, and the proof that this machine earns.
 *
 * The proof is real and sourced: the same platform earned **USD 566.32** in Mercor
 * referral commission to date (`docs/BLOG_CONVERSION_ENGINE.md`). It is quoted as a
 * past result of the *platform*, never as a prediction for the tenant — a promise of
 * income is the one thing these messages must never make.
 *
 * Pure string assembly. The sending is a hand-off (`wa.me`) or the existing broadcast
 * lane; this module never sends.
 */

export const FOUNDERS_PACKAGE = Object.freeze({
  slug: 'founders-package',
  name: "Founder's Package",
  currency: 'KES',
  /** The discount for tenants already in the system (the founder's own list). */
  founderPrice: 1000,
  /** What a client arriving from now on pays. */
  standardPrice: 3000,
  cadence: 'month',
  /** What the fee buys, in the order a tenant cares about it. */
  includes: Object.freeze([
    'WhatsApp line that answers buyers and takes orders from your catalogue',
    'M-Pesa collection with a receipt per order, on your own merchant code',
    'Tenant portal: catalogue, orders, customers, abandoned carts, broadcasts',
    "Writer's Flow: an offer, the pages that rank for it, and a research queue",
    'The agentic lane (Work_Anda): applications filled, a human submits them'
  ]),
  /** Named, so a tenant can read the boundary instead of discovering it. */
  excludes: Object.freeze([
    'Guaranteed sales, hires or income — nobody can sell that',
    'Custom development beyond the published scope',
    'Ad spend, domains, Meta/Daraja fees and other third-party costs'
  ])
});

/** The price this tenant should be quoted. Existing tenants keep the founder's rate. */
export function priceFor({ existing = true } = {}) {
  return existing ? FOUNDERS_PACKAGE.founderPrice : FOUNDERS_PACKAGE.standardPrice;
}

/** A first name, or "there" — a message that opens with "Hi ," is a message deleted. */
export function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first && first.length > 1 ? first : 'there';
}

const clean = (v) => String(v == null ? '' : v).trim();
const money = (n) => `KES ${Number(n || 0).toLocaleString('en-KE')}`;

/**
 * The first message to an existing tenant: what is live, what to do first, and the
 * price — with the invoice deliberately deferred until the catalogue exists.
 */
export function activationMessage({
  contactName = '',
  businessName = '',
  portalUrl = '',
  offerUrl = '',
  existing = true
} = {}) {
  const who = firstName(contactName);
  const business = clean(businessName);
  const price = priceFor({ existing });
  const standard = FOUNDERS_PACKAGE.standardPrice;

  const lines = [
    `Hi ${who}, Saddy from Alphadome.`,
    '',
    business
      ? `Your workspace for ${business} is live${portalUrl ? ' — the link below signs you in, no password to copy.' : '.'}`
      : `Your workspace is live${portalUrl ? ' — the link below signs you in, no password to copy.' : '.'}`,
  ];
  // A message that says "the link below" with no link is the one people stop reading.
  if (portalUrl) lines.push(portalUrl);
  else lines.push('I will send your sign-in link separately — it is personal to your business number.');
  lines.push(
    '',
    'Two things are worth doing first:',
    '1. Catalogue — paste or send your price list. Until it is in, the bot has nothing to sell.',
    "2. Writer's Flow — describe one offer, and it writes the pages a buyer would land on.",
    '',
    `The system is ${money(price)} a month for tenants already in${existing ? ` (it is ${money(standard)} for a new client)` : ''}. I am not invoicing you until your catalogue is loaded and one order has gone through end to end — before that you would be paying for an empty shop.`,
    '',
    'Reply "catalogue" and I will load it, or send it like this — one line per item, name, price, stock:',
    'Omo 1kg | 320 | 12',
    'Omo 3kg, 890'
  );
  if (offerUrl) lines.push('', `What the fee covers: ${offerUrl}`);
  return lines.join('\n');
}

/**
 * The agentic angle on its own — for the tenants who reply to the proof with
 * "how does that earn?"
 */
export function agentMessage({ contactName = '', offerUrl = '' } = {}) {
  const who = firstName(contactName);
  const lines = [
    `${who}, the short version of the agent lane:`,
    '',
    '• Platforms pay for AI work: evaluations, data tasks, and chatter roles (ChatterApply lists chatter roles advertised around USD 450–600 a month).',
    '• The hard part is not the work, it is finishing the application and staying on the queue. That is what an agent is for.',
    '• Our Work_Anda agent fills the application and stops at the questions only you can answer. You read it, you press submit. Nothing is submitted on your behalf, so your account and your reputation stay yours.',
    '',
    'Same system, same login. It is the lane we are building next, on the rails that have already earned the USD 566.'
  ];
  if (offerUrl) lines.push('', `Where it sits in the fee: ${offerUrl}`);
  return lines.join('\n');
}

/** The two nudges. Short on purpose: a third paragraph is a message that is not read. */
export function followUpMessage({ step = 1, contactName = '', offerUrl = '' } = {}) {
  const who = firstName(contactName);
  if (Number(step) <= 1) {
    return [
      `${who}, still holding your workspace open.`,
      '',
      'If the catalogue is the blocker, send me a photo of your price list and I will load it for you — that is the only part that needs your time.',
      offerUrl ? `Fee and what it covers: ${offerUrl}` : ''
    ].filter(Boolean).join('\n');
  }
  return [
    `${who}, last one from me on this.`,
    '',
    `Your workspace stays live either way. When you want the catalogue loaded and the WhatsApp line taking orders, reply "go" and it is a two-hour job on my side.${offerUrl ? ' ' + offerUrl : ''}`
  ].join('\n');
}

/**
 * The proof. It is the founder's own ledger, said plainly, with the number and where
 * it comes from — because "we use AI" is a claim and a figure is evidence.
 */

export function proofMessage({ contactName = '', offerUrl = '' } = {}) {
  const who = firstName(contactName);
  const lines = [
    `Hi ${who} — the thing I keep failing to explain in one line:`,
    '',
    'This is not a bot that replies. It is a system that earns.',
    '',
    'The same platform has earned USD 566 in Mercor referral commission to date. That is our own ledger, not a projection: we found the roles, the engine wrote the pages, the apply button sits where a person actually presses it, and the commission followed.',
    '',
    'Your business runs on the same rails: the WhatsApp line answers, the catalogue sells, M-Pesa collects, and the content engine keeps the pages that bring the buyer.',
    '',
    'The part people ask about next is the agent lane — paid AI-task and chatter work, where the agent fills the application and stops at the questions only you can answer. You press submit, always.'
  ];
  if (offerUrl) lines.push('', `Details and the price: ${offerUrl}`);
  return lines.join('\n');
}

/**
 * For a client who arrives now, at the walk-up price. The founder's rate is named once
 * — as a fact about the list they were not on — and never as a lever to argue with.
 */
export function newClientMessage({ contactName = '', businessName = '', offerUrl = '' } = {}) {
  const who = firstName(contactName);
  const business = clean(businessName);
  const price = FOUNDERS_PACKAGE.standardPrice;
  const lines = [
    `Hi ${who}, Saddy from Alphadome.`,
    '',
    `You asked about ${business ? `getting ${business} selling on WhatsApp` : 'selling on WhatsApp'} — here is what that actually is.`,
    '',
    `The system is ${money(price)} a month: a WhatsApp line that answers from your catalogue, M-Pesa collection with a receipt per order, a portal for your orders and customers, and a content engine that writes the pages buyers search for.`,
    '',
    "The tenants who joined before this month pay KES 1,000 as a founder's rate. That list is closed — I mention it so the price is clear, not to negotiate it.",
    '',
    'If you want to see it work before deciding: send me your price list and I will put one order through end to end on your own number, same day.'
  ];
  if (offerUrl) lines.push('', `What is included: ${offerUrl}`);
  return lines.join('\n');
}

/** The order the campaign runs in, so nobody has to remember it. */
export function campaignSteps({ contactName = '', businessName = '', portalUrl = '', offerUrl = '', existing = true } = {}) {
  return [
    { day: 0, id: 'activation', text: activationMessage({ contactName, businessName, portalUrl, offerUrl, existing }) },
    { day: 2, id: 'proof', text: proofMessage({ contactName, offerUrl }) },
    { day: 4, id: 'agent', text: agentMessage({ contactName, offerUrl }) },
    { day: 7, id: 'nudge-1', text: followUpMessage({ step: 1, contactName, offerUrl }) },
    { day: 12, id: 'nudge-2', text: followUpMessage({ step: 2, contactName, offerUrl }) }
  ];
}

/** A one-line summary for a table, a CSV or a console. */
export function offerLine({ existing = true } = {}) {
  return `${FOUNDERS_PACKAGE.name}: ${money(priceFor({ existing }))}/${FOUNDERS_PACKAGE.cadence}`
    + (existing ? ` (founder's rate; new clients ${money(FOUNDERS_PACKAGE.standardPrice)})` : '');
}
