// Deterministic angle copy — the Writer's Flow journey must survive a dead AI tier.
//
// Live 2026-10-22: OpenRouter answered 429 on every free slug it had left, Gemini
// had spent the day's free quota and HuggingFace had no credits, so all nine
// angles returned nothing and the tenant got a 502 — a buyer watching the demo
// got an error page. A demo cannot depend on someone else's free tier, so each
// angle can also be *composed* from the offer's own fields.
//
// Composed posts are returned with fallback:true and the caller reports mode
// 'template' / 'mixed', so no operator (and no prospect) is ever told the AI
// wrote text it did not write. Copy is deliberately specific per angle: nine
// pages repeating one paragraph under different headings would be duplicate
// content and would look lazy to a buyer.

export const FALLBACK_CTA = {
  job: 'Apply now',
  product: 'Order now',
  service: 'Request a quote',
  brand: 'Get in touch',
  affiliate: 'See the offer',
  course: 'Enrol today',
};

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function offerPrice(o) {
  if (!o || o.compensation_max == null || o.compensation_max === '') return null;
  const n = Number(o.compensation_max);
  if (!isFinite(n)) return esc(o.compensation_max);
  return esc(o.compensation_currency || 'KES') + ' ' + n.toLocaleString('en-KE');
}

const h2 = (t) => '<h2>' + t + '</h2>';
const p = (t) => '<p>' + t + '</p>';
const ul = (items) => '<ul>' + items.map((x) => '<li>' + x + '</li>').join('') + '</ul>';

// Closing bullets, per angle, so no two pages end on the same thought.
// {subject} and {cta} are substituted at compose time; `kind`/`price` are
// already resolved into the body above.
const TAKEAWAYS = {
  'awareness:1': [
    '{subject} is judged on outcomes, not on the pitch that came with it.',
    'Ask what is included before you ask for a discount.',
    'Write the agreement down — a verbal yes is not a term.',
  ],
  'awareness:2': [
    'Compare total cost on identical scope, never on the headline figure.',
    'Exclusions explain more than inclusions do.',
    'Confirm how scope changes are priced before work starts.',
  ],
  'consideration:1': [
    'Know the outcome you need before you compare options.',
    'Make sure the decision-maker is in the conversation from the start.',
    'A low self-assessment score means open questions, not automatic rejection.',
  ],
  'consideration:2': [
    'Your responsiveness is part of the delivery timeline.',
    'Name one owner for approvals, and stick to them.',
    'Raise problems early, while fixes are still cheap.',
  ],
  'preparation:1': [
    'A complete brief earns an accurate quote.',
    'Separate real deadlines from preferences.',
    'Ask what happens when the scope changes.',
  ],
  'preparation:2': [
    'Lead with the outcome, then scope, then constraints.',
    'Evidence beats adjectives — send the photos and measurements.',
    'Keep the comparison fair by comparing like with like.',
  ],
  'action:1': [
    'Get scope, total and dates in writing before anything is scheduled.',
    'Book the first checkpoint at the same time as the start date.',
    'Ask what day one looks like before you commit.',
  ],
  'action:2': [
    'Standardise scope and reporting before adding sites.',
    'Add one location at a time against a fixed baseline.',
    'Log exceptions instead of quietly discounting them.',
  ],
  mastery: [
    'Document what "good" looks like in the first quarter.',
    'Track reworks — it is the honest quality signal.',
    'Renegotiate with measurements, not opinions.',
  ],
};

// Opening line, per angle. Nine posts that open with the same sentence read
// like one page duplicated (and blogManager.isDuplicate scores >0.5 overlap as a
// duplicate), so each angle leads with its own question.
const LEADS = {
  'awareness:1': 'Start with what {subject} actually is, who it suits and what a buyer should expect to see in writing.',
  'awareness:2': 'Price questions come first, so this page breaks down what sets the figure and how to test whether it is fair.',
  'consideration:1': 'Before comparing suppliers, check the decision is genuinely a fit — this is the short test.',
  'consideration:2': 'Half of a successful engagement is the supplier; the other half is what you bring to it.',
  'preparation:1': 'Preparation is the part you control, and it is where most of the savings hide.',
  'preparation:2': 'A precise brief is the cheapest way to get a precise answer.',
  'action:1': 'You have done the thinking; this is the short path from decision to start date.',
  'action:2': 'Growth changes the questions — this covers what to lock down before you scale.',
  mastery: 'The first delivery is the start, not the finish; this is how to keep the value compounding.',
};

const fill = (line, subject, cta) => line
  .replace(/\{subject\}/g, subject)
  .replace(/\{cta\}/g, cta.toLowerCase());

export function composeAnglePost(offer, item) {
  const o = offer || {};
  const it = item || {};
  const subject = esc(o.title || it.title || 'this offer');
  const kind = esc(o.offer_type || 'service');
  const price = offerPrice(o);
  const place = o.location_text ? esc(o.location_text) : null;
  const cta = esc(o.cta_label || FALLBACK_CTA[o.offer_type] || 'Get in touch');
  const skills = (Array.isArray(o.skills) ? o.skills : []).filter(Boolean).map(esc);
  const desc = String(o.description || '').trim();
  const where = place ? ' in ' + place : '';
  const key = String(it.angle || 'awareness') + ':' + String(it.stage || 1);
  const out = [];

  out.push(p(fill(LEADS[key] || LEADS.mastery, subject, cta) +
    ' Every claim below is drawn from the published details of ' + subject +
    ', so you can check each point against the source before you act on it.'));
  // The offer's own description is quoted once, on the first angle — repeating
  // it in all nine pages is what makes a generated series look duplicated.
  if (desc && key === 'awareness:1') out.push(p(esc(desc)));

  if (key === 'awareness:1') {
    out.push(h2('What ' + subject + ' actually involves'));
    out.push(p(subject + ' is a ' + kind + ' listing' + where +
      '. The listing is the starting point, not the whole story: what you are really comparing is the outcome it promises, the effort it asks of you and the terms attached to it.'));
    out.push(h2('Who it is for'));
    out.push(ul([
      'People actively comparing ' + kind + ' options' + where + ' and tired of vague quotes.',
      'Buyers who want the terms in writing before they spend time on a call.',
      'Anyone who has been burned by an offer that looked clear until the invoice arrived.',
      'Teams that need a decision documented, not a verbal promise.',
    ]));
    out.push(h2('Why it matters now'));
    out.push(p('Most ' + kind + ' decisions are made on the strength of one conversation. Writing the details down — what is included, what it costs, who is responsible — turns a hopeful conversation into something you can hold a supplier to.'));
    out.push(h2('What you get'));
    out.push(ul([
      price ? 'A listed figure of ' + price + '. Ask directly what it excludes.' : 'Terms that are still open — ask for the figure and the inclusions in writing.',
      'The scope of work attached to ' + subject + '.',
      'A named contact for follow-up questions.',
      'A clear next step: ' + cta + '.',
    ]));
  } else if (key === 'awareness:2') {
    out.push(h2(subject + ': what it costs and what moves the number'));
    out.push(price
      ? p('The listing shows ' + price + where + '. That figure is the anchor for every question below — the useful work is finding out what sits inside it.')
      : p('No figure is published for ' + subject + ', which is common for ' + kind + ' offers. Treat that as your first question rather than a red flag.'));
    out.push(h2('What typically drives the price'));
    out.push(ul([
      'Scope: how much is included before the price has to move.',
      place ? 'Location: ' + place + ' pricing carries its own logistics and staffing costs.' : 'Delivery: distance, timing and who carries the risk in transit.',
      'Speed: rushed work is priced differently from planned work.',
      'Support after delivery, which is where cheap quotes quietly become expensive.',
    ]));
    out.push(h2('How to judge whether the figure is fair'));
    out.push(p('Collect two or three comparable quotes on exactly the same scope. A quote is only comparable when the inclusions match; a lower number with fewer inclusions is not a saving, it is a different job.'));
    out.push(ul([
      'Ask each supplier to state exclusions explicitly.',
      'Confirm whether the price holds for the stated timeline.',
      'Check what happens if the scope changes mid-way.',
    ]));
    out.push(h2('Before you commit to a number'));
    out.push(p('Get the total — not the headline — in writing, then ' + cta.toLowerCase() + ' for ' + subject + ' and compare it line by line.'));
  } else if (key === 'consideration:1') {
    out.push(h2('Is ' + subject + ' right for you? A short self-assessment'));
    out.push(p('Score each statement from 1 (not true) to 5 (completely true). Anything below 3 is worth resolving before you commit.'));
    out.push(ul([
      'I can state exactly what I need ' + subject + ' to deliver.',
      'I know the budget range I can approve without asking anyone else.',
      'I have compared at least one alternative on the same scope.',
      'I understand what ' + subject + ' does not include.',
      'I know who signs off, and by when.',
    ]));
    out.push(h2('Where most people get this wrong'));
    out.push(ul([
      'Comparing headline prices across different scopes.',
      'Assuming the first conversation is the full picture.',
      'Leaving the decision-maker out until the last minute.',
      'Skipping the written summary because the call felt clear.',
    ]));
    out.push(h2('If you scored low'));
    out.push(p('Do not walk away — narrow the questions. Ask what is included, what it costs to extend, and what the timeline looks like' + where + '. Two precise questions usually resolve the doubt.'));
  } else if (key === 'consideration:2') {
    out.push(h2('What ' + subject + ' asks of you'));
    out.push(p('Every ' + kind + ' offer hands part of the work back to the buyer. Knowing your side of it is what separates a smooth engagement from a frustrating one.'));
    out.push(h2('Capabilities worth having in place'));
    out.push(ul(skills.length
      ? skills.map((s) => s + ' — confirm the level expected, not just the label.')
      : [
        'A clear written brief of the outcome you want.',
        'One decision-maker who can approve changes.',
        'Access to the information or site the work depends on.',
        'A realistic internal timeline for reviews and sign-off.',
      ]));
    out.push(h2('The soft side that decides the outcome'));
    out.push(ul([
      'Answering questions quickly — slow feedback is the most common cause of delay.',
      'Saying when something is wrong early, while it is still cheap to fix.',
      'Choosing one channel for decisions so nothing lives in two places.',
    ]));
    out.push(h2('A 30-day readiness plan'));
    out.push(p('Week one: write the brief. Week two: shortlist and compare on identical scope. Week three: agree terms and timelines in writing. Week four: ' + cta.toLowerCase() + ' and confirm start dates.'));
  } else if (key === 'preparation:1') {
    out.push(h2('What to have ready before you contact anyone about ' + subject));
    out.push(p('Preparation is the cheapest discount available. A supplier who receives a complete brief quotes accurately; a vague enquiry gets a padded number to cover the unknowns.'));
    out.push(h2('The short list'));
    out.push(ul([
      'Your objective in one sentence — what must be true when the work is done.',
      'The scope you want covered, and what you are deliberately leaving out.',
      price ? 'Your budget position against the listed ' + price + '.' : 'Your budget range, or the person who sets it.',
      'Deadlines that are real, and which ones are only preferences.',
      place ? 'Details specific to ' + place + ' — access, timings, restrictions.' : 'Any access or timing constraints.',
    ]));
    out.push(h2('Common preparation mistakes'));
    out.push(ul([
      'Sending a one-line enquiry and expecting an accurate number.',
      'Including "to be confirmed" items and treating the quote as final.',
      'Forgetting to ask what happens when the scope changes.',
    ]));
    out.push(h2('A seven-day prep plan'));
    out.push(p('Day 1–2: write the objective and scope. Day 3: list the constraints. Day 4: collect two comparable quotes. Day 5: compare inclusions line by line. Day 6: agree who holds the budget. Day 7: ' + cta.toLowerCase() + '.'));
  } else if (key === 'preparation:2') {
    out.push(h2('Presenting your requirement so ' + subject + ' works first time'));
    out.push(p('The quality of the answer you get is set by the quality of the question you ask. This is how to ask well.'));
    out.push(h2('A structure that gets a precise reply'));
    out.push(ul([
      'Outcome first: one sentence on what success looks like.',
      'Scope second: what is in, and what is out.',
      'Constraints third: budget, date, location' + (place ? ' (' + place + ')' : '') + '.',
      'Decision process last: who approves, and by when.',
    ]));
    out.push(h2('Show your evidence'));
    out.push(p('If you have photos, previous quotes, measurements or a specification, include them. Evidence removes assumptions, and assumptions are exactly where quotes drift.'));
    out.push(h2('What to avoid'));
    out.push(ul([
      'Sending the same copy-paste enquiry to five suppliers — it invites generic answers.',
      'Hiding the budget, which only produces guesses.',
      'Changing scope mid-quote without restarting the comparison.',
    ]));
    out.push(h2('Next step'));
    out.push(p('Put the four-part structure into a single message, then ' + cta.toLowerCase() + ' for ' + subject + '.'));
  } else if (key === 'action:1') {
    out.push(h2('How to move forward with ' + subject));
    out.push(p('You have compared, assessed and prepared. Three things turn that into progress: a written summary, a named contact and a date.'));
    out.push(h2('The next three steps'));
    out.push(ul([
      'Confirm the scope and the total in writing before anything is scheduled.',
      'Agree who does what, and by when.',
      'Book the start date, with a checkpoint already in the calendar.',
    ]));
    out.push(h2('What happens after you make contact'));
    out.push(ul([
      'Your brief is reviewed against what is actually deliverable.',
      price ? 'The listed ' + price + ' is confirmed or adjusted against your real scope.' : 'Pricing is confirmed against your real scope.',
      'Open questions are resolved before work begins.',
      'A start date and a checkpoint are agreed.',
    ]));
    out.push(h2('The first 30 days'));
    out.push(p('Expect a kickoff conversation, a confirmed plan and an early checkpoint. If a supplier cannot say what day one looks like, that is the signal to ask harder questions.'));
    out.push(h2('Ready?'));
    out.push(p(cta + ' and quote ' + subject + ' so your enquiry arrives with the context already attached.'));
  } else if (key === 'action:2') {
    out.push(h2('Taking ' + subject + ' beyond a single site'));
    out.push(p('Once the first engagement works' + where + ', the question changes from "is this good?" to "does it hold up at a second location, a second team or a second season?"'));
    out.push(h2('What to standardise before you scale'));
    out.push(ul([
      'One written scope template so every site is quoted on the same basis.',
      'One reporting format so results are comparable.',
      'One escalation path so problems do not depend on who noticed them.',
      'One price structure, with exceptions logged instead of quietly discounted.',
    ]));
    out.push(h2('What usually breaks first'));
    out.push(ul([
      'Local variations that nobody wrote down.',
      'A second site inheriting assumptions from the first.',
      'Timelines that were tight at one site becoming impossible at three.',
    ]));
    out.push(h2('How to sequence it'));
    out.push(p('Add one location at a time, each with its own written scope, and compare results against the original baseline before adding the next. ' + cta + ' and ask for the multi-site terms up front.'));
  } else {
    out.push(h2('Getting more value from ' + subject + ' over time'));
    out.push(p('Most of the value of a ' + kind + ' offer is realised after the first delivery — in how well it is used and how quickly problems are surfaced.'));
    out.push(h2('A 12-month roadmap'));
    out.push(ul([
      'Quarter 1: get the basics right and document what "good" looks like.',
      'Quarter 2: remove the recurring friction points you logged.',
      'Quarter 3: extend into the adjacent need you deliberately left out of scope.',
      'Quarter 4: renegotiate with evidence instead of opinion.',
    ]));
    out.push(h2('How to measure whether it is working'));
    out.push(ul([
      'Time from request to delivery, tracked monthly.',
      'Number of reworks, which is the honest quality signal.',
      'Cost per delivery as scope grows, not the headline price.',
      'Repeat decisions — if you keep choosing it, the value is real.',
    ]));
    out.push(h2('When to revisit the offer'));
    out.push(p('Revisit when scope changes materially, when a competitor quotes the same inclusions for less, or when the rework count stops falling. At that point ' + cta.toLowerCase() + ' with your measurements rather than starting the conversation over.'));
  }

  out.push(h2(key.slice(-2) === ':2' ? 'The details on record' : 'At a glance'));
  out.push(ul([
    'Offer: ' + subject + ' (' + kind + ')' + (place ? ', ' + place : '') + '.',
    price ? 'Listed price: ' + price + '.' : 'Price: quoted on request — ask for it in writing.',
    skills.length ? 'Relevant capabilities: ' + skills.join(', ') + '.' : 'Requirements: confirmed with the supplier before work starts.',
    'Next step: ' + cta + '.',
  ]));
  const takes = TAKEAWAYS[key] || TAKEAWAYS.mastery;
  out.push(h2('Key takeaways'));
  out.push(ul(takes.map((t) => fill(t, subject, cta))));

  return out.join('\n');
}
