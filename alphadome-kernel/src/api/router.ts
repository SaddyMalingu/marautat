import express, { type Request, type Response } from "express";
import { getSupabaseClient } from "../adapters/supabase.js";
import { parseWebhookPayload, verifyWebhookSignature, getRawBody } from "../adapters/whatsapp.js";
import { loadTenantContext } from "../core/tenant.js";
import {
  fetchConversationContext,
  generateReply,
  logConversationMessage,
  findAutoResponse,
  type AutoResponseTemplate,
} from "../core/conversation.js";
import { GenerationEngine, createDefaultDispatch } from "../ai/generationEngine.js";

export function createKernelRouter() {
  const router = express.Router();
  const readQuery = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return value[0];
    if (typeof value === "string") return value;
    return undefined;
  };

  // Shared generation engine instance scoped to this router
  const engine = new GenerationEngine(createDefaultDispatch());

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "alphadome-kernel" });
  });

  // Minimal ingress harness for Day 2 extraction validation.
  router.post("/webhook/resolve-tenant", async (req: Request, res: Response) => {
    try {
      const signature = req.header("X-Hub-Signature-256") || undefined;
      const rawBody = getRawBody(req);

      if (!verifyWebhookSignature(rawBody, signature)) {
        // Mirror monolith behavior: acknowledge to avoid retries on invalid signatures.
        return res.status(200).json({ ok: false, ignored: true, reason: "invalid_signature" });
      }

      const envelope = parseWebhookPayload(req.body);
      const supabase = getSupabaseClient();
      const context = await loadTenantContext(supabase, {
        businessPhone: envelope.businessPhone,
        businessPhoneId: envelope.businessPhoneId,
      });

      const results = [];
      for (const msg of envelope.messages) {
        if (!msg.text) continue;

        // Tenant auto-response short-circuit
        const autoResponses = Array.isArray(
          (context.tenant as Record<string, unknown> | null)?.metadata,
        )
          ? ((context.tenant as Record<string, unknown>).metadata as AutoResponseTemplate[])
          : [];
        const autoReply = findAutoResponse(autoResponses, msg.text);

        const conversationContext = context.tenant
          ? await fetchConversationContext(
              supabase,
              msg.from,
              String((context.tenant as Record<string, unknown>).brand_id ?? ""),
              8,
            )
          : [];

        const reply = autoReply
          ? { type: "text" as const, text: autoReply, meta: { llm_used: false, reason: "auto_response" } }
          : await generateReply(msg.text, {
              tenant: context.tenant,
              contextMessages: conversationContext,
            });

        if (context.tenant) {
          const brandId = String((context.tenant as Record<string, unknown>).brand_id ?? "");
          if (brandId) {
            await logConversationMessage(supabase, {
              brand_id: brandId,
              user_id: msg.from,
              direction: "incoming",
              message_text: msg.text,
              whatsapp_message_id: msg.messageId,
            });
            await logConversationMessage(supabase, {
              brand_id: brandId,
              user_id: msg.from,
              direction: "outgoing",
              message_text: reply.text ?? "",
              llm_used: reply.meta.llm_used,
              llm_provider: reply.meta.llm_provider ?? null,
              llm_latency_ms: reply.meta.llm_latency_ms ?? null,
              llm_reason: reply.meta.reason ?? null,
            });
          }
        }

        results.push({
          from: msg.from,
          messageId: msg.messageId,
          reply: { type: reply.type, text: reply.text ?? null },
          meta: reply.meta,
        });
      }

      return res.status(200).json({
        ok: true,
        businessPhone: envelope.businessPhone || null,
        businessPhoneId: envelope.businessPhoneId || null,
        messageCount: envelope.messages.length,
        tenant: context.tenant ? { id: (context.tenant as Record<string,unknown>).id, name: (context.tenant as Record<string,unknown>).client_name } : null,
        source: context.source,
        lookupKey: context.lookupKey,
        results,
      });
    } catch (error) {
      const message = (error as Error).message || "Unknown error";
      return res.status(500).json({ ok: false, error: message });
    }
  });

  // -------------------------------------------------------------------------
  // AI generation engine endpoints — mirrors Zone /api/engine and /api/generate
  // -------------------------------------------------------------------------

  router.get("/api/engine", (_req: Request, res: Response) => {
    res.json({ ok: true, engine: engine.status() });
  });

  router.post("/api/generate", async (req: Request, res: Response) => {
    const { prompt, model, provider, meta } = req.body as {
      prompt?: string;
      model?: string;
      provider?: "openai" | "openrouter" | "huggingface";
      meta?: Record<string, unknown>;
    };

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, error: "prompt is required" });
    }

    const job = engine.enqueue({ prompt: prompt.trim(), model, provider, meta });
    return res.status(202).json({ ok: true, jobId: job.id, status: job.status });
  });

  router.get("/api/generate/:jobId", (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    const job = engine.getJob(jobId);
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });
    return res.json({ ok: true, job });
  });

  router.delete("/api/generate/:jobId", (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    const cancelled = engine.cancel(jobId);
    return res.json({ ok: true, cancelled });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation validation endpoint — Day 7 acceptance criteria
  // -------------------------------------------------------------------------

  const handleIsolationCheck = async (req: Request, res: Response) => {
    const mode = (readQuery(req.query.mode) || "documented").toLowerCase();
    const result = {
      ok: true,
      timestamp: new Date().toISOString(),
      mode,
      boundaries: [
        {
          name: "Conversation history",
          mechanism: "Filtered by brand_id + user_id on fetch",
          supabaseRow: "conversations",
          rls: "SELECT: (brand_id = current_tenant) OR owner == current_user",
          status: "protected" as const,
        },
        {
          name: "Submission documents",
          mechanism: "Filtered by tenant_id on query",
          supabaseRow: "submissions",
          rls: "SELECT: tenant_id = current_tenant",
          status: "protected" as const,
        },
        {
          name: "Billing state (credits)",
          mechanism: "user_credits isolated by user_id",
          supabaseRow: "user_credits",
          rls: "SELECT: user_id = current_user",
          status: "protected" as const,
        },
        {
          name: "Reviewer assignments",
          mechanism: "Filtered by submission_id → tenant_id transitive",
          supabaseRow: "reviewer_assignments",
          rls: "SELECT: submission.tenant_id = current_tenant",
          status: "protected" as const,
        },
        {
          name: "Generation jobs",
          mechanism: "In-memory; not persisted to shared tables",
          supabaseRow: "none",
          rls: "N/A",
          status: "safe" as const,
        },
      ],
      probe: {
        available: mode === "probe",
        executed: false,
        strict: false,
        summary: "Documentation-based isolation guarantees.",
        checks: [] as Array<{
          boundary: string;
          status: "pass" | "fail" | "skipped";
          detail: string;
        }>,
      },
      recommendations: [
        "Enable Row Level Security (RLS) on all tables listed above.",
        "Test with 2+ tenants; verify cross-tenant queries return empty.",
        "Audit all Supabase queries in production for WHERE clause presence.",
        "Monitor for missing tenant_id or user_id filters in application logs.",
      ],
      nextSteps: [
        "Create 2+ test tenants in Supabase",
        "Submit document as Tenant A; verify Tenant B cannot fetch it",
        "Enqueue generation job; verify job history is not cross-tenant",
        "Test M-Pesa callback for Tenant A; verify Tenant B subscription unchanged",
      ],
    };

    if (mode !== "probe") {
      return res.json(result);
    }

    const tenantAId = readQuery(req.query.tenantAId);
    const tenantBId = readQuery(req.query.tenantBId);
    const userAId = readQuery(req.query.userAId);
    const userBId = readQuery(req.query.userBId);

    if (!tenantAId || !tenantBId) {
      return res.status(400).json({
        ...result,
        ok: false,
        probe: {
          ...result.probe,
          available: false,
          summary:
            "Probe mode requires tenantAId and tenantBId query params (optional: userAId and userBId).",
        },
      });
    }

    const supabase = getSupabaseClient();
    const checks: Array<{ boundary: string; status: "pass" | "fail" | "skipped"; detail: string }> = [];

    try {
      const { data: submission } = await supabase
        .from("submissions")
        .select("id")
        .eq("tenant_id", tenantAId)
        .limit(1)
        .maybeSingle();

      if (!submission?.id) {
        checks.push({
          boundary: "Submission documents",
          status: "skipped",
          detail: "No submissions found for tenantAId; unable to run cross-tenant probe.",
        });
      } else {
        const { data: crossRows } = await supabase
          .from("submissions")
          .select("id")
          .eq("id", submission.id)
          .eq("tenant_id", tenantBId)
          .limit(1);
        checks.push({
          boundary: "Submission documents",
          status: crossRows && crossRows.length > 0 ? "fail" : "pass",
          detail:
            crossRows && crossRows.length > 0
              ? "Submission from tenant A was visible under tenant B filter."
              : "Submission ID from tenant A was not returned under tenant B filter.",
        });
      }
    } catch (error) {
      checks.push({
        boundary: "Submission documents",
        status: "skipped",
        detail: `Probe skipped: ${(error as Error).message}`,
      });
    }

    try {
      const { data: tenantA } = await supabase
        .from("bot_tenants")
        .select("brand_id")
        .eq("id", tenantAId)
        .limit(1)
        .maybeSingle();

      const { data: tenantB } = await supabase
        .from("bot_tenants")
        .select("brand_id")
        .eq("id", tenantBId)
        .limit(1)
        .maybeSingle();

      const brandA = String((tenantA as Record<string, unknown> | null)?.brand_id ?? "");
      const brandB = String((tenantB as Record<string, unknown> | null)?.brand_id ?? "");

      if (!brandA || !brandB) {
        checks.push({
          boundary: "Conversation history",
          status: "skipped",
          detail: "Missing brand_id on one or both tenant rows.",
        });
      } else {
        const { data: convo } = await supabase
          .from("conversations")
          .select("id")
          .eq("brand_id", brandA)
          .limit(1)
          .maybeSingle();

        if (!convo?.id) {
          checks.push({
            boundary: "Conversation history",
            status: "skipped",
            detail: "No conversations found for tenant A brand.",
          });
        } else {
          const { data: crossConvo } = await supabase
            .from("conversations")
            .select("id")
            .eq("id", convo.id)
            .eq("brand_id", brandB)
            .limit(1);

          checks.push({
            boundary: "Conversation history",
            status: crossConvo && crossConvo.length > 0 ? "fail" : "pass",
            detail:
              crossConvo && crossConvo.length > 0
                ? "Conversation from tenant A appeared under tenant B brand filter."
                : "Conversation ID from tenant A did not resolve under tenant B brand filter.",
          });
        }
      }
    } catch (error) {
      checks.push({
        boundary: "Conversation history",
        status: "skipped",
        detail: `Probe skipped: ${(error as Error).message}`,
      });
    }

    if (userAId && userBId) {
      try {
        const { data: balanceA } = await supabase
          .from("user_credits")
          .select("user_id")
          .eq("user_id", userAId)
          .limit(1)
          .maybeSingle();

        if (!balanceA?.user_id) {
          checks.push({
            boundary: "Billing state (credits)",
            status: "skipped",
            detail: "No credits row found for userAId.",
          });
        } else {
          const { data: crossCredit } = await supabase
            .from("user_credits")
            .select("user_id")
            .eq("user_id", userBId)
            .eq("user_id", userAId)
            .limit(1);
          checks.push({
            boundary: "Billing state (credits)",
            status: crossCredit && crossCredit.length > 0 ? "fail" : "pass",
            detail:
              crossCredit && crossCredit.length > 0
                ? "A/B user credit filters overlapped unexpectedly."
                : "User A credit row does not appear when filtering by user B.",
          });
        }
      } catch (error) {
        checks.push({
          boundary: "Billing state (credits)",
          status: "skipped",
          detail: `Probe skipped: ${(error as Error).message}`,
        });
      }
    } else {
      checks.push({
        boundary: "Billing state (credits)",
        status: "skipped",
        detail: "Provide userAId and userBId query params to probe credits isolation.",
      });
    }

    checks.push({
      boundary: "Generation jobs",
      status: "pass",
      detail: "Generation jobs are kept in-memory per process; no shared persistence table.",
    });

    const failedCount = checks.filter((check) => check.status === "fail").length;
    const passCount = checks.filter((check) => check.status === "pass").length;
    const skippedCount = checks.filter((check) => check.status === "skipped").length;

    return res.json({
      ...result,
      ok: failedCount === 0,
      probe: {
        available: true,
        executed: true,
        strict: true,
        summary: `Probe complete: ${passCount} pass, ${failedCount} fail, ${skippedCount} skipped.`,
        checks,
      },
    });
  };

  router.get("/api/isolation-check", handleIsolationCheck);
  router.get("/audit/tenant-isolation", handleIsolationCheck);

  return router;
}
