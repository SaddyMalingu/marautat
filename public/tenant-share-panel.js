/**
 * "Ready to share" panel for the tenant portal (2026-11-12).
 *
 * Sits inside Writer's Flow, above the collection controls, and lists the pages the
 * writer has finished with the caption already composed. Three actions per row, no
 * modal, no separate page: Copy (LinkedIn), Copy (X), Post to X.
 *
 * It injects itself instead of living in tenant_dashboard.html: that file is 5,900
 * lines and shared by every tenant, so a panel that mounts itself cannot break the
 * portal it lives in, and reverting it means deleting one script tag.
 *
 * Reads GET /tenant/blogger/share-queue (tenant session cookie), writes through
 * POST /tenant/blogger/posts/:slug/publish/x. LinkedIn stays manual on purpose —
 * its rules forbid an app posting to a member profile.
 */
(function () {
  var MOUNT_ID = 'wfSharePanel';
  var mounted = false;
  var loaded = false;
  var expanded = false;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function style() {
    if (document.getElementById('wfShareStyle')) return;
    var s = document.createElement('style');
    s.id = 'wfShareStyle';
    s.textContent = [
      '#wfSharePanel{border:1px solid var(--border,rgba(255,255,255,.12));border-radius:14px;padding:14px 14px 8px;margin:0 0 16px;background:var(--bg-card,rgba(255,255,255,.03))}',
      '#wfSharePanel .wfs-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '#wfSharePanel .wfs-title{font-weight:700;font-size:.95rem;margin:0}',
      '#wfSharePanel .wfs-count{color:var(--accent,#ff8a00);font-weight:700}',
      '#wfSharePanel .wfs-hint{color:var(--text-muted,#a9bccd);font-size:.78rem;margin:2px 0 8px}',
      '#wfSharePanel .wfs-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,.07)}',
      '#wfSharePanel .wfs-row:first-of-type{border-top:0}',
      '#wfSharePanel .wfs-name{flex:1 1 auto;min-width:0}',
      '#wfSharePanel .wfs-name a{color:inherit;text-decoration:none;font-size:.86rem;font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#wfSharePanel .wfs-name a:hover{text-decoration:underline}',
      '#wfSharePanel .wfs-meta{color:var(--text-muted,#a9bccd);font-size:.72rem}',
      '#wfSharePanel .wfs-acts{display:flex;gap:6px;flex:0 0 auto}',
      '#wfSharePanel .wfs-btn{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:inherit;border-radius:8px;padding:6px 10px;font-size:.74rem;font-weight:600;cursor:pointer;min-height:32px;white-space:nowrap;text-decoration:none}',
      '#wfSharePanel .wfs-btn:hover{border-color:rgba(255,138,0,.55)}',
      '#wfSharePanel .wfs-btn.primary{background:linear-gradient(90deg,#ff8a00,#ffd166);color:#201000;border:0}',
      '#wfSharePanel .wfs-btn[disabled]{opacity:.55;cursor:default}',
      '#wfSharePanel .wfs-msg{font-size:.74rem;margin:0 0 4px}',
      '#wfSharePanel .wfs-msg.err{color:var(--danger,#ff6b7f)}',
      '#wfSharePanel .wfs-msg.ok{color:var(--success,#7ef9c8)}',
      '#wfSharePanel .wfs-more{background:none;border:0;color:var(--accent,#ff8a00);font-size:.76rem;padding:6px 0;cursor:pointer}',
      '@media(max-width:575px){#wfSharePanel .wfs-row{flex-wrap:wrap}#wfSharePanel .wfs-acts{width:100%}}'
    ].join('');
    document.head.appendChild(s);
  }

  function panel() { return document.getElementById(MOUNT_ID); }

  function row(item) {
    var hasCaps = item.ready && item.x && item.linkedin;
    var date = String(item.created_at || '').slice(0, 10);
    return '<div class="wfs-row" data-slug="' + esc(item.slug) + '">' +
      '<div class="wfs-name">' +
        '<a href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(item.title || item.slug) + '</a>' +
        '<div class="wfs-meta">' + esc(item.angle || 'page') + (date ? ' · ' + esc(date) : '') +
          (hasCaps ? '' : ' · no caption yet') + '</div>' +
      '</div>' +
      (hasCaps
        ? '<div class="wfs-acts">' +
            '<button class="wfs-btn" type="button" data-copy="li">LinkedIn</button>' +
            '<button class="wfs-btn" type="button" data-copy="x">X text</button>' +
            '<button class="wfs-btn primary" type="button" data-post="1">Post</button>' +
          '</div>'
        : '<div class="wfs-acts"><a class="wfs-btn" href="' + esc(item.url) + '" target="_blank" rel="noopener">Open</a></div>') +
      '</div>';
  }

  function render(data, host) {
    var items = data.items || [];
    var body = host.querySelector('.wfs-body');
    host.querySelector('.wfs-count').textContent = data.ready ? data.ready + ' ready' : '';
    if (!items.length) {
      body.innerHTML = '<div class="wfs-hint">Nothing new in the last ' + esc(data.days) + ' days. Finished pages appear here on their own.</div>';
      return;
    }
    var shown = expanded ? items : items.slice(0, 5);
    body.innerHTML = shown.map(row).join('') +
      (items.length > 5
        ? '<button class="wfs-more" type="button">' + (expanded ? 'Show fewer' : 'Show all ' + items.length) + '</button>'
        : '');
    var more = body.querySelector('.wfs-more');
    if (more) more.addEventListener('click', function () { expanded = !expanded; render(data, host); });

    Array.prototype.forEach.call(body.querySelectorAll('.wfs-row'), function (el, i) {
      var item = shown[i];
      var msg = document.createElement('div');
      msg.className = 'wfs-msg';
      Array.prototype.forEach.call(el.querySelectorAll('[data-copy]'), function (b) {
        b.addEventListener('click', function () {
          var which = b.getAttribute('data-copy');
          var text = String(which === 'li' ? (item.linkedin && item.linkedin.text) : (item.x && item.x.text) || '');
          var old = b.textContent;
          function done(ok) { b.textContent = ok ? 'Copied' : 'Ctrl+C'; setTimeout(function () { b.textContent = old; }, 1400); }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
          } else { done(false); }
        });
      });
      var post = el.querySelector('[data-post]');
      if (post) {
        post.addEventListener('click', function () {
          post.disabled = true;
          post.textContent = 'Sending';
          fetch('/tenant/blogger/posts/' + encodeURIComponent(item.slug) + '/publish/x', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin'
          }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res) {
              post.disabled = false;
              post.textContent = res.ok && res.d.ok ? 'Posted' : 'Post';
              msg.className = 'wfs-msg ' + (res.ok && res.d.ok ? 'ok' : 'err');
              if (res.ok && res.d.ok) {
                var url = res.d.tweet && res.d.tweet.url;
                msg.innerHTML = url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" style="color:inherit">Posted — open on X</a>' : 'Posted.';
              } else {
                msg.textContent = /not_configured/i.test(String((res.d && res.d.error) || ''))
                  ? 'X is not connected for this workspace. Copy the text instead.'
                  : ((res.d && (res.d.message || res.d.error)) || 'That did not send.');
              }
            })
            .catch(function () {
              post.disabled = false; post.textContent = 'Post';
              msg.className = 'wfs-msg err'; msg.textContent = 'Did not send.';
            });
        });
      }
      el.parentNode.insertBefore(msg, el.nextSibling);
    });
  }

  function load(force) {
    var host = panel();
    if (!host) return;
    if (loaded && !force) return;
    loaded = true;
    var body = host.querySelector('.wfs-body');
    body.innerHTML = '<div class="wfs-hint">Loading…</div>';
    fetch('/tenant/blogger/share-queue?days=14&limit=8', { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) {
          body.innerHTML = '<div class="wfs-hint">Could not load the list' +
            (res.d && res.d.message ? ': ' + esc(res.d.message) : '') + '.</div>';
          return;
        }
        render(res.d, host);
      })
      .catch(function () { body.innerHTML = '<div class="wfs-hint">Could not load the list. Check your connection.</div>'; });
  }

  function mount() {
    if (mounted || panel()) { mounted = true; return true; }
    var anchor = document.getElementById('wfControlBody');
    if (!anchor) return false;
    style();
    var host = document.createElement('div');
    host.id = MOUNT_ID;
    host.innerHTML =
      '<div class="wfs-head">' +
        '<h6 class="wfs-title">Ready to share <span class="wfs-count"></span></h6>' +
        '<button class="wfs-btn" type="button" data-refresh="1">Refresh</button>' +
      '</div>' +
      '<div class="wfs-hint">Pages the writer finished, caption included. LinkedIn: copy and paste. X: post from here.</div>' +
      '<div class="wfs-body"></div>';
    anchor.parentNode.insertBefore(host, anchor);
    host.querySelector('[data-refresh]').addEventListener('click', function () { load(true); });
    mounted = true;
    load(false);
    return true;
  }

  function boot() {
    if (mount()) return;
    // Writer's Flow may render after this script runs, so watch for its anchor instead
    // of guessing a load order. The observer disconnects on first mount so a re-render
    // cannot stack duplicate panels.
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (mount() || tries > 40) clearInterval(timer);
    }, 500);
    var obs = new MutationObserver(function () { if (mount()) obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Switching back to Writer's Flow should show fresh rows, not a stale list.
  document.addEventListener('click', function (e) {
    var sec = e.target && e.target.closest && e.target.closest('[data-sec="writers-flow"]');
    if (sec) setTimeout(function () { load(true); }, 400);
  });

})();
