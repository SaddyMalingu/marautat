import crypto from "node:crypto";
import type { Request } from "express";

export type WhatsAppInboundMessage = {
  from: string;
  text: string;
  messageId: string;
  timestamp?: string;
};

export type WhatsAppWebhookEnvelope = {
  businessPhone?: string;
  businessPhoneId?: string;
  messages: WhatsAppInboundMessage[];
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret = process.env.WHATSAPP_APP_SECRET,
): boolean {
  if (!appSecret) {
    return true;
  }

  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;

  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

export function parseWebhookPayload(body: unknown): WhatsAppWebhookEnvelope {
  const payload = (body || {}) as Record<string, unknown>;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  const messages: WhatsAppInboundMessage[] = [];
  let businessPhone = "";
  let businessPhoneId = "";

  for (const entry of entries) {
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as Record<string, unknown>[])
      : [];

    for (const change of changes) {
      const value = ((change as Record<string, unknown>).value || {}) as Record<string, unknown>;
      const metadata = (value.metadata || {}) as Record<string, unknown>;
      businessPhone = businessPhone || safeString(metadata.display_phone_number);
      businessPhoneId = businessPhoneId || safeString(metadata.phone_number_id);

      const rawMessages = Array.isArray(value.messages)
        ? (value.messages as Record<string, unknown>[])
        : [];

      for (const message of rawMessages) {
        const textPayload = (message.text || {}) as Record<string, unknown>;
        messages.push({
          from: safeString(message.from),
          text: safeString(textPayload.body),
          messageId: safeString(message.id),
          timestamp: safeString(message.timestamp) || undefined,
        });
      }
    }
  }

  return {
    businessPhone: businessPhone || undefined,
    businessPhoneId: businessPhoneId || undefined,
    messages,
  };
}

export function getRawBody(req: Request): string {
  const withRaw = req as Request & { rawBody?: string };
  if (typeof withRaw.rawBody === "string") {
    return withRaw.rawBody;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  return JSON.stringify(req.body || {});
}
