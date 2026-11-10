/**
 * Email delivery for the card lane (2026-11-11).
 *
 * A card buyer in New York has no WhatsApp thread with us, so email is the only
 * channel that can carry their signed access link. This wraps the existing
 * Writer's Flow sender rather than adding a second nodemailer setup, and it is
 * deliberately best-effort: a missing SMTP config must degrade to "the link is on
 * the page", never to "the payment failed".
 *
 * The timeout is not paranoia. `docs/ADMIN_CONSOLE_2026-10-25.md` records Render
 * dropping outbound SMTP, and nodemailer then sitting on its full connect timeout
 * — which once held a prospect's Submit button for two minutes. Delivery happens
 * after the response here, but it must still not pile up sockets.
 */
import sendEmail from '../writers_flow/emailSender.js';

export const DROPS_MAIL_TIMEOUT_MS = 15000;

export function mailerConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

export async function sendDropsEmail({ to, subject, text, html, env = process.env }) {
  if (!to || !subject || !text) return { ok: false, skipped: true, reason: 'incomplete-message' };
  if (!mailerConfigured(env)) return { ok: false, skipped: true, reason: 'smtp-not-configured' };

  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, error: 'smtp-timeout' }), DROPS_MAIL_TIMEOUT_MS);
  });

  const attempt = sendEmail({
    to,
    subject,
    text,
    html,
    smtpConfig: { smtp_from_name: env.DROPS_FROM_NAME || env.SMTP_FROM_NAME || 'Alphadome' },
  })
    .then((info) => ({ ok: true, messageId: (info && info.messageId) || null }))
    .catch((err) => ({ ok: false, error: err.message }));

  return Promise.race([attempt, timeout]);
}

/** Tell the owner a proposal request arrived. Best effort, same terms. */
export async function notifyServiceRequest({ request, env = process.env }) {
  const to = String(env.DROPS_LEAD_EMAIL || env.ADMIN_EMAIL || '').trim();
  if (!to) return { ok: false, skipped: true, reason: 'no-lead-address' };
  const lines = [
    'Proposal request (' + (request.country || 'country unknown') + ')',
    '',
    'Name:     ' + request.name,
    'Company:  ' + (request.company || '—'),
    'Email:    ' + request.email,
    'Budget:   ' + request.budget,
    'Timeline: ' + request.timeline,
    'Channel:  ' + (request.channel || '—'),
    '',
    'What they sell: ' + request.sell,
    '',
    'Problem: ' + (request.problem || '—'),
  ];
  return sendDropsEmail({
    to,
    subject: '[Drops] Funnel build request — ' + request.name + (request.company ? ' @ ' + request.company : ''),
    text: lines.join('\n'),
    env,
  });
}
