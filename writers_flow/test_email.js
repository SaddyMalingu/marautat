// Test script for Writer's Flow emailSender.js
import sendEmail from "../writers_flow/emailSender.js";

(async () => {
  try {
    const info = await sendEmail({
      to: "YOUR_EMAIL@gmail.com", // Change to your email for testing
      subject: "Writer's Flow Test Email",
      text: "This is a test email from Writer's Flow using your Gmail SMTP setup.",
    });
    console.log("Email sent! Message ID:", info.messageId);
  } catch (err) {
    console.error("Failed to send email:", err);
  }
})();
