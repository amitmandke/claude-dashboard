/* Claude Dashboard frontend — renders live session cards from the SSE feed. */

const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const empty = document.getElementById('empty');
const template = document.getElementById('card-template');
const candTemplate = document.getElementById('candidate-template');

const BASE_TITLE = 'Claude Dashboard';
let titleFlasher = null;
let activeFilter = 'all';
let lastData = null;

// Text filter for the Sessions grid. It composes with the stat-tile status
// filter (AND, not replace) so "needs attention" + "orchestrator" is expressible.
// Unlike the candidates filter this one survives a reload: the sessions tab is a
// standing view you leave open, so re-typing the filter after every refresh is
// the wrong default.
const SESS_FILTER_KEY = 'claude-dashboard.sessionFilter';
let sessFilter = '';
try { sessFilter = localStorage.getItem(SESS_FILTER_KEY) || ''; } catch { /* private mode */ }

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

async function send(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText);
  }
}
const post = (path, body) => send('POST', path, body);
const patch = (path, body) => send('PATCH', path, body);
const del = (path) => send('DELETE', path);

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

// ---- full-reply popup: feed entries are truncated to 200 chars server-side,
// so the popup fetches the complete message on demand and renders it as markdown
const mdDialog = document.getElementById('md-dialog');
const mdTitle = document.getElementById('md-title');
const mdBody = document.getElementById('md-body');
document.getElementById('md-close').addEventListener('click', () => mdDialog.close());
mdDialog.addEventListener('click', (e) => { if (e.target === mdDialog) mdDialog.close(); }); // backdrop

function showReply(title, fallbackText, pid, at) {
  mdTitle.textContent = title;
  mdBody.innerHTML = renderMarkdown(fallbackText || '');
  mdBody.scrollTop = 0;
  mdDialog.showModal();
  if (pid == null || !at) return;
  fetch(`/api/sessions/${pid}/text?at=${encodeURIComponent(at)}`)
    .then((r) => r.json())
    .then(({ text }) => {
      if (text && mdDialog.open) {
        mdBody.innerHTML = renderMarkdown(text);
        mdBody.scrollTop = 0;
      }
    })
    .catch(() => {}); // fallback (truncated) text is already showing
}

// ---- expand a single card to a large centered overlay and back. The card
// stays the same DOM node (keeps its live updates, feed scroll, and composer),
// so collapsing drops it right back into its grid spot. One at a time.
const cardBackdrop = document.getElementById('card-backdrop');
function collapseExpanded() {
  const open = grid.querySelector('.card.expanded');
  if (open) {
    open.classList.remove('expanded');
    // drop the inline width/height the corner-drag resize left behind, or the
    // card keeps its dragged size back in the grid
    open.style.width = '';
    open.style.height = '';
  }
  cardBackdrop.hidden = true;
}
function toggleExpand(card) {
  const willExpand = !card.classList.contains('expanded');
  collapseExpanded(); // never two at once
  if (willExpand) {
    card.classList.add('expanded');
    cardBackdrop.hidden = false;
  }
}
cardBackdrop.addEventListener('click', collapseExpanded);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && grid.querySelector('.card.expanded')) collapseExpanded();
});

const EVT_TAGS = { user: 'you', assistant: 'claude' };

function renderEvents(feedEl, events, s) {
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
    if (e.kind === 'assistant') {
      row.classList.add('evt-click');
      row.title = 'Open the full reply';
      row.addEventListener('click', () => showReply(s.title || s.project, e.text, s.pid, e.at));
      const pop = document.createElement('span');
      pop.className = 'evt-pop';
      pop.textContent = '⤢';
      row.appendChild(pop);
    }
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

  const escBtn = card.querySelector('.esc-btn');
  escBtn.addEventListener('click', () =>
    withFeedback(escBtn, 'Esc failed', () =>
      post(`/api/sessions/${s.pid}/key`, { key: 'escape' }), '✓ Sent'));

  card.querySelector('.prompt-text').addEventListener('click', (e) => {
    e.target.classList.toggle('expanded');
  });

  // the amber reply banner shows a clamped tail — click opens the full reply
  card.querySelector('.pending-question').addEventListener('click', () => {
    if (card.dataset.status !== 'reply' || !lastData) return;
    const cur = lastData.sessions.find((x) => x.pid === s.pid);
    if (!cur) return;
    const lastReply = [...(cur.events || [])].reverse().find((e) => e.kind === 'assistant');
    showReply(cur.title || cur.project, cur.lastAssistantText, cur.pid, lastReply && lastReply.at);
  });

  // Quick actions for permission prompts. The digit each button sends is read from
  // the live dialog (see applyDialogOptions) — never assumed: a two-option prompt
  // makes "2" mean No, so hardcoding it would deny instead of "always allow".
  const sendKey = (k) => post(`/api/sessions/${s.pid}/key`, { key: k });
  const qa = (sel, getKey, doneLabel) => {
    const btn = card.querySelector(sel);
    btn.addEventListener('click', () => {
      const k = getKey();
      if (!k) return; // no matching option in this dialog (button is hidden anyway)
      withFeedback(btn, 'Action failed', () => sendKey(k), doneLabel);
    });
  };
  qa('.qa-approve', () => card.dataset.approveDigit || '1', '✓ Approved');
  qa('.qa-always', () => card.dataset.alwaysDigit || '', '✓ Approved');
  qa('.qa-deny', () => 'escape', '✓ Denied');
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

  // Ending terminates the claude process — its context and any in-progress work
  // are gone. A fully complete turn (`done`) is safe to close without asking;
  // every other state gets a confirmation that says what would be lost.
  const END_WARNINGS = {
    busy: (p) => `${p} is STILL WORKING — ending now kills the running turn and loses its in-progress work. End it anyway?`,
    waiting: (p) => `${p} is waiting on your approval — ending now terminates the session and its context. End it anyway?`,
    reply: (p) => `${p} is awaiting your input — ending now terminates the session and its context. End it anyway?`,
  };
  card.querySelector('.expand-btn').addEventListener('click', () => toggleExpand(card));

  const endBtn = card.querySelector('.end-btn');
  endBtn.addEventListener('click', () => {
    const st = card.dataset.status; // live status, not the build-time snapshot
    if (st !== 'done') {
      const msg = (END_WARNINGS[st] || ((p) => `End the ${p} session and close its pane?`))(s.project);
      if (!confirm(msg)) return;
    }
    withFeedback(endBtn, 'End failed', async () => {
      await post(`/api/sessions/${s.pid}/end`);
      toast('Session ended', true);
    });
  });

  return card;
}

// Bottom-most line of the pane that looks like Claude Code's progress indicator,
// e.g. "✽ Germinating… (1m 57s · ↓ 6.7k tokens)": spinner glyph + gerund + "(stats)".
// Don't match on "esc to interrupt" — the shortcut-hint bar below the input box has it too.
function spinnerLine(screen) {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (/^[^\x00-\x7F]\s*\S+…\s*\(/.test(l)) return l;
  }
  return '';
}

// Map the Approve/Always buttons to the digits this specific permission dialog
// uses, parsed from the mirrored screen. Approve falls back to "1" (always the
// top/safest option); Always is shown only when a real don't-ask-again option
// exists — on a two-option prompt option 2 is "No", so we hide it rather than
// deny by mistake.
function applyDialogOptions(card, screen) {
  const { approveDigit, alwaysDigit } = parseDialogOptions(screen);
  card.dataset.approveDigit = approveDigit || '1';
  const alwaysBtn = card.querySelector('.qa-always');
  if (alwaysDigit) {
    card.dataset.alwaysDigit = alwaysDigit;
    alwaysBtn.hidden = false;
  } else {
    delete card.dataset.alwaysDigit;
    alwaysBtn.hidden = true;
  }
}

function resetDialogOptions(card) {
  delete card.dataset.approveDigit;
  delete card.dataset.alwaysDigit;
  card.querySelector('.qa-always').hidden = true;
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
  renderEvents(card.querySelector('.feed'), s.events || [], s);

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

  // while busy, surface the live progress line Claude Code renders in the pane
  // ("✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)") — it exists only on screen
  const live = card.querySelector('.live-line');
  if (st === 'busy' && s.terminal) {
    if (Date.now() - Number(card.dataset.liveAt || 0) > 2000) {
      card.dataset.liveAt = Date.now();
      fetch(`/api/sessions/${s.pid}/screen`)
        .then((r) => r.json())
        .then(({ screen }) => {
          if (card.dataset.status !== 'busy') return;
          const line = spinnerLine(screen || '');
          if (line) live.textContent = line;
          live.hidden = !line && !live.textContent;
        })
        .catch(() => {});
    }
  } else {
    live.hidden = true;
    live.textContent = '';
    delete card.dataset.liveAt;
  }

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
            applyDialogOptions(card, screen);
          }
        })
        .catch(() => {});
    }
  } else {
    mirror.hidden = true;
    delete card.dataset.screenAt;
    resetDialogOptions(card);
  }

  // show approve/deny only when blocked on a permission-style prompt
  card.querySelector('.quick-actions').hidden = st !== 'waiting';
  card.hidden = (activeFilter !== 'all' && st !== activeFilter) ||
                !sessionMatches(s, sessFilter.trim().toLowerCase());

  // observe-only when the hosting terminal has no interaction backend
  const interactive = !!s.terminal;
  card.classList.toggle('readonly', !interactive);
  for (const el of card.querySelectorAll('.send-input, .send-btn, .esc-btn, .focus-btn, .qa-btn, .end-btn')) {
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
  document.querySelector('.stat-waiting').classList.toggle('flashing', counts.waiting > 0);
  return counts;
}

// ---------------------------------------------------------------- text filter

// Substring match across what identifies a session: the card's title, its repo
// folder and full path, the pid, and the prompt it was started with. The first
// prompt is in there deliberately — an AI title drifts from the ask that opened
// the session, so "the one I launched to clone to rel" has to stay findable.
// The live reply text is NOT matched: it would produce hits with no visible
// cause on a collapsed card.
function sessionMatches(s, q) {
  if (!q) return true;
  // firstPrompt is {text, at} — not a string; joining the object itself puts a
  // literal "[object Object]" in every haystack (so "object" would match all).
  const hay = [s.title, s.customTitle, s.aiTitle, s.project, s.cwd, s.firstPrompt?.text, String(s.pid)]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

const sessFilterEl = document.getElementById('sess-filter');
sessFilterEl.value = sessFilter;
sessFilterEl.addEventListener('input', () => {
  sessFilter = sessFilterEl.value;
  try { localStorage.setItem(SESS_FILTER_KEY, sessFilter); } catch { /* private mode */ }
  if (lastData) render(lastData);
});
// Esc clears — but only from inside the input, so it can never be mistaken for
// a card's ⎋ interrupt.
sessFilterEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !sessFilterEl.value) return;
  e.preventDefault();
  e.stopPropagation();
  sessFilterEl.value = '';
  sessFilterEl.dispatchEvent(new Event('input'));
});

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
  // an expanded card whose session just ended is gone — drop the backdrop with it
  if (!grid.querySelector('.card.expanded')) cardBackdrop.hidden = true;

  for (const s of sessions) {
    let card = document.getElementById('card-' + s.pid);
    if (!card) {
      card = buildCard(s);
      grid.appendChild(card);
    }
    updateCard(card, s, now);
  }

  // follow the server's attention-first order (waiting → reply → done → busy,
  // oldest first within a status). appendChild moves existing nodes, which drops
  // focus — so don't shuffle while the user is interacting inside a card.
  const desired = sessions.map((s) => 'card-' + s.pid);
  const current = [...grid.children].map((c) => c.id);
  if (desired.some((id, i) => id !== current[i]) && !grid.contains(document.activeElement)) {
    for (const id of desired) grid.appendChild(document.getElementById(id));
  }

  // Two different "nothing here" states: no sessions at all (tells you how to
  // start one) vs a filter that matched none (telling you to run `claude` there
  // would be wrong advice).
  const visible = [...grid.children].filter((c) => !c.hidden).length;
  empty.hidden = visible > 0 || sessions.length > 0;
  document.getElementById('sess-nomatch').hidden = !(sessions.length > 0 && visible === 0);

  // The stat tiles keep counting what is actually running, so the toolbar has to
  // say how much of that the filter is hiding — otherwise a narrow filter reads
  // as sessions having disappeared.
  const q = sessFilter.trim();
  document.getElementById('sess-count').textContent = sessions.length
    ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}` +
      (q || activeFilter !== 'all' ? ` · ${visible} shown` : '')
    : '';

  const counts = updateStats(sessions);

  // live session count on the Sessions tab (mirrors the Candidates badge)
  const sessBadge = document.getElementById('sess-badge');
  sessBadge.textContent = sessions.length;
  sessBadge.hidden = sessions.length === 0;

  renderCandidates(data);
  renderWatchers(data);

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
      skills.map((s) => `<option value="${s.name}">/${s.name}${s.scope !== 'user' ? ' · ' + s.scope : ''}</option>`).join('');
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

// Enter submits from the prompt textarea (Shift+Enter for a newline), matching Claude Code
nsPrompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

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
document.getElementById('ns-close').addEventListener('click', () => dialog.close());

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

// ---------------------------------------------------------------- candidates

// in-page view toggle: live Sessions vs the launchable Candidates list. One
// page, one SSE stream — this just switches which view is visible.
const VIEWS = ['sessions', 'candidates', 'watchers'];
let activeView = 'sessions';
function setView(view) {
  activeView = VIEWS.includes(view) ? view : 'sessions';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === activeView));
  for (const v of VIEWS) document.getElementById(v + '-view').hidden = activeView !== v;
  // keep the URL hash in sync so a refresh / bookmark lands on the same tab
  const want = activeView === 'sessions' ? '' : '#' + activeView;
  if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
}
document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) setView(tab.dataset.view);
});
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
setView(location.hash.slice(1) || 'sessions');

// client-side filter: narrows the visible candidates by substring across the
// fields that matter (skill, prompt, reason, directory, source). The full list
// is already in the snapshot, so this is pure frontend — no server round-trip.
let candFilter = '';
let lastCandSig = null; // signature of the last candidate render — skip rebuilds when unchanged
const candSel = new Set(); // ids selected for a bulk action; see renderBulkBar
const candFilterEl = document.getElementById('cand-filter');
candFilterEl.addEventListener('input', () => {
  candFilter = candFilterEl.value;
  if (lastData) renderCandidates(lastData);
});

function candMatches(c, q) {
  if (!q) return true;
  const hay = [c.action.skill, c.action.prompt, c.reason, c.action.cwd, c.source, c.producer]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

// After any candidate mutation, re-pull the authoritative list and re-render
// right away — don't wait for the next SSE tick (which may lag or be mid-
// reconnect), or a cleared/changed card lingers on screen until then.
async function refreshCandidates() {
  try {
    const res = await fetch('/api/candidates');
    const { candidates } = await res.json();
    if (lastData) {
      lastData.candidates = candidates;
      renderCandidates(lastData);
    }
  } catch { /* the next SSE snapshot will reconcile */ }
}

async function reprioritize(c, delta) {
  try { await patch(`/api/candidates/${c.id}`, { priority: (c.priority || 0) + delta }); await refreshCandidates(); }
  catch (err) { toast('Reprioritize failed: ' + err.message); }
}

// A candidate's `ref` may be a plain URL string or an object with url /
// slackPermalink / prRefs. Derive a scannable title and clickable link chips so
// the card leads with "what is this" instead of a wall-of-text prompt.
function prFromUrl(u) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(u || '');
  return m ? { repo: m[2], number: +m[3], url: u } : null;
}
function prUrl(pr) {
  return pr.url || (pr.repo && pr.number != null ? `https://github.com/${pr.repo}/pull/${pr.number}` : null);
}
function candTitle(c) {
  const ref = c.ref || {};
  const url = typeof ref === 'string' ? ref : ref.url;
  const pr = (ref.prRefs && ref.prRefs[0]) || prFromUrl(url);
  if (pr) return `${pr.repo} #${pr.number}`;
  if (ref.channelName) return ref.channelName; // e.g. "#eng-alerts"
  if (ref.slackPermalink || (typeof ref === 'string' && ref.includes('slack.com'))) return 'Slack thread';
  return (c.action.prompt || '(no prompt)').split('\n')[0].slice(0, 80);
}
function candLinks(c) {
  const ref = c.ref || {};
  const out = [];
  const url = typeof ref === 'string' ? ref : ref.url;
  const pr = (ref.prRefs && ref.prRefs[0]) || prFromUrl(url);
  if (pr) out.push({ label: `PR ${pr.repo}#${pr.number} ↗`, href: prUrl(pr) || url });
  else if (url) out.push({ label: '↗ link', href: url });
  if (ref.slackPermalink) out.push({ label: `💬 ${ref.channelName || 'Slack thread'} ↗`, href: ref.slackPermalink });
  return out;
}

// candidate ids whose prompt the user has expanded — survives SSE re-renders
const expandedCandPrompts = new Set();

function buildCandidate(c, ctx) {
  const card = candTemplate.content.cloneNode(true).querySelector('.cand-card');
  card.dataset.status = c.status;
  card.classList.toggle('cand-inactive', c.status !== 'pending');

  // Selection lives in candSel (a Set of ids), never in the DOM — the grid is
  // rebuilt wholesale on every change, so DOM-held checkboxes would evaporate.
  const pick = card.querySelector('.cand-pick');
  pick.checked = candSel.has(c.id);
  card.classList.toggle('picked', pick.checked);
  pick.addEventListener('change', () => {
    if (pick.checked) candSel.add(c.id); else candSel.delete(c.id);
    if (lastData) renderCandidates(lastData);
  });

  const skillEl = card.querySelector('.cand-skill');
  skillEl.textContent = c.action.skill ? '/' + c.action.skill : '(no skill)';
  skillEl.classList.toggle('cand-noskill', !c.action.skill);
  card.querySelector('.cand-priority').textContent = 'P' + (c.priority || 0);

  const stateBadge = card.querySelector('.cand-statebadge');
  stateBadge.textContent = c.status;
  stateBadge.hidden = c.status === 'pending';

  card.querySelector('.cand-title').textContent = candTitle(c);

  const linksEl = card.querySelector('.cand-links');
  for (const l of candLinks(c)) {
    const a = document.createElement('a');
    a.href = l.href; a.textContent = l.label;
    a.target = '_blank'; a.rel = 'noopener'; a.className = 'cand-ref';
    linksEl.appendChild(a);
  }

  const reasonEl = card.querySelector('.cand-reason');
  reasonEl.textContent = c.reason || '';
  reasonEl.hidden = !c.reason;

  // prompt clamps by default; click (or "▾ more") expands, a separate ✎ edits
  const promptEl = card.querySelector('.cand-prompt');
  promptEl.textContent = c.action.prompt || '(no prompt)';
  const moreBtn = card.querySelector('.cand-prompt-more');
  const toggle = () => {
    const open = promptEl.classList.toggle('expanded');
    moreBtn.textContent = open ? '▴ less' : '▾ more';
    if (open) expandedCandPrompts.add(c.id); else expandedCandPrompts.delete(c.id);
  };
  promptEl.addEventListener('click', toggle);
  moreBtn.addEventListener('click', toggle);
  // the SSE snapshot rebuilds every card each tick — restore a prompt the user
  // had expanded so it doesn't snap shut a second after they click "more".
  if (expandedCandPrompts.has(c.id)) {
    promptEl.classList.add('expanded');
    moreBtn.textContent = '▴ less';
    moreBtn.hidden = false;
  }
  // reveal the "more" toggle only when the text actually overflows the clamp
  requestAnimationFrame(() => {
    if (promptEl.scrollHeight - promptEl.clientHeight > 4) moreBtn.hidden = false;
  });

  const cwdEl = card.querySelector('.cand-cwd');
  cwdEl.textContent = c.action.cwd || '(no repo — pick one before launch)';
  cwdEl.title = c.action.cwd || '';
  card.querySelector('.cand-source').textContent =
    c.source + (c.producer && c.producer !== 'user' ? ' · ' + c.producer : '');

  const launchBtn = card.querySelector('.cand-launch');
  const dismissBtn = card.querySelector('.cand-dismiss');
  const undismissBtn = card.querySelector('.cand-undismiss');
  const editBtn = card.querySelector('.cand-edit');
  const upBtn = card.querySelector('.cand-prio-up');
  const downBtn = card.querySelector('.cand-prio-down');
  const clearBtn = card.querySelector('.cand-clear');

  if (c.status === 'pending') {
    if (ctx.atCap) {
      launchBtn.disabled = true;
      launchBtn.title = `At the concurrency cap (${ctx.liveCount}/${ctx.caps.maxConcurrent} actively working)`;
    }
    launchBtn.addEventListener('click', () =>
      withFeedback(launchBtn, 'Launch failed', async () => {
        await post(`/api/candidates/${c.id}/launch`);
        toast('Launching — switch to Sessions to watch it appear', true);
        await refreshCandidates();
      }, '✓ Launched'));
    dismissBtn.addEventListener('click', () =>
      withFeedback(dismissBtn, 'Dismiss failed', async () => {
        await post(`/api/candidates/${c.id}/dismiss`);
        await refreshCandidates();
      }));
    editBtn.addEventListener('click', () => openCandEdit(c));
    upBtn.addEventListener('click', () => reprioritize(c, +1));
    downBtn.addEventListener('click', () => reprioritize(c, -1));
  } else {
    // history item — a dismissed one can be restored; either can be cleared now
    // (otherwise it auto-prunes: launched soon, dismissed after a few days)
    for (const b of [launchBtn, dismissBtn, editBtn, upBtn, downBtn]) b.hidden = true;
    clearBtn.hidden = false;
    clearBtn.addEventListener('click', () =>
      withFeedback(clearBtn, 'Clear failed', async () => {
        await del(`/api/candidates/${c.id}`);
        await refreshCandidates();
      }));
    if (c.status === 'dismissed') {
      undismissBtn.hidden = false;
      undismissBtn.addEventListener('click', () =>
        withFeedback(undismissBtn, 'Restore failed', async () => {
          await post(`/api/candidates/${c.id}/undismiss`);
          await refreshCandidates();
        }));
    }
  }
  return card;
}

function renderCandidates(data) {
  const list = data.candidates || [];
  const caps = data.caps || {};
  // match the server rule: count only actively-working sessions (busy/waiting),
  // not idle/turn-complete windows.
  const liveCount = (data.sessions || []).filter((s) => s.status === 'busy' || s.derivedStatus === 'waiting').length;
  const atCap = caps.maxConcurrent != null && liveCount >= caps.maxConcurrent;

  // The SSE snapshot fires every tick even when candidates haven't changed;
  // rebuilding the grid then would reset scroll/expansion mid-read. Skip the
  // rebuild unless something that affects the rendered output actually changed.
  // Drop selected ids that no longer exist (launched from another tab, pruned)
  // before signing the render — a stale id would inflate every count and be sent
  // to the server as a notFound.
  const alive = new Set(list.map((c) => c.id));
  for (const id of candSel) if (!alive.has(id)) candSel.delete(id);

  const sig = JSON.stringify(list) + '|' + atCap + '|' + candFilter + '|' + [...candSel].join(',');
  if (sig === lastCandSig) return;
  lastCandSig = sig;

  const pending = list.filter((c) => c.status === 'pending');

  const badge = document.getElementById('cand-badge');
  badge.textContent = pending.length;
  badge.hidden = pending.length === 0;

  const q = candFilter.trim().toLowerCase();
  const filtered = list.filter((c) => candMatches(c, q));

  const cgrid = document.getElementById('cand-grid');
  cgrid.innerHTML = '';
  for (const c of filtered) cgrid.appendChild(buildCandidate(c, { atCap, liveCount, caps }));

  document.getElementById('cand-empty').hidden = list.length !== 0;
  document.getElementById('cand-nomatch').hidden = !(list.length > 0 && filtered.length === 0);

  renderBulkBar(filtered, list, { pending: pending.length, q, atCap, liveCount, caps });
}

// ---- bulk selection ------------------------------------------------------

// The toolbar's right half IS the triage bar — the filter stays where it is,
// because the filter is what defined the selection. There is deliberately no
// floating action bar, and no "Launch selected": launching a dozen candidates
// means a dozen iTerm2 windows, and the concurrency cap would silently drop the
// tail. Bulk clears the board; it doesn't fill it.
function renderBulkBar(filtered, list, { pending, q, atCap, liveCount, caps }) {
  const shownIds = filtered.map((c) => c.id);
  const selectedShown = shownIds.filter((id) => candSel.has(id)).length;
  const n = candSel.size;

  // "All shown" means exactly that — it can only ever tick what the filter is
  // showing, so "select all then Clear" can never reach a card you haven't seen.
  const selAll = document.getElementById('cand-selall');
  selAll.checked = shownIds.length > 0 && selectedShown === shownIds.length;
  selAll.indeterminate = selectedShown > 0 && selectedShown < shownIds.length;
  selAll.disabled = shownIds.length === 0;

  const verbs = document.getElementById('cand-bulk-verbs');
  verbs.hidden = n === 0;
  // the create action steps aside while a selection is live — one job at a time
  document.getElementById('new-candidate-btn').hidden = n > 0;

  if (n > 0) {
    const dismissable = [...candSel].filter(
      (id) => (list.find((c) => c.id === id) || {}).status === 'pending'
    ).length;
    const dis = document.getElementById('cand-bulk-dismiss');
    dis.innerHTML = '';
    dis.append(`✕ Dismiss ${dismissable}`, el('small', 'keeps them 7 days'));
    dis.disabled = dismissable === 0;
    dis.title = dismissable === 0
      ? 'Nothing selected is still pending — dismiss only applies to pending candidates'
      : '';

    const clr = document.getElementById('cand-bulk-clear');
    clr.innerHTML = '';
    clr.append(`🗑 Clear ${n}`, el('small', 'permanent'));
  }

  document.getElementById('cand-count').textContent = list.length
    ? (n > 0 ? `${n} selected · ${list.length} total` : `${pending} pending`) +
      (q && n === 0 ? ` · ${filtered.length} shown` : '') +
      (atCap ? ` · ${liveCount}/${caps.maxConcurrent} running (at cap)` : '')
    : '';
}

function el(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}

document.getElementById('cand-selall').addEventListener('change', (e) => {
  const q = candFilter.trim().toLowerCase();
  const shown = ((lastData && lastData.candidates) || []).filter((c) => candMatches(c, q));
  for (const c of shown) {
    if (e.target.checked) candSel.add(c.id); else candSel.delete(c.id);
  }
  if (lastData) renderCandidates(lastData);
});

document.getElementById('cand-bulk-cancel').addEventListener('click', () => {
  candSel.clear();
  if (lastData) renderCandidates(lastData);
});

document.getElementById('cand-bulk-dismiss').addEventListener('click', () => runBulk('dismiss'));
document.getElementById('cand-bulk-clear').addEventListener('click', async () => {
  const n = candSel.size;
  const ok = await confirmBulk(
    `Clear ${n} candidate${n === 1 ? '' : 's'}?`,
    'This deletes them now. Dismissed candidates go away on their own after 7 days, ' +
    'if you would rather keep the option to restore them.',
    `Clear ${n}`
  );
  if (ok) runBulk('clear');
});

// A bulk action runs against a selection built a moment ago, so a card may have
// been launched in another tab in between. Report exactly that rather than a
// blanket "done" — or worse, a blanket failure.
async function runBulk(action) {
  const ids = [...candSel];
  if (!ids.length) return;
  try {
    const res = await fetch('/api/candidates/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ids }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || res.statusText);
    candSel.clear();
    const verb = action === 'clear' ? 'Cleared' : 'Dismissed';
    const missed = [...r.skipped.map((s) => s.status), ...r.notFound.map(() => 'gone')];
    const tally = missed.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
    const note = Object.entries(tally)
      .map(([s, k]) => `${k} had already been ${s === 'gone' ? 'removed' : s}`)
      .join(' · ');
    toast(`${verb} ${r.done}` + (note ? ` · ${note}` : ''), true);
    refreshCandidates();
  } catch (err) {
    toast(`Bulk ${action} failed: ${err.message}`);
  }
}

const bcDialog = document.getElementById('bulk-confirm-dialog');
let bcResolve = null;
function confirmBulk(title, copy, goLabel) {
  document.getElementById('bc-title').textContent = title;
  document.getElementById('bc-copy').textContent = copy;
  document.getElementById('bc-go').textContent = goLabel; // same verb + count as the button clicked
  bcDialog.showModal();
  return new Promise((resolve) => { bcResolve = resolve; });
}
function closeBulkConfirm(answer) {
  if (bcDialog.open) bcDialog.close();
  if (bcResolve) { bcResolve(answer); bcResolve = null; }
}
document.getElementById('bc-go').addEventListener('click', () => closeBulkConfirm(true));
document.getElementById('bc-cancel').addEventListener('click', () => closeBulkConfirm(false));
document.getElementById('bc-close').addEventListener('click', () => closeBulkConfirm(false));
bcDialog.addEventListener('close', () => closeBulkConfirm(false)); // Esc

// ---- new-candidate dialog (mirrors the New Session form, but stages instead
// of launching — it POSTs to /api/candidates)
const ncDialog = document.getElementById('new-candidate-dialog');
const ncCwd = document.getElementById('nc-cwd');
const ncSkill = document.getElementById('nc-skill');
const ncSkillDesc = document.getElementById('nc-skill-desc');
const ncPrompt = document.getElementById('nc-prompt');
let ncSkillDescriptions = {};

async function ncLoadSkills() {
  try {
    const res = await fetch('/api/skills?cwd=' + encodeURIComponent(ncCwd.value.trim()));
    const { skills } = await res.json();
    ncSkillDescriptions = Object.fromEntries(skills.map((s) => [s.name, s.description]));
    const current = ncSkill.value;
    ncSkill.innerHTML =
      '<option value="">(none — free-form prompt)</option>' +
      skills.map((s) => `<option value="${s.name}">/${s.name}${s.scope !== 'user' ? ' · ' + s.scope : ''}</option>`).join('');
    if (ncSkillDescriptions[current] !== undefined) ncSkill.value = current;
    ncUpdateSkillUi();
  } catch { /* dropdown still usable with just "(none)" */ }
}

function ncUpdateSkillUi() {
  const skill = ncSkill.value;
  ncSkillDesc.textContent = skill ? ncSkillDescriptions[skill] || '' : '';
  document.getElementById('nc-prompt-label').textContent = skill ? `Arguments for /${skill}` : 'Prompt';
  ncPrompt.placeholder = skill ? `arguments for /${skill}` : 'What should this session work on?';
}

ncSkill.addEventListener('change', ncUpdateSkillUi);
ncCwd.addEventListener('change', ncLoadSkills);

// the same dialog serves "new" (POST) and "edit" (PATCH) — ncEditId picks which.
let ncEditId = null;
const ncReason = document.getElementById('nc-reason');
const ncPriority = document.getElementById('nc-priority');
const ncTitle = document.getElementById('nc-dialog-title');
const ncEyebrow = document.getElementById('nc-eyebrow');
const ncIdent = document.getElementById('nc-ident');
const ncPromptMeta = document.getElementById('nc-prompt-meta');
const ncSubmit = document.getElementById('nc-submit');

// live line/char count in the prompt editor bar
function ncUpdatePromptMeta() {
  const v = ncPrompt.value;
  if (!v) { ncPromptMeta.textContent = ''; return; }
  const lines = v.split('\n').length;
  ncPromptMeta.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${v.length} chars`;
}
ncPrompt.addEventListener('input', ncUpdatePromptMeta);

async function ncLoadProjects() {
  try {
    const { projects } = await (await fetch('/api/projects')).json();
    document.getElementById('nc-projects').innerHTML = projects.map((p) => `<option value="${p}"></option>`).join('');
  } catch { /* picker still usable without suggestions */ }
}

document.getElementById('new-candidate-btn').addEventListener('click', async () => {
  ncEditId = null;
  ncEyebrow.textContent = 'New candidate';
  ncTitle.textContent = 'New candidate session';
  ncIdent.hidden = true; ncIdent.textContent = '';
  ncSubmit.textContent = 'Add candidate';
  ncCwd.required = true; // a new candidate needs a folder to launch into
  ncCwd.value = ''; ncPrompt.value = ''; ncSkill.value = ''; ncReason.value = ''; ncPriority.value = '0';
  ncUpdatePromptMeta();
  await ncLoadProjects();
  ncLoadSkills();
  ncUpdateSkillUi();
  ncDialog.showModal();
  ncCwd.focus();
});

// Open the same dialog to EDIT an existing candidate — a roomy popup with the
// prompt as the hero, folder suggestions, and the candidate's identity up top.
async function openCandEdit(c) {
  ncEditId = c.id;
  ncEyebrow.textContent = 'Edit candidate';
  ncTitle.textContent = candTitle(c);
  ncIdent.textContent = '';
  const ref = c.ref || {};
  const chan = ref.channelName || (ref.slackPermalink ? 'Slack thread' : '');
  if (chan) { const s = document.createElement('span'); s.className = 'chip mono'; s.textContent = `💬 ${chan}`; ncIdent.appendChild(s); }
  ncIdent.hidden = ncIdent.children.length === 0;
  ncSubmit.textContent = 'Save changes';
  ncCwd.required = false; // editing may leave the folder empty (set it later)
  ncCwd.value = c.action.cwd || '';
  ncReason.value = c.reason || '';
  ncPriority.value = c.priority || 0;
  ncPrompt.value = c.action.prompt || '';
  ncUpdatePromptMeta();
  await ncLoadProjects();
  await ncLoadSkills();
  // select the current skill even if it isn't in the folder's list
  if (c.action.skill && ![...ncSkill.options].some((o) => o.value === c.action.skill)) {
    ncSkill.add(new Option(`/${c.action.skill}`, c.action.skill));
  }
  ncSkill.value = c.action.skill || '';
  ncUpdateSkillUi();
  ncDialog.showModal();
  ncPrompt.focus();
}

document.getElementById('nc-cancel').addEventListener('click', () => ncDialog.close());
document.getElementById('nc-close').addEventListener('click', () => ncDialog.close());

document.getElementById('new-candidate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const editing = ncEditId;
  withFeedback(btn, editing ? 'Save failed' : 'Add failed', async () => {
    const body = {
      cwd: ncCwd.value.trim(),
      skill: ncSkill.value,
      prompt: ncPrompt.value.trim(),
      reason: ncReason.value.trim(),
      priority: Number(ncPriority.value) || 0,
    };
    if (editing) {
      await patch(`/api/candidates/${editing}`, body);
      toast('Candidate updated', true);
    } else {
      await post('/api/candidates', { ...body, source: 'manual' });
      toast('Candidate added', true);
    }
    ncDialog.close();
    await refreshCandidates();
  }, editing ? '✓ Saved' : '✓ Added');
});

// ----------------------------------------------------------------- watchers

const watchTemplate = document.getElementById('watcher-template');
let watchEditOpen = false; // true while an inline channel time-editor is open (pauses re-render)
let lastWatchSig = null; // signature of the last watcher render — skip rebuilds when unchanged
let watchFlashName = null; // a just-saved watcher: scroll to its card once and flash it

// Re-pull watcher status and re-render now, so a Pause/Resume/Run reflects
// immediately instead of waiting for the next SSE tick.
async function refreshWatchers() {
  try {
    const status = await (await fetch('/api/watchers')).json();
    if (lastData) {
      lastData.watchers = status;
      renderWatchers(lastData);
    }
  } catch { /* the next SSE snapshot will reconcile */ }
}

function watchAction(name, verb) {
  return async () => {
    try {
      const res = await fetch(`/api/watchers/${encodeURIComponent(name)}/${verb}`, { method: 'POST' });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'failed');
      toast(`Watcher ${name}: ${verb} ✓`, true);
      await refreshWatchers();
    } catch (err) { toast(`${verb} failed: ${err.message}`); }
  };
}

// The two watcher types the UI names: a Slack watcher, and a Generic watcher
// (a prompt of your own on a cadence — `trigger.type: 'schedule'` in config).
const TRIGGER_GLYPH = { slack: '⌗', schedule: '◷', github: '⎇' };
const TYPE_LABEL = { slack: 'slack', schedule: 'generic', github: 'github' };

/** "every 30m" / "daily 09:00" / a cron expression — a schedule in words. */
function scheduleText(w) {
  if (w.cron) return `cron ${w.cron}`;
  if (w.at) return `daily ${w.at}`;
  if (!w.everyMinutes) return '';
  return w.everyMinutes % 60 === 0 && w.everyMinutes >= 60
    ? `every ${w.everyMinutes / 60}h`
    : `every ${w.everyMinutes}m`;
}

function buildWatcher(w) {
  const card = watchTemplate.content.cloneNode(true).querySelector('.watch-card');
  const type = w.type || w.trigger || 'slack';
  const schedule = type === 'schedule';
  card.dataset.state = w.state;
  card.dataset.name = w.name; // lets refreshWatchVolatile find this card without a rebuild
  card.querySelector('.watch-name').textContent = w.name;
  card.querySelector('.watch-trigger').textContent =
    `${TRIGGER_GLYPH[type] || '·'} ${TYPE_LABEL[type] || type}`;
  card.querySelector('.watch-auto').hidden = !w.discover;

  const stateEl = card.querySelector('.watch-state');
  stateEl.textContent = w.state;
  stateEl.className = 'watch-state watch-state-' + w.state;

  // a pulsing dot when the watcher is actively running — the at-a-glance "alive"
  card.querySelector('.watch-live').hidden = w.state !== 'running';

  // a schedule watcher has no channels — it shows the prompt it will run; a
  // github watcher shows the query it asks. Only slack watchers list channels.
  const github = type === 'github';
  const body = card.querySelector('.watch-body');
  body.hidden = !schedule && !github;
  if (schedule) card.querySelector('.watch-prompt').textContent = w.prompt || '(no prompt)';
  else if (github) card.querySelector('.watch-prompt').textContent = w.search || 'review-requested:@me is:open is:pr';
  else renderWatchChannels(card.querySelector('.watch-channels'), w);

  // poll time is the real (uniform) liveness signal — lead with it, relative + bright
  const poll = card.querySelector('.watch-lastpoll');
  if (schedule) {
    poll.textContent = scheduleText(w);
  } else {
    poll.textContent = w.lastPollAt ? `polled ${agoText(w.lastPollAt)}` : 'not polled yet';
    poll.title = w.lastPollAt ? `last poll ${fmtTime(w.lastPollAt)}` : '';
    poll.classList.toggle('live', w.state === 'running' && !!w.lastPollAt);
  }
  card.querySelector('.watch-every').textContent =
    !schedule && w.everySeconds ? `every ${w.everySeconds}s` : '';
  const n = (w.channels || []).length;
  card.querySelector('.watch-channelcount').textContent =
    !schedule && n ? `${n} channel${n === 1 ? '' : 's'}` : '';
  card.querySelector('.watch-staged').textContent = `${w.staged || 0} staged`;
  // the chip carries what governs the watcher: rule count (slack) or skill (schedule)
  const rulesEl = card.querySelector('.watch-rules');
  const chip = schedule ? (w.skill ? `/${w.skill}` : '') : (w.rules ? `${w.rules} rule${w.rules === 1 ? '' : 's'}` : '');
  rulesEl.hidden = !chip;
  rulesEl.textContent = chip;

  const errEl = card.querySelector('.watch-error');
  errEl.hidden = !w.lastError;
  if (w.lastError) {
    // an offline blip reads as weather, not a fault — same line, softer glyph
    errEl.textContent = (w.state === 'offline' ? '◌ ' : '⚠ ') + w.lastError;
  }

  // after a save the grid rebuilds; point at the card that changed instead of
  // leaving it to be found among the others
  if (watchFlashName === w.name) {
    watchFlashName = null;
    card.classList.add('just-saved');
    requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  card.querySelector('.watch-edit').addEventListener('click', () => openWatcherEditor(w.name));
  card.querySelector('.watch-delete').addEventListener('click', () => deleteWatcher(w.name));

  const pauseBtn = card.querySelector('.watch-pause');
  const resumeBtn = card.querySelector('.watch-resume');
  const runBtn = card.querySelector('.watch-run');
  const paused = w.state === 'paused' || w.state === 'disabled';
  // Pause/Resume/Run-now are poll-loop controls; a schedule watcher isn't run by
  // it yet, so offering them would promise something that can't happen.
  pauseBtn.hidden = paused || schedule;
  resumeBtn.hidden = !paused || schedule;
  runBtn.hidden = schedule;
  pauseBtn.addEventListener('click', watchAction(w.name, 'pause'));
  resumeBtn.addEventListener('click', watchAction(w.name, 'resume'));
  runBtn.addEventListener('click', watchAction(w.name, 'run'));
  return card;
}

// "1m ago" / "3h ago" / "2d ago" — used for the watcher's poll time (its real
// liveness signal). Channels intentionally do NOT use a relative age: their
// "watching since" point is a fixed floor, and a relative age there reads as
// staleness when a quiet channel is perfectly healthy.
function agoText(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}
function fmtSince(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// compact: time-only when it's today, else date+time — for the ⏱ button label
function fmtSinceShort(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Each channel row: name over its "from <point>" floor (the saved query start),
// plus a per-channel pause toggle and a ⏱ control to change the floor. A paused
// channel is skipped every poll and dimmed here.
function renderWatchChannels(container, w) {
  container.textContent = '';
  const channels = w.channels || [];

  if (channels.length > 1) {
    const head = document.createElement('div');
    head.className = 'wc-chan-head';
    const setAll = document.createElement('button');
    setAll.className = 'wc-setall';
    setAll.textContent = 'Watch all from now';
    setAll.title = "Move every channel's start point to now — skip any earlier backlog (does not poll)";
    setAll.addEventListener('click', () => setAllWatchCursors(w));
    head.appendChild(setAll);
    container.appendChild(head);
  }

  if (!channels.length) {
    const empty = document.createElement('div');
    empty.className = 'wc-chan-empty';
    empty.textContent = w.discover ? 'discovering channels on next poll…' : 'no channels';
    container.appendChild(empty);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'wc-chans-wrap';
  if (channels.length > 5) wrap.classList.add('overflowing'); // show scroll fade
  const list = document.createElement('div');
  list.className = 'wc-chans';
  for (const ch of channels) {
    const row = document.createElement('div');
    row.className = 'watch-chan' + (ch.paused ? ' paused' : '');

    const main = document.createElement('div');
    main.className = 'chan-main';
    const name = document.createElement('div');
    name.className = 'chan-name';
    name.textContent = ch.name || ch.id;
    name.title = ch.name ? `${ch.name} (${ch.id})` : ch.id;
    // The channel's recency of the last check — recent, so it reads as "live",
    // not stale. The fixed "watch from" floor lives on the ⏱ tooltip instead.
    const sub = document.createElement('div');
    sub.className = 'chan-sub';
    if (ch.paused) {
      sub.textContent = 'paused';
    } else {
      sub.append(document.createTextNode('checked '));
      const age = document.createElement('span');
      age.className = 'chan-age';
      age.textContent = w.lastPollAt ? agoText(w.lastPollAt) : 'not yet';
      sub.appendChild(age);
    }
    main.append(name, sub);

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'chan-pause';
    pauseBtn.textContent = ch.paused ? '▶' : '⏸';
    pauseBtn.title = ch.paused ? 'Resume this channel' : 'Pause this channel';
    pauseBtn.addEventListener('click', () => setChannelPaused(w.name, ch, !ch.paused));

    const setBtn = document.createElement('button');
    setBtn.className = 'chan-set';
    setBtn.textContent = '⏱';
    setBtn.title = ch.watchingSince
      ? `Polling from ${fmtSince(ch.watchingSince)} — click to change`
      : 'Set the time to poll from';
    setBtn.addEventListener('click', () => openChannelTimeEditor({ row, sub, pauseBtn, setBtn, w, ch }));

    row.append(main, pauseBtn, setBtn);
    list.appendChild(row);
  }
  wrap.appendChild(list);
  container.appendChild(wrap);
}

async function setChannelPaused(name, ch, paused) {
  try {
    const res = await fetch(`/api/watchers/${encodeURIComponent(name)}/channel/${paused ? 'pause' : 'resume'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: ch.id }),
    });
    const r = await res.json();
    if (!res.ok || r.ok === false) throw new Error(r.error || 'failed');
    toast(`${ch.name || ch.id}: ${paused ? 'paused' : 'resumed'}`, true);
    await refreshWatchers();
  } catch (err) {
    toast(`Channel ${paused ? 'pause' : 'resume'} failed: ` + err.message);
  }
}

async function setAllWatchCursors(w) {
  const chans = w.channels || [];
  if (!chans.length) return;
  try {
    for (const ch of chans) {
      const res = await fetch(`/api/watchers/${encodeURIComponent(w.name)}/cursor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: ch.id, at: 'now' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'failed');
    }
    toast(`${w.name}: all channels watching from now`, true);
    await refreshWatchers();
  } catch (err) {
    toast('Set all failed: ' + err.message);
  }
}

// datetime-local value ("YYYY-MM-DDTHH:mm", local) for an ISO instant.
function toLocalInputValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function postWatchCursor(name, ch, at) {
  const res = await fetch(`/api/watchers/${encodeURIComponent(name)}/cursor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: ch.id, at }),
  });
  const r = await res.json();
  if (!res.ok || r.ok === false) throw new Error(r.error || 'failed');
  return r;
}

// Inline calendar/time editor on the row — replaces the sub-line with a native
// datetime picker + Now/Save/Cancel. No popup.
function openChannelTimeEditor({ row, sub, pauseBtn, setBtn, w, ch }) {
  if (row.classList.contains('editing')) return;
  row.classList.add('editing');
  watchEditOpen = true; // pause the periodic re-render so the picker isn't wiped
  pauseBtn.hidden = true;
  setBtn.hidden = true;
  sub.textContent = '';

  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.className = 'chan-time-input';
  input.value = toLocalInputValue(ch.watchingSince);

  const mk = (txt, cls, fn) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = txt;
    b.addEventListener('click', fn);
    return b;
  };
  const done = () => { watchEditOpen = false; return refreshWatchers(); };
  const commit = async (at) => {
    try {
      const r = await postWatchCursor(w.name, ch, at);
      const isPast = typeof at === 'number' && at < Date.now() - 60000;
      if (isPast) {
        // leave edit mode but keep render paused, and show the backfill on the row
        // while we poll from the past point right now (so it happens visibly).
        row.classList.remove('editing');
        pauseBtn.hidden = false;
        setBtn.hidden = false;
        sub.textContent = '';
        const bf = document.createElement('span');
        bf.className = 'chan-backfill';
        bf.textContent = `backfilling from ${fmtSince(r.watchingSince)}…`;
        sub.appendChild(bf);
        const run = await (await fetch(`/api/watchers/${encodeURIComponent(w.name)}/run`, { method: 'POST' })).json();
        if (run && run.ok !== false) {
          toast(run.staged ? `Backfill done · ${run.staged} new candidate${run.staged === 1 ? '' : 's'}` : 'Backfill done · nothing new', true);
        }
      } else {
        toast(`${ch.name || ch.id}: watching from now`, true);
      }
    } catch (err) {
      toast('Set failed: ' + err.message);
    }
    watchEditOpen = false; // resume rendering; the refresh clears the backfill line
    await refreshWatchers();
  };
  const ctrls = document.createElement('span');
  ctrls.className = 'chan-edit';
  ctrls.append(
    input,
    mk('Now', 'chan-edit-btn', () => commit('now')),
    mk('Save', 'chan-edit-btn primary', () => commit(input.value ? new Date(input.value).getTime() : 'now')),
    mk('Cancel', 'chan-edit-btn', done)
  );
  sub.appendChild(ctrls);
  input.focus();
}

// Everything that affects the grid's STRUCTURE. `lastPollAt`/`staged` are
// deliberately excluded: they move on every poll while their text is relative to
// now, so they are refreshed in place (below) instead of forcing a rebuild.
function watchSig(list) {
  return JSON.stringify(list.map((w) => ({ ...w, lastPollAt: null, staged: null })));
}

// The only two bits that change without a structural change. Updating them in
// place is what lets the rebuild be skipped on the vast majority of ticks.
function refreshWatchVolatile(list) {
  const grid = document.getElementById('watch-grid');
  for (const w of list) {
    const card = grid.querySelector(`.watch-card[data-name="${CSS.escape(w.name)}"]`);
    if (!card) continue;
    card.querySelector('.watch-staged').textContent = `${w.staged || 0} staged`;
    if ((w.type || w.trigger) === 'schedule') continue; // shows a schedule, not a poll age
    const poll = card.querySelector('.watch-lastpoll');
    poll.textContent = w.lastPollAt ? `polled ${agoText(w.lastPollAt)}` : 'not polled yet';
    poll.title = w.lastPollAt ? `last poll ${fmtTime(w.lastPollAt)}` : '';
    poll.classList.toggle('live', w.state === 'running' && !!w.lastPollAt);
  }
}

function renderWatchers(data) {
  // Don't rebuild the grid while a channel time-editor is open — the periodic
  // SSE snapshot would otherwise destroy the inline picker mid-edit. Forget the
  // signature too, so the render after it closes rebuilds from real state rather
  // than trusting a DOM the inline editor has been mutating.
  if (watchEditOpen) { lastWatchSig = null; return; }
  const status = data.watchers || { watchers: [] };
  const list = status.watchers || [];
  const grid = document.getElementById('watch-grid');

  // The SSE snapshot arrives every 1.5s. Rebuilding the grid then threw away
  // scroll position (jumping the tab to the top mid-read) plus hover and focus,
  // so only rebuild when something structural actually changed — same guard the
  // candidate grid uses.
  // include the flash target: a save should always rebuild so the just-saved card
  // gets its highlight, even when nothing structural changed.
  const sig = watchSig(list) + '|' + watchFlashName;
  if (sig === lastWatchSig) { refreshWatchVolatile(list); return; }
  lastWatchSig = sig;

  grid.textContent = '';
  for (const w of list) grid.appendChild(buildWatcher(w));

  document.getElementById('watch-empty').hidden = list.length > 0;
  const running = list.filter((w) => w.state === 'running').length;
  document.getElementById('watch-summary').textContent =
    list.length ? `${running} running · ${list.length} watcher${list.length === 1 ? '' : 's'}` : '';

  const badge = document.getElementById('watch-badge');
  badge.textContent = running;
  badge.hidden = running === 0;
}

document.getElementById('watch-stopall').addEventListener('click', async () => {
  try { await fetch('/api/watchers/stop-all', { method: 'POST' }); toast('All watchers paused', true); await refreshWatchers(); }
  catch (err) { toast('Stop-all failed: ' + err.message); }
});
document.getElementById('watch-startall').addEventListener('click', async () => {
  try {
    const r = await (await fetch('/api/watchers/start-all', { method: 'POST' })).json();
    if (r && r.ok === false) throw new Error(r.error || 'failed');
    toast('All watchers started', true); await refreshWatchers();
  } catch (err) { toast('Start-all failed: ' + err.message); }
});

// ------------------------------------------------------- watcher create / edit

// One dialog, two stage sets (Slack / Schedule). The editor holds a working copy
// of the watcher's v2 raw config; Save sends it as a patch to the API, which
// validates fail-closed and merges it onto what's stored (unknown keys and
// hand-written `//` comments therefore survive a round trip through this UI).
const wdDialog = document.getElementById('watcher-dialog');
const wtDialog = document.getElementById('watcher-trigger-dialog');
const wdEl = (id) => document.getElementById(id);

let skillCatalog = []; // [{ name, description, scope }] — for a rule's skill picker
// folder picker choices: every discovered checkout + recent project dirs (the
// same source the New Session launcher uses)
let folderData = { dirs: [], projects: [] };

const WD_OTHER = ' other'; // sentinel option value: "type a path myself"

/**
 * Fill a <select> + its sibling "other" text input from a list of
 * `{ value, label, group }` choices, preselecting `value`. A stored value that
 * isn't in the list (a folder that moved, a name typed by hand) selects Other…
 * and prefills it, so the form never silently drops what config already says.
 */
function wdFillPicker(id, choices, value) {
  const sel = wdEl(id);
  const other = wdEl(`${id}-other`);
  sel.textContent = '';
  let group = null;
  let groupEl = null;
  for (const c of choices) {
    const o = document.createElement('option');
    o.value = c.value;
    o.textContent = c.label;
    if (c.group) {
      if (c.group !== group) {
        group = c.group;
        groupEl = document.createElement('optgroup');
        groupEl.label = c.group;
        sel.append(groupEl);
      }
      groupEl.append(o);
    } else {
      group = null;
      sel.append(o);
    }
  }
  const o = document.createElement('option');
  o.value = WD_OTHER;
  o.textContent = 'Other…';
  sel.append(o);

  const known = choices.some((c) => c.value === (value || ''));
  sel.value = known ? (value || '') : WD_OTHER;
  other.hidden = sel.value !== WD_OTHER;
  other.value = known ? '' : (value || '');
}

/** The effective value of a select + "other" pair. */
function wdPickerValue(id) {
  const sel = wdEl(id);
  return sel.value === WD_OTHER ? wdEl(`${id}-other`).value.trim() : sel.value;
}

/** Fill a skill <select> from the installed catalog, keeping an unknown stored value. */
function wdFillSkillSelect(sel, value) {
  sel.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(no skill)';
  sel.append(none);
  for (const s of skillCatalog) {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = `/${s.name}${s.scope && s.scope !== 'user' ? ` · ${s.scope}` : ''}`;
    sel.append(o);
  }
  if (value && !skillCatalog.some((s) => s.name === value)) {
    const o = document.createElement('option'); // a skill that isn't installed here
    o.value = value;
    o.textContent = `/${value} (not found)`;
    sel.append(o);
  }
  sel.value = value || '';
}

function wdFolderChoices(noneLabel) {
  const seen = new Set();
  const out = [{ value: '', label: noneLabel }];
  for (const p of folderData.projects) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ value: p, label: p, group: 'Recent folders' });
  }
  for (const d of folderData.dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    out.push({ value: d, label: d, group: 'Repo checkouts' });
  }
  return out;
}

const wed = {
  kind: 'slack',       // 'slack' | 'schedule'
  editing: null,       // existing watcher name, or null when creating
  chanMode: 'auto',    // 'auto' | 'pick'
  schedMode: 'every',  // 'every' | 'daily' | 'cron'
  channels: [],        // picked channel ids
  live: [],            // channels the bot can see (from /api/watchers/channels)
  rules: [],           // [{ name, about, mentions:[], actionType, skill, prompt }]
  mentions: [],        // watcher-level mention allowlist (trigger.mentions)
  raw: null,           // the stored raw watcher, when editing
  rawOpen: false,
};

function wdSetError(msg) {
  const el = wdEl('wd-error');
  el.hidden = !msg;
  el.textContent = msg || '';
}

/** Build the patch that will be saved — also what the Raw JSON view shows. */
function wdPatch() {
  const name = wdEl('wd-name').value.trim();
  if (wed.kind === 'schedule') {
    const trigger = { type: 'schedule' };
    if (wed.schedMode === 'cron') trigger.cron = wdEl('wd-cron').value.trim();
    else if (wed.schedMode === 'daily') trigger.at = wdEl('wd-at').value.trim();
    else trigger.everyMinutes = parseInt(wdEl('wd-every').value, 10) || 60;
    return {
      name,
      trigger,
      skill: wdEl('wd-sched-skill').value,
      prompt: wdEl('wd-prompt').value.trim(),
      action: { cwd: wdPickerValue('wd-cwd2') },
    };
  }
  if (wed.kind === 'github') {
    const trigger = {
      type: 'github',
      search: wdEl('wd-gh-search').value.trim() || 'review-requested:@me is:open is:pr',
      jiraProjects: wed.ghProjects,
      skipDrafts: true,
      maxGroupSize: parseInt(wdEl('wd-gh-group').value, 10) || 5,
      maxStagePerTick: parseInt(wdEl('wd-gh-cap').value, 10) || 5,
      group: wed.ghGroupMode,
    };
    // saveWatcher merges the trigger shallowly over what's stored, so BOTH author
    // keys are always sent — the inactive one empty. Omitting it would leave a
    // stale stored list behind a mode switch, which the backend rejects
    // (includeAuthors and excludeAuthors cannot both be set).
    trigger.includeAuthors = wed.ghAuthorMode === 'only' ? wed.ghAuthors : [];
    trigger.excludeAuthors = wed.ghAuthorMode === 'only' ? [] : wed.ghAuthors;
    return {
      name,
      trigger,
      rules: wed.rules.map((r) => ({
        name: r.name,
        about: r.about,
        action: { type: 'skill', skill: r.skill },
      })),
      poll: { everySeconds: parseInt(wdEl('wd-gh-poll').value, 10) || 900 },
      prompt: wdEl('wd-gh-prompt').value.trim(),
      action: { cwd: wdPickerValue('wd-cwd3') },
    };
  }
  return {
    name,
    trigger: {
      type: 'slack',
      botRef: wdEl('wd-bot').value || 'default',
      mentions: wed.mentions,
      channels: wed.chanMode === 'auto' ? 'auto' : wed.channels,
    },
    rules: wed.rules.map((r) => ({
      name: r.name,
      about: r.about,
      action: r.actionType === 'prompt'
        ? { type: 'prompt', prompt: r.prompt }
        : { type: 'skill', skill: r.skill },
    })),
    poll: { everySeconds: parseInt(wdEl('wd-poll').value, 10) || 120 },
    action: { cwd: wdPickerValue('wd-cwd') },
  };
}

/** The plain-language "what this will do" line, kept in sync with the fields. */
function wdSummary() {
  const b = (s) => `<b>${escapeHtml(String(s))}</b>`;
  if (wed.kind === 'schedule') {
    const when = wed.schedMode === 'cron'
      ? `on cron ${b(wdEl('wd-cron').value.trim() || '—')}`
      : wed.schedMode === 'daily'
        ? `every day at ${b(wdEl('wd-at').value.trim() || '—')}`
        : `every ${b((wdEl('wd-every').value || '60') + ' min')}`;
    const sk = wdEl('wd-sched-skill').value;
    const as = sk ? ` under ${b('/' + sk)}` : '';
    return `Runs your prompt${as} as a session ${when}; it stages candidates and closes. ` +
      'Not executed yet — the runner still handles Slack triggers only.';
  }
  if (wed.kind === 'github') {
    const q = wdEl('wd-gh-search').value.trim() || 'review-requested:@me is:open is:pr';
    const stories = wed.ghGroupMode === 'all'
      ? 'everything selected folds into ONE batch card'
      : wed.ghProjects.length
        ? `PRs sharing a ${wed.ghProjects.map((k) => b(k)).join('/')} story key become one candidate`
        : 'PRs sharing a story key become one candidate';
    const authors = wed.ghAuthorMode === 'only'
      ? `only PRs by ${wed.ghAuthors.length ? wed.ghAuthors.map((a) => b(a)).join(', ') : b('nobody yet')}`
      : `bot authors${wed.ghAuthors.length ? ` and ${wed.ghAuthors.map((a) => b(a)).join(', ')}` : ''} skipped`;
    const rules = wed.rules.length
      ? `${b(wed.rules.length)} stack rule${wed.rules.length === 1 ? '' : 's'} pick the review skill`
      : 'no stack rules yet — candidates launch without a skill';
    return `Asks GitHub (as you, via ${b('gh')}) for ${b(q)}; ${authors}; ${stories}; ${rules}. ` +
      `Polls every ${b((wdEl('wd-gh-poll').value || '900') + 's')}, staging at most ` +
      `${b(wdEl('wd-gh-cap').value || '5')} new candidates per poll.`;
  }
  const bot = wdEl('wd-bot');
  const botName = (bot.selectedOptions[0] && bot.selectedOptions[0].textContent) || 'a bot';
  const where = wed.chanMode === 'auto'
    ? `every channel it is in${wed.live.length ? ` (${wed.live.length} today)` : ''}`
    : `${wed.channels.length} of ${wed.live.length || '?'} channels`;
  const who = wed.mentions.length ? wed.mentions.map((m) => b(m)).join(', ') : b('nobody yet');
  const rules = wed.rules.length
    ? `${b(wed.rules.length)} rule${wed.rules.length === 1 ? '' : 's'} stage a candidate on a match`
    : 'with no rules, the classifier picks a skill itself';
  return `As ${b(botName)}, watch ${b(where)} for mentions of ${who}; ${rules}. ` +
    `Polls every ${b((wdEl('wd-poll').value || '120') + 's')}.`;
}

function wdRenderMentions() {
  wdRenderChips('wd-mentions', wed.mentions, 'U01234ABCD', (v) => v.replace(/^<@|>$/g, ''));
}

function wdSync() {
  wdEl('wd-summary').innerHTML = wdSummary();
  if (wed.rawOpen) wdEl('wd-raw').value = JSON.stringify(wdPatch(), null, 2);
}

// ---- rules editor

function wdRuleCard(rule, i) {
  const card = document.createElement('div');
  card.className = 'rule-card';

  const head = document.createElement('div');
  head.className = 'rule-card-head';
  const idx = document.createElement('span');
  idx.className = 'idx';
  idx.textContent = `R${i + 1}`;
  const nameInp = document.createElement('input');
  nameInp.className = 'nm';
  nameInp.value = rule.name;
  nameInp.placeholder = 'rule name (e.g. review-go)';
  nameInp.addEventListener('input', () => { rule.name = nameInp.value; wdSync(); });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn danger';
  del.title = 'Remove this rule';
  del.textContent = '✕';
  del.addEventListener('click', () => {
    wed.rules.splice(i, 1);
    wdRenderRules();
    wdSync();
  });
  head.append(idx, nameInp, del);

  const body = document.createElement('div');
  body.className = 'rule-body';

  // WHEN: about (what the message is asking for)
  const when = document.createElement('div');
  when.className = 'wt';
  const whenKey = document.createElement('span');
  whenKey.className = 'wt-key';
  whenKey.textContent = 'When';
  const whenFields = document.createElement('div');
  whenFields.className = 'wt-fields';
  const aboutRow = document.createElement('div');
  aboutRow.className = 'cond';
  const aboutK = document.createElement('span');
  aboutK.className = 'k';
  aboutK.textContent = 'about';
  const aboutInp = document.createElement('input');
  aboutInp.className = 'inp';
  aboutInp.value = rule.about;
  aboutInp.placeholder = 'reviewing a Go PR';
  aboutInp.addEventListener('input', () => { rule.about = aboutInp.value; wdSync(); });
  aboutRow.append(aboutK, aboutInp);
  whenFields.append(aboutRow);
  when.append(whenKey, whenFields);

  // THEN: use a skill, or run a prompt
  const then = document.createElement('div');
  then.className = 'wt';
  const thenKey = document.createElement('span');
  thenKey.className = 'wt-key then';
  thenKey.textContent = 'Then';
  const thenFields = document.createElement('div');
  thenFields.className = 'wt-fields';

  const seg = document.createElement('div');
  seg.className = 'seg';
  const skillSel = document.createElement('select');
  skillSel.className = 'inp';
  const promptInp = document.createElement('textarea');
  promptInp.className = 'inp';
  promptInp.placeholder = 'what the launched session should do';
  promptInp.value = rule.prompt || '';
  promptInp.addEventListener('input', () => { rule.prompt = promptInp.value; wdSync(); });

  const applyAction = () => {
    for (const b of seg.children) b.classList.toggle('on', b.dataset.action === rule.actionType);
    skillSel.hidden = rule.actionType !== 'skill';
    promptInp.hidden = rule.actionType !== 'prompt';
  };
  for (const [action, label] of [['skill', 'Use a skill'], ['prompt', 'Run a prompt']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener('click', () => { rule.actionType = action; applyAction(); wdSync(); });
    seg.append(b);
  }

  wdFillSkillSelect(skillSel, rule.skill);
  skillSel.addEventListener('change', () => { rule.skill = skillSel.value; wdSync(); });

  const sentence = document.createElement('div');
  sentence.className = 'rule-sentence';
  const paint = () => {
    const about = rule.about ? `about <b>${escapeHtml(rule.about)}</b>` : 'in a watched channel';
    const act = rule.actionType === 'prompt'
      ? 'stage it with <b>a custom prompt</b>'
      : `stage using <b>${escapeHtml(rule.skill || 'no skill')}</b>`;
    sentence.innerHTML = `When a thread mentions you ${about} → ${act}.`;
  };
  paint();
  for (const el of [aboutInp, skillSel, promptInp]) el.addEventListener('input', paint);
  skillSel.addEventListener('change', paint);
  seg.addEventListener('click', paint);

  thenFields.append(seg, skillSel, promptInp);
  then.append(thenKey, thenFields);
  applyAction();

  body.append(when, then, sentence);
  card.append(head, body);
  return card;
}

function wdRenderRules() {
  const box = wdEl(wed.kind === 'github' ? 'wd-gh-rules' : 'wd-rules');
  box.textContent = '';
  wed.rules.forEach((r, i) => box.append(wdRuleCard(r, i)));
}

// ---- chip lists (mentions / jira projects / authors)

/** A removable-chip list over `arr`, rendered into #id — mentions, projects, authors. */
function wdRenderChips(id, arr, emptyPlaceholder, normalize = (v) => v) {
  const box = wdEl(id);
  box.textContent = '';
  arr.forEach((m, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = m;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.title = 'Remove';
    x.addEventListener('click', () => { arr.splice(i, 1); wdRenderChips(id, arr, emptyPlaceholder, normalize); wdSync(); });
    chip.append(x);
    box.append(chip);
  });
  const add = document.createElement('input');
  add.className = 'add';
  add.placeholder = arr.length ? 'add…' : emptyPlaceholder;
  add.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const v = normalize(add.value.trim());
    if (v && !arr.includes(v)) arr.push(v);
    wdRenderChips(id, arr, emptyPlaceholder, normalize);
    wdSync();
    wdEl(id).querySelector('.add').focus();
  });
  box.append(add);
}

// ---- channels

function wdRenderChannels() {
  const list = wdEl('wd-chan-list');
  const filter = wdEl('wd-chan-filter').value.trim().toLowerCase();
  // In auto mode the list is still shown — you should be able to see exactly what
  // the bot covers — but it is ticked-and-inert, since "all" isn't half-pickable.
  const auto = wed.chanMode === 'auto';
  list.classList.toggle('read-only', auto);
  list.textContent = '';
  const shown = wed.live.filter((c) => !filter || (c.name || c.id).toLowerCase().includes(filter));
  if (!wed.live.length) {
    const p = document.createElement('div');
    p.className = 'loading';
    p.textContent = wed.liveError || 'reading the bot\u2019s channels…';
    list.append(p);
  }
  for (const c of shown) {
    const picked = auto || wed.channels.includes(c.id);
    const row = document.createElement('div');
    row.className = 'chan-opt' + (picked ? ' on' : '');
    const box = document.createElement('span');
    box.className = 'box';
    box.textContent = picked ? '✓' : '';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.name ? `#${c.name}` : c.id;
    row.append(box, nm);
    if (c.archived) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'archived';
      row.append(tag);
    }
    if (!auto) {
      row.addEventListener('click', () => {
        const at = wed.channels.indexOf(c.id);
        if (at === -1) wed.channels.push(c.id);
        else wed.channels.splice(at, 1);
        wdRenderChannels();
        wdSync();
      });
    }
    list.append(row);
  }
  wdEl('wd-chan-count').textContent = !wed.live.length
    ? ''
    : auto ? `all ${wed.live.length}` : `${wed.channels.length} of ${wed.live.length}`;
}

async function wdLoadChannels() {
  const botRef = wdEl('wd-bot').value || 'default';
  wed.live = [];
  wed.liveError = '';
  wdEl('wd-chan-refresh').classList.add('spinning');
  wdRenderChannels();
  try {
    const r = await (await fetch(`/api/watchers/channels?botRef=${encodeURIComponent(botRef)}`)).json();
    if (r.ok === false) throw new Error(r.error || 'could not list channels');
    wed.live = (r.channels || []).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  } catch (err) {
    wed.liveError = `Could not list channels — ${err.message}`;
  }
  wdEl('wd-chan-refresh').classList.remove('spinning');
  wdRenderChannels();
  wdSync();
}

async function wdLoadBots(selected) {
  const sel = wdEl('wd-bot');
  sel.textContent = '';
  let bots = [];
  try {
    bots = (await (await fetch('/api/watchers/bots')).json()).bots || [];
  } catch { /* shown as "no bots" below */ }
  for (const b of bots) {
    const o = document.createElement('option');
    o.value = b.ref;
    o.textContent = b.identity && b.identity.user ? `${b.ref} — @${b.identity.user}` : b.ref;
    sel.append(o);
  }
  if (!bots.length) {
    const o = document.createElement('option');
    o.value = 'default';
    o.textContent = 'default (none configured)';
    sel.append(o);
  }
  sel.value = selected && bots.some((b) => b.ref === selected) ? selected : (bots[0] ? bots[0].ref : 'default');

  const bot = bots.find((b) => b.ref === sel.value);
  const conn = wdEl('wd-bot-conn');
  const txt = wdEl('wd-bot-conn-txt');
  conn.hidden = !bot;
  if (bot) {
    conn.classList.toggle('bad', !!bot.error);
    if (bot.error) {
      txt.textContent = `${bot.tokenRef || 'token'} — ${bot.error}`;
    } else {
      const id = bot.identity || {};
      txt.innerHTML = `Signed in as <b>@${escapeHtml(id.user || '?')}</b>` +
        (id.team ? ` in <b>${escapeHtml(id.team)}</b>` : '') +
        ` · token from <b>${escapeHtml(bot.tokenRef || '')}</b>`;
    }
  }
  return bots;
}

// ---- open / save / delete

function wdSetKind(kind) {
  wed.kind = kind;
  wdEl('wd-kind').textContent =
    kind === 'schedule' ? 'Generic' : kind === 'github' ? 'GitHub reviews' : 'Slack';
  wdEl('wd-slack-stages').hidden = kind !== 'slack';
  wdEl('wd-github-stages').hidden = kind !== 'github';
  wdEl('wd-schedule-stages').hidden = kind !== 'schedule';
}

function wdSetChanMode(mode) {
  const wasAuto = wed.chanMode === 'auto';
  wed.chanMode = mode;
  for (const b of wdEl('wd-chan-mode').children) b.classList.toggle('on', b.dataset.mode === mode);
  // Switching auto → pick with nothing stored would leave the watcher fail-closed
  // (no channels = doesn't run), so start from what auto covered and let the user
  // untick. An existing explicit list is left alone.
  if (mode === 'pick' && wasAuto && !wed.channels.length) {
    wed.channels = wed.live.map((c) => c.id);
  }
  wdRenderChannels();
}

function wdSetGhAuthorMode(mode) {
  wed.ghAuthorMode = mode;
  for (const b of wdEl('wd-gh-author-mode').children) b.classList.toggle('on', b.dataset.mode === mode);
}

function wdSetGhGroupMode(mode) {
  wed.ghGroupMode = mode;
  for (const b of wdEl('wd-gh-group-mode').children) b.classList.toggle('on', b.dataset.mode === mode);
}

function wdSetSchedMode(mode) {
  wed.schedMode = mode;
  for (const b of wdEl('wd-sched-mode').children) b.classList.toggle('on', b.dataset.mode === mode);
  wdEl('wd-every-wrap').hidden = mode !== 'every';
  wdEl('wd-at-wrap').hidden = mode !== 'daily';
  wdEl('wd-cron-wrap').hidden = mode !== 'cron';
}

/**
 * Open the editor. `name` = edit that watcher (its stored raw is fetched from
 * /api/watchers/config), or null + `kind` to create a new one.
 */
async function openWatcherEditor(name, kind) {
  wdSetError('');
  // Slack-backed setup, deferred until the dialog is actually on screen (below).
  let afterOpen = null;
  wed.editing = name || null;
  wed.rules = [];
  wed.mentions = [];
  wed.ghProjects = [];
  wed.ghAuthors = [];
  wed.ghAuthorMode = 'exclude';
  wed.ghGroupMode = 'story';
  wed.channels = [];
  wed.live = [];
  wed.liveError = '';
  wed.rawOpen = false;
  wdEl('wd-raw').hidden = true;
  wdEl('wd-raw-toggle').textContent = '▸ Raw JSON';
  wdEl('wd-raw-toggle').setAttribute('aria-expanded', 'false');

  try {
    const [sk, fo, pr] = await Promise.all([
      fetch('/api/skills?cwd=').then((r) => r.json()),
      fetch('/api/watchers/folders').then((r) => r.json()),
      fetch('/api/projects').then((r) => r.json()),
    ]);
    skillCatalog = sk.skills || [];
    folderData = { dirs: fo.dirs || [], projects: pr.projects || [] };
  } catch {
    // the pickers still offer "(none)" and "Other…", so the form stays usable
    skillCatalog = [];
    folderData = { dirs: [], projects: [] };
  }

  let raw = {};
  if (name) {
    try {
      const cfg = await (await fetch('/api/watchers/config')).json();
      const found = (cfg.watchers || []).find((w) => w.name === name);
      if (!found) throw new Error(`"${name}" is not in the config file`);
      raw = found.raw || {};
    } catch (err) {
      toast(`Could not load ${name}: ${err.message}`);
      return;
    }
  }
  wed.raw = raw;
  const trigger = raw.trigger || {};
  wdSetKind(kind || trigger.type || 'slack');

  wdEl('wd-eyebrow').textContent = name ? 'Edit watcher' : 'New watcher';
  wdEl('wd-submit').textContent = name ? 'Save changes' : 'Create watcher';
  wdEl('wd-delete').hidden = !name;
  wdEl('wd-name').value = raw.name || '';

  const action = raw.action || {};
  if (wed.kind === 'github') {
    wdEl('wd-gh-search').value = trigger.search || '';
    wed.ghProjects = Array.isArray(trigger.jiraProjects) ? [...trigger.jiraProjects] : [];
    const only = Array.isArray(trigger.includeAuthors) && trigger.includeAuthors.length > 0;
    wed.ghAuthorMode = only ? 'only' : 'exclude';
    wed.ghAuthors = [...((only ? trigger.includeAuthors : trigger.excludeAuthors) || [])];
    wdSetGhAuthorMode(wed.ghAuthorMode);
    wdSetGhGroupMode(trigger.group === 'all' ? 'all' : 'story');
    wdEl('wd-gh-prompt').value = raw.prompt || '';
    wdEl('wd-gh-group').value = trigger.maxGroupSize || 5;
    wdEl('wd-gh-cap').value = trigger.maxStagePerTick || 5;
    wed.rules = (Array.isArray(raw.rules) ? raw.rules : []).map((r) => {
      const a = (r && r.action) || {};
      return { name: r.name || '', about: r.about || '', actionType: 'skill', skill: a.skill || '', prompt: '' };
    });
    if (!name && !wed.rules.length) {
      // a new reviews watcher almost always wants the two stack rules — start
      // from them (editable/removable) instead of an empty list
      wed.rules = [
        { name: 'java', about: 'a Java service', actionType: 'skill', skill: '', prompt: '' },
        { name: 'go', about: 'a Go service', actionType: 'skill', skill: '', prompt: '' },
      ];
    }
    wdEl('wd-gh-poll').value = (raw.poll && raw.poll.everySeconds) || 900;
    wdFillPicker('wd-cwd3', wdFolderChoices('(none — pick it at launch)'), action.cwd);
    wdRenderChips('wd-gh-projects', wed.ghProjects, 'AK', (v) => v.toUpperCase());
    wdRenderChips('wd-gh-authors', wed.ghAuthors, 'a-buildbot', (v) => v.toLowerCase());
    wdRenderRules();
  } else if (wed.kind === 'schedule') {
    wdSetSchedMode(trigger.cron ? 'cron' : trigger.at ? 'daily' : 'every');
    wdEl('wd-every').value = trigger.everyMinutes || 60;
    wdEl('wd-at').value = trigger.at || '';
    wdEl('wd-cron').value = trigger.cron || '';
    wdFillSkillSelect(wdEl('wd-sched-skill'), raw.skill || '');
    wdEl('wd-prompt').value = raw.prompt || '';
    wdFillPicker('wd-cwd2', wdFolderChoices('(none — the session picks)'), action.cwd);
  } else {
    wed.mentions = Array.isArray(trigger.mentions) ? [...trigger.mentions] : [];
    wed.rules = (Array.isArray(raw.rules) ? raw.rules : []).map((r) => {
      const a = (r && r.action) || {};
      return {
        name: r.name || '',
        about: r.about || '',
        actionType: a.type === 'prompt' ? 'prompt' : 'skill',
        skill: a.skill || '',
        prompt: a.prompt || '',
      };
    });
    wdEl('wd-poll').value = (raw.poll && raw.poll.everySeconds) || 120;
    wdFillPicker('wd-cwd', wdFolderChoices('(none — pick it at launch)'), action.cwd);
    const auto = trigger.channels === 'auto' || trigger.channels === undefined;
    wed.channels = Array.isArray(trigger.channels) ? [...trigger.channels] : [];
    wdRenderMentions();
    wdRenderRules();
    // These hit Slack through the shared pacer, so they cost ~1s idle and were
    // measured at 11s mid-poll (a full pass would be ~70s). Awaiting them here
    // meant the Edit button did nothing visible for that whole time, so they run
    // after the dialog is up instead — the bot picker and channel list fill in.
    afterOpen = async () => {
      await wdLoadBots(trigger.botRef);
      wdSetChanMode(auto ? 'auto' : 'pick');
      wdLoadChannels(); // fresh every open, so an edit shows the bot's channels as they are now
    };
  }
  wdSyncCadences();
  wdSync();
  watchEditOpen = true; // stop the SSE re-render from rebuilding the tab under us
  wdDialog.showModal();
  if (afterOpen) await afterOpen();
}

async function saveWatcher() {
  let patch;
  if (wed.rawOpen) {
    try {
      patch = JSON.parse(wdEl('wd-raw').value);
    } catch (err) {
      wdSetError(`Raw JSON is not valid: ${err.message}`);
      return;
    }
  } else {
    patch = wdPatch();
  }
  if (!patch.name) return wdSetError('A name is required.');

  const url = wed.editing ? `/api/watchers/${encodeURIComponent(wed.editing)}` : '/api/watchers';
  try {
    const res = await fetch(url, {
      method: wed.editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const r = await res.json();
    if (!res.ok || r.ok === false) throw new Error(r.error || 'save failed');
    closeWatcherEditor();
    watchFlashName = r.name;
    toast(`Watcher ${r.name} ${r.created ? 'created' : 'saved'} — ${r.state}`, true);
    await refreshWatchers();
  } catch (err) {
    wdSetError(err.message);
  }
}

async function deleteWatcher(name) {
  if (!confirm(`Delete watcher "${name}"? Its config entry is removed; watch history is kept.`)) return;
  try {
    const res = await fetch(`/api/watchers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const r = await res.json();
    if (!res.ok || r.ok === false) throw new Error(r.error || 'delete failed');
    if (wdDialog.open) closeWatcherEditor();
    toast(`Watcher ${name} deleted`, true);
    await refreshWatchers();
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
}

function closeWatcherEditor() {
  wdDialog.close();
  watchEditOpen = false;
}

wdEl('watch-new').addEventListener('click', () => wtDialog.showModal());
wdEl('wt-close').addEventListener('click', () => wtDialog.close());
for (const opt of wtDialog.querySelectorAll('.trig-opt[data-kind]')) {
  opt.addEventListener('click', () => {
    wtDialog.close();
    openWatcherEditor(null, opt.dataset.kind);
  });
}

wdEl('wd-close').addEventListener('click', closeWatcherEditor);
wdEl('wd-cancel').addEventListener('click', closeWatcherEditor);
wdDialog.addEventListener('close', () => { watchEditOpen = false; });
wdEl('watcher-form').addEventListener('submit', (e) => { e.preventDefault(); saveWatcher(); });
wdEl('wd-delete').addEventListener('click', () => wed.editing && deleteWatcher(wed.editing));
for (const id of ['wd-add-rule', 'wd-gh-add-rule']) {
  wdEl(id).addEventListener('click', () => {
    wed.rules.push({ name: '', about: '', actionType: 'skill', skill: '', prompt: '' });
    wdRenderRules();
    wdSync();
  });
}
for (const b of wdEl('wd-chan-mode').children) {
  b.addEventListener('click', () => { wdSetChanMode(b.dataset.mode); wdSync(); });
}
for (const b of wdEl('wd-sched-mode').children) {
  b.addEventListener('click', () => { wdSetSchedMode(b.dataset.mode); wdSync(); });
}
for (const b of wdEl('wd-gh-author-mode').children) {
  b.addEventListener('click', () => { wdSetGhAuthorMode(b.dataset.mode); wdSync(); });
}
for (const b of wdEl('wd-gh-group-mode').children) {
  b.addEventListener('click', () => { wdSetGhGroupMode(b.dataset.mode); wdSync(); });
}
wdEl('wd-chan-filter').addEventListener('input', wdRenderChannels);
wdEl('wd-chan-refresh').addEventListener('click', wdLoadChannels);
// cadence controls: preset beats + a numeric stepper for a custom value. A beat
// sets the (hidden) input every other reader already uses, so nothing downstream
// needs to know this control exists.
const cadences = [];
for (const box of document.querySelectorAll('.cadence')) {
  const input = wdEl(box.dataset.input);
  const stepper = box.querySelector('.stepper');
  const beats = [...box.querySelectorAll('.beat')];
  const step = parseInt(stepper.dataset.step, 10) || 1;
  const min = parseInt(stepper.dataset.min, 10);
  const max = parseInt(stepper.dataset.max, 10);

  // reflect the input's value: light the matching beat, or fall back to Custom
  const sync = () => {
    const v = String(parseInt(input.value, 10) || '');
    const match = beats.find((b) => b.dataset.value === v);
    for (const b of beats) b.classList.toggle('on', b === (match || beats[beats.length - 1]));
    stepper.hidden = !!match;
  };
  cadences.push(sync);

  for (const b of beats) {
    b.addEventListener('click', () => {
      if (b.classList.contains('is-custom')) {
        stepper.hidden = false;
        for (const o of beats) o.classList.toggle('on', o === b);
        input.focus();
        input.select();
      } else {
        input.value = b.dataset.value;
        sync();
      }
      wdSync();
    });
  }

  const nudge = (dir) => {
    const cur = parseInt(input.value, 10);
    const from = Number.isFinite(cur) ? cur : min;
    // land on clean multiples of the step when nudging off an odd value
    const next = dir > 0 ? Math.floor(from / step) * step + step : Math.ceil(from / step) * step - step;
    input.value = Math.min(max, Math.max(min, next));
    wdSync();
  };
  stepper.querySelector('.step-dn').addEventListener('click', () => nudge(-1));
  stepper.querySelector('.step-up').addEventListener('click', () => nudge(1));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    nudge(e.key === 'ArrowUp' ? 1 : -1);
  });
  input.addEventListener('input', wdSync);
}

/** Light the beat that matches each cadence input (called after loading a watcher). */
function wdSyncCadences() {
  for (const sync of cadences) sync();
}

wdEl('wd-raw-toggle').addEventListener('click', () => {
  wed.rawOpen = !wed.rawOpen;
  wdEl('wd-raw').hidden = !wed.rawOpen;
  wdEl('wd-raw-toggle').textContent = wed.rawOpen ? '▾ Raw JSON' : '▸ Raw JSON';
  wdEl('wd-raw-toggle').setAttribute('aria-expanded', String(wed.rawOpen));
  wdSync();
});
// every field feeds the live summary (and the raw view when it's open)
for (const id of ['wd-name', 'wd-at', 'wd-cron', 'wd-prompt', 'wd-gh-search', 'wd-gh-group', 'wd-gh-cap', 'wd-gh-prompt']) {
  wdEl(id).addEventListener('input', wdSync);
}
wdEl('wd-sched-skill').addEventListener('change', wdSync);
for (const id of ['wd-cwd', 'wd-cwd2', 'wd-cwd3']) {
  wdEl(id).addEventListener('change', () => {
    const other = wdEl(`${id}-other`);
    other.hidden = wdEl(id).value !== WD_OTHER;
    if (!other.hidden) other.focus();
    wdSync();
  });
  wdEl(`${id}-other`).addEventListener('input', wdSync);
}

// ---------------------------------------------------------------- theme toggle

// Three modes: auto (follow the OS appearance, live — handles scheduled
// day/night switching), light, dark. No stored value = auto; an explicit
// choice pins and persists. A head-inline script applies the resolved theme
// before the stylesheet loads (no flash); this keeps the button in sync.
const themeBtn = document.getElementById('theme-toggle');
const systemLight = matchMedia('(prefers-color-scheme: light)');
const THEME_FACES = { auto: '🌗', light: '☀️', dark: '🌙' };
const THEME_ORDER = ['auto', 'light', 'dark'];
let themeMode = localStorage.theme || 'auto';

function applyTheme() {
  const resolved = themeMode === 'auto' ? (systemLight.matches ? 'light' : 'dark') : themeMode;
  document.documentElement.dataset.theme = resolved;
  themeBtn.textContent = THEME_FACES[themeMode];
  themeBtn.title = `Theme: ${themeMode === 'auto' ? 'auto (follows your system)' : themeMode} — click to change`;
}
applyTheme();
systemLight.addEventListener('change', () => { if (themeMode === 'auto') applyTheme(); });
themeBtn.addEventListener('click', () => {
  themeMode = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length];
  if (themeMode === 'auto') localStorage.removeItem('theme');
  else localStorage.theme = themeMode;
  applyTheme();
});

// ---------------------------------------------------------------- live connection

// the indicator only appears when the stream is broken — healthy is silent
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { conn.hidden = true; };
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    conn.textContent = 'reconnecting…';
    conn.className = 'conn err';
    conn.hidden = false;
  };
}

connect();
