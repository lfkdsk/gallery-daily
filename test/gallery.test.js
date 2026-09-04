'use strict';

// sqlite.db 和 feed.json 是两份各有权威部分的数据，合起来才是「有哪些照片、每张
// 是什么」。这里盯的是合并规则本身：谁决定收录、字段从哪来、选片是否稳定。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loadGallery, pickDaily, countsByDay, topValue, logoFile } = require('../lib/gallery');

const feed = JSON.parse(fs.readFileSync(path.join(__dirname, 'feed.json'), 'utf8'));
const { photos, albumCount } = loadGallery(fs.readFileSync(path.join(__dirname, 'gallery.db')), feed);
const byName = new Map(photos.map((p) => [p.name, p]));

test('收录范围由 feed 决定，两边对不上的都不要', () => {
  // D 只在数据库里（没 EXIF，没进 feed）；Z 只在 feed 里（数据库查无此路径）
  assert.deepStrictEqual(photos.map((p) => p.name), ['B', 'A', 'C']);
  assert.strictEqual(albumCount, 2);
});

test('按拍摄时间倒序', () => {
  assert.deepStrictEqual(
    photos.map((p) => p.date.toISOString()),
    ['2026-03-04T18:00:00.000Z', '2026-03-04T09:14:51.000Z', '2025-11-20T07:00:00.000Z']
  );
});

test('元信息按来源各取所长', () => {
  const a = byName.get('A');
  assert.strictEqual(a.album, 'Daily');          // 来自 album 表
  assert.strictEqual(a.model, 'X-S20');          // 来自 exifdata 表
  assert.strictEqual(a.lens, 'XF16-80mmF4 R OIS WR');
  assert.strictEqual(a.country, 'United States of America'); // 来自 location 表
  assert.strictEqual(a.link, 'https://gallery.lfkdsk.org?name=Daily/A.jpg'); // 来自 feed
  assert.strictEqual(a.shotAt, '2026-03-04 09:14:51');

  const b = byName.get('B');
  assert.strictEqual(b.livephoto, true);
  assert.strictEqual(b.country, ''); // 没有 location 就是空，不是 null
  assert.strictEqual(b.maker, 'Apple'); // EXIF 里的尾随空格要收掉
  assert.strictEqual(b.camera, 'Apple iPhone 15 Pro Max');
});

test('机型已经带了厂商就不再重复一遍', () => {
  // "FUJIFILM" + "X-S20" 要拼起来，"Apple" + "iPhone…" 也要；但机型自带厂商名时不该重复
  assert.strictEqual(byName.get('A').camera, 'FUJIFILM X-S20');
  assert.strictEqual(byName.get('C').camera, 'Hasselblad X2D II 100C');
});

test('缩略图地址换分支换后缀，原图地址保持原样', () => {
  const c = byName.get('C');
  assert.strictEqual(c.origin, 'https://cdn.jsdelivr.net/gh/lfkdsk/gallery@master/Tahoe/C-JPEG.webp');
  assert.strictEqual(c.thumb, 'https://cdn.jsdelivr.net/gh/lfkdsk/gallery@thumbnail/Tahoe/C-JPEG.webp');
  assert.strictEqual(byName.get('A').thumb, 'https://cdn.jsdelivr.net/gh/lfkdsk/gallery@thumbnail/Daily/A.webp');
});

test('同一天永远选到同一张，换一天要能换掉', () => {
  const first = pickDaily(photos, '2026-09-04');
  assert.strictEqual(pickDaily(photos, '2026-09-04'), first);
  assert.ok(photos.includes(first));
  // 换种子要真的会落到别的照片上，不能永远同一张
  const seeds = ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'];
  assert.ok(new Set(seeds.map((d) => pickDaily(photos, d).name)).size > 1);
  assert.strictEqual(pickDaily([], '2026-09-04'), null);
});

test('按天计数只算指定年份', () => {
  const counts = countsByDay(photos, 2026);
  assert.deepStrictEqual([...counts.entries()], [['2026-03-04', 2]]);
  assert.strictEqual(countsByDay(photos, 2025).get('2025-11-20'), 1);
  assert.strictEqual(countsByDay(photos, 2019).size, 0);
});

test('取众数', () => {
  assert.deepStrictEqual(topValue(photos, 'album'), { value: 'Tahoe', count: 2 });
  assert.strictEqual(topValue([], 'album'), null);
  // 空字符串不该被算成一个取值
  assert.strictEqual(topValue([{ x: '' }, { x: '' }], 'x'), null);
});

test('厂商 logo 的匹配容忍 EXIF 里的空格和大小写', () => {
  assert.strictEqual(logoFile('FUJIFILM'), 'fujifilm.png');
  assert.strictEqual(logoFile('RICOH IMAGING COMPANY, LTD.  '), '384_ricoh.jpg');
  assert.strictEqual(logoFile('RICOH IMAGING COMPANY, LTD.'), '384_ricoh.jpg');
  assert.strictEqual(logoFile('Hasselblad'), 'hasselblad.jpg');
  assert.strictEqual(logoFile('没这个牌子'), null);
  assert.strictEqual(logoFile(''), null);
});
