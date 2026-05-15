// Hugging Face LLM utility for Writer's Flow
import fetch from 'node-fetch';



const HF_API_KEY = process.env.HF_API_KEY_WRITERS_FLOW || process.env.HF_API_KEY;
const HF_MODEL = process.env.HF_MODEL || 'meta-llama/Llama-3.1-8B-Instruct';
const HF_API_KEY_MASKED = HF_API_KEY ? HF_API_KEY.slice(0, 6) + '...' + HF_API_KEY.slice(-4) : 'undefined';
console.log(`[HF-LLM] Using Hugging Face model: ${HF_MODEL}`);
console.log(`[HF-LLM] Using Hugging Face API key: ${HF_API_KEY_MASKED}`);

export function getHuggingFaceLLMConfig() {
  return {
    provider: 'huggingface',
    model: HF_MODEL,
    apiKeyMasked: HF_API_KEY_MASKED,
  };
}

export async function hfChatCompletion({ prompt, max_tokens = 700, temperature = 0.8 }) {
  const url = `https://api-inference.huggingface.co/models/${HF_MODEL}`;
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
  console.log(`[HF-LLM] Sending prompt to model: ${HF_MODEL}`);
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`HF API error: ${res.status}`);
  const data = await res.json();
  // Try to extract the generated text
  if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text;
  if (data?.generated_text) return data.generated_text;
  if (data?.choices?.[0]?.text) return data.choices[0].text;
  throw new Error('No generated text from HF');
}
