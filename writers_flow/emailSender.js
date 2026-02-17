// Email sender module using nodemailer with validation and logging
import nodemailer from 'nodemailer';

function validateEmailConfig() {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required email config: ${key}`);
    }
  }
}

let transporter;
try {
  validateEmailConfig();
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
} catch (err) {
  console.error('[EmailSender] Transporter setup failed:', err);
}

export default async function sendEmail({ from, to, subject, text, html }) {
  if (!transporter) throw new Error('Email transporter not configured');
  if (!from || !to || !subject || !text) {
    throw new Error('Missing required email fields');
  }
  try {
    const info = await transporter.sendMail({ from, to, subject, text, html });
    console.log(`[EmailSender] Email sent: ${info.messageId} to ${to}`);
    return info;
  } catch (err) {
    console.error(`[EmailSender] Failed to send email to ${to}:`, err);
    throw err;
  }
}
