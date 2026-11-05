/**
 * OneForma: what to do next (2026-11-05)
 *
 * `tasks/oneForma.js` reads the contributor's certifications and open projects off the page.
 * This turns that reading into an ordered answer: do this, then that, and here is why. It is
 * pure — no DOM, no network, no clicks — because it is the part a demo has to be able to
 * show honestly.
 *
 * **Why there is no submission here.** Sitting a certification is an attestation that a
 * person did the work, and applying to a project is a representation to the client paying
 * for it. An agent that clicks those makes the account's answers untrue. So this module's
 * output stops one step earlier and is more useful for it: every action carries a `prep`
 * list (what the test will ask, what you scored last time, what the gap is) and the human
 * spends their effort answering rather than working out what to answer.
 *
 * Ranking is deliberately boring and explainable: an in-progress certification beats an
 * untouched one (it is nearly finished, and abandonments are the thing this is meant to
 * fix), a passed certification is not an action at all, and a project scores on its rate.
 */

function money(value) {
  const match = String(value || '').match(/(\d[\d,]*(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ''));
}

/** Points scored, out of whatever the row's denominator is. `7/10` -> {score:7, outOf:10}. */
function scoreValue(value) {
  const text = String(value || '');
  const fraction = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (fraction) return { score: Number(fraction[1]), outOf: Number(fraction[2]) };
  const single = text.match(/(\d+(?:\.\d+)?)/);
  if (single) return { score: Number(single[1]), outOf: null };
  return null;
}

function minutesFromTimeLimit(value) {
  const text = String(value || '').toLowerCase();
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(hour|hr)/);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const mins = text.match(/(\d+(?:\.\d+)?)\s*min/);
  if (mins) return Math.round(Number(mins[1]));
  return null;
}

function daysUntil(deadline, now) {
  if (!deadline) return null;
  const at = Date.parse(String(deadline));
  if (!Number.isFinite(at)) return null;
  return Math.round((at - now.getTime()) / 86400000);
}

function certificationAction(cert) {
  const reasons = [];
  const prep = [];
  let score = 0;

  if (cert.state === 'in_progress') { score += 45; reasons.push('already started — finishing costs one sitting'); }
  else if (cert.state === 'todo') { score += 40; reasons.push('not started, and it gates the work that pays'); }
  else if (cert.state === 'not_passed') {
    score += 20;
    reasons.push('not passed yet — a retake is the shortest route to more work');
  } else return null;

  const required = scoreValue(cert.requiredScore);
  const last = scoreValue(cert.lastScore);
  let gap = null;
  if (required && last && last.score < required.score) {
    gap = required.score - last.score;
    // A near miss is the cheapest win in the whole queue: a few points, one retake.
    if (gap <= 5) { score += 15; reasons.push(`last scored ${last.score}, needs ${required.score} — a ${gap}-point miss`); }
    else { reasons.push(`last scored ${last.score}, needs ${required.score} — ${gap} points short`); }
  } else if (required && !last) {
    reasons.push(`pass mark is ${required.score}${required.outOf ? '/' + required.outOf : ''}`);
  }

  if (cert.questions) prep.push(`${cert.questions} questions`);
  const minutes = minutesFromTimeLimit(cert.timeLimit);
  if (minutes) prep.push(`timed: ${minutes} minutes`);
  if (required) prep.push(`needs ${required.score}${required.outOf ? '/' + required.outOf : ''} to pass`);
  if (last) prep.push(`last attempt: ${last.score}${last.outOf ? '/' + last.outOf : ''}`);
  if (gap !== null) prep.push(`close a ${gap}-point gap`);
  prep.push('you take the test and submit it');

  return {
    kind: 'certification',
    title: cert.name,
    action: cert.state === 'not_passed' ? 'retake' : 'take',
    status: cert.state,
    category: cert.category || null,
    gap,
    score,
    reasons,
    prep
  };
}

function projectAction(project, now) {
  const reasons = [];
  const prep = [];
  let score = 0;

  const rate = money(project.rate);
  if (rate) {
    // Log scale for the same reason as the offer queue: one huge rate must not bury the
    // twenty ordinary ones, each of which is a separate application.
    score += Math.min(20, Math.round(Math.log10(rate + 1) * 10));
    reasons.push(`pays ${project.rate}`);
  } else {
    reasons.push('rate not stated');
  }

  const days = daysUntil(project.deadline, now);
  if (days !== null) {
    if (days < 0) prep.push('deadline has passed — check before spending time');
    else if (days <= 3) { score += 12; reasons.push(`closes in ${days} day(s)`); }
  }

  if (project.category) prep.push(`category: ${project.category}`);
  if (project.status) prep.push(`status: ${project.status}`);
  prep.push('you check the requirements against your profile');
  prep.push('you submit the application');

  return {
    kind: 'project',
    title: project.project || project.title || project.link || 'Untitled project',
    action: 'apply',
    status: project.status || null,
    category: project.category || null,
    rate: rate,
    daysLeft: days,
    score,
    reasons,
    prep
  };
}


/**
 * @param {{certifications?: object[], projects?: object[], now?: Date, limit?: number}} input
 * @returns {{actions: object[], skipped: object[], totals: object, headline: string}}
 */
export function rankOneFormaQueue({ certifications = [], projects = [], now = new Date(), limit = 5 } = {}) {
  const actions = [];
  const skipped = [];

  for (const cert of Array.isArray(certifications) ? certifications : []) {
    if (!cert || !cert.name) continue;
    const action = certificationAction(cert);
    if (action) actions.push(action);
    else skipped.push({ title: cert.name, reason: cert.state === 'passed' ? 'already_passed' : 'unknown_status' });
  }
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project) continue;
    const action = projectAction(project, now);
    if (action.title === 'Untitled project') { skipped.push({ title: '', reason: 'untitled_project' }); continue; }
    actions.push(action);
  }

  // Certifications outrank projects at equal score: a certification unlocks work, one
  // application does not. Ties then break by title so the order is stable between runs —
  // a queue that reshuffles itself every refresh is a queue nobody trusts.
  actions.sort((a, b) =>
    (b.score - a.score) ||
    (a.kind === b.kind ? 0 : a.kind === 'certification' ? -1 : 1) ||
    String(a.title).localeCompare(String(b.title)));

  const capped = actions.slice(0, Math.max(0, Number(limit) || 0));
  const totals = {
    certifications: (Array.isArray(certifications) ? certifications : []).length,
    projects: (Array.isArray(projects) ? projects : []).length,
    actions: actions.length,
    shown: capped.length,
    skipped: skipped.length,
    passed: skipped.filter((s) => s.reason === 'already_passed').length
  };

  const first = capped[0];
  const headline = first
    ? `${first.kind === 'certification' ? 'Finish' : 'Apply to'} ${first.title}` +
      (first.reasons.length ? ` — ${first.reasons[0]}` : '')
    : 'Nothing to do: every certification is passed and no projects are open';

  return { actions: capped, skipped, totals, headline };
}
