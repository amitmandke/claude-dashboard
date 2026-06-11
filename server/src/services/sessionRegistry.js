'use strict';

/**
 * Session registry — discovers live Claude Code sessions from
 * ~/.claude/sessions/<pid>.json (written by Claude Code itself) and enriches
 * each with details parsed from its transcript.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const transcript = require('./transcript');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STATUS_RANK = { waiting: 0, reply: 1, done: 2, busy: 3 }; // attention-needing first

function collectSessions() {
  let files = [];
  try {
    files = fs.readdirSync(config.SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const sessions = [];
  for (const file of files) {
    let reg;
    try {
      reg = JSON.parse(fs.readFileSync(path.join(config.SESSIONS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!reg.pid || !reg.sessionId || !isAlive(reg.pid)) continue;

    const transcriptPath = path.join(
      config.PROJECTS_DIR,
      transcript.encodeProjectDir(reg.cwd),
      reg.sessionId + '.jsonl'
    );

    let prompt = null;
    let parsed = { events: [], model: null, lastAssistantText: null, lastAssistantTail: null, pendingTool: null };
    let transcriptMtime = null;
    if (fs.existsSync(transcriptPath)) {
      prompt = transcript.firstPrompt(transcriptPath);
      parsed = transcript.parseTail(transcriptPath);
      try {
        transcriptMtime = fs.statSync(transcriptPath).mtimeMs;
      } catch {}
    }

    // Split "idle" into: turn complete vs the user still has to act. Two signals:
    // (a) Claude's last message asks a question, or
    // (b) the turn ended with a big deliverable (e.g. a drafted review) but no
    //     side-effecting action — the result lives only in the chat, so the user
    //     must do something with it.
    const status = reg.status || 'unknown';
    const awaitsUser =
      transcript.needsReply(parsed.lastAssistantTail) ||
      (transcript.looksLikeDeliverable(parsed.lastAssistantHead) && !parsed.lastTurnSideEffect);
    const derivedStatus = status === 'idle' ? (awaitsUser ? 'reply' : 'done') : status;

    sessions.push({
      pid: reg.pid,
      sessionId: reg.sessionId,
      cwd: reg.cwd,
      project: path.basename(reg.cwd),
      status, // raw registry value: idle | busy | waiting
      derivedStatus, // waiting | reply | done | busy | unknown
      waitingFor: reg.waitingFor || null,
      startedAt: reg.startedAt,
      statusUpdatedAt: reg.statusUpdatedAt || reg.updatedAt,
      version: reg.version,
      kind: reg.kind,
      model: parsed.model,
      firstPrompt: prompt,
      lastAssistantText: parsed.lastAssistantText,
      lastAssistantTail: parsed.lastAssistantTail,
      // what the session is blocked on (only meaningful while status is "waiting")
      pendingTool: parsed.pendingTool,
      contextTokens: parsed.contextTokens,
      recentOutputTokens: parsed.outputTokens,
      events: parsed.events,
      transcriptMtime,
    });
  }

  sessions.sort((a, b) => {
    const rank = (s) => (s.derivedStatus in STATUS_RANK ? STATUS_RANK[s.derivedStatus] : 4);
    return rank(a) - rank(b) || a.startedAt - b.startedAt;
  });
  return sessions;
}

module.exports = { collectSessions, isAlive };
