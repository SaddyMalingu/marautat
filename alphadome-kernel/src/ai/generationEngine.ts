import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type GenerationJob = {
  id: string;
  prompt: string;
  model?: string | null;
  provider?: string | null;
  status: JobStatus;
  result?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  meta?: Record<string, unknown>;
};

export type GenerationRequest = {
  prompt: string;
  model?: string | null;
  provider?: "openai" | "openrouter" | "huggingface" | null;
  meta?: Record<string, unknown>;
};

export type GenerationEngineEvents = {
  jobStarted: [job: GenerationJob];
  jobCompleted: [job: GenerationJob];
  jobFailed: [job: GenerationJob];
  jobCancelled: [job: GenerationJob];
};

type DispatchFn = (prompt: string, model: string, provider: string) => Promise<string>;

// ---------------------------------------------------------------------------
// GenerationEngine — persistent job loop, mirrors Zone generationEngine.ts
// ---------------------------------------------------------------------------

export class GenerationEngine extends EventEmitter {
  private jobs = new Map<string, GenerationJob>();
  private queue: string[] = [];
  private running = false;
  private dispatch: DispatchFn;

  constructor(dispatch: DispatchFn) {
    super();
    this.dispatch = dispatch;
  }

  enqueue(request: GenerationRequest): GenerationJob {
    const job: GenerationJob = {
      id: randomUUID(),
      prompt: request.prompt,
      model: request.model ?? null,
      provider: request.provider ?? null,
      status: "pending",
      createdAt: new Date().toISOString(),
      meta: request.meta,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    if (!this.running) {
      void this.runLoop();
    }
    return job;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return false;
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    this.queue = this.queue.filter((id) => id !== jobId);
    this.emit("jobCancelled", job);
    return true;
  }

  getJob(jobId: string): GenerationJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(): GenerationJob[] {
    return Array.from(this.jobs.values());
  }

  status(): { running: boolean; queued: number; total: number } {
    return {
      running: this.running,
      queued: this.queue.length,
      total: this.jobs.size,
    };
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const job = this.jobs.get(jobId);
      if (!job || job.status === "cancelled") continue;

      job.status = "running";
      job.startedAt = new Date().toISOString();
      this.emit("jobStarted", job);

      try {
        const model = job.model || "gpt-4o-mini";
        const provider = job.provider || "openai";
        const result = await this.dispatch(job.prompt, model, provider);
        job.result = result;
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        this.emit("jobCompleted", job);
      } catch (err) {
        job.error = (err as Error).message;
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        this.emit("jobFailed", job);
      }
    }
    this.running = false;
  }
}

// ---------------------------------------------------------------------------
// createDefaultDispatch — provider fallback chain matching conversation.ts order
// ---------------------------------------------------------------------------

export function createDefaultDispatch(): DispatchFn {
  return async (prompt: string, model: string, provider: string): Promise<string> => {
    if (provider === "openai" && process.env.OPENAI_API_KEY) {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0].message.content ?? "";
    }

    if (
      (provider === "openrouter" || !process.env.OPENAI_API_KEY) &&
      process.env.OPENROUTER_KEY
    ) {
      const { default: axios } = await import("axios");
      const res = await axios.post(
        "https://api.openrouter.ai/v1/chat/completions",
        {
          model: model.includes("/") ? model : "meta-llama/llama-3.3-70b-instruct:free",
          messages: [{ role: "user", content: prompt }],
        },
        { headers: { Authorization: `Bearer ${process.env.OPENROUTER_KEY}` } },
      );
      return (res.data as { choices: { message: { content: string } }[] }).choices[0].message
        .content;
    }

    if (process.env.HF_API_KEY) {
      const { default: axios } = await import("axios");
      const res = await axios.post(
        "https://router.huggingface.co/v1/chat/completions",
        {
          model: "meta-llama/Llama-3.1-8B-Instruct:novita",
          messages: [{ role: "user", content: prompt }],
        },
        { headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` } },
      );
      return (res.data as { choices: { message: { content: string } }[] }).choices[0].message
        .content;
    }

    throw new Error("No AI provider credentials available");
  };
}
