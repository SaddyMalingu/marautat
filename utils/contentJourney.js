// Content Journey System
// Each job gets a series of posts that take readers from awareness → action

const CONTENT_ANGLES = {
  // Each angle represents a different stage in the reader's journey
  awareness: {
    name: "Awareness",
    description: "Help readers understand the role and its value",
    templates: [
      {
        title: (job) => `What is a ${job.title}? A Complete Guide for ${new Date().getFullYear()}`,
        slug: (slug) => `${slug}-guide`,
        prompt: (job) => `Write an educational blog post explaining what a ${job.title} does, why this role matters in the industry, and who should consider this career. Include: role overview, day-to-day responsibilities, industry demand, and career outlook. HTML format, NO markdown.`
      },
      {
        title: (job) => `${job.title} Salary Guide: What You Can Actually Earn`,
        slug: (slug) => `${slug}-salary`,
        prompt: (job) => `Write a comprehensive salary guide for ${job.title}. Include: hourly/annual breakdown ($${job.compensation_max || 75}/hr baseline), factors affecting pay, comparison with similar roles, negotiation tips, and regional variations. HTML format, NO markdown.`
      }
    ]
  },
  
  consideration: {
    name: "Consideration", 
    description: "Help readers evaluate if this role fits them",
    templates: [
      {
        title: (job) => `Is ${job.title} Right for You? A Self-Assessment`,
        slug: (slug) => `${slug}-assessment`,
        prompt: (job) => `Write a self-assessment guide for people considering becoming a ${job.title}. Include: required skills checklist, personality traits that succeed, common misconceptions, day-to-day reality vs expectations, and a scoring system to evaluate fit. HTML format, NO markdown.`
      },
      {
        title: (job) => `Essential Skills for ${job.title}s: Do You Have What It Takes?`,
        slug: (slug) => `${slug}-skills`,
        prompt: (job) => `Write a comprehensive skills guide for ${job.title}. Include: technical skills (${job.skills?.join(', ') || 'relevant skills'}), soft skills, how to develop each skill, learning resources, and a 90-day skill building plan. HTML format, NO markdown.`
      }
    ]
  },
  
  preparation: {
    name: "Preparation",
    description: "Help readers prepare for success",
    templates: [
      {
        title: (job) => `How to Pass the ${job.title} Assessment: Complete Prep Guide`,
        slug: (slug) => `${slug}-prep`,
        prompt: (job) => `Write an assessment preparation guide for ${job.title} roles. Include: what assessments typically cover, sample questions with explanations, study resources, common mistakes to avoid, and a 7-day prep plan. HTML format, NO markdown.`
      },
      {
        title: (job) => `Building a ${job.title} Portfolio That Gets You Hired`,
        slug: (slug) => `${slug}-portfolio`,
        prompt: (job) => `Write a portfolio building guide for ${job.title}. Include: what makes a strong portfolio, 5 project ideas with detailed steps, how to present your work, common portfolio mistakes, and examples of successful portfolios. HTML format, NO markdown.`
      }
    ]
  },
  
  action: {
    name: "Action",
    description: "Help readers take the next step",
    templates: [
      {
        title: (job) => `How to Get Hired as a ${job.title}: Step-by-Step`,
        slug: (slug) => `${slug}-hired`,
        prompt: (job) => `Write an actionable guide for getting hired as a ${job.title}. Include: where to find opportunities, application tips, interview preparation, salary negotiation scripts, and what to expect in the first 30 days. HTML format, NO markdown.`
      },
      {
        title: (job) => `Remote ${job.title} Jobs: Work from Anywhere Guide`,
        slug: (slug) => `${slug}-remote`,
        prompt: (job) => `Write a guide for finding remote ${job.title} jobs. Include: best platforms for remote work, how to stand out as a remote candidate, salary expectations ($${job.compensation_max || 75}/hr baseline), remote work tools, and work-life balance tips. HTML format, NO markdown.`
      }
    ]
  },
  
  mastery: {
    name: "Mastery",
    description: "Help readers excel once hired",
    templates: [
      {
        title: (job) => `${job.title} Career Roadmap: Junior to Senior in 5 Years`,
        slug: (slug) => `${slug}-roadmap`,
        prompt: (job) => `Write a career progression guide for ${job.title}. Include: skills to develop each year, certifications worth pursuing, salary milestones, leadership opportunities, and how to stay relevant as the industry evolves. HTML format, NO markdown.`
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
  const baseSlug = job.slug.replace(/-salary$|-skills$|-howto$|-remote$|-guide$|-prep$|-portfolio$|-hired$|-roadmap$|-assessment$/, '');
  
  Object.entries(CONTENT_ANGLES).forEach(([angle, data]) => {
    data.templates.forEach((template, index) => {
      journey.push({
        angle,
        angleName: data.name,
        angleDescription: data.description,
        title: template.title(job),
        slug: `${baseSlug}-${angle}`,
        prompt: template.prompt(job),
        stage: index + 1
      });
    });
  });
  
  return journey;
}
