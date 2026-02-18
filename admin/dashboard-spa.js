// SPA shell for admin dashboard

const routes = {
  dashboard: {
    label: 'Dashboard',
    icon: 'fa-solid fa-gauge',
    render: renderDashboard
  },
  logs: {
    label: 'Conversation Logs',
    icon: 'fa-solid fa-comments',
    render: renderLogs
  },
  llm: {
    label: 'LLM Usage',
    icon: 'fa-solid fa-brain',
    render: renderLLM
  },
  errors: {
    label: 'Error Rates',
    icon: 'fa-solid fa-triangle-exclamation',
    render: renderErrors
  },
  tenants: {
    label: 'Tenants',
    icon: 'fa-solid fa-users',
    render: renderTenants
  },
  health: {
    label: 'Health Check',
    icon: 'fa-solid fa-heart-pulse',
    render: renderHealth
  }
};

function navigate(route) {
  window.location.hash = route;
  renderRoute(route);
}

function renderRoute(route) {
  const main = document.querySelector('.main');
  if (!routes[route]) route = 'dashboard';
  main.innerHTML = '';
  routes[route].render(main);
  setActiveMenu(route);
}

function setActiveMenu(route) {
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.route === route);
  });
}

import { attachSmtpConfigHandler } from './smtpConfigHandler.js';

function renderDashboard(main) {
  main.innerHTML = `
    <div class="card">
      <h2>Welcome to the Admin Dashboard</h2>
      <p>Use the menu to view logs, LLM usage, errors, tenants, or run a health check.</p>
    </div>
    <section class="card mt-4">
      <h3><i class="fa-solid fa-envelope"></i> Tenant Email (SMTP) Settings</h3>
      <form id="smtpConfigForm">
        <div class="mb-2">
          <label for="smtp_host" class="form-label">SMTP Host</label>
          <input type="text" class="form-control" id="smtp_host" name="smtp_host" required>
        </div>
        <div class="mb-2">
          <label for="smtp_port" class="form-label">SMTP Port</label>
          <input type="number" class="form-control" id="smtp_port" name="smtp_port" required>
        </div>
        <div class="mb-2">
          <label for="smtp_user" class="form-label">SMTP User</label>
          <input type="email" class="form-control" id="smtp_user" name="smtp_user" required>
        </div>
        <div class="mb-2">
          <label for="smtp_pass" class="form-label">SMTP Password</label>
          <input type="password" class="form-control" id="smtp_pass" name="smtp_pass" required>
        </div>
        <div class="mb-2">
          <label for="smtp_from_name" class="form-label">Sender Name</label>
          <input type="text" class="form-control" id="smtp_from_name" name="smtp_from_name">
        </div>
        <button type="submit" class="btn btn-info mt-2">Save SMTP Settings</button>
      </form>
    </section>
  `;
  // TODO: Replace 'tenantId' with actual tenant ID from context/session
  attachSmtpConfigHandler('smtpConfigForm', 'tenantId');
}
function renderLogs(main) {
  main.innerHTML = `<div class="card"><h2>Conversation Logs</h2><div id="logs-list">Loading...</div></div>`;
  // TODO: fetch and render logs
}
function renderLLM(main) {
  main.innerHTML = `<div class="card"><h2>LLM Usage</h2><div id="llm-usage">Loading...</div></div>`;
  // TODO: fetch and render LLM usage
}
function renderErrors(main) {
  main.innerHTML = `<div class="card"><h2>Error Rates</h2><div id="error-rates">Loading...</div></div>`;
  // TODO: fetch and render errors
}
function renderTenants(main) {
  main.innerHTML = `<div class="card"><h2>Tenant Status</h2><div id="tenant-status">Loading...</div></div>`;
  // TODO: fetch and render tenants
}
function renderHealth(main) {
  main.innerHTML = `<div class="card"><h2>Health Check</h2><button id="run-health">Run Health Check</button><div id="health-status"></div></div>`;
  document.getElementById('run-health').onclick = async () => {
    document.getElementById('health-status').textContent = 'Running...';
    // TODO: call health check endpoint
    setTimeout(() => {
      document.getElementById('health-status').textContent = 'OK';
    }, 1000);
  };
}

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    a.onclick = e => {
      e.preventDefault();
      navigate(a.dataset.route);
    };
  });
  window.addEventListener('hashchange', () => {
    renderRoute(window.location.hash.replace('#',''));
  });
  renderRoute(window.location.hash.replace('#','') || 'dashboard');
});
