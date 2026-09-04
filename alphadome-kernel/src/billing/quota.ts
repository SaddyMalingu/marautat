import { getSupabaseClient } from "../adapters/supabase.js";
import type { QuotaCheckResult } from "../types/index.js";

function startOfUtcDayIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export async function checkDailyQuota(params: {
  userId: string;
  dailyLimit?: number;
}): Promise<QuotaCheckResult> {
  const supabase = getSupabaseClient();
  const dailyLimit = params.dailyLimit ?? Number(process.env.DAILY_QUOTA_LIMIT || 100);

  if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) {
    return {
      allowed: false,
      usedToday: 0,
      dailyLimit: 0,
      reason: "Invalid daily quota limit"
    };
  }

  const todayStart = startOfUtcDayIso();
  const { count, error } = await supabase
    .from("render_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", params.userId)
    .gte("created_at", todayStart);

  if (error) {
    throw new Error(`Failed to check daily quota: ${error.message}`);
  }

  const usedToday = Number(count || 0);
  const allowed = usedToday < dailyLimit;

  return {
    allowed,
    usedToday,
    dailyLimit,
    reason: allowed ? undefined : `Daily quota exceeded (${usedToday}/${dailyLimit})`
  };
}
