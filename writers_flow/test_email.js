// Test SendGrid email sending using Node.js SDK and environment variables
import sgMail from '@sendgrid/mail';

// Load API key and sender from environment
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;

if (!SENDGRID_API_KEY || !SENDGRID_FROM_EMAIL) {
  console.error('Missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL in environment variables.');
  process.exit(1);
}

sgMail.setApiKey(SENDGRID_API_KEY);

// Simple test email parameters
const to = process.argv[2] || 'davidmsaddy@gmail.com'; // Pass recipient as CLI arg or hardcode
const subject = "SendGrid Test Email from Writer's Flow";
const text = "This is a test email sent via SendGrid from your Writer's Flow integration.";

const msg = {
  to,
  from: SENDGRID_FROM_EMAIL,
  subject,
  text,
};

sgMail
  .send(msg)
  .then(() => {
    console.log(`Test email sent to ${to} via SendGrid!`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('SendGrid send error:', error.response?.body || error.message || error);
    process.exit(1);
  });
