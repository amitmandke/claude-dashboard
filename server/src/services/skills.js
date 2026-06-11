'use strict';

/**
 * Skill / slash-command discovery — lists what a new session could start with,
 * the same things `/` offers inside Claude Code:
 *   ~/.claude/skills/<name>/SKILL.md      (user skills)
 *   ~/.claude/commands/<name>.md          (user commands)
 *   <cwd>/.claude/skills|commands         (project-level, when a cwd is chosen)
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');

/** First `description:` line of YAML frontmatter; '' when absent. */
function frontmatterDescription(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  if (end === -1) return '';
  const m = text.slice(0, end).match(/^description:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

function skillsIn(dir, scope, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const manifest = path.join(dir, e.name, 'SKILL.md');
      if (fs.existsSync(manifest)) {
        out.set(e.name, { name: e.name, description: frontmatterDescription(manifest), scope });
      }
    } else if (e.name.endsWith('.md')) {
      const name = e.name.replace(/\.md$/, '');
      out.set(name, { name, description: frontmatterDescription(path.join(dir, e.name)), scope });
    }
  }
}

/** All skills/commands available to a session started in `cwd` (project wins on name clash). */
function listSkills(cwd) {
  const out = new Map();
  skillsIn(path.join(config.CLAUDE_DIR, 'skills'), 'user', out);
  skillsIn(path.join(config.CLAUDE_DIR, 'commands'), 'user', out);
  if (cwd) {
    skillsIn(path.join(cwd, '.claude', 'skills'), 'project', out);
    skillsIn(path.join(cwd, '.claude', 'commands'), 'project', out);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listSkills };
