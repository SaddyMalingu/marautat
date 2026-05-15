// Simple NLP intent handler for Writer's Flow
// Recognizes stop/cancel/abort commands

const STOP_PATTERNS = [
  /\bstop\b/i,
  /\bcancel\b/i,
  /\babort\b/i,
  /\bend\b/i,
  /\bexit\b/i,
  /\bkill\b/i,
  /\bterminate\b/i,
  /\bshutdown\b/i,
  /\bstop writer'?s? flow\b/i,
  /\bstop the flow\b/i,
  /\bstop outreach\b/i,
  /\bstop searching\b/i,
  /\bstop campaign\b/i,
  /\bstop process\b/i,
  /\bstop running\b/i,
  /\bstop now\b/i,
  /\bplease stop\b/i,
  /\bhalt\b/i,
];

export function isStopCommand(text) {
  if (!text || typeof text !== 'string') return false;
  return STOP_PATTERNS.some((re) => re.test(text));
}

export default { isStopCommand };
