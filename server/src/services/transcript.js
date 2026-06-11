'use strict';

/**
 * Transcript parsing — extracts the initial prompt and a compact event feed
 * (user prompts, tool calls, assistant replies, tool errors) from the
 * session JSONL transcripts under ~/.claude/projects/.
 */

const config = require('../config');
const { readHead, readTail, parseLines, truncate } = require('../utils/fsio');

/** '/Users/me/code/my-app' -> '-Users-me-code-my-app' */
function encodeProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

function isRealUserPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return false;
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return !c.startsWith('<');
  if (Array.isArray(c)) {
    const t = c.find((b) => b.type === 'text');
    return !!t && !t.text.startsWith('<');
  }
  return false;
}

function userPromptText(entry) {
  const c = entry.message.content;
  if (typeof c === 'string') return c;
  const t = c.find((b) => b.type === 'text');
  return t ? t.text : '';
}

/** '<command-name>/my-skill</command-name>…<command-args>x</command-args>' -> '/my-skill x' */
function commandPromptText(raw) {
  const name = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (!name) return null;
  const args = raw.match(/<command-args>([^<]*)<\/command-args>/);
  return `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim();
}

/** First real user prompt of a session (what the session "started with").
 *  Sessions started via a slash command have no plain prompt — fall back to it. */
function firstPrompt(transcriptPath) {
  let commandFallback = null;
  for (const entry of parseLines(readHead(transcriptPath, config.HEAD_BYTES))) {
    if (isRealUserPrompt(entry)) {
      return { text: truncate(userPromptText(entry), 500), at: entry.timestamp };
    }
    if (!commandFallback && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
      const c = entry.message && entry.message.content;
      const raw = typeof c === 'string' ? c : '';
      const cmd = raw && commandPromptText(raw);
      if (cmd) commandFallback = { text: truncate(cmd, 500), at: entry.timestamp };
    }
  }
  return commandFallback;
}

function summarizeToolInput(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash':
      return input.description || input.command || '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path || '';
    case 'Glob':
    case 'Grep':
      return input.pattern || '';
    case 'Agent':
      return input.description || '';
    case 'WebFetch':
    case 'WebSearch':
      return input.url || input.query || '';
    case 'Skill':
      return input.skill || '';
    case 'AskUserQuestion':
      return (input.questions || []).map((q) => q.question).join(' | ');
    default:
      try {
        return truncate(JSON.stringify(input), 120);
      } catch {
        return '';
      }
  }
}

/**
 * Build the recent-activity feed from transcript tail entries.
 * Returns { events, model, lastAssistantText, pendingTool }.
 * pendingTool is the most recent tool call with no result yet — when a session
 * is `waiting`, this is the thing it is asking permission for / the question asked.
 */
function extractEvents(entries) {
  const events = [];
  let model = null;
  let lastAssistantText = null;
  let lastAssistantTail = null; // untruncated end of the last message — where a question would be
  let lastAssistantHead = null; // untruncated start — where a document header would be
  let lastAssistantLen = 0;
  let lastTurnSideEffect = false; // did the current turn land its work anywhere?
  const pendingToolNames = new Map(); // tool_use id -> tool name, to label errors
  const unresolved = new Map(); // tool_use id -> {tool, detail}, deleted when a result arrives

  for (const entry of entries) {
    if (entry.isSidechain) continue; // subagent internals — too noisy for the feed
    const ts = entry.timestamp;

    if (entry.type === 'assistant' && entry.message) {
      if (entry.message.model) model = entry.message.model;
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) {
          lastAssistantText = truncate(block.text, 300);
          lastAssistantTail = block.text.trim().slice(-400);
          lastAssistantHead = block.text.trim().slice(0, 400);
          lastAssistantLen = block.text.trim().length;
          events.push({ kind: 'assistant', text: truncate(block.text, 200), at: ts });
        } else if (block.type === 'tool_use') {
          pendingToolNames.set(block.id, block.name);
          const detail = truncate(summarizeToolInput(block.name, block.input), 300);
          if (isSideEffect(block.name, block.input)) lastTurnSideEffect = true;
          // for the approval banner, the literal command matters more than the description
          const pendingDetail =
            block.name === 'Bash' && block.input && block.input.command
              ? truncate(block.input.command, 300)
              : detail;
          unresolved.set(block.id, { tool: block.name, detail: pendingDetail });
          events.push({
            kind: 'tool',
            tool: block.name,
            detail: truncate(detail, 160),
            at: ts,
          });
        }
      }
    } else if (entry.type === 'user' && entry.message) {
      if (isRealUserPrompt(entry)) {
        events.push({ kind: 'user', text: truncate(userPromptText(entry), 200), at: ts });
        lastTurnSideEffect = false; // a new turn starts
        continue;
      }
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_result') unresolved.delete(block.tool_use_id);
        if (block.type === 'tool_result' && block.is_error) {
          let msg = '';
          if (typeof block.content === 'string') msg = block.content;
          else if (Array.isArray(block.content)) {
            const t = block.content.find((b) => b.type === 'text');
            msg = t ? t.text : '';
          }
          events.push({
            kind: 'error',
            tool: pendingToolNames.get(block.tool_use_id) || 'tool',
            detail: truncate(msg, 160),
            at: ts,
          });
        }
      }
    }
  }

  const pendingTool = [...unresolved.values()].pop() || null;
  return {
    events: events.slice(-config.MAX_EVENTS),
    model,
    lastAssistantText,
    lastAssistantTail,
    lastAssistantHead,
    lastAssistantLen,
    lastTurnSideEffect,
    pendingTool,
  };
}

// Tool calls whose effect lands outside the chat: pushed commits, posted comments,
// approvals, file edits. Used to tell "work delivered" from "deliverable only in chat".
// Matches mutating *invocations*, not words — "show PR commits" must not count.
const SIDE_EFFECT_TOOL = /^(Write|Edit|NotebookEdit)$/;
const MUTATING_COMMAND =
  /\bgit\s+(push|commit)\b|\bgh\s+(pr|issue)\s+(review|comment|merge|close|edit|create)\b|\bgh\s+api\b[^|;&]*(-X|--method)\s*(POST|PATCH|PUT|DELETE)|\bcurl\b[^|;&]*-X\s*(POST|PUT|PATCH|DELETE)/i;
const MUTATING_MCP = /add|create|edit|transition|approve|comment|update|post|send|delete|merge/i;

function isSideEffect(name, input) {
  if (SIDE_EFFECT_TOOL.test(name)) return true;
  if (name === 'Bash') return MUTATING_COMMAND.test((input && input.command) || '');
  if (name.startsWith('mcp__')) return MUTATING_MCP.test(name);
  return false;
}

// A final message that is a structured document (markdown headers) rather than
// conversation — e.g. a drafted review or report handed to the user in chat.
function looksLikeDeliverable(head) {
  return !!head && /^#{1,4}\s/m.test(head);
}

// Distinguish "Claude finished and is asking you something" from "turn fully complete".
// Heuristic on the end of the last assistant message — documented in DESIGN.md.
const REPLY_HINTS =
  /\b(let me know|should i|do you want|want me to|shall i|would you like|your (call|preference|choice)|which (one|option|approach)|waiting (for|on) you)\b/i;

function needsReply(lastAssistantTail) {
  if (!lastAssistantTail) return false;
  const t = lastAssistantTail.trim();
  return /\?$/.test(t) || REPLY_HINTS.test(t);
}

function parseTail(transcriptPath) {
  return extractEvents(parseLines(readTail(transcriptPath, config.TAIL_BYTES)));
}

module.exports = { encodeProjectDir, firstPrompt, parseTail, needsReply, looksLikeDeliverable };
