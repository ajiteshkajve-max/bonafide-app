(function () {
  'use strict';
  const app = document.getElementById('app');
  let me = null;
  let timers = [];
  let geoWatch = null;

  /* ---------- helpers ---------- */
  const ICONS = {
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M8.5 12l2.5 2.5L15.5 9.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
    back: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-3-7-7-1z"/></svg>',
    silhouette: '<svg viewBox="0 0 220 260" aria-hidden="true"><circle cx="110" cy="92" r="52" fill="#A9C0BA"/><path d="M10 260c4-62 46-98 100-98s96 36 100 98z" fill="#A9C0BA"/></svg>',
    warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8A5300" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>'
  };
  function icon(n) {
    const t = document.createElement('template');
    t.innerHTML = ICONS[n];
    return t.content.firstChild;
  }
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  async function api(path, method, body) {
    const opts = { method: method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const r = await fetch('/api' + path, opts);
    let data = {};
    try { data = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) {
      const err = new Error(data.error || 'Something went wrong');
      err.status = r.status;
      throw err;
    }
    return data;
  }
  function toast(msg) {
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  }
  function clearTimers() {
    timers.forEach(clearInterval);
    timers = [];
    if (geoWatch != null && navigator.geolocation) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  }
  function mount(node) { app.replaceChildren(node); window.scrollTo(0, 0); }
  function fmtTime(sec) {
    return new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function brand() { return h('div', { class: 'brand' }, icon('shield'), 'Bonafide'); }
  function field(label, input) {
    const id = 'f' + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), input);
  }
  function personPhoto(u) {
    const box = h('div', { class: 'photo' });
    if (u.photo) box.append(h('img', { src: u.photo, alt: 'Photo of ' + u.name }));
    else box.append(icon('silhouette'));
    if (u.verified) box.append(h('span', { class: 'pill ok' }, icon('check'), 'Verified: face and ID'));
    return box;
  }
  function avatar(u) {
    const a = h('div', { class: 'avatar' });
    if (u.photo) a.append(h('img', { src: u.photo, alt: '' }));
    else a.append((u.name || '?').charAt(0).toUpperCase());
    return a;
  }

  /* ---------- navigation ---------- */
  let unread = 0;
  function navbar(active) {
    const items = [
      ['discover', 'Discover', 'compass'],
      ['chats', 'Chats', 'chat'],
      ['safedate', 'Safe Date', 'shield'],
      ['profile', 'Profile', 'user']
    ];
    return h('nav', { class: 'nav', 'aria-label': 'Main' }, items.map(([key, label, ic]) => {
      const b = h('button', { type: 'button', class: key === active ? 'on' : '', 'aria-current': key === active ? 'page' : null, onclick: () => go(key) }, icon(ic), label);
      if (key === 'chats' && unread > 0) b.append(h('span', { class: 'badge' }, unread));
      return b;
    }));
  }
  function go(view, arg) {
    clearTimers();
    const views = { auth, verify, discover, chats, chat, safedate, profile };
    views[view](arg);
  }

  /* ---------- auth ---------- */
  function auth() {
    let mode = 'signup';
    const body = h('div', { class: 'col' });
    const screen = h('div', { class: 'screen no-nav' }, brand(),
      h('div', { class: 'col' },
        h('h1', {}, 'Real people. Verified. Serious intent.'),
        h('p', { class: 'muted' }, 'Every member is face-checked and ID-verified before they can say hello.')),
      body);
    function render() {
      const err = h('div', { class: 'err', role: 'alert' });
      const tabs = h('div', { class: 'tabs', role: 'tablist' },
        h('button', { type: 'button', class: mode === 'signup' ? 'on' : '', onclick: () => { mode = 'signup'; render(); } }, 'Create account'),
        h('button', { type: 'button', class: mode === 'login' ? 'on' : '', onclick: () => { mode = 'login'; render(); } }, 'Log in'));
      const email = h('input', { type: 'email', autocomplete: 'email', required: true });
      const pw = h('input', { type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true, minlength: 8 });
      const form = h('form', { class: 'col', novalidate: true });
      let name, gender, dob, city, agree;
      if (mode === 'signup') {
        name = h('input', { type: 'text', autocomplete: 'given-name', maxlength: 40 });
        gender = h('select', {}, h('option', { value: '' }, 'Choose'), h('option', { value: 'woman' }, 'Woman'), h('option', { value: 'man' }, 'Man'));
        dob = h('input', { type: 'date', max: new Date().toISOString().slice(0, 10) });
        city = h('input', { type: 'text', maxlength: 60, autocomplete: 'address-level2' });
        agree = h('input', { type: 'checkbox', id: 'agree' });
        form.append(field('First name', name), field('I am a', gender), field('Date of birth', dob), field('City', city));
      }
      form.append(field('Email', email), field('Password (8+ characters)', pw));
      if (mode === 'signup') {
        form.append(h('div', { class: 'row' }, agree, h('label', { for: 'agree', class: 'muted' }, 'I am 18 or older and agree to respect other members.')));
      }
      const btn = h('button', { class: 'btn', type: 'submit' }, mode === 'signup' ? 'Create account' : 'Log in');
      form.append(err, btn);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        if (mode === 'signup' && !agree.checked) { err.textContent = 'Please confirm you are 18 or older.'; return; }
        btn.disabled = true;
        try {
          if (mode === 'signup') {
            await api('/signup', 'POST', { name: name.value, email: email.value, password: pw.value, gender: gender.value, dob: dob.value, city: city.value });
          } else {
            await api('/login', 'POST', { email: email.value, password: pw.value });
          }
          await boot();
        } catch (e) { err.textContent = e.message; btn.disabled = false; }
      });
      body.replaceChildren(tabs, form, h('p', { class: 'small' }, 'Your ID is checked once and never shown on your profile.'));
    }
    render();
    mount(screen);
  }

  /* ---------- verification ---------- */
  function verify() {
    const note = me.verify_mode === 'demo'
      ? h('div', { class: 'banner warn' }, icon('warn'), 'Demo mode: verification steps are auto-approved for testing. Connect a real KYC provider before launching.')
      : null;
    const msg = h('div', { class: 'err', role: 'alert' });
    const camBox = h('div', { class: 'col' });
    let stream = null;
    const stopCam = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };

    async function doStep(step) {
      msg.textContent = '';
      try {
        await api('/verify', 'POST', { step });
        stopCam();
        me = await api('/me');
        if (me.verified) { toast('You are verified'); go('discover'); } else verify();
      } catch (e) { msg.textContent = e.message; }
    }
    function startCam() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = 'Camera not available on this device.'; return; }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }).then((s) => {
        stream = s;
        const v = h('video', { autoplay: true, playsinline: true, muted: true });
        v.srcObject = s;
        camBox.replaceChildren(v,
          h('p', { class: 'muted' }, 'Look straight at the camera in good light, then tap below. The video is not stored in this version.'),
          h('button', { class: 'btn', type: 'button', onclick: () => doStep('selfie') }, 'Capture and verify'));
      }).catch(() => { msg.textContent = 'Camera permission was denied. Allow camera access and try again.'; });
    }
    function step(title, desc, done, action) {
      return h('div', { class: 'step' + (done ? ' done' : '') },
        h('div', { class: 'dot' }, done ? h('span', { style: 'color:#fff' }, icon('check')) : icon('user')),
        h('div', { class: 'col', style: 'gap:2px;flex:1' }, h('strong', {}, title), h('span', { class: 'muted' }, desc)),
        action);
    }
    const screen = h('div', { class: 'screen' }, brand(),
      h('h2', {}, 'Confirm it is really you'),
      h('p', { class: 'muted' }, 'Verification keeps Bonafide safe for everyone. Until both steps are done, you cannot browse or chat.'),
      note,
      h('div', { class: 'col steps' },
        step('Selfie check', me.selfie_ok ? 'Done' : 'A short live selfie to match your face.', me.selfie_ok,
          me.selfie_ok ? null : h('button', { class: 'btn', type: 'button', onclick: startCam }, 'Start')),
        step('Government ID', me.id_ok ? 'Done' : 'Verify with DigiLocker.', me.id_ok,
          me.id_ok ? null : h('button', { class: 'btn', type: 'button', onclick: () => doStep('id') }, 'Verify'))),
      camBox, msg, navbar('discover'));
    mount(screen);
  }

  /* ---------- discover ---------- */
  async function discover() {
    if (!me.verified) { return verify(); }
    const screen = h('div', { class: 'screen' }, brand(), h('p', { class: 'muted' }, 'Loading people...'), navbar('discover'));
    mount(screen);
    let data;
    try { data = await api('/discover'); } catch (e) { return toastErr(e); }
    let i = 0;
    const holder = h('div', { class: 'col' });
    const banner = me.gender === 'woman'
      ? 'You message first. Only you decide who can reply.'
      : 'Women message first on Bonafide. When someone says hello, the chat appears in Chats.';
    function show() {
      const u = data.people[i];
      if (!u) {
        holder.replaceChildren(h('div', { class: 'card col' }, h('strong', {}, 'No more profiles for now'),
          h('p', { class: 'muted' }, 'Check back soon. Only verified, well-reviewed members are shown.'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { i = 0; go('discover'); } }, 'Refresh')));
        return;
      }
      const msgBox = h('div', { class: 'col' });
      const actions = h('div', { class: 'row' },
        h('button', { class: 'btn ghost', type: 'button', style: 'flex:1', onclick: () => { i++; show(); } }, 'Pass'));
      if (data.can_start) {
        actions.append(h('button', { class: 'btn', type: 'button', style: 'flex:2', onclick: () => openHello(u, msgBox) }, 'Say hello'));
      } else {
        actions.append(h('button', { class: 'btn ghost', type: 'button', style: 'flex:2', onclick: () => { i++; show(); } }, 'Next'));
      }
      holder.replaceChildren(
        h('div', { class: 'person' }, personPhoto(u),
          h('div', { class: 'info' },
            h('div', { class: 'row', style: 'justify-content:space-between;align-items:baseline' },
              h('h2', {}, u.name + ', ' + u.age), h('span', { class: 'muted' }, u.city)),
            u.bio ? h('p', { class: 'muted' }, u.bio) : null,
            u.intent ? h('div', {}, h('span', { class: 'pill' }, u.intent)) : null,
            h('div', { class: 'row' }, h('span', { class: 'small', style: 'font-weight:600;white-space:nowrap' }, 'Trust score ' + u.trust),
              h('div', { class: 'bar' }, h('i', { style: 'width:' + u.trust + '%' }))))),
        actions, msgBox);
    }
    function openHello(u, box) {
      const ta = h('textarea', { maxlength: 500, rows: 3, 'aria-label': 'First message' });
      const err = h('div', { class: 'err', role: 'alert' });
      const send = h('button', { class: 'btn', type: 'button' }, 'Send hello');
      send.addEventListener('click', async () => {
        send.disabled = true;
        try {
          await api('/hello', 'POST', { to: u.id, body: ta.value });
          toast('Hello sent');
          i++; show();
        } catch (e) { err.textContent = e.message; send.disabled = false; }
      });
      box.replaceChildren(h('div', { class: 'card col' }, h('label', { class: 'small' }, 'Write something about their profile'), ta, err, send));
      ta.focus();
    }
    screen.replaceChildren(brand(), h('div', { class: 'banner' }, icon('chat'), banner), holder, navbar('discover'));
    show();
  }
  function toastErr(e) {
    if (e.status === 401) { me = null; return auth(); }
    toast(e.message);
  }

  /* ---------- chats ---------- */
  async function chats() {
    const list = h('div', { class: 'col' }, h('p', { class: 'muted' }, 'Loading...'));
    mount(h('div', { class: 'screen' }, brand(), h('h2', {}, 'Chats'), list, navbar('chats')));
    async function load() {
      try {
        const d = await api('/conversations');
        unread = d.conversations.reduce((n, c) => n + c.unread, 0);
        if (!d.conversations.length) {
          list.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' },
            me.gender === 'woman' ? 'No chats yet. Say hello to someone in Discover.' : 'No chats yet. When a woman says hello, the chat appears here.')));
          return;
        }
        list.replaceChildren(...d.conversations.map((c) => h('button', { class: 'conv', type: 'button', onclick: () => go('chat', c.user.id) },
          avatar(c.user),
          h('div', { class: 'col', style: 'gap:2px;flex:1;min-width:0' },
            h('strong', {}, c.user.name + ', ' + c.user.age),
            h('span', { class: 'muted', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, c.last)),
          c.unread ? h('span', { class: 'badge', style: 'position:static' }, c.unread) : null)));
      } catch (e) { toastErr(e); }
    }
    load();
    timers.push(setInterval(load, 8000));
  }

  async function chat(uid) {
    const msgsBox = h('div', { class: 'msgs' });
    const input = h('input', { type: 'text', maxlength: 1000, placeholder: 'Write a message', 'aria-label': 'Message', autocomplete: 'off' });
    const form = h('form', { class: 'composer' }, input, h('button', { type: 'submit', 'aria-label': 'Send' }, icon('send')));
    const head = h('div', { class: 'chat-head' });
    const wrap = h('div', { class: 'chatwrap' }, head, msgsBox, form);
    mount(wrap);
    let user = null, lastCount = -1;

    async function load() {
      let d;
      try { d = await api('/messages?with=' + encodeURIComponent(uid)); } catch (e) { clearTimers(); toast(e.message); return go('chats'); }
      if (!user) {
        user = d.user;
        head.replaceChildren(
          h('button', { class: 'back', type: 'button', 'aria-label': 'Back', onclick: () => go('chats') }, icon('back')),
          avatar(user),
          h('div', { class: 'col', style: 'gap:1px;flex:1' }, h('strong', {}, user.name),
            h('span', { class: 'small', style: 'color:var(--teal);font-weight:600' }, 'Verified, trust score ' + user.trust)),
          h('button', { class: 'btn ghost', type: 'button', style: 'min-height:40px;padding:0 12px;font-size:13px', onclick: () => go('safedate', user.name) }, 'Plan a date'),
          h('button', { class: 'btn ghost', type: 'button', style: 'min-height:40px;padding:0 12px;font-size:13px', onclick: reportUser }, 'Report'));
      }
      if (d.messages.length === lastCount) return;
      lastCount = d.messages.length;
      const nodes = [h('div', { class: 'pill', style: 'align-self:center' }, user.name + ' was face-checked and ID-verified')];
      for (const m of d.messages) {
        nodes.push(h('div', { class: 'msg ' + (m.mine ? 'me' : 'them') }, m.body));
        if (m.flagged && !m.mine) {
          nodes.push(h('div', { class: 'banner warn col', role: 'alert', style: 'gap:8px' },
            h('div', { class: 'row', style: 'gap:8px' }, icon('warn'), h('strong', {}, 'Money request detected')),
            h('span', {}, 'Requests for money are the most common scam on dating apps. Do not send money or share bank details with someone you have not met in person.'),
            h('button', { class: 'btn danger', type: 'button', style: 'min-height:44px', onclick: reportUser }, 'Report and block')));
        } else if (m.flagged && m.mine) {
          nodes.push(h('div', { class: 'small', style: 'align-self:flex-end' }, 'Money-related messages show a scam warning to the other person.'));
        }
      }
      msgsBox.replaceChildren(...nodes);
      msgsBox.scrollTop = msgsBox.scrollHeight;
    }
    async function reportUser() {
      if (!window.confirm('Report and block ' + user.name + '? This also hides the chat.')) return;
      try { await api('/report', 'POST', { user: user.id, reason: 'Reported from chat' }); toast('Reported and blocked'); go('chats'); }
      catch (e) { toast(e.message); }
    }
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try { await api('/messages', 'POST', { to: uid, body: text }); lastCount = -1; await load(); }
      catch (e) { toast(e.message); input.value = text; }
    });
    await load();
    timers.push(setInterval(load, 4000));
  }

  /* ---------- Safe Date ---------- */
  async function safedate(withName) {
    const box = h('div', { class: 'col' });
    mount(h('div', { class: 'screen' }, brand(), h('h2', {}, 'Safe Date mode'), box, navbar('safedate')));
    let sd;
    try { sd = (await api('/safedate')).safedate; } catch (e) { return toastErr(e); }
    if (!sd) return renderForm();
    renderActive(sd);

    function renderForm() {
      const err = h('div', { class: 'err', role: 'alert' });
      const who = h('input', { type: 'text', maxlength: 60, value: typeof withName === 'string' ? withName : '' });
      const venue = h('input', { type: 'text', maxlength: 120, placeholder: 'Public place, with address' });
      const when = h('input', { type: 'text', maxlength: 80, placeholder: 'Saturday, 7:30 pm' });
      const cname = h('input', { type: 'text', maxlength: 60 });
      const cphone = h('input', { type: 'tel', maxlength: 20, autocomplete: 'off' });
      const mins = h('select', {}, ...[[60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']].map(([v, l]) => h('option', { value: v }, l)));
      const btn = h('button', { class: 'btn', type: 'submit' }, 'Start Safe Date');
      const form = h('form', { class: 'col', novalidate: true },
        h('div', { class: 'banner' }, icon('shield'), 'For a first meeting, choose a public place and tell someone where you are going.'),
        field('Who are you meeting?', who), field('Venue', venue), field('When', when),
        field('Trusted contact name', cname), field('Trusted contact phone (optional)', cphone),
        field('Check in within', mins), err, btn);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault(); btn.disabled = true; err.textContent = '';
        try {
          const r = await api('/safedate', 'POST', { with_name: who.value, venue: venue.value, when_text: when.value, contact_name: cname.value, contact_phone: cphone.value, checkin_minutes: parseInt(mins.value, 10) });
          renderActive(r.safedate);
        } catch (e) { err.textContent = e.message; btn.disabled = false; }
      });
      box.replaceChildren(form);
    }

    function renderActive(s) {
      sd = s;
      const link = location.origin + s.link;
      const statusText = { active: 'Date in progress', overdue: 'Check-in time has passed. Tap "I am safe" or your contact will worry.', sos: 'SOS sent. Your contact can see your location.' }[s.status] || s.status;
      const sw = h('button', { type: 'button', role: 'switch', 'aria-checked': String(s.sharing), 'aria-label': 'Share live location', class: 'switch' + (s.sharing ? ' on' : ''),
        onclick: async () => { try { const r = await api('/safedate/sharing', 'POST', { on: !s.sharing }); renderActive(r.safedate); } catch (e) { toast(e.message); } } }, h('i'));
      const err = h('div', { class: 'err', role: 'alert' });
      const share = async () => {
        const text = 'I am going on a date. You are my trusted contact on Bonafide. Follow my Safe Date here: ' + link;
        if (navigator.share) { try { await navigator.share({ text }); } catch (e) { /* cancelled */ } }
        else window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
      };
      box.replaceChildren(
        h('div', { class: 'banner' + (s.status === 'active' ? '' : ' warn') }, icon(s.status === 'active' ? 'shield' : 'warn'), statusText),
        h('div', { class: 'card col' },
          h('strong', {}, 'Date with ' + (s.with_name || 'someone')),
          h('span', { class: 'muted' }, s.venue + (s.when_text ? ', ' + s.when_text : '')),
          h('span', { class: 'muted' }, 'Check in by ' + fmtTime(s.checkin_due))),
        h('div', { class: 'card col' },
          h('div', { class: 'row', style: 'justify-content:space-between' },
            h('div', { class: 'col', style: 'gap:2px' }, h('strong', {}, 'Share live location'),
              h('span', { class: 'muted' }, 'Updates while this page stays open.')), sw),
          h('button', { class: 'btn ghost', type: 'button', onclick: share }, 'Send link to ' + (s.contact_name || 'your trusted contact')),
          h('span', { class: 'small' }, 'Your contact opens the link, no account needed. They see your status and last location.')),
        h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api('/safedate/checkin', 'POST'); toast('Checked in. Stay safe.'); clearTimers(); safedate(); } catch (e) { err.textContent = e.message; } } }, 'I am safe'),
        h('button', { class: 'btn sos', type: 'button', onclick: async () => {
          if (!window.confirm('Send SOS to your trusted contact link?')) return;
          try { const r = await api('/safedate/sos', 'POST'); renderActive(r.safedate); } catch (e) { err.textContent = e.message; } } }, 'SOS: alert my contact'),
        h('a', { class: 'btn ghost', href: 'tel:112' }, 'Call 112 (emergency)'),
        h('button', { class: 'btn ghost', type: 'button', onclick: async () => { try { await api('/safedate/end', 'POST'); clearTimers(); safedate(); } catch (e) { err.textContent = e.message; } } }, 'End Safe Date'),
        err);
      startGeo(s);
    }
    function startGeo(s) {
      if (geoWatch != null && navigator.geolocation) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
      if (!s.sharing || !navigator.geolocation) return;
      let lastSent = 0;
      geoWatch = navigator.geolocation.watchPosition((pos) => {
        if (Date.now() - lastSent < 30000) return;
        lastSent = Date.now();
        api('/safedate/location', 'POST', { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
      }, () => toast('Location permission is needed to share your location.'), { enableHighAccuracy: true, maximumAge: 15000 });
    }
  }

  /* ---------- profile ---------- */
  function profile() {
    const err = h('div', { class: 'err', role: 'alert' });
    let photo = null; // null = unchanged
    const prev = h('div', { class: 'photo', style: 'height:220px;border-radius:18px' });
    function drawPrev(src) {
      prev.replaceChildren();
      if (src) prev.append(h('img', { src, alt: 'Your photo' })); else prev.append(icon('silhouette'));
    }
    drawPrev(me.photo);
    const file = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Choose photo', style: 'display:none' });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = () => {
        const max = 640, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        photo = c.toDataURL('image/jpeg', 0.8);
        URL.revokeObjectURL(url);
        drawPrev(photo);
      };
      img.onerror = () => { err.textContent = 'Could not read that image.'; };
      img.src = url;
    });
    const bio = h('textarea', { maxlength: 300 }); bio.value = me.bio || '';
    const city = h('input', { type: 'text', maxlength: 60, value: me.city || '' });
    const intent = h('select', {}, h('option', { value: '' }, 'Choose'), ...me.intents.map((x) => h('option', { value: x }, x)));
    intent.value = me.intent || '';
    const save = h('button', { class: 'btn', type: 'button' }, 'Save profile');
    save.addEventListener('click', async () => {
      err.textContent = ''; save.disabled = true;
      try {
        const body = { bio: bio.value, city: city.value, intent: intent.value };
        if (photo !== null) body.photo = photo;
        await api('/profile', 'PUT', body);
        me = await api('/me'); toast('Saved'); profile();
      } catch (e) { err.textContent = e.message; save.disabled = false; }
    });
    mount(h('div', { class: 'screen' }, brand(), h('h2', {}, 'Your profile'),
      h('div', { class: 'row' }, h('span', { class: 'pill ' + (me.verified ? 'ok' : '') }, me.verified ? [icon('check'), 'Verified'] : 'Not verified'),
        h('span', { class: 'pill' }, 'Trust score ' + me.trust)),
      !me.verified ? h('button', { class: 'btn', type: 'button', onclick: () => go('verify') }, 'Complete verification') : null,
      prev, h('button', { class: 'btn ghost', type: 'button', onclick: () => file.click() }, 'Choose photo'), file,
      field('About you', bio), field('City', city), field('Looking for', intent), err, save,
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { try { await api('/logout', 'POST'); } catch (e) { /* ignore */ } me = null; go('auth'); } }, 'Log out'),
      navbar('profile')));
  }

  /* ---------- boot ---------- */
  async function boot() {
    try { me = await api('/me'); } catch (e) { me = null; return auth(); }
    try { const c = await api('/conversations'); unread = c.conversations.reduce((n, x) => n + x.unread, 0); } catch (e) { unread = 0; }
    go(me.verified ? 'discover' : 'verify');
  }
  boot();
})();
