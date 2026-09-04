import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { updateSubmissionStatus } from "./intake.js";

export type ReviewerAssignment = {
  id: string;
  submission_id: string;
  reviewer_email: string;
  reviewer_name?: string | null;
  google_doc_link?: string | null;
  assigned_at: string;
  notes?: string | null;
};

export type AssignReviewerInput = {
  submissionId: string;
  reviewerEmails: string[];
  reviewerName?: string | null;
  googleDocLink?: string | null;
  notes?: string | null;
};

export type AssignmentResult = {
  assignments: ReviewerAssignment[];
  notified: string[];
  errors: string[];
};

export type EmailDispatchFn = (opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// insertReviewerAssignment — mirrors assign_reviewer() metadata step
// ---------------------------------------------------------------------------

export async function insertReviewerAssignment(
  supabase: SupabaseClient,
  input: AssignReviewerInput,
  reviewerEmail: string,
): Promise<ReviewerAssignment> {
  const now = new Date().toISOString();
  const row: ReviewerAssignment = {
    id: randomUUID(),
    submission_id: input.submissionId,
    reviewer_email: reviewerEmail,
    reviewer_name: input.reviewerName ?? null,
    google_doc_link: input.googleDocLink ?? null,
    assigned_at: now,
    notes: input.notes ?? null,
  };

  const { error } = await supabase.from("reviewer_assignments").insert([row]);
  if (error) {
    throw new Error(`[kernel/assignment] Insert failed for ${reviewerEmail}: ${error.message}`);
  }

  return row;
}

// ---------------------------------------------------------------------------
// buildReviewEmail — generates the notification body sent to each reviewer
// ---------------------------------------------------------------------------

function buildReviewEmail(
  assignment: ReviewerAssignment,
  submissionTitle: string,
): { subject: string; html: string; text: string } {
  const docSection = assignment.google_doc_link
    ? `<p>Google Doc: <a href="${assignment.google_doc_link}">${assignment.google_doc_link}</a></p>`
    : "";
  const docSectionText = assignment.google_doc_link
    ? `\nGoogle Doc: ${assignment.google_doc_link}`
    : "";

  return {
    subject: `Review Assignment: ${submissionTitle}`,
    html: `
      <h2>You have been assigned to review a submission</h2>
      <p><strong>Title:</strong> ${submissionTitle}</p>
      <p><strong>Submission ID:</strong> ${assignment.submission_id}</p>
      ${docSection}
      ${assignment.notes ? `<p><strong>Notes:</strong> ${assignment.notes}</p>` : ""}
      <p>Please log in to the review portal to access the full document.</p>
    `.trim(),
    text: [
      `You have been assigned to review: ${submissionTitle}`,
      `Submission ID: ${assignment.submission_id}`,
      docSectionText,
      assignment.notes ? `Notes: ${assignment.notes}` : "",
      "Please log in to the review portal to access the full document.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

// ---------------------------------------------------------------------------
// assignReviewers — mirrors assign_reviewer() + send_review_email()
// ---------------------------------------------------------------------------

export async function assignReviewers(
  supabase: SupabaseClient,
  input: AssignReviewerInput,
  submissionTitle: string,
  dispatch: EmailDispatchFn,
): Promise<AssignmentResult> {
  const assignments: ReviewerAssignment[] = [];
  const notified: string[] = [];
  const errors: string[] = [];

  for (const email of input.reviewerEmails) {
    let assignment: ReviewerAssignment;
    try {
      assignment = await insertReviewerAssignment(supabase, input, email);
      assignments.push(assignment);
    } catch (err) {
      errors.push(`db:${email}:${(err as Error).message}`);
      continue;
    }

    const { subject, html, text } = buildReviewEmail(assignment, submissionTitle);
    try {
      await dispatch({ to: email, subject, html, text });
      notified.push(email);
    } catch (err) {
      errors.push(`email:${email}:${(err as Error).message}`);
    }
  }

  // Advance submission status to under_review if at least one assignment succeeded
  if (assignments.length > 0) {
    try {
      await updateSubmissionStatus(supabase, input.submissionId, "under_review");
    } catch (err) {
      errors.push(`status:${(err as Error).message}`);
    }
  }

  return { assignments, notified, errors };
}

// ---------------------------------------------------------------------------
// getAssignmentsForSubmission
// ---------------------------------------------------------------------------

export async function getAssignmentsForSubmission(
  supabase: SupabaseClient,
  submissionId: string,
): Promise<ReviewerAssignment[]> {
  const { data, error } = await supabase
    .from("reviewer_assignments")
    .select("*")
    .eq("submission_id", submissionId)
    .order("assigned_at", { ascending: false });

  if (error) {
    throw new Error(`[kernel/assignment] Fetch failed: ${error.message}`);
  }

  return (data ?? []) as ReviewerAssignment[];
}
