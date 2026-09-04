import { getSupabaseClient } from "../adapters/supabase.js";
import { FREE_TIER_INITIAL_CREDITS } from "./tiers.js";
import type { CreditBalance, TransactionType } from "../types/index.js";

function nowIso() {
  return new Date().toISOString();
}

export async function getUserCredits(userId: string): Promise<CreditBalance> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("user_credits")
    .select("user_id,balance_credits,subscription_tier,lifetime_purchased,updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load user credits: ${error.message}`);
  }

  if (!data) {
    const starter: CreditBalance = {
      userId,
      balanceCredits: FREE_TIER_INITIAL_CREDITS,
      subscriptionTier: "free",
      lifetimePurchased: 0,
      updatedAt: nowIso()
    };

    const { error: insertError } = await supabase.from("user_credits").insert({
      user_id: starter.userId,
      balance_credits: starter.balanceCredits,
      subscription_tier: starter.subscriptionTier,
      lifetime_purchased: starter.lifetimePurchased,
      updated_at: starter.updatedAt
    });

    if (insertError) {
      throw new Error(`Failed to create initial user credits: ${insertError.message}`);
    }

    return starter;
  }

  return {
    userId: data.user_id,
    balanceCredits: Number(data.balance_credits || 0),
    subscriptionTier: data.subscription_tier || "free",
    lifetimePurchased: Number(data.lifetime_purchased || 0),
    updatedAt: data.updated_at || undefined
  };
}

async function recordCreditTransaction(params: {
  userId: string;
  amount: number;
  transactionType: TransactionType;
  reason: string;
  balanceBefore: number;
  balanceAfter: number;
  paymentIntentId?: string | null;
  renderRequestId?: string | null;
}) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("credit_transactions").insert({
    user_id: params.userId,
    amount: params.amount,
    transaction_type: params.transactionType,
    reason: params.reason,
    payment_intent_id: params.paymentIntentId || null,
    render_request_id: params.renderRequestId || null,
    balance_before: params.balanceBefore,
    balance_after: params.balanceAfter,
    created_at: nowIso()
  });

  if (error) {
    throw new Error(`Failed to record credit transaction: ${error.message}`);
  }
}

export async function deductCredits(params: {
  userId: string;
  amount: number;
  reason: string;
  renderRequestId?: string;
}) {
  if (params.amount <= 0) {
    throw new Error("deductCredits amount must be greater than 0");
  }

  const supabase = getSupabaseClient();
  const current = await getUserCredits(params.userId);

  if (current.balanceCredits < params.amount) {
    throw new Error(
      `Insufficient credits. Have ${current.balanceCredits}, need ${params.amount}`
    );
  }

  const nextBalance = Number((current.balanceCredits - params.amount).toFixed(4));

  const { error } = await supabase
    .from("user_credits")
    .update({
      balance_credits: nextBalance,
      updated_at: nowIso()
    })
    .eq("user_id", params.userId);

  if (error) {
    throw new Error(`Failed to deduct credits: ${error.message}`);
  }

  await recordCreditTransaction({
    userId: params.userId,
    amount: -params.amount,
    transactionType: "charge",
    reason: params.reason,
    renderRequestId: params.renderRequestId || null,
    balanceBefore: current.balanceCredits,
    balanceAfter: nextBalance
  });

  return {
    userId: params.userId,
    deducted: params.amount,
    balanceBefore: current.balanceCredits,
    balanceAfter: nextBalance
  };
}

export async function addCredits(params: {
  userId: string;
  amount: number;
  reason: string;
  transactionType?: TransactionType;
  paymentIntentId?: string;
}) {
  if (params.amount <= 0) {
    throw new Error("addCredits amount must be greater than 0");
  }

  const supabase = getSupabaseClient();
  const current = await getUserCredits(params.userId);
  const nextBalance = Number((current.balanceCredits + params.amount).toFixed(4));

  const updatePayload: Record<string, unknown> = {
    balance_credits: nextBalance,
    updated_at: nowIso()
  };

  if ((params.transactionType || "purchase") === "purchase") {
    updatePayload.lifetime_purchased = Number(
      (current.lifetimePurchased + params.amount).toFixed(4)
    );
  }

  const { error } = await supabase
    .from("user_credits")
    .update(updatePayload)
    .eq("user_id", params.userId);

  if (error) {
    throw new Error(`Failed to add credits: ${error.message}`);
  }

  await recordCreditTransaction({
    userId: params.userId,
    amount: params.amount,
    transactionType: params.transactionType || "purchase",
    reason: params.reason,
    paymentIntentId: params.paymentIntentId || null,
    balanceBefore: current.balanceCredits,
    balanceAfter: nextBalance
  });

  return {
    userId: params.userId,
    added: params.amount,
    balanceBefore: current.balanceCredits,
    balanceAfter: nextBalance
  };
}
