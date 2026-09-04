import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

export type SubmissionStatus =
  | "pending"
  | "under_review"
  | "accepted"
  | "rejected"
  | "revision_requested";

export type SubmissionMetadata = {
  title: string;
  abstract?: string | null;
  author_name: string;
  author_email: string;
  author_phone?: string | null;
  tenant_id?: string | null;
  category?: string | null;
  tags?: string[] | null;
  extra?: Record<string, unknown> | null;
};

export type IntakeResult = {
  submission_id: string;
  storage_path: string;
  public_url: string | null;
  status: SubmissionStatus;
  created_at: string;
};

export type IntakeInput = {
  fileBuffer: Uint8Array | Buffer;
  fileName: string;
  mimeType: string;
  metadata: SubmissionMetadata;
  bucket?: string;
};

export type SubmissionRow = {
  id: string;
  tenant_id: string | null;
  title: string;
  abstract: string | null;
  author_name: string;
  author_email: string;
  author_phone: string | null;
  category: string | null;
  tags: string[] | null;
  status: SubmissionStatus;
  storage_path: string;
  extra: Record<string, unknown> | null;
  created_at: string;
};

const DEFAULT_BUCKET = "submissions";

function buildStoragePath(submissionId: string, fileName: string): string {
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "bin";
  return `${submissionId}/${submissionId}.${ext}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

// ---------------------------------------------------------------------------
// uploadSubmissionFile — mirrors submit_journal() storage step
// ---------------------------------------------------------------------------

export async function uploadSubmissionFile(
  supabase: SupabaseClient,
  input: Pick<IntakeInput, "fileBuffer" | "fileName" | "mimeType" | "bucket">,
  submissionId: string,
): Promise<{ storagePath: string; publicUrl: string | null }> {
  const bucket = input.bucket || DEFAULT_BUCKET;
  const safeName = sanitizeFileName(input.fileName);
  const storagePath = buildStoragePath(submissionId, safeName);

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, input.fileBuffer, {
      contentType: input.mimeType,
      upsert: false,
    });

  if (error) {
    throw new Error(`[kernel/intake] Storage upload failed: ${error.message}`);
  }

  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  const publicUrl = urlData?.publicUrl ?? null;

  return { storagePath, publicUrl };
}

// ---------------------------------------------------------------------------
// insertSubmissionMetadata — mirrors insert_submission_metadata()
// ---------------------------------------------------------------------------

export async function insertSubmissionMetadata(
  supabase: SupabaseClient,
  submissionId: string,
  storagePath: string,
  meta: SubmissionMetadata,
): Promise<SubmissionRow> {
  const now = new Date().toISOString();
  const row: SubmissionRow = {
    id: submissionId,
    tenant_id: meta.tenant_id ?? null,
    title: meta.title,
    abstract: meta.abstract ?? null,
    author_name: meta.author_name,
    author_email: meta.author_email,
    author_phone: meta.author_phone ?? null,
    category: meta.category ?? null,
    tags: meta.tags ?? null,
    status: "pending",
    storage_path: storagePath,
    extra: meta.extra ?? null,
    created_at: now,
  };

  const { error } = await supabase.from("submissions").insert([row]);
  if (error) {
    throw new Error(`[kernel/intake] Metadata insert failed: ${error.message}`);
  }

  return row;
}

// ---------------------------------------------------------------------------
// submitDocument — full intake pipeline: upload + metadata
// ---------------------------------------------------------------------------

export async function submitDocument(
  supabase: SupabaseClient,
  input: IntakeInput,
): Promise<IntakeResult> {
  const submissionId = randomUUID();
  const { storagePath, publicUrl } = await uploadSubmissionFile(supabase, input, submissionId);
  const row = await insertSubmissionMetadata(supabase, submissionId, storagePath, input.metadata);

  return {
    submission_id: submissionId,
    storage_path: storagePath,
    public_url: publicUrl,
    status: row.status,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// getSubmission
// ---------------------------------------------------------------------------

export async function getSubmission(
  supabase: SupabaseClient,
  submissionId: string,
): Promise<SubmissionRow | null> {
  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("id", submissionId)
    .maybeSingle();

  if (error) {
    throw new Error(`[kernel/intake] Fetch failed: ${error.message}`);
  }

  return (data as SubmissionRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// updateSubmissionStatus
// ---------------------------------------------------------------------------

export async function updateSubmissionStatus(
  supabase: SupabaseClient,
  submissionId: string,
  status: SubmissionStatus,
): Promise<void> {
  const { error } = await supabase
    .from("submissions")
    .update({ status })
    .eq("id", submissionId);

  if (error) {
    throw new Error(`[kernel/intake] Status update failed: ${error.message}`);
  }
}
