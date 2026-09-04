import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantRecord } from "./tenant.js";

export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
  role: ConversationRole;
  content: string;
};

export type ReplyMeta = {
  llm_used: boolean;
  llm_provider?: string;
  llm_latency_ms?: number;
  llm_error?: string;
  reason?: string;
};

export type ReplyResult = {
  type: "text" | "catalog";
  text?: string;
  items?: Record<string, unknown>[];
  meta: ReplyMeta;
};

export type TrainingEntry = {
  question?: string;
  answer?: string;
  category?: string;
  priority?: number;
  confidence_score?: number;
};

export type AutoResponseTemplate = {
  enabled?: boolean;
  trigger?: string;
  response?: string;
};

export type GenerateReplyOptions = {
  tenant?: TenantRecord | null;
  templates?: AutoResponseTemplate[] | null;
  trainingData?: TrainingEntry[];
  contextMessages?: ConversationMessage[];
  dbContext?: string;
};

type ProviderCredentials = {
  aiApiKey?: string | null;
  aiProvider?: string | null;
  aiModel?: string | null;
};

// ---------------------------------------------------------------------------
// Greeting detection — mirrors monolith isGreetingMessage()
// ---------------------------------------------------------------------------

const GREETING_TOKENS = [
  "hi", "hello", "hey",
  "good morning", "good afternoon", "good evening",
  "mambo", "niaje", "sasa", "habari",
];

export function isGreetingMessage(message = ""): boolean {
  const text = (message || "").toLowerCase().trim();
  if (!text) return false;
  return GREETING_TOKENS.some(
    (g) => text === g || text.startsWith(`${g} `),
  );
}

// ---------------------------------------------------------------------------
// Training data lookup — mirrors monolith findTrainingAnswer()
// ---------------------------------------------------------------------------

export function findTrainingAnswer(
  trainingData: TrainingEntry[] = [],
  userMessage = "",
): string | null {
  const text = (userMessage || "").toLowerCase().trim();
  if (!text || !trainingData.length) return null;

  const candidates = trainingData
    .map((entry) => {
      const q = (entry.question || "").toLowerCase().trim();
      const a = (entry.answer || "").trim();
      if (!a) return null;

      let score = 0;
      if (q && text.includes(q)) score = 3;
      else if (q && q.includes(text)) score = 2;
      else if (entry.category && text.includes(entry.category.toLowerCase())) score = 1;
      if (score === 0) return null;

      return {
        score,
        answer: a,
        priority: entry.priority ?? 0,
        confidence: Number(entry.confidence_score ?? 0),
      };
    })
    .filter(Boolean) as { score: number; answer: string; priority: number; confidence: number }[];

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.confidence - a.confidence;
  });

  return candidates[0]?.answer ?? null;
}

// ---------------------------------------------------------------------------
// Auto-response template matching — mirrors monolith findAutoResponse()
// ---------------------------------------------------------------------------

export function findAutoResponse(
  templates: AutoResponseTemplate[] = [],
  userMessage = "",
): string | null {
  const text = String(userMessage || "").toLowerCase().trim();
  if (!text || !Array.isArray(templates) || !templates.length) return null;

  for (const tpl of templates) {
    if (!tpl || tpl.enabled === false) continue;
    const trigger = String(tpl.trigger || "").toLowerCase().trim();
    const response = String(tpl.response || "").trim();
    if (!trigger || !response) continue;
    if (text === trigger || text.includes(trigger)) return response;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversation context fetch — mirrors monolith fetchConversationContext()
// ---------------------------------------------------------------------------

export async function fetchConversationContext(
  supabase: SupabaseClient,
  userId: string,
  brandId: string,
  limit = 8,
): Promise<ConversationMessage[]> {
  if (!userId || !brandId) return [];

  const { data, error } = await supabase.rpc("get_conversation_context", {
    p_user_id: userId,
    p_brand_id: brandId,
    p_limit: limit,
  });

  if (error) {
    console.warn(`[kernel/conversation] context fetch error: ${error.message}`);
    return [];
  }

  const items = (data?.items || []) as { direction: string; message_text: string }[];
  return items.map((m) => ({
    role: m.direction === "incoming" ? "user" : "assistant",
    content: m.message_text,
  }));
}

// ---------------------------------------------------------------------------
// Conversation message persistence — wraps conversations table inserts
// ---------------------------------------------------------------------------

export type ConversationRow = {
  brand_id: string;
  user_id: string;
  direction: "incoming" | "outgoing";
  message_text: string;
  whatsapp_message_id?: string | null;
  raw_payload?: Record<string, unknown> | null;
  llm_used?: boolean;
  llm_provider?: string | null;
  llm_latency_ms?: number | null;
  llm_error?: string | null;
  llm_reason?: string | null;
};

export async function logConversationMessage(
  supabase: SupabaseClient,
  row: ConversationRow,
): Promise<void> {
  const { error } = await supabase.from("conversations").insert([{
    ...row,
    created_at: new Date().toISOString(),
  }]);
  if (error) {
    console.error(`[kernel/conversation] insert error: ${error.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// LLM reply generation — mirrors monolith generateReply() provider waterfall
// ---------------------------------------------------------------------------

function buildStaticFallback(): ReplyResult {
  return {
    type: "text",
    text: "I'm sorry, I'm unable to respond right now. Please try again later or contact support.",
    meta: { llm_used: false, reason: "no_llm_credentials" },
  };
}

function getProviderCredentials(tenant: TenantRecord | null | undefined): ProviderCredentials {
  if (!tenant) {
    return {
      aiApiKey: process.env.OPENAI_API_KEY,
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
    };
  }

  const tenantRecord = tenant as TenantRecord & {
    ai_api_key?: string | null;
    ai_provider?: string | null;
    ai_model?: string | null;
  };

  return {
    aiApiKey: tenantRecord.ai_api_key || process.env.OPENAI_API_KEY,
    aiProvider: tenantRecord.ai_provider || "openai",
    aiModel: tenantRecord.ai_model || "gpt-4o-mini",
  };
}

async function tryOpenAI(
  messages: { role: string; content: string }[],
  creds: ProviderCredentials,
): Promise<ReplyResult | null> {
  if (!creds.aiApiKey) return null;

  // Dynamic import keeps the kernel decoupled — consumers that do not use OpenAI
  // do not need to install the openai package.
  let OpenAI: (typeof import("openai"))["default"];
  try {
    const mod = await import("openai");
    OpenAI = mod.default;
  } catch {
    return null;
  }

  try {
    const client = new OpenAI({ apiKey: creds.aiApiKey });
    const start = Date.now();
    const completion = await client.chat.completions.create({
      model: creds.aiModel || "gpt-4o-mini",
      messages: messages as Parameters<typeof client.chat.completions.create>[0]["messages"],
    });
    return {
      type: "text",
      text: completion.choices[0].message.content || "",
      meta: { llm_used: true, llm_provider: "openai", llm_latency_ms: Date.now() - start },
    };
  } catch (err) {
    console.warn(`[kernel/conversation] OpenAI error: ${(err as Error).message}`);
    return null;
  }
}

async function tryChatCompletionEndpoint(
  url: string,
  model: string,
  authToken: string,
  messages: { role: string; content: string }[],
  providerLabel: string,
): Promise<ReplyResult | null> {
  if (!authToken) return null;

  // Dynamic import to avoid bundling axios as a hard peer dependency.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let post: (u: string, d: unknown, cfg: unknown) => Promise<{ data: any }>;
  try {
    const mod = await import("axios");
    // Cast through unknown to avoid incompatible overload types
    post = mod.default.post.bind(mod.default) as typeof post;
  } catch {
    return null;
  }

  try {
    const start = Date.now();
    const response = await post(
      url,
      { model, messages },
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    const data = response.data as { choices?: { message: { content: string } }[] };
    if (!data.choices?.length) return null;

    return {
      type: "text",
      text: data.choices[0].message.content,
      meta: { llm_used: true, llm_provider: providerLabel, llm_latency_ms: Date.now() - start },
    };
  } catch (err) {
    console.warn(`[kernel/conversation] ${providerLabel} error: ${(err as Error).message}`);
    return null;
  }
}

export async function generateReply(
  userMessage: string,
  options: GenerateReplyOptions = {},
): Promise<ReplyResult> {
  const { tenant = null, trainingData = [], contextMessages = [], dbContext = "" } = options;

  // 1. Training data short-circuit (no LLM call)
  if (!isGreetingMessage(userMessage)) {
    const trainingReply = findTrainingAnswer(trainingData, userMessage);
    if (trainingReply) {
      return {
        type: "text",
        text: trainingReply,
        meta: { llm_used: false, reason: "training" },
      };
    }
  }

  const creds = getProviderCredentials(tenant);

  // 2. Guard: no credentials at all
  const hasOpenAI = Boolean(creds.aiApiKey);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_KEY);
  const hasHF = Boolean(process.env.HF_API_KEY);
  if (!hasOpenAI && !hasOpenRouter && !hasHF) {
    return buildStaticFallback();
  }

  // Build message stack
  const messageStack: { role: string; content: string }[] = [];
  if (dbContext) {
    messageStack.push({ role: "system", content: `Context data:\n${dbContext}` });
  }
  messageStack.push(...contextMessages);
  messageStack.push({ role: "user", content: userMessage });

  // 3. OpenAI
  const openAIResult = await tryOpenAI(messageStack, creds);
  if (openAIResult) return openAIResult;

  // 4. OpenRouter fallback
  const openRouterResult = await tryChatCompletionEndpoint(
    "https://api.openrouter.ai/v1/chat/completions",
    "meta-llama/llama-3.3-70b-instruct:free",
    process.env.OPENROUTER_KEY || "",
    messageStack,
    "openrouter",
  );
  if (openRouterResult) return openRouterResult;

  // 5. HuggingFace fallback
  const hfResult = await tryChatCompletionEndpoint(
    "https://router.huggingface.co/v1/chat/completions",
    "meta-llama/Llama-3.1-8B-Instruct:novita",
    process.env.HF_API_KEY || "",
    messageStack,
    "huggingface",
  );
  if (hfResult) return hfResult;

  return buildStaticFallback();
}
