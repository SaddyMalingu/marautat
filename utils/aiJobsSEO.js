const SITE_URL = process.env.SITE_URL || 'https://alphadome.com';

const CATEGORY_KEYWORDS = {
  'software-engineering': { primary: 'software engineering jobs', secondary: ['remote software engineer jobs', 'AI software engineer jobs', 'Python developer jobs'] },
  'data-analysis': { primary: 'data analysis jobs', secondary: ['remote data analyst jobs', 'AI data scientist jobs', 'data annotation jobs'] },
  'finance': { primary: 'finance jobs', secondary: ['remote finance jobs', 'AI finance analyst jobs', 'fintech jobs'] },
  'medicine': { primary: 'medical AI jobs', secondary: ['healthcare AI jobs', 'medical research jobs', 'clinical AI jobs'] },
  'law': { primary: 'legal AI jobs', secondary: ['remote legal jobs', 'AI legal research jobs', 'contract analysis jobs'] },
  'business-operations': { primary: 'business operations jobs', secondary: ['remote operations jobs', 'AI operations jobs', 'project management jobs'] },
  'life-physical-social-sciences': { primary: 'science AI jobs', secondary: ['research AI jobs', 'scientist jobs remote', 'AI research scientist'] },
  'other-engineering': { primary: 'engineering jobs', secondary: ['remote engineering jobs', 'AI engineering jobs', 'mechanical engineer jobs'] },
  'arts-design': { primary: 'design AI jobs', secondary: ['UX design jobs remote', 'AI design jobs', 'graphic design jobs'] },
  'language-audio': { primary: 'language AI jobs', secondary: ['translation jobs remote', 'AI language jobs', 'transcription jobs'] },
  'humanities': { primary: 'humanities AI jobs', secondary: ['AI ethics jobs', 'humanities research jobs', 'AI content jobs'] }
};

const FAQ_CONTENT = {
  'what-is-mercor': { question: 'What is Mercor?', answer: 'Mercor is an AI-powered talent platform that connects professionals with opportunities in software engineering, data science, finance, medicine, law, and other fields.' },
  'how-does-mercor-work': { question: 'How does Mercor work?', answer: 'Mercor matches professionals with companies. Professionals create a profile, complete assessments, and get matched with opportunities. Mercor handles payments and contracts.' },
  'how-to-apply-mercor': { question: 'How to apply for jobs at Mercor?', answer: 'Sign up, create a profile, complete assessments, browse opportunities, and apply. If selected, complete onboarding and start working.' },
  'mercor-referral-program': { question: 'How does the Mercor referral program work?', answer: 'Earn 20% of referred candidate eligible earnings until the cap. Payouts are twice weekly via Stripe or Wise.' },
  'mercor-earnings': { question: 'How much can you earn at Mercor?', answer: 'Software engineers earn $75-150/hour, data scientists $65-120/hour, finance professionals $80-130/hour. Referrers earn 20% of referred earnings.' },
  'remote-ai-jobs': { question: 'What are remote AI jobs?', answer: 'Remote AI jobs include machine learning engineering, data annotation, AI training, AI research, and AI ethics that can be performed from anywhere.' },
  'ai-jobs-no-experience': { question: 'Can I get AI jobs with no experience?', answer: 'Yes, entry-level positions include data annotation, AI training, content moderation, and basic data analysis.' },
  'best-ai-jobs-2026': { question: 'What are the best AI jobs in 2026?', answer: 'Best AI jobs include ML Engineer ($150-300k), AI Research Scientist ($180-350k), Data Scientist ($120-200k), and Prompt Engineer ($90-150k).' }
};

function generateFAQSchema(faqs) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(faq => ({
      "@type": "Question",
      "name": faq.question,
      "acceptedAnswer": { "@type": "Answer", "text": faq.answer }
    }))
  };
}

export { CATEGORY_KEYWORDS, FAQ_CONTENT, generateFAQSchema, SITE_URL };
