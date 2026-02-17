// Orchestrator: robust workflow with logging, error handling, and test mode
import scrapeOpportunities from './scraper.js';
import humanizeMessage from './llmService.js';
import sendEmail from './emailSender.js';

export default async function writersFlow({ keywords, userId, fromEmail, testMode = false }) {
  let opportunities = [];
  let sent = 0;
  try {
    opportunities = await scrapeOpportunities(keywords, testMode);
    if (!Array.isArray(opportunities)) throw new Error('scrapeOpportunities did not return an array');
    for (const opp of opportunities) {
      if (!opp.contactEmail) {
        console.warn(`[Writer's Flow] Skipping opportunity with no contactEmail:`, opp);
        continue;
      }
      const message = `Hello,\nI found your opportunity: ${opp.title} (${opp.url})`;
      let humanized;
      try {
        humanized = await humanizeMessage(message, userId);
      } catch (err) {
        console.error(`[Writer's Flow] Error humanizing message:`, err);
        humanized = message;
      }
      try {
        await sendEmail({
          from: fromEmail,
          to: opp.contactEmail,
          subject: `Regarding: ${opp.title}`,
          text: humanized,
        });
        sent++;
        console.log(`[Writer's Flow] Email sent to ${opp.contactEmail}`);
      } catch (err) {
        console.error(`[Writer's Flow] Failed to send email to ${opp.contactEmail}:`, err);
      }
    }
  } catch (err) {
    console.error(`[Writer's Flow] Workflow failed:`, err);
    throw err;
  }
  return { sent };
}
