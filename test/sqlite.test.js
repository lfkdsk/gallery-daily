'use strict';

// lib/sqlite.js 是自己手写的文件格式解析，出错会安静地给出错数据而不是报错，
// 所以拿一个覆盖各种取值形态的 fixture 盯住它。fixture 由 Python 的 sqlite3
// 生成（见 README），页大小特意设成 512，好让长文本走到溢出页、行数走到内部页。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { SqliteFile } = require('../lib/sqlite');

const db = new SqliteFile(fs.readFileSync(path.join(__dirname, 'fixture.db')));
const rows = db.table('sample');
const byId = new Map(rows.map((r) => [r.id, r]));

test('认出文件头并读出表结构', () => {
  assert.deepStrictEqual([...db.schema.keys()].sort(), ['plain', 'sample']);
  assert.deepStrictEqual(
    db.schema.get('sample').columns.map((c) => c.name),
    ['id', 'small', 'big', 'ratio', 'label', 'payload', 'maybe']
  );
  // 表级约束（FOREIGN KEY ...）不能被当成列
  assert.strictEqual(db.schema.get('sample').columns.length, 7);
});

test('非法输入直接报错，而不是给出垃圾数据', () => {
  assert.throws(() => new SqliteFile(Buffer.alloc(4096)), /不是 SQLite/);
  assert.throws(() => db.table('nope'), /表不存在/);
});

test('全表扫描要能走完内部页', () => {
  assert.strictEqual(rows.length, 299);
  assert.deepStrictEqual(
    rows.map((r) => r.id),
    Array.from({ length: 299 }, (_, i) => i + 1)
  );
});

test('INTEGER PRIMARY KEY 取的是 rowid', () => {
  // 这一列在记录里存的是 NULL，值只存在于 rowid
  assert.strictEqual(byId.get(1).id, 1);
  assert.strictEqual(byId.get(299).id, 299);
  // 普通表的普通列没有这层替换，NULL 就是 NULL
  assert.strictEqual(db.table('plain')[0].a, null);
});

test('各种宽度的整数、浮点和 NULL', () => {
  assert.strictEqual(byId.get(1).small, 0);
  assert.strictEqual(byId.get(1).big, 1);
  assert.strictEqual(byId.get(1).ratio, 0.5);
  assert.strictEqual(byId.get(1).maybe, null);

  assert.strictEqual(byId.get(2).small, -1);
  assert.strictEqual(byId.get(2).big, 2 ** 40);
  assert.strictEqual(byId.get(2).ratio, -2.25);

  assert.strictEqual(byId.get(3).big, -(2 ** 40));
  assert.strictEqual(byId.get(3).ratio, 1e-8);

  assert.strictEqual(byId.get(4).small, 32767);
  assert.strictEqual(byId.get(4).big, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(byId.get(4).ratio, Math.PI);
});

test('UTF-8 文本、空串和 BLOB', () => {
  assert.strictEqual(byId.get(2).label, '中文 · émoji 🚀');
  assert.strictEqual(byId.get(4).label, '');
  assert.strictEqual(byId.get(4).maybe, '');
  assert.ok(Buffer.isBuffer(byId.get(1).payload));
  assert.deepStrictEqual([...byId.get(1).payload], [0, 1, 2]);
  assert.strictEqual(byId.get(2).payload.length, 0);
  assert.strictEqual(byId.get(3).payload, null);
});

test('跨溢出页的 payload 要拼回完整内容', () => {
  // 页大小 512，4000 字节的文本必然溢出，而且不止一页
  assert.strictEqual(byId.get(3).label, 'x'.repeat(4000));
  assert.strictEqual(byId.get(4).payload.length, 900);
  assert.ok(byId.get(4).payload.every((b) => b === 0xff));
});

test('indexBy 按主键建索引', () => {
  const map = db.indexBy('sample');
  assert.strictEqual(map.size, 299);
  assert.strictEqual(map.get(2).label, '中文 · émoji 🚀');
});
