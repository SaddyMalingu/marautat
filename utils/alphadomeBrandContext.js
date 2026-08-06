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
      "Alphadome is a multi-tenant AI platform for automation, WhatsApp business workflows, digital operations, lead handling, analytics, and intelligent brand experiences.",
    pricing:
      "Starter subscription plans begin from KES 200 per month and are credits-based.",
  };
}

export function buildAlphadomeBrandPromptBlock() {
  const brand = getAlphadomeBrandContext();
  const contacts = brand.contacts.map((entry) => `${entry.label}: ${entry.number} (${entry.purpose})`).join("; ");

  return `
BRAND KNOWLEDGE:
- Brand: ${brand.brandName}
- Creator: ${brand.creator}
- Website: ${brand.website}
- Description: ${brand.summary}
- Pricing: ${brand.pricing}
- Contact details: ${contacts}
- If a user asks for a human, support, a real person, or escalation, offer the contact details above and invite them to call or WhatsApp the appropriate line.
- Always keep responses professional, concise, and helpful.
- If the user asks about the brand, explain that Alphadome is an AI platform for automation, WhatsApp workflows, analytics, and digital operations.
- If a user asks about the creator, say that David Saddy Malingu created Alphadome.
- If users ask about subscriptions, explain that plans start at KES 200/month and work on a credits model.
- Never share internal-only implementation or fulfillment details with clients.
- Normalize Kenyan phone numbers to 254 format automatically.
`.trim();
}

export function buildAlphadomeBrandTrainingEntries() {
  const brand = getAlphadomeBrandContext();
  const humanAnswer = `If you want a human, please contact ${brand.contacts[0].number} for calls or ${brand.contacts[1].number} for WhatsApp. You can also visit ${brand.website} for more information.`;

  return [
    {
      question: "what is alphadome",
      answer: `${brand.summary} It is built to help businesses automate conversations, operations, and growth with AI-powered workflows.`,
    },
    {
      question: "what does alphadome offer",
      answer: "Alphadome offers AI automation, WhatsApp bot experiences, customer engagement, lead handling, analytics, and digital operations workflows for brands and teams.",
    },
    {
      question: "how much is alphadome",
      answer: "Starter subscriptions begin at KES 200 per month and run on a credits model based on usage.",
    },
    {
      question: "subscription price",
      answer: "Our starter subscription starts from KES 200/month, using credits tied to usage.",
    },
    {
      question: "who created alphadome",
      answer: `Alphadome was created by David Saddy Malingu.`,
    },
    {
      question: "alphadome website",
      answer: `You can learn more at ${brand.website}.`,
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
      question: "who is the creator",
      answer: `The creator of Alphadome is David Saddy Malingu.`,
    },
    {
      question: "call",
      answer: `For calls, use ${brand.contacts[0].number}. For WhatsApp, use ${brand.contacts[1].number}.`,
    },
    {
      question: "whatsapp",
      answer: `For WhatsApp, contact ${brand.contacts[1].number}. For calls, use ${brand.contacts[0].number}.`,
    },
  ];
}
