/* Claude Dashboard frontend — renders live session cards from the SSE feed. */

const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const empty = document.getElementById('empty');
const template = document.getElementById('card-template');

const BASE_TITLE = 'Claude Dashboard';
let titleFlasher = null;
let activeFilter = 'all';
let lastData = null;

const STATUS_LABELS = {
  busy: 'working',
  reply: 'awaiting your action',
  done: 'turn complete',
  waiting: 'needs you!',
  unknown: 'unknown',
};

// ---------------------------------------------------------------- helpers

function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function shortModel(model) {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function toast(msg, ok = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (ok ? ' toast-ok' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText);
  }
}

// ---------------------------------------------------------------- card rendering

// Standard button lifecycle: disable + dim while in flight, brief green "done"
// confirmation on success, restore + toast on failure.
async function withFeedback(btn, errPrefix, fn, doneLabel) {
  if (btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.classList.add('btn-busy');
  try {
    await fn();
    btn.classList.remove('btn-busy');
    btn.classList.add('btn-done');
    if (doneLabel) btn.textContent = doneLabel;
    setTimeout(() => {
      btn.classList.remove('btn-done');
      btn.textContent = orig;
      btn.disabled = false;
    }, 1200);
  } catch (err) {
    btn.classList.remove('btn-busy');
    btn.textContent = orig;
    btn.disabled = false;
    toast(errPrefix + ': ' + err.message);
  }
}

const EVT_TAGS = { user: 'you', assistant: 'claude' };

function renderEvents(feedEl, events) {
  // keep scroll pinned to bottom unless the user scrolled up
  const pinned = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 30;
  feedEl.innerHTML = '';
  for (const e of events) {
    const row = document.createElement('div');
    row.className = 'evt evt-' + e.kind;
    const time = document.createElement('time');
    time.textContent = fmtTime(e.at);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = e.kind === 'tool' ? e.tool : e.kind === 'error' ? '✗ ' + (e.tool || '') : EVT_TAGS[e.kind];
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = e.detail || e.text || '';
    row.append(time, tag, detail);
    feedEl.appendChild(row);
  }
  if (pinned) feedEl.scrollTop = feedEl.scrollHeight;
}

function buildCard(s) {
  const node = template.content.cloneNode(true);
  const card = node.querySelector('.card');
  card.id = 'card-' + s.pid;

  const input = card.querySelector('.send-input');
  const enterBox = card.querySelector('.press-enter');
  const sendBtn = card.querySelector('.send-btn');

  card.querySelector('.send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    withFeedback(sendBtn, 'Send failed', async () => {
      await post(`/api/sessions/${s.pid}/send`, { text, pressEnter: enterBox.checked });
      input.value = '';
    }, '✓ Sent');
  });

  const focusBtn = card.querySelector('.focus-btn');
  focusBtn.addEventListener('click', () =>
    withFeedback(focusBtn, 'Open failed', () => post(`/api/sessions/${s.pid}/focus`)));

  card.querySelector('.prompt-text').addEventListener('click', (e) => {
    e.target.classList.toggle('expanded');
  });

  // quick actions for permission prompts
  const sendKey = (k) => post(`/api/sessions/${s.pid}/key`, { key: k });
  const qa = (sel, k, doneLabel) => {
    const btn = card.querySelector(sel);
    btn.addEventListener('click', () =>
      withFeedback(btn, 'Action failed', () => sendKey(k), doneLabel));
  };
  qa('.qa-approve', '1', '✓ Approved');
  qa('.qa-always', '2', '✓ Approved');
  qa('.qa-deny', 'escape', '✓ Denied');
  const editBtn = card.querySelector('.qa-edit');
  editBtn.addEventListener('click', () =>
    withFeedback(editBtn, 'Action failed', async () => {
      await sendKey('escape');
      input.placeholder = 'Tell Claude what to do instead…';
      input.focus();
    }, '✓ Denied'));

  card.querySelector('.rename-btn').addEventListener('click', async () => {
    const current = card.querySelector('.project').textContent;
    const next = prompt('Session title (leave empty to revert to the auto title):', current);
    if (next === null) return; // cancelled
    try {
      await post(`/api/sessions/${s.pid}/title`, { title: next });
    } catch (err) {
      toast('Rename failed: ' + err.message);
    }
  });

  const endBtn = card.querySelector('.end-btn');
  endBtn.addEventListener('click', () => {
    if (!confirm(`End the ${s.project} session and close its pane?`)) return;
    withFeedback(endBtn, 'End failed', async () => {
      await post(`/api/sessions/${s.pid}/end`);
      toast('Session ended', true);
    });
  });

  return card;
}

function updateCard(card, s, now) {
  const st = s.derivedStatus || s.status;
  card.dataset.status = st;
  const titleEl = card.querySelector('.project');
  titleEl.textContent = s.title || s.project;
  titleEl.title = s.title || s.project;
  card.querySelector('.status-label').textContent =
    st === 'waiting' && s.waitingFor
      ? s.waitingFor
      : (STATUS_LABELS[st] || st) +
        (s.statusUpdatedAt ? ' · ' + fmtAgo(now - s.statusUpdatedAt) : '');

  const cwdEl = card.querySelector('.cwd');
  cwdEl.textContent = `${s.project} · ${s.cwd}`;
  cwdEl.title = s.cwd;
  card.querySelector('.pid').textContent = 'pid ' + s.pid;
  card.querySelector('.model').textContent = shortModel(s.model);
  card.querySelector('.uptime').textContent = s.startedAt ? 'up ' + fmtAgo(now - s.startedAt) : '';
  card.querySelector('.tokens').textContent = s.contextTokens
    ? `ctx ${fmtTokens(s.contextTokens)} · ↑${fmtTokens(s.recentOutputTokens)}`
    : '';

  card.querySelector('.prompt-text').textContent = s.firstPrompt ? s.firstPrompt.text : '(no prompt yet)';
  renderEvents(card.querySelector('.feed'), s.events || []);

  // when blocked or awaiting a reply, show what the session is actually asking
  const pq = card.querySelector('.pending-question');
  const pqText = pq.querySelector('.pq-text');
  let question = '';
  if (st === 'waiting' && s.pendingTool) {
    question =
      s.pendingTool.tool === 'AskUserQuestion'
        ? s.pendingTool.detail
        : `wants to run ${s.pendingTool.tool}` + (s.pendingTool.detail ? ` — ${s.pendingTool.detail}` : '');
  } else if (st === 'reply' && s.lastAssistantTail) {
    question = s.lastAssistantTail;
  }
  pq.hidden = !question.trim();
  pq.classList.toggle('pq-amber', st === 'reply');
  pqText.textContent = question;
  pqText.title = question; // full text on hover; the banner itself is one clamped line

  // mirror the terminal's permission dialog (command + safety warning) while waiting
  const mirror = card.querySelector('.screen-mirror');
  if (st === 'waiting') {
    const stamp = String(s.statusUpdatedAt || '');
    if (card.dataset.screenAt !== stamp) {
      card.dataset.screenAt = stamp;
      fetch(`/api/sessions/${s.pid}/screen`)
        .then((r) => r.json())
        .then(({ screen }) => {
          if (card.dataset.status === 'waiting' && screen) {
            mirror.textContent = screen;
            mirror.hidden = false;
            mirror.scrollTop = mirror.scrollHeight;
          }
        })
        .catch(() => {});
    }
  } else {
    mirror.hidden = true;
    delete card.dataset.screenAt;
  }

  // show approve/deny only when blocked on a permission-style prompt
  card.querySelector('.quick-actions').hidden = st !== 'waiting';
  card.hidden = activeFilter !== 'all' && st !== activeFilter;

  // observe-only when the hosting terminal has no interaction backend
  const interactive = !!s.terminal;
  card.classList.toggle('readonly', !interactive);
  for (const el of card.querySelectorAll('.send-input, .send-btn, .focus-btn, .qa-btn, .end-btn')) {
    if (!el.classList.contains('btn-done')) el.disabled = !interactive;
  }
  if (!interactive) {
    card.querySelector('.send-input').placeholder = 'Observe-only — this terminal is not scriptable';
  }
}

// ---------------------------------------------------------------- summary bar

function updateStats(sessions) {
  const counts = { busy: 0, reply: 0, done: 0, waiting: 0 };
  for (const s of sessions) {
    const st = s.derivedStatus || s.status;
    if (counts[st] !== undefined) counts[st]++;
  }
  document.getElementById('stat-total').textContent = sessions.length;
  document.getElementById('stat-busy').textContent = counts.busy;
  document.getElementById('stat-reply').textContent = counts.reply;
  document.getElementById('stat-done').textContent = counts.done;
  document.getElementById('stat-waiting').textContent = counts.waiting;
  return counts;
}

document.getElementById('stats').addEventListener('click', (e) => {
  const tile = e.target.closest('.stat');
  if (!tile) return;
  const filter = tile.dataset.filter;
  activeFilter = activeFilter === filter ? 'all' : filter; // click again to clear
  document.querySelectorAll('.stat').forEach((t) =>
    t.classList.toggle('active', t.dataset.filter === activeFilter && activeFilter !== 'all'));
  if (lastData) render(lastData);
});

// ---------------------------------------------------------------- main render

function render(data) {
  lastData = data;
  const { sessions, now } = data;
  const livePids = new Set(sessions.map((s) => 'card-' + s.pid));

  for (const card of [...grid.children]) {
    if (!livePids.has(card.id)) card.remove();
  }

  for (const s of sessions) {
    let card = document.getElementById('card-' + s.pid);
    if (!card) {
      card = buildCard(s);
      grid.appendChild(card);
    }
    updateCard(card, s, now);
  }

  const visible = [...grid.children].filter((c) => !c.hidden).length;
  empty.hidden = visible > 0;

  const counts = updateStats(sessions);

  // live combined usage across the active sessions (recomputed every tick)
  const ctx = sessions.reduce((a, s) => a + (s.contextTokens || 0), 0);
  const out = sessions.reduce((a, s) => a + (s.recentOutputTokens || 0), 0);
  document.getElementById('usage-strip').textContent = sessions.length
    ? `live usage — context in use: ${fmtTokens(ctx)} tokens across ${sessions.length} session${sessions.length === 1 ? '' : 's'} · recent output: ${fmtTokens(out)} tokens`
    : '';

  // flash the browser tab title when any session needs the user
  const needsAttention = counts.waiting > 0;
  if (needsAttention && !titleFlasher) {
    let on = false;
    titleFlasher = setInterval(() => {
      on = !on;
      const n = document.getElementById('stat-waiting').textContent;
      document.title = on ? `🔴 ${n} waiting — ${BASE_TITLE}` : BASE_TITLE;
    }, 800);
  } else if (!needsAttention && titleFlasher) {
    clearInterval(titleFlasher);
    titleFlasher = null;
    document.title = BASE_TITLE;
  }
}

// ---------------------------------------------------------------- new session dialog

const dialog = document.getElementById('new-session-dialog');
const nsCwd = document.getElementById('ns-cwd');
const nsPrompt = document.getElementById('ns-prompt');
const nsSkill = document.getElementById('ns-skill');
const nsSkillDesc = document.getElementById('ns-skill-desc');
let skillDescriptions = {};

async function loadSkills() {
  try {
    const res = await fetch('/api/skills?cwd=' + encodeURIComponent(nsCwd.value.trim()));
    const { skills } = await res.json();
    skillDescriptions = Object.fromEntries(skills.map((s) => [s.name, s.description]));
    const current = nsSkill.value;
    nsSkill.innerHTML =
      '<option value="">(none — free-form prompt)</option>' +
      skills.map((s) => `<option value="${s.name}">/${s.name}${s.scope === 'project' ? ' · project' : ''}</option>`).join('');
    if (skillDescriptions[current] !== undefined) nsSkill.value = current;
    updateSkillUi();
  } catch { /* dropdown still usable with just "(none)" */ }
}

function updateSkillUi() {
  const skill = nsSkill.value;
  nsSkillDesc.textContent = skill ? skillDescriptions[skill] || '' : '';
  document.getElementById('ns-prompt-label').textContent = skill ? `Arguments for /${skill}` : 'Initial prompt';
  nsPrompt.placeholder = skill ? `arguments for /${skill}` : 'What should this session work on?';
}

nsSkill.addEventListener('change', updateSkillUi);
nsCwd.addEventListener('change', loadSkills); // project skills depend on the chosen dir

document.getElementById('new-session-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/projects');
    const { projects } = await res.json();
    document.getElementById('ns-projects').innerHTML =
      projects.map((p) => `<option value="${p}"></option>`).join('');
  } catch { /* picker still usable without suggestions */ }
  loadSkills();
  dialog.showModal();
  nsCwd.focus();
});

document.getElementById('ns-cancel').addEventListener('click', () => dialog.close());

document.getElementById('new-session-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  withFeedback(btn, 'Launch failed', async () => {
    const args = nsPrompt.value.trim();
    const prompt = nsSkill.value ? `/${nsSkill.value} ${args}`.trim() : args;
    await post('/api/sessions/new', { cwd: nsCwd.value.trim(), prompt });
    dialog.close();
    nsPrompt.value = '';
    nsSkill.value = '';
    updateSkillUi();
    toast('Session launching — it will appear here in a few seconds', true);
  }, '✓ Launched');
});

// ---------------------------------------------------------------- live connection

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { conn.textContent = 'live'; conn.className = 'conn ok'; };
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    conn.textContent = 'reconnecting…';
    conn.className = 'conn err';
  };
}

connect();
