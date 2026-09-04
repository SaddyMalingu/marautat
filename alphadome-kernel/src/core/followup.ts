// ---------------------------------------------------------------------------
// Follow-up scheduling and dispatch
//
// Mirrors the monolith's scheduleFallbackReminder and follow-up dispatch logic.
// Keeps scheduling simple and dependency-free using Node timers so it works
// without an external job queue. Callers can swap the dispatch function for
// WhatsApp, email, or any other channel adapter.
// ---------------------------------------------------------------------------

export type FollowUpJob = {
  id: string;
  waPhone: string;
  subscriptionId: string;
  planType?: string | null;
  level?: number | string | null;
  amount?: number | null;
  scheduledAt: number;
  fired: boolean;
};

export type FollowUpDispatchFn = (job: FollowUpJob) => Promise<void>;

type TimerHandle = ReturnType<typeof setTimeout>;

const DEFAULT_REMINDER_DELAY_MS = 30 * 60 * 1000; // 30 minutes, matches monolith intent

const activeJobs = new Map<string, { job: FollowUpJob; timer: TimerHandle }>();

let _globalDispatch: FollowUpDispatchFn | null = null;

// ---------------------------------------------------------------------------
// setFollowUpDispatch — wire in a channel-specific send function at startup
// ---------------------------------------------------------------------------

export function setFollowUpDispatch(fn: FollowUpDispatchFn): void {
  _globalDispatch = fn;
}

// ---------------------------------------------------------------------------
// scheduleFollowUp — replaces monolith scheduleFallbackReminder()
// ---------------------------------------------------------------------------

export function scheduleFollowUp(
  params: Omit<FollowUpJob, "id" | "scheduledAt" | "fired">,
  delayMs = DEFAULT_REMINDER_DELAY_MS,
  dispatch?: FollowUpDispatchFn,
): FollowUpJob {
  const id = `${params.subscriptionId}-${Date.now()}`;
  const job: FollowUpJob = {
    id,
    ...params,
    scheduledAt: Date.now() + delayMs,
    fired: false,
  };

  const dispatchFn = dispatch || _globalDispatch;

  const timer = setTimeout(async () => {
    job.fired = true;
    activeJobs.delete(id);
    if (dispatchFn) {
      try {
        await dispatchFn(job);
      } catch (err) {
        console.error(`[kernel/followup] dispatch error for job ${id}: ${(err as Error).message}`);
      }
    }
  }, delayMs);

  activeJobs.set(id, { job, timer });
  return job;
}

// ---------------------------------------------------------------------------
// cancelFollowUp — cancel a scheduled reminder before it fires
// ---------------------------------------------------------------------------

export function cancelFollowUp(jobId: string): boolean {
  const entry = activeJobs.get(jobId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  activeJobs.delete(jobId);
  return true;
}

// ---------------------------------------------------------------------------
// listActiveFollowUps — for monitoring
// ---------------------------------------------------------------------------

export function listActiveFollowUps(): FollowUpJob[] {
  return Array.from(activeJobs.values()).map((e) => e.job);
}

// ---------------------------------------------------------------------------
// buildFallbackReminderText — message body for payment retry reminders
// ---------------------------------------------------------------------------

export function buildFallbackReminderText(
  planType: string | null | undefined,
  level: string | number | null | undefined,
  amount: number | null | undefined,
): string {
  const planLabel = planType ? planType.toUpperCase() : "your plan";
  const levelLabel = level != null ? ` Level ${level}` : "";
  const amountLabel = amount ? `KES ${amount}` : "";

  return [
    `👋 Just following up on your payment for *${planLabel}${levelLabel}*${amountLabel ? ` (${amountLabel})` : ""}.`,
    ``,
    `If you ran into issues, here are your options:`,
    `  🔄 Reply *RETRY* to try M-Pesa again`,
    `  🏦 Reply *BANK* for bank transfer details`,
    `  🚚 Reply *COD* for cash on delivery`,
    `  📞 Reply *SUPPORT* to reach our team`,
  ].join("\n");
}
