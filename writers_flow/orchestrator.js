// Orchestrator: coordinates scraping, humanization, and email sending
const scrapeOpportunities = require('./scraper');
const humanizeMessage = require('./llmService');
const sendEmail = require('./emailSender');

module.exports = async function writersFlow({ keywords, userId, fromEmail }) {
  const opportunities = await scrapeOpportunities(keywords);
  for (const opp of opportunities) {
    const message = `Hello,\nI found your opportunity: ${opp.title} (${opp.url})`;
    const humanized = await humanizeMessage(message, userId);
    await sendEmail({
      from: fromEmail,
      to: opp.contactEmail,
      subject: `Regarding: ${opp.title}`,
      text: humanized,
    });
  }
  return { sent: opportunities.length };
};
