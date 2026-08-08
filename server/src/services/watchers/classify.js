'use strict';

/**
 * Agentic resolution: turn a Slack thread that mentions you into a candidate
 * plan — is it actual work, and if so which repo / skill / prompt. This reuses
 * the AI-titles machinery (headless `claude -p`, billed to the user's Claude
 * subscription, no API key; run in HEADLESS_CWD with CLAUDE_DASH_INTERNAL so the
 * worker is hidden from the registry). It is a read-only reasoning call — it
 * drafts a plan, it does not run tools or touch a repo; the real work happens
 * only if you click Launch.
 *
 * Runs strictly one-at-a-time (each call spawns a full Claude process), only on
 * a qualifying thread (never on idle polls). Any failure degrades to a
 * conservative "unclassified" plan so a mention is never silently dropped.
 */

const fs = require('fs');
const { spawn } = require('child_process');

const config = require('../../config');
const match = require('./match');

const TIMEOUT_MS = 90 * 1000;

let queue = Promise.resolve(); // generations run strictly one at a time

/**
 * Build the classifier prompt from the thread + context. Two modes:
 *  - intent mode (`intents` non-empty): match the thread to ONE configured
 *    intent by name (or none); the skill is decided by config, not the model.
 *  - free mode: the model judges actionability and picks a skill from `skills`.
 */
// Shared spec for the `prompt` field the model emits — the instruction handed to
// a fresh Claude session at launch. Deliberately a LIGHT hand-off, not a rich
// pre-solved brief: the skill supplies the *how* (it investigates at launch, and
// stays fresh); this prompt supplies only the *what* and the pointers to reach it.
// Pre-baking a diff summary or a findings table here would just duplicate the
// launched session's own work and go stale as the PR moves.
const PROMPT_FIELD =
  '"prompt": "<the instruction to hand a fresh Claude session that will do this work using the skill>"';
const PROMPT_RULES =
  'Write "prompt" as a crisp hand-off, not a solution:\n' +
  '  1. Say plainly what is being asked, in one or two sentences drawn from the thread — the human\'s actual request, not a paraphrase of every message.\n' +
  '  2. List the concrete pointers to investigate: PR links, Jira ticket IDs (e.g. AK-12345), repo names, and the Slack thread link.\n' +
  '  3. Do NOT pre-solve: never summarize a diff you have not read, invent findings, or restate the skill\'s own steps. The skill investigates at launch.\n' +
  '  Keep it under ~120 words.\n';

function buildPrompt({ threadText, prRefs = [], repos = [], skills = [], intents = [], permalink = '' }) {
  const repoLine = repos.length ? repos.join(', ') : '(none discovered)';
  const prLine = prRefs.length
    ? prRefs.map((r) => `${r.repo}#${r.number}`).join(', ')
    : '(no PR links in the thread)';
  const linkLine = permalink ? `Slack thread link: ${permalink}\n` : '';
  const head =
    'You triage a Slack thread that mentioned a specific engineer, to decide whether it is ' +
    'real work for them versus social chatter, an FYI, or an already-resolved discussion.\n\n';
  const context =
    `PR references detected: ${prLine}\n` +
    `Known repos (owner/repo): ${repoLine}\n` +
    linkLine +
    `\nThread (oldest first):\n${threadText}`;

  if (intents.length) {
    // Intent mode: the model names a matching intent AND drafts the launch prompt.
    // The skill, repo and reason are still derived deterministically by the caller
    // (the model does not choose the skill) — but the prompt is model-authored now,
    // because a crisp "what's being asked + pointers" hand-off beats the old raw
    // thread-text dump. `launchPromptFrom` stays as the deterministic fallback.
    const intentLines = intents.map((it) => `- ${it.name}: ${it.description || ''}`.trim()).join('\n');
    return (
      head +
      'Match the thread to exactly ONE of these intents, or null if none is actionable work for them:\n' +
      `${intentLines}\n\n` +
      'Reply with ONLY a JSON object, no prose, no code fences:\n' +
      `{"intent": "<intent-name>"|null, ${PROMPT_FIELD}, "confidence": 0.0-1.0}\n\n` +
      'Rules: "intent" MUST be exactly one of the names listed above, or null. If none fits, set ' +
      'intent to null and "prompt" may be empty.\n' +
      PROMPT_RULES +
      '\n' +
      context
    );
  }

  const skillLines = skills.map((s) => `- ${s.name}: ${s.description || ''}`.trim()).join('\n');
  return (
    head +
    'Reply with ONLY a JSON object, no prose, no code fences:\n' +
    '{"actionable": true|false, "repo": "owner/repo"|null, "skill": "<skill-name>"|null, ' +
    `${PROMPT_FIELD}, "reason": "<one line: why this is for them>", ` +
    '"confidence": 0.0-1.0}\n\n' +
    'Rules: pick "repo" from a PR link if present, else from the repo the thread is clearly about, ' +
    'else null. Pick "skill" ONLY from the list below (or null if none fits). If not actionable, set ' +
    '"actionable": false and the other fields may be null.\n' +
    PROMPT_RULES +
    `\nAvailable skills:\n${skillLines || '(none)'}\n\n` +
    context
  );
}

/** Extract the first JSON object from model output (tolerates fences/prose). */
function parseResult(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  return {
    actionable: obj.actionable === true,
    intent: typeof obj.intent === 'string' && obj.intent.trim() ? obj.intent.trim() : null,
    repo: typeof obj.repo === 'string' && obj.repo.trim() ? obj.repo.trim().toLowerCase() : null,
    skill: typeof obj.skill === 'string' && /^[\w:-]+$/.test(obj.skill.trim()) ? obj.skill.trim() : '',
    prompt: typeof obj.prompt === 'string' ? obj.prompt.trim() : '',
    reason: typeof obj.reason === 'string' ? obj.reason.trim() : '',
    confidence: Number.isFinite(obj.confidence) ? Math.max(0, Math.min(1, obj.confidence)) : 0,
  };
}

/**
 * Conservative fallback when the classifier can't run or returns garbage: stage
 * the mention anyway (never drop it) as unclassified, so the user decides. Uses
 * the first detected PR ref as a repo hint when there is one.
 */
function fallbackPlan({ prRefs = [] }) {
  return {
    actionable: true,
    intent: null,
    repo: prRefs[0] ? prRefs[0].repo : null,
    skill: '',
    // Leave prompt empty so the caller falls back to launchPromptFrom, which
    // carries the permalink + PR refs the raw thread slice would drop.
    prompt: '',
    reason: '(unclassified — Slack thread mentioning you; classifier unavailable)',
    confidence: 0,
    unclassified: true,
  };
}

function runHeadless(prompt) {
  // Mirrors aiTitles.runHeadless: a hidden, subscription-billed `claude -p` call.
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.HEADLESS_CWD, { recursive: true });
    const child = spawn(config.CLAUDE_BIN, ['-p', '--model', config.AI_TITLE_MODEL], {
      cwd: config.HEADLESS_CWD,
      env: { ...process.env, CLAUDE_DASH_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('classify timed out'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.end(prompt);
  });
}

/** Matches the timestamped line format the watcher loop logs with. */
function defaultLog(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

/**
 * Classify one thread → a plan. Queued so only one headless process runs at a
 * time. `_run` is injectable for tests (defaults to the real headless call).
 */
function classify(input, { _run = runHeadless, _log = defaultLog } = {}) {
  const task = queue.then(async () => {
    try {
      const plan = parseResult(await _run(buildPrompt(input)));
      return plan || fallbackPlan(input);
    } catch (e) {
      // Degrading to "unclassified" is deliberate, but doing it SILENTLY hid a
      // two-day outage: every candidate quietly arrived with no intent and no
      // skill after the `claude` binary moved. Always leave a trace.
      _log(`ERROR watcher classify unavailable, staging unclassified: ${e.message}`);
      return fallbackPlan(input);
    }
  });
  // keep the chain alive even if a caller ignores rejections (they can't: we catch)
  queue = task.catch(() => {});
  return task;
}

module.exports = { classify, buildPrompt, parseResult, fallbackPlan };
