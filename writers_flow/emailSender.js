// Email sender module using nodemailer with validation and logging
/**
 * Writer's Flow — Email Sender
 * Supports dynamic SMTP config passed at runtime (per-campaign or from env).
 */
import nodemailer from 'nodemailer';

function buildTransporter(config = {}) {
  const host = config.smtp_host || process.env.SMTP_HOST;
  const port = parseInt(config.smtp_port || process.env.SMTP_PORT || '587', 10);
  const user = config.smtp_user || process.env.SMTP_USER;
  const pass = config.smtp_pass || process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP config incomplete. Set SMTP_HOST, SMTP_USER, SMTP_PASS or pass smtp config.');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

/**
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} params.text
 * @param {string} [params.html]
 * @param {object} [params.smtpConfig] - optional {smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name}
 */
export default async function sendEmail({ to, subject, text, html, smtpConfig = {} }) {
  if (!to || !subject || !text) throw new Error('to, subject, and text are required');

  const transporter = buildTransporter(smtpConfig);
  const fromName = smtpConfig.smtp_from_name || process.env.SMTP_FROM_NAME || 'Alphadome';
  const fromAddr = smtpConfig.smtp_user || process.env.SMTP_USER;
  const from = `"${fromName}" <${fromAddr}>`;

  const info = await transporter.sendMail({ from, to, subject, text, html: html || text });
  console.log(`[EmailSender] Sent to ${to}: ${info.messageId}`);
  return info;
}
