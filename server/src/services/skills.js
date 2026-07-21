'use strict';

/**
 * Skill / slash-command discovery — lists what a new session could start with,
 * the same things `/` offers inside Claude Code:
 *   ~/.claude/skills/<name>/SKILL.md      (user skills)
 *   ~/.claude/commands/<name>.md          (user commands)
 *   <cwd>/.claude/skills|commands         (project-level, when a cwd is chosen)
 *   enabled plugins under ~/.claude/plugins/…   (marketplace-installed skills)
 *
 * Plugins are the reason a freshly added skill can go missing from the picker:
 * an installed+enabled plugin ships its skill under
 * ~/.claude/plugins/… (not ~/.claude/skills), so it must be discovered from
 * settings.json `enabledPlugins` + plugins/installed_plugins.json rather than a
 * directory walk of the two well-known folders.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');

/** Value of a single `field:` line in the YAML frontmatter; '' when absent. */
function frontmatterField(file, field) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  if (end === -1) return '';
  const m = text.slice(0, end).match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

const frontmatterDescription = (file) => frontmatterField(file, 'description');

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

/** JSON-parse a file, returning `fallback` on any error (missing/corrupt). */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Install paths of plugins that are BOTH enabled (settings.json `enabledPlugins`)
 * and installed (plugins/installed_plugins.json). Only enabled plugins surface
 * their skills inside Claude Code, so the picker mirrors that.
 */
function enabledPluginPaths(claudeDir) {
  const settings = readJson(path.join(claudeDir, 'settings.json'), {});
  const enabled = settings.enabledPlugins || {};
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'), {});
  const byId = installed.plugins || {};
  const paths = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    const entries = byId[id];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // Prefer the most recently updated install when a plugin has several.
    const pick = entries.reduce((a, b) => ((b.lastUpdated || '') > (a.lastUpdated || '') ? b : a));
    if (pick && pick.installPath) paths.push({ id, installPath: pick.installPath });
  }
  return paths;
}

/**
 * A plugin can expose skills three ways, mirroring the user dirs: a root
 * SKILL.md (the plugin itself is one skill), a skills/ subtree, and a commands/
 * subtree. Root skills take their name from the manifest `name:` (falling back
 * to the plugin's base id) since there is no enclosing directory to name them.
 */
function pluginSkillsInto(claudeDir, out) {
  for (const { id, installPath } of enabledPluginPaths(claudeDir)) {
    const rootManifest = path.join(installPath, 'SKILL.md');
    if (fs.existsSync(rootManifest)) {
      const name = frontmatterField(rootManifest, 'name') || id.split('@')[0];
      out.set(name, { name, description: frontmatterDescription(rootManifest), scope: 'plugin' });
    }
    skillsIn(path.join(installPath, 'skills'), 'plugin', out);
    skillsIn(path.join(installPath, 'commands'), 'plugin', out);
  }
}

/**
 * All skills/commands available to a session started in `cwd`. On a name clash
 * the more specific scope wins: plugin < user < project (later writes override).
 * `claudeDir` is injectable so the discovery is unit-testable against a fixture.
 */
function collectSkills(cwd, claudeDir = config.CLAUDE_DIR) {
  const out = new Map();
  pluginSkillsInto(claudeDir, out);
  skillsIn(path.join(claudeDir, 'skills'), 'user', out);
  skillsIn(path.join(claudeDir, 'commands'), 'user', out);
  if (cwd) {
    skillsIn(path.join(cwd, '.claude', 'skills'), 'project', out);
    skillsIn(path.join(cwd, '.claude', 'commands'), 'project', out);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** All skills/commands available to a session started in `cwd`. */
function listSkills(cwd) {
  return collectSkills(cwd);
}

module.exports = { listSkills, collectSkills, enabledPluginPaths };
