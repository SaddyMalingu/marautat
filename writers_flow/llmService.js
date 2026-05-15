// LLM Humanization module with logging
/**
 * Writer's Flow — LLM Service
 * Handles humanization passes and quality checks via OpenAI.
 */


let useHF = process.env.LLM_PROVIDER === 'hf';
let openai, hfChatCompletion, getHuggingFaceLLMConfig;
let LLM_CONFIG = { provider: 'unknown', model: 'unknown', apiKeyMasked: 'unknown' };
if (process.env.OPENAI_API_KEY && !useHF) {
  const OpenAI = (await import('openai')).default;
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  LLM_CONFIG = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKeyMasked: process.env.OPENAI_API_KEY.slice(0, 6) + '...' + process.env.OPENAI_API_KEY.slice(-4),
  };
  console.log('[WF-LLM] llmService: Using OpenAI', LLM_CONFIG);
} else {
  const hf = await import('./hfLLM.js');
  hfChatCompletion = hf.hfChatCompletion;
  getHuggingFaceLLMConfig = hf.getHuggingFaceLLMConfig;
  useHF = true;
  LLM_CONFIG = getHuggingFaceLLMConfig();
  console.log('[WF-LLM] llmService: Using Hugging Face', LLM_CONFIG);
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
      console.log('[WF-LLM] Hugging Face LLM used for humanization:', LLM_CONFIG);
    } else {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 600,
      });
      content = res.choices[0].message.content;
      console.log('[WF-LLM] OpenAI LLM used for humanization:', LLM_CONFIG);
    }
    return content.trim();
  } catch (err) {
    console.error(`[LLM] humanizeMessage error: ${err.message}`);
    return text;
  }
}

export function getLLMConfig() {
  return LLM_CONFIG;
}

export default humanizeMessage;
