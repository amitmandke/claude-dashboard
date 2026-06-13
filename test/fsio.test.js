'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readHead, readTail, parseLines, truncate } = require('../server/src/utils/fsio');

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsio-')), 'f.txt');
  fs.writeFileSync(p, contents);
  return p;
}

test('truncate collapses whitespace and trims', () => {
  assert.equal(truncate('  a \n b  ', 100), 'a b');
});

test('truncate caps with an ellipsis', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
});

test('truncate leaves short strings intact', () => {
  assert.equal(truncate('short', 100), 'short');
});

test('truncate returns empty string for non-strings', () => {
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
  assert.equal(truncate(42, 10), '');
});

test('readHead returns the first N bytes', () => {
  const p = tmpFile('hello world');
  assert.equal(readHead(p, 5), 'hello');
});

test('readHead caps at file size', () => {
  const p = tmpFile('hi');
  assert.equal(readHead(p, 1000), 'hi');
});

test('readHead returns empty string for a missing file', () => {
  assert.equal(readHead('/no/such/file/xyz', 10), '');
});

test('readTail drops the partial first line when truncated', () => {
  const p = tmpFile('line1\nline2\nline3\n');
  // ask for fewer bytes than the file: the first (partial) line is dropped
  const tail = readTail(p, 12);
  assert.ok(!tail.includes('line1'));
  assert.ok(tail.includes('line3'));
});

test('readTail returns whole file when bytes exceed size', () => {
  const p = tmpFile('a\nb\n');
  assert.equal(readTail(p, 1000), 'a\nb\n');
});

test('parseLines skips blank and unparseable lines', () => {
  const text = '{"a":1}\n\nnot json\n{"b":2}\n';
  assert.deepEqual(parseLines(text), [{ a: 1 }, { b: 2 }]);
});

test('parseLines returns empty array for empty input', () => {
  assert.deepEqual(parseLines(''), []);
});
