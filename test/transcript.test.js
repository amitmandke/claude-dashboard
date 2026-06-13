'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const t = require('../server/src/services/transcript');

function tmpJsonl(lines) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tx-')), 's.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('encodeProjectDir replaces non-alphanumerics with dashes', () => {
  assert.equal(t.encodeProjectDir('/Users/me/code/my-app'), '-Users-me-code-my-app');
});

test('needsReply: question mark at the end', () => {
  assert.equal(t.needsReply('So should I proceed?'), true);
});

test('needsReply: reply-hint phrase', () => {
  assert.equal(t.needsReply('let me know what you think'), true);
  assert.equal(t.needsReply('Want me to push this'), true);
});

test('needsReply: a plain statement does not need a reply', () => {
  assert.equal(t.needsReply('All done, everything passes.'), false);
});

test('needsReply: empty/falsy is false', () => {
  assert.equal(t.needsReply(''), false);
  assert.equal(t.needsReply(null), false);
});

test('looksLikeDeliverable detects a markdown header', () => {
  assert.equal(t.looksLikeDeliverable('## Findings\nstuff'), true);
  assert.equal(t.looksLikeDeliverable('just a sentence'), false);
});

test('commandPromptText extracts /name args', () => {
  const raw = '<command-name>/review-pr</command-name><command-args>1625</command-args>';
  assert.equal(t.commandPromptText(raw), '/review-pr 1625');
});

test('commandPromptText returns null without a command name', () => {
  assert.equal(t.commandPromptText('plain prompt'), null);
});

test('summarizeToolInput picks the right field per tool', () => {
  assert.equal(t.summarizeToolInput('Bash', { command: 'ls', description: 'list' }), 'list');
  assert.equal(t.summarizeToolInput('Bash', { command: 'ls' }), 'ls');
  assert.equal(t.summarizeToolInput('Read', { file_path: '/a/b.js' }), '/a/b.js');
  assert.equal(t.summarizeToolInput('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(t.summarizeToolInput('Skill', { skill: 'review' }), 'review');
});

test('isSideEffect: file writes and mutating commands count; reads do not', () => {
  assert.equal(t.isSideEffect('Edit', {}), true);
  assert.equal(t.isSideEffect('Write', {}), true);
  assert.equal(t.isSideEffect('Bash', { command: 'git push origin main' }), true);
  assert.equal(t.isSideEffect('Bash', { command: 'gh pr view 10' }), false);
  assert.equal(t.isSideEffect('Read', { file_path: '/a' }), false);
});

test('isSideEffect: mutating MCP tool names count', () => {
  assert.equal(t.isSideEffect('mcp__jira__create_issue', {}), true);
  assert.equal(t.isSideEffect('mcp__jira__get_issue', {}), false);
});

test('firstPrompt returns the first real user prompt', () => {
  const p = tmpJsonl([
    { type: 'user', message: { content: 'investigate the OOM' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
  ]);
  assert.equal(t.firstPrompt(p).text, 'investigate the OOM');
});

test('parseTail builds an event feed and finds the model', () => {
  const p = tmpJsonl([
    { type: 'user', message: { content: 'do a thing' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'working on it' },
          { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      timestamp: '2026-01-01T00:00:01Z',
    },
  ]);
  const r = t.parseTail(p);
  assert.equal(r.model, 'claude-opus-4-8');
  assert.ok(r.events.some((e) => e.kind === 'tool' && e.tool === 'Bash'));
  assert.ok(r.events.some((e) => e.kind === 'user'));
});

test('assistantTextAt returns the full untruncated message at a timestamp', () => {
  const long = 'A'.repeat(500);
  const p = tmpJsonl([
    { type: 'assistant', message: { content: [{ type: 'text', text: long }] }, timestamp: '2026-01-01T00:00:05Z' },
  ]);
  assert.equal(t.assistantTextAt(p, '2026-01-01T00:00:05Z'), long);
  assert.equal(t.assistantTextAt(p, '2026-01-01T00:00:09Z'), null);
});
