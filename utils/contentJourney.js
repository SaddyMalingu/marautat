// Content Journey System
// Each job gets a series of posts that take readers from awareness → action

// Offers are not all jobs. The journey was written for the Mercor job catalog,
// so a tenant's service listing generated "How to Get Hired as a Kassangas Music
// Shop" on its own blog (live, 2026-10-22). Templates therefore branch on
// offer_type: `job` (the default, and what every legacy row is) keeps the career
// copy, everything else gets buyer copy.
const isJobOffer = (job) => !job || !job.offer_type ? true : job.offer_type === 'job';
const offerCurrency = (job) => (job && job.compensation_currency) || 'KES';
const offerPrice = (job) => (job && job.compensation_max != null ? job.compensation_max : null);

// A rate the reader can recognise in the title. The LinkedIn export is blunt
// about why this matters: "Is $150/hr really what a senior software engineer
// earns?" reached 94% out-of-network and 153 impressions, while "Salary Guide"
// phrasing reached 23. The figure is the hook; the word "guide" is not.
const rateLabel = (job) => {
  const n = offerPrice(job);
  if (n == null) return '';
  const cur = offerCurrency(job);
  return (cur === 'USD' ? '$' : cur + ' ') + n + '/hr';
};

const CONTENT_ANGLES = {
  // Each angle represents a different stage in the reader's journey
  awareness: {
    name: "Awareness",
    description: "Help readers understand the offer and its value",
    templates: [
      {
        title: (job) => isJobOffer(job)
          ? `What a ${job.title} Actually Does All Day`
          : `${job.title}: What It Is, Who It Suits, What It Costs`,
        slug: (slug) => `${slug}-guide`,
        prompt: (job) => isJobOffer(job)
          ? `Write an educational blog post explaining what a ${job.title} does, why this role matters in the industry, and who should consider this career. Include: role overview, day-to-day responsibilities, industry demand, and career outlook. HTML format, NO markdown.`
          : `Write an educational blog post explaining what ${job.title} is, who it is for, what a buyer gets and what it does not include. Include: an overview, who it suits, what is typically included, and what to confirm before enquiring. HTML format, NO markdown.`
      },
      {
        title: (job) => isJobOffer(job)
          ? (rateLabel(job) ? `Is ${rateLabel(job)} Really What a ${job.title} Earns?` : `${job.title} Pay: What the Hourly Rate Really Means`)
          : `${job.title}: What It Costs and What You Get`,
        slug: (slug) => `${slug}-salary`,
        prompt: (job) => isJobOffer(job)
          ? `Write a comprehensive salary guide for ${job.title}. Include: hourly/annual breakdown ($${job.compensation_max || 75}/hr baseline), factors affecting pay, comparison with similar roles, negotiation tips, and regional variations. HTML format, NO markdown.`
          : `Write a pricing guide for ${job.title}${offerPrice(job) != null ? ` (listed at ${offerCurrency(job)} ${offerPrice(job)})` : ''}. Include: what drives the price, how to compare two quotes on identical scope, which exclusions to ask about, and how to negotiate without trading away quality. HTML format, NO markdown.`
      }
    ]
  },
  
  consideration: {
    name: "Consideration", 
    description: "Help readers evaluate if this fits them",
    templates: [
      {
        title: (job) => isJobOffer(job)
          ? `Is ${job.title} Right for You? A Self-Assessment`
          : `Is ${job.title} Right for You? A Buyer's Self-Assessment`,
        slug: (slug) => `${slug}-assessment`,
        prompt: (job) => isJobOffer(job)
          ? `Write a self-assessment guide for people considering becoming a ${job.title}. Include: required skills checklist, personality traits that succeed, common misconceptions, day-to-day reality vs expectations, and a scoring system to evaluate fit. HTML format, NO markdown.`
          : `Write a buyer's self-assessment for ${job.title}. Include: a readiness checklist, the questions to answer before enquiring, common misconceptions, what the offer does not cover, and a scoring system to decide whether to proceed. HTML format, NO markdown.`
      },
      {
        title: (job) => isJobOffer(job)
          ? `The Skills ${job.title} Work Actually Rewards`
          : `What to Check Before You Choose ${job.title}`,
        slug: (slug) => `${slug}-skills`,
        prompt: (job) => isJobOffer(job)
          ? `Write a comprehensive skills guide for ${job.title}. Include: technical skills (${job.skills?.join(', ') || 'relevant skills'}), soft skills, how to develop each skill, learning resources, and a 90-day skill building plan. HTML format, NO markdown.`
          : `Write a buyer's checklist for ${job.title}. Include: what to verify (${job.skills?.join(', ') || 'scope, timeline, exclusions'}), questions to ask, red flags, how to compare two offers fairly, and what to confirm in writing. HTML format, NO markdown.`
      }
    ]
  },
  
  preparation: {
    name: "Preparation",
    description: "Help readers prepare for success",
    templates: [
      {
        title: (job) => isJobOffer(job)
          ? `What the ${job.title} Assessment Asks For, and How to Prepare`
          : `How to Prepare Before You Contact ${job.title}`,
        slug: (slug) => `${slug}-prep`,
        prompt: (job) => isJobOffer(job)
          ? `Write an assessment preparation guide for ${job.title} roles. Include: what assessments typically cover, sample questions with explanations, study resources, common mistakes to avoid, and a 7-day prep plan. HTML format, NO markdown.`
          : `Write a preparation guide for buyers of ${job.title}. Include: what to have ready before enquiring, the brief to write, budget and timeline details to settle, common mistakes, and a 7-day prep plan. HTML format, NO markdown.`
      },
      {
        title: (job) => isJobOffer(job)
          ? `The Portfolio a ${job.title} Hiring Manager Actually Reads`
          : `How to Brief ${job.title} So You Get the Right Result`,
        slug: (slug) => `${slug}-portfolio`,
        prompt: (job) => isJobOffer(job)
          ? `Write a portfolio building guide for ${job.title}. Include: what makes a strong portfolio, 5 project ideas with detailed steps, how to present your work, common portfolio mistakes, and examples of successful portfolios. HTML format, NO markdown.`
          : `Write a guide on briefing ${job.title} well. Include: how to state the outcome, scope and constraints, what evidence to attach, how to keep quotes comparable, and how to review the delivery. HTML format, NO markdown.`
      }
    ]
  },
  
  action: {
    name: "Action",
    description: "Help readers take the next step",
    templates: [
      {
        title: (job) => isJobOffer(job)
          ? `Applying for ${job.title} Work: What Happens, Step by Step`
          : `How to Get Started with ${job.title}: Step by Step`,
        slug: (slug) => `${slug}-hired`,
        prompt: (job) => isJobOffer(job)
          ? `Write an actionable guide for getting hired as a ${job.title}. Include: where to find opportunities, application tips, interview preparation, salary negotiation scripts, and what to expect in the first 30 days. HTML format, NO markdown.`
          : `Write an actionable guide for buying or starting with ${job.title}. Include: how to make contact, what happens next, the first 30 days, and how to hold the supplier to the agreed terms. HTML format, NO markdown.`
      },
      {
        title: (job) => isJobOffer(job)
          ? `Where Remote ${job.title} Jobs Are Actually Listed`
          : `Taking ${job.title} Beyond a Single Site`,
        slug: (slug) => `${slug}-remote`,
        prompt: (job) => isJobOffer(job)
          ? `Write a guide for finding remote ${job.title} jobs. Include: best platforms for remote work, how to stand out as a remote candidate, salary expectations ($${job.compensation_max || 75}/hr baseline), remote work tools, and work-life balance tips. HTML format, NO markdown.`
          : `Write a guide to using ${job.title} across multiple sites, teams or seasons. Include: what to standardise first, how to sequence a rollout, what usually breaks, and how to compare results against the first engagement. HTML format, NO markdown.`
      }
    ]
  },
  
  mastery: {
    name: "Mastery",
    description: "Help readers excel once they commit",
    templates: [
      {
        title: (job) => isJobOffer(job)
          ? `What Changes in Five Years of ${job.title} Work`
          : `${job.title}: Getting More Value in the First Year`,
        slug: (slug) => `${slug}-roadmap`,
        prompt: (job) => isJobOffer(job)
          ? `Write a career progression guide for ${job.title}. Include: skills to develop each year, certifications worth pursuing, salary milestones, leadership opportunities, and how to stay relevant as the industry evolves. HTML format, NO markdown.`
          : `Write a guide to getting long-term value from ${job.title}. Include: quarterly milestones for the first year, the metrics worth tracking, how to handle scope changes, and when to renegotiate. HTML format, NO markdown.`
      }
    ]
  }
};

// Get all angles for a job
export function getAllAngles() {
  return Object.keys(CONTENT_ANGLES);
}

// Get templates for a specific angle
export function getAngleTemplates(angle) {
  return CONTENT_ANGLES[angle]?.templates || [];
}

// Get all templates across all angles
export function getAllTemplates() {
  const templates = [];
  Object.entries(CONTENT_ANGLES).forEach(([angle, data]) => {
    data.templates.forEach(template => {
      templates.push({ ...template, angle: angle, angleName: data.name });
    });
  });
  return templates;
}

// Generate a unique slug for each post
export function generateSlug(baseSlug, angle, index) {
  return `${baseSlug}-${angle}-${index}`;
}

// Get content journey for a job (all angles)
export function getContentJourney(job) {
  const journey = [];
  // opportunities.slug is generated by the API, but a legacy row can lack one.
  const rawSlug = job.slug || String(job.title || 'offer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const baseSlug = rawSlug.replace(/-salary$|-skills$|-howto$|-remote$|-guide$|-prep$|-portfolio$|-hired$|-roadmap$|-assessment$/, '');
  
  Object.entries(CONTENT_ANGLES).forEach(([angle, data]) => {
    data.templates.forEach((template, index) => {
      journey.push({
        angle,
        angleName: data.name,
        angleDescription: data.description,
        title: template.title(job),
        // Two templates share an angle, so a slug keyed only on the angle made
        // the second post overwrite the first. Live effect (2026-10-22): a
        // "9 of 9 angles" journey wrote 5 pages — the salary post silently
        // replaced the "what is it" guide. Stage keeps every angle its own URL.
        slug: data.templates.length > 1 ? `${baseSlug}-${angle}-${index + 1}` : `${baseSlug}-${angle}`,
        prompt: template.prompt(job),
        stage: index + 1
      });
    });
  });
  
  return journey;
}
