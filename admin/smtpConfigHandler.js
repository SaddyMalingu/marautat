// admin/smtpConfigHandler.js
// Handles SMTP config form submission for super admin and tenant dashboards

import { updateTenantSmtpConfig } from '../utils/tenantSmtpConfig.js';

// Attach handler to form
export function attachSmtpConfigHandler(formId, tenantId) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const smtp_host = form.smtp_host.value;
    const smtp_port = parseInt(form.smtp_port.value, 10);
    const smtp_user = form.smtp_user.value;
    const smtp_pass = form.smtp_pass.value;
    const smtp_from_name = form.smtp_from_name.value;
    try {
      await updateTenantSmtpConfig({ tenantId, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name });
      alert('SMTP settings updated successfully!');
    } catch (err) {
      alert('Failed to update SMTP settings: ' + err.message);
    }
  });
}
