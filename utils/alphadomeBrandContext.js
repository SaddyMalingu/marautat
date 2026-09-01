export function normalizeKenyanPhone(value) {
  let phone = String(value || "").trim().replace(/\s+/g, "");
  if (!phone) return "";
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("0")) phone = `254${phone.slice(1)}`;
  if (/^7\d{8}$/.test(phone)) phone = `254${phone}`;
  return phone;
}

export function getAlphadomeBrandContext() {
  const website = "https://alphadome.onrender.com/";
  const callContact = normalizeKenyanPhone("0743780542");
  const whatsappContact = normalizeKenyanPhone("0117604817");

  return {
    brandName: "Alphadome",
    creator: "David Saddy Malingu",
    website,
    contacts: [
      { label: "call", number: callContact, purpose: "mostly for calls" },
      { label: "whatsapp", number: whatsappContact, purpose: "mostly for WhatsApp" },
    ],
    summary:
      "Alphadome is a blockchain-powered AI ecosystem transforming African brands with automated systems, AI agents, digital information systems (3.0), NFTs, and physical robot embodiments. Built to turn brands into digital enterprises with dedicated AI employees.",
    pricing:
      "Founder's Package starts at 1,000 KES/month (M-Pesa STK, Bank Transfer, or flexible payment options). Alpha 1 Squad custom packages available for enterprise clients.",
    founderMessage:
      "24 months ago, David Saddy Malingu collected an Afrika-shaped rock and promised to make it the most valuable digital asset in the world by helping African brands build their dreams through Alphadome.",
    alpha1_program:
      "Join our Alpha 1 Squad - first 1,000 clients over 24 months with priority access to custom 3.0 systems, AI agents, Avatar designs, blockchain crowdfunding, and dedicated support.",
  };
}

export function buildAlphadomeBrandPromptBlock() {
  const brand = getAlphadomeBrandContext();
  const contacts = brand.contacts.map((entry) => `${entry.label}: ${entry.number} (${entry.purpose})`).join("; ");

  return `
BRAND KNOWLEDGE - ALPHADOME 3.0:
- Brand: ${brand.brandName}
- Creator: ${brand.creator}
- Website: ${brand.website}
- Founder Message: ${brand.founderMessage}

WHAT IS ALPHADOME:
${brand.summary}

KEY OFFERINGS:
1. FOUNDER'S PACKAGE (Entry Level)
   - Cost: 1,000 KES/month
   - Payment: M-Pesa STK Push, Bank Transfer, or flexible options
   - Includes: Platform access, WhatsApp integration, basic AI automation, dashboards

2. ALPHA 1 SQUAD (Premium Program)
   - For first 1,000 clients over 24 months
   - Custom 3.0 information systems (databases, dashboards, automation)
   - Brand-specific AI agents (trained to brand personality)
   - Physical Avatar/robot design (8 production designs available)
   - Blockchain crowdfunding support (community equity participation)
   - Dedicated success team and revenue optimization
   - Examples: Building Plans 3.0, Intra Africa Journal Hub, KEMSA 3.0

3.0 SYSTEMS EXPLAINED:
- Custom information systems built for your specific business needs
- Integrate databases, dashboards, workflows, and AI automation
- Examples: AI Architect (design), Journal Hub (publishing), KEMSA 3.0 (supply chain)
- 40+ active client systems across retail, pharma, fashion, hospitality, tech

AVATAR UNIVERSE & PHYSICAL ROBOTS:
Eight production-ready designs: Shape Shifter, Tumbler, Titan, Black Panther, Chaos, Atlas, Hunter, Alien Shell
- Each branded with Afrika rock emblem
- AI personality fine-tuned to your brand
- Can be physical robots or digital kiosks
- Deployed at customer touchpoints

BLOCKCHAIN MODEL:
- Users can own equity shares in 3.0 systems via blockchain crowdfunding
- Revenue from systems is shared with shareholders
- Democratic value creation where community funds development

CLIENT ONBOARDING:
Phase 1: Discovery & Qualification
Phase 2: System Design & Customization
Phase 3: Implementation & Deployment
Phase 4: Avatar Design & Prototyping
Phase 5: Blockchain Crowdfunding Campaign
Phase 6: Production Launch & Support
Phase 7: Growth & Optimization

PRICING & PAYMENT:
- Founder's Package: ${brand.pricing}
- Payment flexibility: Client chooses method at any interaction point
- M-Pesa STK is primary recommended method
- Multiple payment gateways supported

CONTACT & NEXT STEPS:
- Website: ${brand.website}
- Contact details: ${contacts}
- If a user asks for a human, support, a real person, or escalation, offer the contact details above and invite them to call or WhatsApp the appropriate line.
- Always keep responses professional, concise, and helpful.
- Never share internal-only implementation details with clients.
- Normalize Kenyan phone numbers to 254 format automatically.
`.trim();
}

export function buildAlphadomeBrandTrainingEntries() {
  const brand = getAlphadomeBrandContext();
  const humanAnswer = `If you want a human, please contact ${brand.contacts[0].number} for calls or ${brand.contacts[1].number} for WhatsApp. You can also visit ${brand.website} for more information.`;

  return [
    {
      question: "what is alphadome",
      answer: `${brand.summary} We help African brands build custom AI systems, information systems, digital agents, and physical robot embodiments for scalable growth.`,
    },
    {
      question: "what does alphadome offer",
      answer: "Alphadome offers AI automation, custom 3.0 information systems, branded AI agents, physical robots/digital kiosks (Avatar Universe), blockchain equity crowdfunding, WhatsApp workflows, and dedicated support for brand transformation.",
    },
    {
      question: "how much does alphadome cost",
      answer: `${brand.pricing} For Alpha 1 Squad and custom enterprise systems, contact us for a personalized quote.`,
    },
    {
      question: "subscription price",
      answer: `Our Founder's Package is 1,000 KES/month with flexible payment options including M-Pesa STK, bank transfer, and other gateways. Alpha 1 custom packages available.`,
    },
    {
      question: "alpha 1 squad",
      answer: `${brand.alpha1_program} You receive custom 3.0 systems, AI agents, physical Avatar robots, blockchain crowdfunding, and dedicated success teams. Contact us to apply.`,
    },
    {
      question: "what is founder's package",
      answer: "The Founder's Package is our entry-level offering at 1,000 KES/month, including platform access, WhatsApp integration, basic AI automation, and performance dashboards. Pay via M-Pesa STK or bank transfer.",
    },
    {
      question: "3.0 systems",
      answer: "3.0 Systems are custom-built information systems for your brand including databases, dashboards, automation workflows, AI agents, and blockchain-backed NFTs. Examples: AI Architect (design), Journal Hub (publishing), KEMSA 3.0 (supply chain).",
    },
    {
      question: "ai agents",
      answer: "AI agents are your dedicated digital employees, trained to your brand's personality and processes. They handle sales, support, operations, and growth—24/7. Each agent can be deployed as software or embodied in physical robots.",
    },
    {
      question: "physical robots avatar",
      answer: "Our Avatar Universe offers 8 production-ready robot designs: Shape Shifter, Tumbler, Titan, Black Panther, Chaos, Atlas, Hunter, and Alien Shell. Each carries the Afrika rock emblem and can be customized to your brand.",
    },
    {
      question: "blockchain crowdfunding",
      answer: "Users can purchase equity shares of 3.0 systems through blockchain crowdfunding. Shareholders own proportional equity and receive revenue from system operations. Example: Fund Intra Africa Journal Hub and earn from its success.",
    },
    {
      question: "who created alphadome",
      answer: `Alphadome was created by David Saddy Malingu. ${brand.founderMessage}`,
    },
    {
      question: "david saddy malingu",
      answer: `David Saddy Malingu is the Founder and CEO of Alphadome. He envisions making the Afrika digital asset the most valuable in the world by empowering African brands and professionals.`,
    },
    {
      question: "alphadome website",
      answer: `Learn more at ${brand.website}. You can explore our 3.0 systems, Avatar designs, and pricing options.`,
    },
    {
      question: "contact support",
      answer: humanAnswer,
    },
    {
      question: "human",
      answer: humanAnswer,
    },
    {
      question: "support",
      answer: humanAnswer,
    },
    {
      question: "help",
      answer: humanAnswer,
    },
    {
      question: "call",
      answer: `For calls, use ${brand.contacts[0].number}. For WhatsApp, use ${brand.contacts[1].number}.`,
    },
    {
      question: "whatsapp",
      answer: `For WhatsApp, contact ${brand.contacts[1].number}. For calls, use ${brand.contacts[0].number}.`,
    },
    {
      question: "payment methods",
      answer: "We accept M-Pesa STK Push (primary), bank transfers, and other flexible payment gateways. You choose your preferred method at any interaction point.",
    },
    {
      question: "m-pesa",
      answer: "M-Pesa STK Push is our recommended payment method. You'll receive a push prompt to confirm your monthly subscription. Bank transfer and other options are also available.",
    },
    {
      question: "pricing comparison",
      answer: "Founder's Package: 1,000 KES/month (entry-level with core features). Alpha 1 Squad: Custom pricing for enterprise clients with 3.0 systems, AI agents, robots, and dedicated support.",
    },
    {
      question: "which package should i choose",
      answer: "Choose Founder's Package (1,000 KES/month) if you're starting out. Apply for Alpha 1 Squad if you want a fully custom digital ecosystem with 3.0 systems, AI agents, physical robots, and growth optimization.",
    },
    {
      question: "how to join alphadome",
      answer: `Visit ${brand.website} or contact us at ${brand.contacts[1].number} (WhatsApp). We'll guide you through our Founder's Package or Alpha 1 Squad application process.`,
    },
    {
      question: "alphadome clients",
      answer: "We serve 40+ active brands across retail, fashion, pharmaceuticals, hospitality, healthcare, technology, education, and professional services. Each has custom 3.0 systems and AI agents.",
    },
    {
      question: "use cases examples",
      answer: "E-commerce automation, customer support bots, inventory management, lead generation, appointment scheduling, payment processing, social listening, content generation, and analytics. Any business workflow can be automated.",
    },
  ];
}
