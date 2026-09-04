import type { SupabaseClient } from "@supabase/supabase-js";

export type TenantRecord = {
  id: string;
  client_name?: string | null;
  client_phone?: string | null;
  whatsapp_phone_number_id?: string | null;
  is_active?: boolean | null;
  status?: string | null;
  updated_at?: string | null;
};

export type TenantLookupInput = {
  businessPhone?: string | null;
  businessPhoneId?: string | null;
  requireActive?: boolean;
};

export type TenantLookupResult = {
  tenant: TenantRecord | null;
  lookupKey: string | null;
  candidates: string[];
  source: "phone_number_id" | "phone" | "none";
};

type RpcTenantResult = {
  tenant?: TenantRecord;
};

const MAIN_BUSINESS_PHONE = process.env.WHATSAPP_BUSINESS_PHONE || "254707529706";

export function normalizePhone(value: string | null | undefined): string {
  return String(value || "").replace(/\D/g, "");
}

export function toKeE164(value: string | null | undefined): string {
  const digits = normalizePhone(value);
  if (!digits) return "";
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}

export function buildPhoneCandidates(value: string | null | undefined): string[] {
  const digits = normalizePhone(value);
  if (!digits) return [];

  const candidates = new Set<string>([digits]);
  if (digits.startsWith("0") && digits.length >= 10) {
    candidates.add(`254${digits.slice(1)}`);
  }
  if (digits.startsWith("254") && digits.length >= 12) {
    candidates.add(`0${digits.slice(3)}`);
  }
  if (digits.length === 9) {
    candidates.add(`254${digits}`);
    candidates.add(`0${digits}`);
  }

  const expanded = new Set<string>([
    ...candidates,
    ...Array.from(candidates).map(toKeE164),
  ]);
  expanded.delete("");

  return Array.from(expanded);
}

export function isTenantRecordActive(tenant: TenantRecord | null | undefined): boolean {
  if (!tenant) return false;
  if (typeof tenant.is_active === "boolean") {
    return tenant.is_active;
  }
  const status = String(tenant.status || "").trim().toLowerCase();
  if (!status) return true;
  return status === "active";
}

export function isMissingTableInSchemaCache(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message || "").toLowerCase();
  return message.includes("could not find the table") || message.includes("schema cache");
}

export function isSchemaNotExposedError(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message || "").toLowerCase();
  return (
    message.includes("the schema must be one of the following") ||
    message.includes("schema must be one of the following")
  );
}

export async function findTenantByPhone(
  supabase: SupabaseClient,
  tenantPhone: string,
  requireActive = true,
): Promise<TenantRecord | null> {
  const candidates = buildPhoneCandidates(tenantPhone);
  if (!candidates.length) return null;

  const inList = candidates.join(",");
  const { data, error } = await supabase
    .from("bot_tenants")
    .select("*")
    .or(`client_phone.in.(${inList}),whatsapp_phone_number_id.in.(${inList})`)
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error) {
    throw error;
  }

  const rows = (data || []) as TenantRecord[];
  if (!rows.length) return null;
  if (!requireActive) return rows[0];
  return rows.find(isTenantRecordActive) || null;
}

export async function resolveAlphadomeTenantByPhone(
  supabase: SupabaseClient,
  tenantPhone: string,
): Promise<TenantRecord | null> {
  const candidates = buildPhoneCandidates(tenantPhone);
  for (const phone of candidates) {
    const { data, error } = await supabase.rpc("get_tenant_by_wa", {
      business_phone: phone,
    });

    if (error) {
      throw error;
    }

    const payload = data as RpcTenantResult | null;
    if (payload?.tenant?.id) {
      return payload.tenant;
    }
  }

  return null;
}

export async function loadTenantContext(
  supabase: SupabaseClient,
  input: TenantLookupInput,
): Promise<TenantLookupResult> {
  const requireActive = input.requireActive ?? true;
  const normalizedBusinessPhone = normalizePhone(input.businessPhone);
  const businessPhoneId = normalizePhone(input.businessPhoneId);

  if (businessPhoneId) {
    const tenantByPhoneId = await findTenantByPhone(supabase, businessPhoneId, requireActive);
    if (tenantByPhoneId?.id) {
      return {
        tenant: tenantByPhoneId,
        lookupKey: businessPhoneId,
        candidates: [businessPhoneId],
        source: "phone_number_id",
      };
    }
  }

  if (normalizedBusinessPhone) {
    const tenantByPhone = await findTenantByPhone(supabase, normalizedBusinessPhone, requireActive);
    if (tenantByPhone?.id) {
      return {
        tenant: tenantByPhone,
        lookupKey: normalizedBusinessPhone,
        candidates: buildPhoneCandidates(normalizedBusinessPhone),
        source: "phone",
      };
    }
  }

  // Keep parity with monolith fallback behavior by trying the default Alphadome line.
  const fallbackTenant = await resolveAlphadomeTenantByPhone(supabase, MAIN_BUSINESS_PHONE);
  if (fallbackTenant?.id) {
    return {
      tenant: fallbackTenant,
      lookupKey: normalizePhone(MAIN_BUSINESS_PHONE),
      candidates: buildPhoneCandidates(MAIN_BUSINESS_PHONE),
      source: "phone",
    };
  }

  return {
    tenant: null,
    lookupKey: normalizedBusinessPhone || businessPhoneId || null,
    candidates: buildPhoneCandidates(normalizedBusinessPhone || businessPhoneId),
    source: "none",
  };
}
