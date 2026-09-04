import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentStatus =
  | "pending"
  | "subscribed"
  | "paid"
  | "failed"
  | "manual_pending_verification"
  | "cod_pending_delivery"
  | "cancelled";

export type MpesaCallbackItem = {
  Name: string;
  Value?: string | number | null;
};

export type MpesaCallbackBody = {
  Body?: {
    stkCallback?: {
      CheckoutRequestID?: string;
      MerchantRequestID?: string;
      ResultCode?: number;
      CallbackMetadata?: { Item?: MpesaCallbackItem[] };
    };
  };
  CheckoutRequestID?: string;
};

export type SubscriptionRow = {
  id: string;
  user_id?: string | null;
  phone?: string | null;
  plan_type?: string | null;
  level?: number | string | null;
  amount?: number | null;
  status?: string | null;
  mpesa_checkout_request_id?: string | null;
  mpesa_receipt_no?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type PaymentCallbackResult = {
  outcome: "success" | "failure" | "not_found" | "error";
  subscriptionId?: string | null;
  receipt?: string | null;
  amount?: string | number | null;
  phone?: string | null;
  resultCode?: number | null;
  error?: string | null;
};

// ---------------------------------------------------------------------------
// extractCallbackFields — parse raw M-Pesa STK push callback body
// ---------------------------------------------------------------------------

export function extractCallbackFields(body: MpesaCallbackBody): {
  checkoutId: string | null;
  resultCode: number | null;
  receipt: string | null;
  amount: string | number | null;
  phone: string | null;
} {
  const cb = body?.Body?.stkCallback;
  const checkoutId =
    cb?.CheckoutRequestID || cb?.MerchantRequestID || body?.CheckoutRequestID || null;
  const resultCode = cb?.ResultCode !== undefined ? Number(cb.ResultCode) : null;
  const items = cb?.CallbackMetadata?.Item || [];
  const get = (name: string) =>
    (items.find((i) => i.Name === name)?.Value as string | number | null) ?? null;

  return {
    checkoutId,
    resultCode,
    receipt: get("MpesaReceiptNumber") as string | null,
    amount: get("Amount"),
    phone: get("PhoneNumber") as string | null,
  };
}

// ---------------------------------------------------------------------------
// findSubscriptionByCheckoutId — look up the pending subscription
// ---------------------------------------------------------------------------

export async function findSubscriptionByCheckoutId(
  supabase: SupabaseClient,
  checkoutId: string,
): Promise<SubscriptionRow | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("mpesa_checkout_request_id", checkoutId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`[kernel/payments] Subscription lookup failed: ${error.message}`);
  }

  return (Array.isArray(data) ? data[0] : null) ?? null;
}

// ---------------------------------------------------------------------------
// markSubscriptionSuccess — mirrors successful M-Pesa callback update path
// ---------------------------------------------------------------------------

export async function markSubscriptionSuccess(
  supabase: SupabaseClient,
  sub: SubscriptionRow,
  receipt: string | null,
  callbackBody: unknown,
): Promise<void> {
  const finalStatus: PaymentStatus =
    sub.plan_type === "kassangas_template" ? "paid" : "subscribed";

  await supabase
    .from("subscriptions")
    .update({
      status: finalStatus,
      mpesa_receipt_no: receipt,
      metadata: {
        ...(sub.metadata && typeof sub.metadata === "object" ? sub.metadata : {}),
        callback: callbackBody,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.id);

  if (sub.user_id) {
    await supabase
      .from("users")
      .update({
        subscribed: true,
        subscription_type: sub.plan_type,
        subscription_level: sub.level,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sub.user_id);
  }
}

// ---------------------------------------------------------------------------
// markSubscriptionFailed — mirrors failed M-Pesa callback update path
// ---------------------------------------------------------------------------

export async function markSubscriptionFailed(
  supabase: SupabaseClient,
  sub: SubscriptionRow,
  resultCode: number | null,
  callbackBody: unknown,
): Promise<void> {
  await supabase
    .from("subscriptions")
    .update({
      status: "failed",
      metadata: {
        callback: callbackBody,
        fallback_offered: true,
        failed_at: new Date().toISOString(),
        failure_result_code: resultCode,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.id);
}

// ---------------------------------------------------------------------------
// processMpesaCallback — full callback state machine
// ---------------------------------------------------------------------------

export async function processMpesaCallback(
  supabase: SupabaseClient,
  body: MpesaCallbackBody,
): Promise<PaymentCallbackResult> {
  const { checkoutId, resultCode, receipt, amount, phone } = extractCallbackFields(body);

  if (!checkoutId) {
    return { outcome: "error", error: "missing CheckoutRequestID" };
  }

  let sub: SubscriptionRow | null;
  try {
    sub = await findSubscriptionByCheckoutId(supabase, checkoutId);
  } catch (err) {
    return { outcome: "error", error: (err as Error).message };
  }

  if (!sub) {
    return { outcome: "not_found", resultCode };
  }

  const resolvedPhone = (phone as string | null) || sub.phone || null;

  if (resultCode === 0) {
    await markSubscriptionSuccess(supabase, sub, receipt as string | null, body);
    return {
      outcome: "success",
      subscriptionId: sub.id,
      receipt: receipt as string | null,
      amount,
      phone: resolvedPhone,
    };
  }

  await markSubscriptionFailed(supabase, sub, resultCode, body);
  return {
    outcome: "failure",
    subscriptionId: sub.id,
    resultCode,
    phone: resolvedPhone,
    amount,
  };
}
