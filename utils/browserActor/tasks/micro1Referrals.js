/**
 * Micro1 referral links are multi-role — and that is why nothing has been earning (2026-11-13)
 *
 * Live behaviour on micro1's "Your referral link" page:
 *
 *     Select the opportunities you want to include in your link
 *     … 1 Roles selected … Select at least 2 roles
 *
 * So a referral link is generated for a **group** of at least two opportunities, not per role.
 * Every link this system has captured for micro1 so far came from a single role page, which means
 * they are either not valid referral links at all or links that never attribute — consistent with
 * the dashboard showing no statistics while pages were being shared.
 *
 * What that changes, and what this module is:
 *
 *   - The unit of capture is a **group**, not a role. One generated link is attached to every
 *     offer in its group, so two roles share one link. That is micro1's own model, not a shortcut.
 *   - Groups should be *related* (same category, same skill family) because the page is organised
 *     that way and because a link mixing "Paralegal" with "Godot Developer" reads as spam to the
 *     person receiving it.
 *   - "Refer and earn" is the real value signal, so the planner prefers groups whose members pay
 *     the most per referral. Hourly pay is only a tiebreak: a $1,500 referral at $80/hr beats a
 *     $100 referral at $200/hr.
 *
 * Everything here is pure, so grouping is decided and tested offline; the browser only has to
 * click what this produces.
 */

/** Tokens too common to imply any relationship between two roles. */
const STOP = new Set([
  'expert', 'specialist', 'senior', 'junior', 'software', 'engineer', 'developer', 'analyst',
  'consultant', 'advisor', 'manager', 'associate', 'assistant', 'lead', 'principal', 'staff',
  'and', 'or', 'the', 'of', 'for', 'with', 'language', 'based', 'remote', 'us', 'uk', 'level',
  'training', 'evaluation', 'ai', 'ml', 'data', 'openings', 'role', 'roles'
]);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+\s#]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

/** "Legal Expert (Employment & Labor Law)" -> 'legal' — the family a recruiter would group on. */
export function roleFamily(title) {
  return tokens(title)[0] || null;
}

/** $1,000 -> 1000. "$100 - $200/hour" -> 200 (the top of the band, i.e. the best case). */
export function parseRefereeValue(text) {
  const numbers = String(text || '').match(/[\d,]+/g);
  if (!numbers) return null;
  const values = numbers.map((n) => Number(n.replace(/,/g, ''))).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

/** "$100 - $200/hour" -> 200, for the tiebreak. */
export function parsePay(text) {
  return parseRefereeValue(text);
}

/**
 * Cards read off the "Your referral link" page.
 *
 * The page renders each opportunity as a card with a title, a pay band, a "Refer and earn" figure
 * and an expandable skills list — so the reader returns text and the numbers are parsed here,
 * rather than by another regex written inside the browser expression.
 *
 * @param {{ok: boolean, cards?: object[]}} snapshot
 */
export function parseAffiliateCards(snapshot = {}) {
  if (!snapshot?.ok) return { ok: false, reason: snapshot?.reason || 'unreadable', cards: [] };
  const cards = (Array.isArray(snapshot.cards) ? snapshot.cards : [])
    .map((card, index) => ({
      index,
      title: String(card?.title || '').trim(),
      payText: card?.pay || null,
      referText: card?.refer || null,
      skills: Array.isArray(card?.skills) ? card.skills.filter(Boolean) : [],
      posted: card?.posted || null,
      openings: Number(String(card?.openings || '').match(/\d+/)?.[0] || 0) || null,
      family: roleFamily(card?.title),
      payMax: parsePay(card?.pay),
      referValue: parseRefereeValue(card?.refer)
    }))
    .filter((card) => card.title);
  return { ok: true, cards };
}

/**
 * Group cards into referral links of `size` roles.
 *
 * Same family first, then whatever is left — a link with two legal roles is a coherent
 * recommendation; a link mixing legal with game development is not. Ties inside a family break by
 * referral value, so the high-value pairs are generated first.
 *
 * @param {object[]} cards   from parseAffiliateCards().cards
 * @param {{size?: number, maxGroups?: number, alreadyGrouped?: string[]}} options
 * @returns {{groups: object[], skipped: object[]}}
 */
export function planReferralGroups(cards = [], { size = 2, maxGroups = 10, alreadyGrouped = [] } = {}) {
  const sizeWanted = Math.max(2, Number(size) || 2);
  const used = new Set((alreadyGrouped || []).map((t) => String(t).toLowerCase()));
  const pool = (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.title && !used.has(String(card.title).toLowerCase()));

  const byFamily = new Map();
  for (const card of pool) {
    const key = card.family || '(none)';
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(card);
  }
  for (const list of byFamily.values()) {
    list.sort((a, b) => (b.referValue || 0) - (a.referValue || 0) || (b.payMax || 0) - (a.payMax || 0));
  }

  const groups = [];
  const skipped = [];

  /** Take whole groups off the front of a list; remember the ones that cannot form one. */
  const take = (family, list, kind) => {
    while (list.length >= 2 && groups.length < maxGroups) {
      const members = list.splice(0, sizeWanted);
      groups.push({
        family,
        kind,
        members,
        title: members.map((m) => m.title).join(' + '),
        referralValue: members.reduce((sum, m) => sum + (m.referValue || 0), 0),
        maxPay: Math.max(...members.map((m) => m.payMax || 0)),
        // Carried into the run report so the portal can say *why* these were paired.
        reason: kind === 'family'
          ? `${members.length} ${family || 'related'} role(s) — a coherent recommendation`
          : `${members.length} leftover role(s) — paired to satisfy micro1's two-role minimum`
      });
    }
    for (const leftover of list) {
      skipped.push({ title: leftover.title, reason: 'no partner in its family — micro1 needs at least 2 roles' });
    }
  };

  for (const [family, list] of byFamily) take(family, list, 'family');

  // Stranded singles can still pair with other stranded singles: better a mixed link than an offer
  // that can never earn.
  if (groups.length < maxGroups) {
    const leftovers = [];
    for (const [, list] of byFamily) leftovers.push(...list);
    leftovers.sort((a, b) => (b.referValue || 0) - (a.referValue || 0));
    if (leftovers.length >= 2) {
      const mixed = [];
      take(null, leftovers, 'mixed');
      // `take` collected the pair(s); the remains are genuinely un-pairable.
      for (const item of mixed) leftovers.push(item);
    }
    for (const leftover of leftovers) {
      if (!skipped.some((s) => s.title === leftover.title)) {
        skipped.push({ title: leftover.title, reason: 'only one role left with no partner' });
      }
    }
  }

  groups.sort((a, b) => b.referralValue - a.referralValue || b.maxPay - a.maxPay);
  return { groups: groups.slice(0, maxGroups), skipped };
}

/**
 * Which of *our* offers a generated link belongs to.
 *
 * The link is per group, so every offer whose title matches a member gets the same URL. Matching is
 * normalised because micro1's card wording and our imported title differ by a suffix more often
 * than by meaning ("Student Loan Counselor" vs "Student Loan Counselor/Advisor").
 */
export function matchOffersToGroup(group, offers = []) {
  const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = (group.members || []).map((m) => norm(m.title));
  return (Array.isArray(offers) ? offers : []).filter((offer) => {
    const title = norm(offer.title);
    if (!title) return false;
    return wanted.some((target) => target && (title === target || title.startsWith(target) || target.startsWith(title)));
  });
}

