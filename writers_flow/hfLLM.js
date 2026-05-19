// Hugging Face LLM utility for Writer's Flow
import fetch from 'node-fetch';




const HF_API_KEY = process.env.HF_API_KEY_WRITERS_FLOW || process.env.HF_API_KEY;
// Prioritized list of fallback models
const HF_MODELS = [
  process.env.HF_MODEL,
  'meta-llama/Llama-3.1-8B-Instruct',
  'Qwen/Qwen2.5-7B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.2',
  'google/gemma-7b-it',
  'meta-llama/Llama-2-7b-chat-hf',
  'meta-llama/Llama-3-8b-chat-hf',
  'openchat/openchat-3.5-0106',
  'tiiuae/falcon-7b-instruct',
  'databricks/dolly-v2-7b',
  'NousResearch/Nous-Hermes-2-Mistral-7B-DPO',
  'HuggingFaceH4/zephyr-7b-beta',
].filter(Boolean);

// Remove any accidental suffix (e.g., ':novita') from all
const CLEANED_HF_MODELS = HF_MODELS.map(m => m.includes(':') ? m.split(':')[0] : m);
const HF_API_KEY_MASKED = HF_API_KEY ? HF_API_KEY.slice(0, 6) + '...' + HF_API_KEY.slice(-4) : 'undefined';
console.log(`[HF-LLM] Using Hugging Face model fallback list: ${CLEANED_HF_MODELS.join(', ')}`);
console.log(`[HF-LLM] Using Hugging Face API key: ${HF_API_KEY_MASKED}`);

export function getHuggingFaceLLMConfig() {
  return {
    provider: 'huggingface',
    model: CLEANED_HF_MODELS[0],
    apiKeyMasked: HF_API_KEY_MASKED,
    fallbackModels: CLEANED_HF_MODELS,
  };
}


export async function hfChatCompletion({ prompt, max_tokens = 700, temperature = 0.8 }) {
  const headers = {
    'Authorization': `Bearer ${HF_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const body = JSON.stringify({
    inputs: prompt,
    parameters: { max_new_tokens: max_tokens, temperature },
  });

  let lastErr = null;
  for (const model of CLEANED_HF_MODELS) {
    const url = `https://api-inference.huggingface.co/models/${model}`;
    console.log(`[HF-LLM] Sending prompt to model: ${model}`);
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (!res.ok) {
        console.warn(`[HF-LLM] Model ${model} failed with status ${res.status}`);
        if (res.status === 404 || res.status === 403) {
          lastErr = new Error(`HF API error: ${res.status}`);
          continue; // Try next model
        } else {
          throw new Error(`HF API error: ${res.status}`);
        }
      }
      const data = await res.json();
      // Try to extract the generated text
      if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text;
      if (data?.generated_text) return data.generated_text;
      if (data?.choices?.[0]?.text) return data.choices[0].text;
      throw new Error('No generated text from HF');
    } catch (err) {
      lastErr = err;
      console.warn(`[HF-LLM] Model ${model} failed: ${err.message}`);
      continue;
    }
  }
  throw lastErr || new Error('All Hugging Face models failed');
}
