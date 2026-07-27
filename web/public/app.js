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
  card.hidden = activeFilter !== 'all' && st !== activeFilter;

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

  const visible = [...grid.children].filter((c) => !c.hidden).length;
  empty.hidden = visible > 0;

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

  document.getElementById('cand-count').textContent = list.length
    ? `${pending.length} pending` +
      (q ? ` · ${filtered.length} shown` : '') +
      (atCap ? ` · ${liveCount}/${caps.maxConcurrent} running (at cap)` : '')
    : '';
}

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

function buildWatcher(w) {
  const card = watchTemplate.content.cloneNode(true).querySelector('.watch-card');
  card.dataset.state = w.state;
  card.querySelector('.watch-name').textContent = w.name;
  card.querySelector('.watch-trigger').textContent = w.trigger ? `#${w.trigger}` : '';
  card.querySelector('.watch-auto').hidden = !w.discover;

  const stateEl = card.querySelector('.watch-state');
  stateEl.textContent = w.state;
  stateEl.className = 'watch-state watch-state-' + w.state;

  // a pulsing dot when the watcher is actively running — the at-a-glance "alive"
  card.querySelector('.watch-live').hidden = w.state !== 'running';

  renderWatchChannels(card.querySelector('.watch-channels'), w);

  // poll time is the real (uniform) liveness signal — lead with it, relative + bright
  const poll = card.querySelector('.watch-lastpoll');
  poll.textContent = w.lastPollAt ? `polled ${agoText(w.lastPollAt)}` : 'not polled yet';
  poll.title = w.lastPollAt ? `last poll ${fmtTime(w.lastPollAt)}` : '';
  poll.classList.toggle('live', w.state === 'running' && !!w.lastPollAt);
  card.querySelector('.watch-every').textContent = w.everySeconds ? `every ${w.everySeconds}s` : '';
  const n = (w.channels || []).length;
  card.querySelector('.watch-channelcount').textContent = n ? `${n} channel${n === 1 ? '' : 's'}` : '';
  card.querySelector('.watch-staged').textContent = `${w.staged || 0} staged`;

  const errEl = card.querySelector('.watch-error');
  errEl.hidden = !w.lastError;
  if (w.lastError) errEl.textContent = '⚠ ' + w.lastError;

  const pauseBtn = card.querySelector('.watch-pause');
  const resumeBtn = card.querySelector('.watch-resume');
  const runBtn = card.querySelector('.watch-run');
  const paused = w.state === 'paused' || w.state === 'disabled';
  pauseBtn.hidden = paused;
  resumeBtn.hidden = !paused;
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

function renderWatchers(data) {
  // Don't rebuild the grid while a channel time-editor is open — the periodic
  // SSE snapshot would otherwise destroy the inline picker mid-edit.
  if (watchEditOpen) return;
  const status = data.watchers || { watchers: [] };
  const list = status.watchers || [];
  const grid = document.getElementById('watch-grid');
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
