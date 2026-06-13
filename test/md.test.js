'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { renderMarkdown, highlight, escapeHtml } = require('../web/public/md.js');

test('escapeHtml neutralizes HTML metacharacters', () => {
  assert.equal(escapeHtml('<b> & </b>'), '&lt;b&gt; &amp; &lt;/b&gt;');
});

test('renderMarkdown escapes raw HTML (no injection)', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderMarkdown renders headings at their literal level', () => {
  assert.ok(renderMarkdown('# Title').includes('<h1>Title</h1>'));
  assert.ok(renderMarkdown('### Sub').includes('<h3>Sub</h3>'));
});

test('renderMarkdown renders bold, italic, and inline code', () => {
  const html = renderMarkdown('**b** _i_ `c`');
  assert.ok(html.includes('<strong>b</strong>'));
  assert.ok(html.includes('<em>i</em>'));
  assert.ok(html.includes('<code>c</code>'));
});

test('renderMarkdown renders a fenced code block with a language badge', () => {
  const html = renderMarkdown('```js\nconst x = 1;\n```');
  assert.ok(html.includes('<pre data-lang="js">'));
  assert.ok(html.includes('<code>'));
});

test('renderMarkdown renders an ordered and an unordered list', () => {
  assert.ok(renderMarkdown('- a\n- b').includes('<ul>'));
  assert.ok(renderMarkdown('1. a\n2. b').includes('<ol>'));
});

test('renderMarkdown renders a table', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>A</th>'));
  assert.ok(html.includes('<td>1</td>'));
});

test('renderMarkdown renders blockquotes and horizontal rules', () => {
  assert.ok(renderMarkdown('> quoted').includes('<blockquote>'));
  assert.ok(renderMarkdown('---').includes('<hr>'));
});

test('highlight tints keywords, strings, numbers, and comments', () => {
  const out = highlight('// note\nconst x = "hi";');
  assert.ok(out.includes('class="hl-com"'));
  assert.ok(out.includes('class="hl-kw"'));
  assert.ok(out.includes('class="hl-str"'));
});
