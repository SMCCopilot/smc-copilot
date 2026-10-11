/**
 * The HTML developer client (B05 week 11). One page that walks the whole flow with AI off: wallet sign-in, gates,
 * session, live analysis over the socket, the execution gate, the trade log and the journal. It is a test harness for the
 * owner, served only when DEV_CLIENT_ENABLED=true. It never shows candles or exchange prices; plan levels come from
 * the analysis the engine produced. The source avoids backticks and dollar-brace so it can live in a raw string.
 */
export const DEV_CLIENT_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMC Copilot dev client</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#14181f; --muted:#5b6472; --line:#d5dae1; --card:#f5f7fa; --ok:#0a7d4b; --bad:#b3261e; --accent:#2457d6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --fg:#e8ecf2; --muted:#9aa4b2; --line:#2a3140; --card:#171c26; --ok:#4cc38a; --bad:#ff8a80; --accent:#7aa2ff; } }
  body { margin:0; font:14px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:1000px; margin:0 auto; padding:16px; }
  h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:14px; margin:0 0 8px; }
  .muted { color:var(--muted); }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; margin:12px 0; }
  button { font:inherit; padding:6px 12px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  button:disabled { opacity:.5; cursor:default; }
  input, select { font:inherit; padding:6px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:6px 0; }
  pre { margin:0; max-height:260px; overflow:auto; font:12px/1.4 ui-monospace,monospace; white-space:pre-wrap; word-break:break-word; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  table { border-collapse:collapse; width:100%; } td, th { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); }
</style>
</head>
<body>
<main>
  <h1>SMC Copilot - dev client</h1>
  <div class="muted">Analysis only. No orders are ever placed; the gate records a human decision.</div>

  <section id="auth"><h2>1. Sign in with a wallet</h2>
    <div class="row">
      <button id="eth" class="primary">Ethereum wallet</button>
      <button id="sol">Solana wallet</button>
      <button id="out" disabled>Sign out</button>
      <span id="who" class="muted">signed out</span>
    </div>
  </section>

  <section id="gates"><h2>2. Access gates</h2>
    <div id="gatestate" class="muted">sign in first</div>
    <div class="row">
      <input id="invite" placeholder="invite code">
      <button id="redeem">Redeem invite</button>
      <button id="disc">Accept disclaimer</button>
      <button id="age">I am 18 or older</button>
    </div>
  </section>

  <section><h2>3. Session</h2>
    <div class="row">
      <select id="inst"></select>
      <select id="tf"><option>15m</option><option>1h</option><option>5m</option><option>4h</option></select>
      <button id="start" class="primary">Start session</button>
      <button id="stop" disabled>End session</button>
      <span id="sock" class="muted">not connected</span>
    </div>
  </section>

  <section><h2>4. Live analysis</h2>
    <div id="dq" class="muted">-</div>
    <div id="bias"></div>
    <table id="setups"><thead><tr><th>Setup</th><th>State</th><th>Grade</th><th>Plan</th><th></th></tr></thead><tbody></tbody></table>
  </section>

  <section><h2>5. Execution gate and trade log</h2>
    <div id="gate" class="muted">pick a setup with a plan, then Review</div>
    <div class="row">
      <button id="confirm" disabled>Confirm (tap)</button>
      <button id="decline" disabled>Decline</button>
      <span id="count" class="muted"></span>
    </div>
    <div class="row">
      <input id="entry" size="10" placeholder="entry price">
      <input id="size" size="8" placeholder="size">
      <button id="log" disabled>Log my trade</button>
    </div>
    <table id="trades"><thead><tr><th>Trade</th><th>Status</th><th>R</th><th></th></tr></thead><tbody></tbody></table>
  </section>

  <section><h2>6. Journal and notifications</h2>
    <div class="row"><input id="note" size="40" placeholder="note"><button id="addnote">Add note</button><button id="refresh">Refresh</button></div>
    <div id="summary" class="muted"></div>
    <pre id="journal"></pre>
  </section>

  <section><h2>7. Explanation of the analysis</h2>
    <div id="narr-src" class="muted">-</div>
    <div id="narr"></div>
  </section>

  <section><h2>8. Chat</h2>
    <div class="muted">Ask about the chart or about Smart Money Concepts. It will not tell you to trade.</div>
    <pre id="chatlog"></pre>
    <div class="row"><input id="chatin" size="50" placeholder="ask a question"><button id="chatsend">Send</button><span id="budget" class="muted"></span></div>
  </section>

  <section><h2>9. Explain a chart image</h2>
    <div class="muted">The picture is read once and not kept. Only your market and a short written answer are stored.</div>
    <div class="row"><input type="file" id="img" accept="image/png,image/jpeg,image/webp"><select id="exsrc"><option value="UPLOAD">Upload (old screenshot allowed)</option><option value="SHARE">Live capture</option></select><button id="explain">Explain</button></div>
    <div id="exstage" class="muted"></div>
    <pre id="exout"></pre>
  </section>

  <section><h2>10. AI providers (admin only)</h2>
    <div class="muted">Turn each provider on or off. Needs your account to have the admin role. Changes apply within seconds.</div>
    <div class="row"><button id="aiload">Load</button><button id="aispend">Show spend</button></div>
    <table id="aiprov"><thead><tr><th>Provider</th><th>On</th><th>Key</th><th>Order</th><th>Data it may see</th><th></th></tr></thead><tbody></tbody></table>
    <pre id="aispendout"></pre>
  </section>

  <section><h2>Event log</h2><pre id="log2"></pre></section>
</main>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/socket.io-client@4.8.4/dist/socket.io.min.js"></script>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var sb = null, token = null, session = null, socket = null, activeGate = null, countdown = null, lastSeq = 0, setups = {};
  function log(t, o) {
    var el = $('log2');
    el.textContent = new Date().toISOString().slice(11, 19) + ' ' + t + (o ? ' ' + JSON.stringify(o).slice(0, 300) : '') + '\n' + el.textContent.slice(0, 6000);
  }
  function api(method, path, body, extra) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    if (method === 'POST' && path.indexOf('/v1/sessions') === 0 || path === '/v1/trades' && method === 'POST') h['Idempotency-Key'] = crypto.randomUUID();
    if (extra) for (var k in extra) h[k] = extra[k];
    return fetch(path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (j) { if (!r.ok) { log('HTTP ' + r.status + ' ' + path, j); throw j; } return j; });
    });
  }
  function setAuthed(on) { $('out').disabled = !on; $('eth').disabled = on; $('sol').disabled = on; }

  fetch('/dev/config').then(function (r) { return r.json(); }).then(function (cfg) {
    sb = supabase.createClient(cfg.supabaseUrl, cfg.anonKey);
    sb.auth.onAuthStateChange(function (_e, s) {
      token = s ? s.access_token : null;
      setAuthed(!!token);
      $('who').textContent = token ? 'signed in' : 'signed out';
      if (token) { refreshMe(); loadInstruments(); loadTrades(); }
    });
    sb.auth.getSession().then(function (r) { if (r.data.session) { token = r.data.session.access_token; setAuthed(true); refreshMe(); loadInstruments(); loadTrades(); } });
  });

  function web3(chain) {
    var statement = 'Sign in to SMC Copilot';
    sb.auth.signInWithWeb3({ chain: chain, statement: statement }).then(function (r) { if (r.error) { log('sign-in error', { message: r.error.message }); } });
  }
  $('eth').onclick = function () { web3('ethereum'); };
  $('sol').onclick = function () { web3('solana'); };
  $('out').onclick = function () { sb.auth.signOut(); if (socket) socket.disconnect(); };

  function refreshMe() {
    return api('GET', '/v1/me').then(function (me) {
      var w = me.wallets.map(function (x) { return x.address.slice(0, 8) + '...'; }).join(', ');
      $('who').textContent = 'wallet ' + (w || 'none') + ' / plan ' + me.workspace.plan;
      $('gatestate').innerHTML = 'invite: <b class="' + (me.invite.redeemed ? 'ok' : 'bad') + '">' + (me.invite.redeemed ? 'ok' : 'needed') + '</b> | disclaimer: <b class="' +
        (me.disclaimer.acceptedVersion === me.disclaimer.currentVersion ? 'ok' : 'bad') + '">' + (me.disclaimer.acceptedVersion === me.disclaimer.currentVersion ? 'ok' : 'needed (' + me.disclaimer.currentVersion + ')') +
        '</b> | 18+: <b class="' + (me.ageConfirmed ? 'ok' : 'bad') + '">' + (me.ageConfirmed ? 'ok' : 'needed') + '</b>';
      window.__disc = me.disclaimer.currentVersion;
    });
  }
  $('redeem').onclick = function () { api('POST', '/v1/me/invite', { code: $('invite').value.trim() }).then(refreshMe); };
  $('disc').onclick = function () { api('POST', '/v1/me/disclaimer', { version: window.__disc }).then(refreshMe); };
  $('age').onclick = function () { api('POST', '/v1/me/age-confirmation', { confirmed: true }).then(refreshMe); };

  function loadInstruments() {
    return api('GET', '/v1/instruments').then(function (r) {
      $('inst').innerHTML = r.items.map(function (i) { return '<option value="' + esc(i.id) + '" data-c="' + esc(i.canonical) + '">' + esc(i.display) + '</option>'; }).join('');
    }).catch(function () {});
  }

  $('start').onclick = function () {
    var opt = $('inst').selectedOptions[0];
    api('POST', '/v1/sessions', { instrumentId: opt.value, tf: $('tf').value, mode: 'FEED' }).then(function (s) {
      session = s; $('stop').disabled = false; $('start').disabled = true;
      connect(s.sessionId, s.wsToken, opt.getAttribute('data-c'));
    });
  };
  $('stop').onclick = function () { if (session) api('POST', '/v1/sessions/' + session.sessionId + '/end').then(function () { if (socket) socket.disconnect(); $('stop').disabled = true; $('start').disabled = false; $('sock').textContent = 'ended'; }); };

  function connect(sessionId, wsToken, canonical) {
    socket = io({ path: '/ws', auth: { wsToken: wsToken }, transports: ['websocket'] });
    socket.on('connect', function () { $('sock').textContent = 'connected'; socket.emit('session.start', { sessionId: sessionId, lastSeq: lastSeq || undefined }); });
    socket.on('connect_error', function (e) { $('sock').textContent = 'refused: ' + e.message; log('connect_error', { m: e.message }); });
    socket.on('disconnect', function () { $('sock').textContent = 'disconnected'; });
    ['session.state', 'analysis.update', 'setup.event', 'feed.status', 'warning', 'error', 'gate.state', 'position.event', 'notification', 'context.updated', 'narrative.done', 'chat.chunk', 'chat.done', 'budget.update', 'voice.final'].forEach(function (t) {
      socket.on(t, function (env) {
        if (t === 'narrative.done') { renderNarr(env.payload); return; }
        if (t === 'chat.chunk') { chatChunk(env.payload); return; }
        if (t === 'chat.done') { chatDone(env.payload); return; }
        if (t === 'budget.update') { $('budget').textContent = 'AI today: $' + env.payload.spentUsd.toFixed(3) + ' of $' + env.payload.limitUsd.toFixed(2); return; }
        if (env && typeof env.seq === 'number') lastSeq = Math.max(lastSeq, env.seq);
        if (t === 'analysis.update') renderAnalysis(env.payload); else log(t, env && env.payload);
        if (t === 'setup.event') { setups[env.payload.setup.id] = env.payload.setup; renderSetups(); }
        if (t === 'notification' || t === 'position.event') { loadTrades(); loadJournal(); }
      });
    });
  }

  function renderAnalysis(a) {
    $('dq').innerHTML = 'as of ' + a.asOf + ' | data <b class="' + (a.dataQuality === 'OK' ? 'ok' : 'bad') + '">' + a.dataQuality + '</b>' + (a.warnings.length ? ' | ' + a.warnings.join(', ') : '');
    $('bias').textContent = 'HTF bias (' + a.htfBias.tf + '): ' + a.htfBias.trend + (a.htfBias.lastBreak ? ' - last ' + a.htfBias.lastBreak.type : '');
    if (a.setups) a.setups.forEach(function (s) { setups[s.id] = s; });
    renderSetups();
  }
  function renderSetups() {
    var rows = Object.keys(setups).map(function (id) { return setups[id]; }).filter(function (s) { return s.state === 'ARMED' || s.state === 'TRIGGERED'; });
    $('setups').tBodies[0].innerHTML = rows.map(function (s) {
      var p = s.plan;
      var plan = p ? (p.direction + ' entry ' + p.entry.bottom + '-' + p.entry.top + ' stop ' + p.stop.price + ' tp ' + p.targets.map(function (t) { return t.price; }).join('/')) : '-';
      var hist = s.historical ? Math.round(s.historical.rate * 100) + '% (n=' + s.historical.n + ')' : 'not enough history';
      return '<tr><td>' + s.template + ' ' + s.direction + '</td><td>' + s.state + '</td><td>' + (s.grade || '-') + '</td><td>' + plan + '<br><span class="muted">' + hist + '</span></td><td>' +
        (p ? '<button data-plan="' + p.planId + '" data-entry="' + p.entry.refPrice + '">Review</button>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">no active setups</td></tr>';
    Array.prototype.forEach.call(document.querySelectorAll('button[data-plan]'), function (b) {
      b.onclick = function () { review(b.getAttribute('data-plan'), b.getAttribute('data-entry')); };
    });
  }

  function review(planId, entry) {
    api('POST', '/v1/gate/issue', { planId: planId }).then(function (g) {
      activeGate = g; activeGate.entry = entry; $('entry').value = entry;
      $('gate').innerHTML = 'Gate open for plan <code>' + g.planHash.slice(0, 10) + '</code> - confirm within 60 s, or decline.';
      $('confirm').disabled = false; $('decline').disabled = false;
      var left = 60; clearInterval(countdown);
      countdown = setInterval(function () { left--; $('count').textContent = left + ' s'; if (left <= 0) { clearInterval(countdown); $('confirm').disabled = true; $('count').textContent = 'expired'; } }, 1000);
    });
  }
  $('confirm').onclick = function () {
    // A real tap. The server refuses anything that says it came from voice.
    api('POST', '/v1/gate/' + activeGate.gateId + '/confirm', { token: activeGate.token, planHash: activeGate.planHash }, { 'X-Input-Mode': 'tap' }).then(function (g) {
      clearInterval(countdown); $('confirm').disabled = true; $('decline').disabled = true; $('log').disabled = false;
      $('gate').innerHTML = '<b class="ok">Confirmed.</b> Place the trade yourself, then log it here within 60 s.';
      activeGate.state = g.state;
    }).catch(function () {});
  };
  $('decline').onclick = function () { api('POST', '/v1/gate/' + activeGate.gateId + '/decline', {}).then(function () { clearInterval(countdown); $('gate').textContent = 'declined'; $('confirm').disabled = true; $('decline').disabled = true; }); };

  $('log').onclick = function () {
    var plan = null; Object.keys(setups).forEach(function (id) { if (setups[id].plan && setups[id].plan.planId === activeGate.planId) plan = setups[id]; });
    if (!plan) return;
    var p = plan.plan;
    var body = { instrumentId: $('inst').value, direction: p.direction, entryPrice: Number($('entry').value), stopPrice: p.stop.price, targets: p.targets.map(function (t) { return t.price; }), planId: p.planId, gateId: activeGate.gateId };
    if ($('size').value) body.size = Number($('size').value);
    api('POST', '/v1/trades', body).then(function () { $('log').disabled = true; $('gate').textContent = 'trade logged'; loadTrades(); loadJournal(); });
  };

  function loadTrades() {
    return api('GET', '/v1/trades?limit=20').then(function (r) {
      $('trades').tBodies[0].innerHTML = r.items.map(function (t) {
        return '<tr><td>' + t.direction + ' @ ' + t.entryPrice + '</td><td>' + t.status + '</td><td>' + (t.realizedR === null ? '-' : t.realizedR) + '</td><td>' +
          (t.status === 'OPEN' ? '<button data-close="' + t.id + '">Close</button>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="muted">no trades</td></tr>';
      Array.prototype.forEach.call(document.querySelectorAll('button[data-close]'), function (b) {
        b.onclick = function () {
          var px = prompt('Exit price you got?'); if (!px) return;
          api('POST', '/v1/trades/' + b.getAttribute('data-close') + '/close', { exitPrice: Number(px), reason: 'MANUAL' }).then(function () { loadTrades(); loadJournal(); });
        };
      });
    }).catch(function () {});
  }

  function loadJournal() {
    api('GET', '/v1/journal/summary').then(function (s) {
      $('summary').textContent = 'closed ' + s.closedTrades + ', open ' + s.openTrades + ', setups shown ' + s.setupsShown + ', total R ' + (s.totalR === null ? '-' : s.totalR) + ', win rate ' + (s.winRate === null ? 'needs 30 trades' : Math.round(s.winRate * 100) + '%');
    }).catch(function () {});
    api('GET', '/v1/journal?limit=15').then(function (r) {
      $('journal').textContent = r.items.map(function (e) { return e.createdAt.slice(11, 19) + ' ' + e.kind + (e.notes ? ' - ' + e.notes : ''); }).join('\n');
    }).catch(function () {});
  }
  $('addnote').onclick = function () { api('POST', '/v1/journal/notes', { notes: $('note').value, tags: [] }).then(function () { $('note').value = ''; loadJournal(); }); };
  $('refresh').onclick = function () { loadJournal(); loadTrades(); };
  setInterval(function () { if (token) loadJournal(); }, 30000);

  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function renderNarr(n) {
    $('narr-src').innerHTML = (n.aiGenerated ? '<b>AI-written</b>' : 'Template text') + (n.generating ? ' - a fuller explanation is being written' : '') + ' | as of ' + n.asOf;
    var c = n.content;
    $('narr').innerHTML = '<p><b>' + esc(c.headline) + '</b></p><p>' + esc(c.bias_summary) + '</p>' +
      c.scenarios.map(function (s) { return '<p><i>' + esc(s.kind.toLowerCase()) + ':</i> ' + esc(s.if_then) + '</p>'; }).join('') +
      (c.risks_and_unknowns.length ? '<p class="muted">' + esc(c.risks_and_unknowns.join(' ')) + '</p>' : '') +
      c.history.map(function (h) { return '<p class="muted">' + esc(h.text) + '</p>'; }).join('');
  }

  var chatBuf = '';
  function chatChunk(e) { chatBuf += e.delta; $('chatlog').textContent = $('chatlog').dataset.base + 'Assistant: ' + chatBuf; }
  function chatDone(e) { $('chatlog').dataset.base += 'Assistant: ' + e.text + (e.aiGenerated ? '  [AI]' : '') + '\n\n'; chatBuf = ''; $('chatlog').textContent = $('chatlog').dataset.base; }
  $('chatlog').dataset.base = '';
  $('chatsend').onclick = function () {
    var t = $('chatin').value.trim();
    if (!t || !socket) return;
    $('chatlog').dataset.base += 'You: ' + t + '\n';
    $('chatlog').textContent = $('chatlog').dataset.base;
    socket.emit('chat.send', { clientMsgId: crypto.randomUUID(), text: t, inputMode: 'text' });
    $('chatin').value = '';
  };
  $('chatin').onkeydown = function (e) { if (e.key === 'Enter') $('chatsend').click(); };

  $('explain').onclick = function () {
    var file = $('img').files[0];
    if (!file) { $('exstage').textContent = 'choose an image first'; return; }
    var fd = new FormData();
    fd.append('image', file);
    fd.append('source', $('exsrc').value);
    if (session) fd.append('sessionId', session.sessionId);
    $('exout').textContent = '';
    $('exstage').textContent = 'sending...';
    fetch('/v1/explain', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { $('exstage').textContent = 'refused: ' + (j.code || r.status) + ' ' + (j.detail || ''); });
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) return;
          buf += dec.decode(x.value, { stream: true });
          var parts = buf.split('\n\n'); buf = parts.pop();
          parts.forEach(function (p) {
            var ev = /^event: (.+)$/m.exec(p), dt = /^data: (.+)$/m.exec(p);
            if (!ev || !dt) return;
            var d = JSON.parse(dt[1]);
            if (ev[1] === 'explain.stage') $('exstage').textContent = d.stage + '...';
            else if (ev[1] === 'explain.chunk') $('exout').textContent += d.delta;
            else if (ev[1] === 'explain.done') $('exstage').textContent = d.mode + (d.aiGenerated ? ' (AI-written)' : ' (template)') + (d.warnings.length ? ' - ' + d.warnings.join(', ') : '');
          });
          return pump();
        });
      }
      return pump();
    });
  };

  function adminApi(method, path, body) {
    return api(method, path, body, { 'X-Admin-Confirm': 'yes' });
  }
  function loadProviders() {
    return adminApi('GET', '/v1/admin/ai/providers').then(function (r) {
      $('aiprov').tBodies[0].innerHTML = r.items.map(function (p) {
        return '<tr><td>' + p.id + '</td><td><b class="' + (p.enabled ? 'ok' : 'bad') + '">' + (p.enabled ? 'ON' : 'off') + '</b> <span class="muted">(' + p.enabledSource + ')</span></td><td>' +
          (p.keyPresent ? 'set' : '<span class="bad">missing</span>') + '</td><td><input size="2" value="' + p.priority + '" data-prio="' + p.id + '"></td><td>' +
          ['D0', 'D1', 'D2'].map(function (c) { return '<label><input type="checkbox" data-cls="' + p.id + '" value="' + c + '"' + (p.dataClasses.indexOf(c) >= 0 ? ' checked' : '') + '>' + c + '</label>'; }).join(' ') +
          '</td><td><button data-tog="' + p.id + '" data-on="' + (p.enabled ? '1' : '0') + '">' + (p.enabled ? 'Turn off' : 'Turn on') + '</button> <button data-save="' + p.id + '">Save order and data</button></td></tr>';
      }).join('');
      Array.prototype.forEach.call(document.querySelectorAll('button[data-tog]'), function (b) {
        b.onclick = function () { adminApi('PUT', '/v1/admin/ai/providers/' + b.getAttribute('data-tog'), { enabled: b.getAttribute('data-on') !== '1' }).then(loadProviders); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('button[data-save]'), function (b) {
        var id = b.getAttribute('data-save');
        b.onclick = function () {
          var cls = Array.prototype.map.call(document.querySelectorAll('input[data-cls="' + id + '"]:checked'), function (x) { return x.value; });
          var prio = Number(document.querySelector('input[data-prio="' + id + '"]').value);
          adminApi('PUT', '/v1/admin/ai/providers/' + id, { priority: prio, dataClasses: cls }).then(loadProviders);
        };
      });
    });
  }
  $('aiload').onclick = loadProviders;
  $('aispend').onclick = function () { adminApi('GET', '/v1/admin/ai/spend').then(function (r) { $('aispendout').textContent = JSON.stringify(r, null, 2); }); };
})();
</script>
</body>
</html>
`;
