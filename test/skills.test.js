'use strict';

// skills.js is integration-oriented (it walks ~/.claude), but the plugin
// discovery is pure enough to test against a temp fixture by injecting the
// claudeDir into collectSkills(). We build a throwaway ~/.claude look-alike.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { collectSkills, enabledPluginPaths } = require('../server/src/services/skills');

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const write = (rel, body) => {
    const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  return { root, write };
}

const fm = (fields) =>
  '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\nbody\n';

test('user skills and commands are discovered with their descriptions', () => {
  const { root, write } = mkFixture();
  write('skills/alpha/SKILL.md', fm({ description: 'the alpha skill' }));
  write('commands/beta.md', fm({ description: 'the beta command' }));

  const got = collectSkills('', root);
  assert.deepStrictEqual(
    got,
    [
      { name: 'alpha', description: 'the alpha skill', scope: 'user' },
      { name: 'beta', description: 'the beta command', scope: 'user' },
    ],
  );
});

test('an enabled plugin exposes its root SKILL.md (name from frontmatter)', () => {
  const { root, write } = mkFixture();
  const installPath = path.join(root, 'plugins', 'cache', 'mkt', 'my-plugin', '0.1.0');
  write('settings.json', JSON.stringify({ enabledPlugins: { 'my-plugin@mkt': true } }));
  write(
    'plugins/installed_plugins.json',
    JSON.stringify({ plugins: { 'my-plugin@mkt': [{ installPath, lastUpdated: '2026-07-18' }] } }),
  );
  write(
    path.join(installPath, 'SKILL.md'),
    fm({ name: 'debug-thing', description: 'a plugin skill' }),
  );

  const got = collectSkills('', root);
  assert.deepStrictEqual(got, [{ name: 'debug-thing', description: 'a plugin skill', scope: 'plugin' }]);
});

test('root plugin skill falls back to the plugin id when no name frontmatter', () => {
  const { root, write } = mkFixture();
  const installPath = path.join(root, 'plugins', 'cache', 'mkt', 'no-name', '1.0.0');
  write('settings.json', JSON.stringify({ enabledPlugins: { 'no-name@mkt': true } }));
  write('plugins/installed_plugins.json', JSON.stringify({ plugins: { 'no-name@mkt': [{ installPath }] } }));
  write(path.join(installPath, 'SKILL.md'), fm({ description: 'no name here' }));

  const got = collectSkills('', root);
  assert.deepStrictEqual(got, [{ name: 'no-name', description: 'no name here', scope: 'plugin' }]);
});

test('a plugin can also expose skills/ and commands/ subtrees', () => {
  const { root, write } = mkFixture();
  const installPath = path.join(root, 'plugins', 'cache', 'mkt', 'multi', '1.0.0');
  write('settings.json', JSON.stringify({ enabledPlugins: { 'multi@mkt': true } }));
  write('plugins/installed_plugins.json', JSON.stringify({ plugins: { 'multi@mkt': [{ installPath }] } }));
  write(path.join(installPath, 'skills', 'sub-skill', 'SKILL.md'), fm({ description: 'sub' }));
  write(path.join(installPath, 'commands', 'sub-cmd.md'), fm({ description: 'cmd' }));

  const names = collectSkills('', root).map((s) => s.name);
  assert.deepStrictEqual(names, ['sub-cmd', 'sub-skill']);
});

test('disabled or not-installed plugins contribute nothing', () => {
  const { root, write } = mkFixture();
  const installPath = path.join(root, 'plugins', 'cache', 'mkt', 'off', '1.0.0');
  write('settings.json', JSON.stringify({ enabledPlugins: { 'off@mkt': false, 'ghost@mkt': true } }));
  write('plugins/installed_plugins.json', JSON.stringify({ plugins: { 'off@mkt': [{ installPath }] } }));
  write(path.join(installPath, 'SKILL.md'), fm({ description: 'should not appear' }));

  assert.deepStrictEqual(enabledPluginPaths(root), []);
  assert.deepStrictEqual(collectSkills('', root), []);
});

test('the most recently updated install wins when a plugin has several', () => {
  const { root, write } = mkFixture();
  const oldPath = path.join(root, 'a');
  const newPath = path.join(root, 'b');
  write('settings.json', JSON.stringify({ enabledPlugins: { 'p@mkt': true } }));
  write(
    'plugins/installed_plugins.json',
    JSON.stringify({
      plugins: {
        'p@mkt': [
          { installPath: oldPath, lastUpdated: '2026-01-01' },
          { installPath: newPath, lastUpdated: '2026-07-01' },
        ],
      },
    }),
  );
  assert.deepStrictEqual(enabledPluginPaths(root), [{ id: 'p@mkt', installPath: newPath }]);
});

test('project scope overrides user, user overrides plugin, on a name clash', () => {
  const { root, write } = mkFixture();
  const installPath = path.join(root, 'plugins', 'cache', 'mkt', 'dup', '1.0.0');
  write('settings.json', JSON.stringify({ enabledPlugins: { 'dup@mkt': true } }));
  write('plugins/installed_plugins.json', JSON.stringify({ plugins: { 'dup@mkt': [{ installPath }] } }));
  write(path.join(installPath, 'SKILL.md'), fm({ name: 'clash', description: 'from plugin' }));
  write('skills/clash/SKILL.md', fm({ description: 'from user' }));

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'clash'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'clash', 'SKILL.md'), fm({ description: 'from project' }));

  const userOnly = collectSkills('', root).find((s) => s.name === 'clash');
  assert.strictEqual(userOnly.scope, 'user');
  assert.strictEqual(userOnly.description, 'from user');

  const withProject = collectSkills(cwd, root).find((s) => s.name === 'clash');
  assert.strictEqual(withProject.scope, 'project');
  assert.strictEqual(withProject.description, 'from project');
});
