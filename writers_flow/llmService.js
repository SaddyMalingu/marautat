// LLM Humanization module with logging
/**
 * Writer's Flow — LLM Service
 * Handles humanization passes and quality checks via OpenAI.
 */

let useHF = process.env.LLM_PROVIDER === 'hf';
let openai, hfChatCompletion;
if (!useHF) {
  const OpenAI = (await import('openai')).default;
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  hfChatCompletion = (await import('./hfLLM.js')).hfChatCompletion;
}

/**
 * Run a humanization pass on already-generated text to remove AI patterns.
 * Used as an optional extra step after generateOutreach().
 */
export async function humanizeMessage(text, context = '') {
  const prompt = `
Rewrite the following email to sound more human and natural.
Rules:
- Vary sentence length and rhythm
- Remove any formal/corporate phrases (e.g. "I hope this message finds you well", "leverage", "synergy")
- Keep the core message and call to action intact
- Do NOT make it longer — aim for same or shorter length
- Sound like a real person, not a marketing bot
${context ? `Context: ${context}` : ''}

Text to rewrite:
${text}

Return only the rewritten text.`.trim();

  try {
    let content;
    if (useHF) {
      content = await hfChatCompletion({ prompt, max_tokens: 600, temperature: 0.9 });
    } else {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 600,
      });
      content = res.choices[0].message.content;
    }
    return content.trim();
  } catch (err) {
    console.error(`[LLM] humanizeMessage error: ${err.message}`);
    return text;
  }
}

export default humanizeMessage;
