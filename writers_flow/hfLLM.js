// Hugging Face LLM utility for Writer's Flow
import fetch from 'node-fetch';

const HF_API_KEY = process.env.HF_API_KEY_WRITERS_FLOW || process.env.HF_API_KEY;
const HF_MODEL = process.env.HF_MODEL || 'HuggingFaceH4/zephyr-7b-beta';

export async function hfChatCompletion({ prompt, max_tokens = 700, temperature = 0.8 }) {
  const url = `https://api-inference.huggingface.co/models/${HF_MODEL}`;
  const headers = {
    'Authorization': `Bearer ${HF_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({
    inputs: prompt,
    parameters: { max_new_tokens: max_tokens, temperature },
  });
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`HF API error: ${res.status}`);
  const data = await res.json();
  // Try to extract the generated text
  if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text;
  if (data?.generated_text) return data.generated_text;
  if (data?.choices?.[0]?.text) return data.choices[0].text;
  throw new Error('No generated text from HF');
}
