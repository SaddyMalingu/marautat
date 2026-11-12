/**
 * Ready-to-share page (2026-11-12).
 *
 * Reads GET /tenant/blogger/share-queue and renders each page with its caption
 * already composed: copy for LinkedIn (assisted), copy or post for X (automated).
 * Deliberately its own file so the tenant dashboard (5,900 lines) is untouched and
 * this cannot break the portal it links from.
 */
(function () {
  var list = document.getElementById('list');
  var count = document.getElementById('count');
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fail(msg) {
    list.innerHTML = '<div class="card"><b>We could not load your pages</b><p class="lede">' + esc(msg) + '</p>' +
      '<p class="note">Open this page from your portal, because it needs your signed-in session — <a class="link" href="/tenant-dashboard">go to the portal</a>.</p></div>';
  }
  function copy(text, btn) {
    var old = btn.textContent;
    function done(ok) {
      btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  }
  function postToX(slug, btn, msgEl) {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    fetch('/tenant/blogger/posts/' + encodeURIComponent(slug) + '/publish/x', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Post to X';
        if (!res.ok || !res.d.ok) {
          var code = String((res.d && res.d.error) || '');
          msgEl.className = 'msg err';
          msgEl.textContent = /not_configured/i.test(code)
            ? 'X is not connected for this workspace yet — copy the caption instead.'
            : ((res.d && (res.d.message || res.d.error)) || 'That did not send.');
          return;
        }
        var url = res.d.tweet && res.d.tweet.url;
        msgEl.className = 'msg ok';
        msgEl.innerHTML = url ? 'Posted. <a class="link" href="' + esc(url) + '" target="_blank" rel="noopener">Open it on X</a>' : 'Posted.';
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Post to X';
        msgEl.className = 'msg err'; msgEl.textContent = 'The request did not send. Check your connection.';
      });
  }
  function card(item, i) {
    var id = 'm' + i;
    var x = item.x || {};
    var li = item.linkedin || {};
    var body = item.ready
      ? '<div class="cap"><b>LinkedIn</b>' + esc(li.text || '') + '</div>' +
        '<div class="cap"><b>X · ' + esc(x.weighted || 0) + '/280</b>' + esc(x.text || '') + '</div>' +
        '<div class="row">' +
          '<button class="ghost" data-copy="' + esc(li.text || '') + '" type="button">Copy for LinkedIn</button>' +
          '<button class="ghost" data-copy="' + esc(x.text || '') + '" type="button">Copy for X</button>' +
          '<button class="primary" data-x="' + esc(item.slug) + '" type="button">Post to X</button>' +
          '<a class="btn ghost" href="' + esc(item.url) + '" target="_blank" rel="noopener">Open the page</a>' +
        '</div><div class="msg" id="' + id + '"></div>'
      : '<div class="cap">No share card for this page yet, so there is no caption to copy. Open it and share the link by hand.</div>' +
        '<div class="row"><a class="btn ghost" href="' + esc(item.url) + '" target="_blank" rel="noopener">Open the page</a></div>';
    return '<div class="card"><span class="tag">' + esc(item.angle || 'page') + '</span>' +
      '<h2>' + esc(item.title || item.slug) + '</h2>' +
      '<div class="meta">' + esc(String(item.created_at || '').slice(0, 10)) + ' · /blog/' + esc(item.slug) + '</div>' +
      body + '</div>';
  }

  fetch('/tenant/blogger/share-queue?days=14&limit=8')
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok || !res.d.ok) { fail((res.d && res.d.message) || 'Your session may have expired.'); return; }
      var items = res.d.items || [];
      if (res.d.ready) count.textContent = res.d.ready + ' ready to share';
      if (!items.length) {
        list.innerHTML = '<div class="card empty">No new pages in the last ' + esc(res.d.days) + ' days. When the writer finishes a batch they appear here.</div>';
        return;
      }
      list.innerHTML = items.map(card).join('');
      Array.prototype.forEach.call(list.querySelectorAll('button[data-copy]'), function (b) {
        b.addEventListener('click', function () { copy(b.getAttribute('data-copy'), b); });
      });
      Array.prototype.forEach.call(list.querySelectorAll('button[data-x]'), function (b) {
        b.addEventListener('click', function () {
          var msgEl = b.parentNode.parentNode.querySelector('.msg');
          postToX(b.getAttribute('data-x'), b, msgEl);
        });
      });
    })
    .catch(function () { fail('The request did not send. Check your connection.'); });
})();
