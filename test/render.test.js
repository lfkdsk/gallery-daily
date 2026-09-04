'use strict';

// SVG 是字符串拼出来的，一处没转义就整张图打不开，而 GitHub 上渲染失败只会显示成
// 一个碎图标、不会有任何报错。所以这里既盯内容，也盯「拼出来的东西还是合法 XML」。

const test = require('node:test');
const assert = require('node:assert');

const { renderDaily, renderHeatmap, truncate, approxWidth } = require('../lib/render');

const IMAGE = { width: 1000, height: 667, mime: 'image/webp', dataUri: 'data:image/webp;base64,AAAA' };
const PORTRAIT = { ...IMAGE, width: 750, height: 1000 };

const PHOTO = {
  name: 'DSCF3401',
  album: 'Tahoe',
  country: 'United States of America',
  date: new Date(Date.UTC(2026, 2, 4, 9, 14, 51)),
  shotAt: '2026-03-04 09:14:51',
  maker: 'FUJIFILM',
  model: 'X-S20',
  camera: 'FUJIFILM X-S20',
  lens: 'XF16-80mmF4 R OIS WR',
  exposure: '1/180',
  aperture: '6.8',
  iso: '50',
  focal: '35',
  livephoto: false,
};

/** 粗查一遍 XML 合法性：未转义的 & 和不配对的标签都会让整张图渲染不出来。 */
function assertWellFormed(svg) {
  assert.match(svg, /^<svg [^>]*>/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.doesNotMatch(svg, /&(?!(amp|lt|gt|quot|apos|#\d+);)/, '存在未转义的 &');
  const stack = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z:]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) assert.strictEqual(stack.pop(), name, `</${name}> 没有配对的开标签`);
    else stack.push(name);
  }
  assert.deepStrictEqual(stack, [], '有标签没闭合');
}

test('今日一图：EXIF 栏按站点的版式排布', () => {
  const svg = renderDaily({ photo: PHOTO, image: IMAGE });
  assertWellFormed(svg);
  // 左栏：参数顺序照抄站点 wrapperData()，然后是拍摄时间
  assert.match(svg, /ISO 50 F6\.8 35mm 1\/180s/);
  assert.match(svg, /2026-03-04 09:14:51/);
  // 右栏：机型 / 镜头 / 作者
  assert.match(svg, />X-S20</);
  assert.match(svg, />XF16-80mmF4 R OIS WR</);
  assert.match(svg, />By lfkdsk</);
  assert.match(svg, /xlink:href="data:image\/webp;base64,AAAA"/);
});

test('没有 EXIF 时退回站点那行居中提示', () => {
  const bare = { ...PHOTO, model: '', camera: '', lens: '', iso: '', aperture: '', focal: '', exposure: '' };
  const svg = renderDaily({ photo: bare, image: IMAGE, author: 'lfkdsk' });
  assertWellFormed(svg);
  assert.match(svg, /Shot By lfkdsk/);
  assert.doesNotMatch(svg, /By lfkdsk<\/text>\s*\n\s*<text[^>]*>ISO/);
});

test('卡纸跟着照片的比例走', () => {
  const wide = renderDaily({ photo: PHOTO, image: IMAGE });
  const tall = renderDaily({ photo: PHOTO, image: PORTRAIT });
  const size = (svg) => svg.match(/width="(\d+)" height="(\d+)" viewBox/).slice(1).map(Number);
  const [ww, wh] = size(wide);
  const [tw, th] = size(tall);
  assert.strictEqual(ww, 1000);      // 横构图铺满上限宽度
  assert.strictEqual(tw, 720);       // 竖构图收窄到下限，不留大片空白
  assert.ok(th > wh, '竖构图应该更高');
  // 照片高度有上限，再竖也不会无限长
  assert.ok(th < 800, `竖构图卡纸过高：${th}`);
});

test('厂商 logo 有就画、没有也不影响其它内容', () => {
  const logo = { width: 2048, height: 1152, mime: 'image/png', dataUri: 'data:image/png;base64,BBBB' };
  const withLogo = renderDaily({ photo: PHOTO, image: IMAGE, logo });
  assertWellFormed(withLogo);
  assert.match(withLogo, /data:image\/png;base64,BBBB/);

  const without = renderDaily({ photo: PHOTO, image: IMAGE, logo: null });
  assertWellFormed(without);
  assert.doesNotMatch(without, /base64,BBBB/);
  assert.match(without, />X-S20</); // 少了 logo，文字照旧
});

test('文本一律转义，元数据里的尖括号不会破坏 SVG', () => {
  const nasty = { ...PHOTO, model: 'a<b>&"c"', lens: '</text><script>alert(1)</script>' };
  const svg = renderDaily({ photo: nasty, image: IMAGE });
  assertWellFormed(svg);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /a&lt;b&gt;&amp;/);
});

test('热力图一年一格不多不少，闰年多一天', () => {
  const cells = (svg) => (svg.match(/<rect[^>]*><title>/g) || []).length;
  const footer = { title: '2026', line: '摘要' };
  const y2026 = renderHeatmap({ year: 2026, counts: new Map(), today: new Date(Date.UTC(2026, 8, 4)), footer });
  const y2024 = renderHeatmap({ year: 2024, counts: new Map(), today: new Date(Date.UTC(2024, 8, 4)), footer });
  assertWellFormed(y2026);
  assertWellFormed(y2024);
  assert.strictEqual(cells(y2026), 365);
  assert.strictEqual(cells(y2024), 366);
});

test('热力图按当年的分位数分档，不同年份都能看出疏密', () => {
  const counts = new Map();
  for (let d = 1; d <= 20; d++) counts.set(`2026-01-${String(d).padStart(2, '0')}`, d);
  const svg = renderHeatmap({
    year: 2026,
    counts,
    today: new Date(Date.UTC(2026, 11, 31)),
    footer: { title: '2026', line: '摘要' },
  });
  assertWellFormed(svg);
  // 四档颜色都要用上，否则图上分不出层次
  for (const level of [0, 1, 2, 3]) {
    assert.match(svg, new RegExp(`fill="var\\(--l${level}\\)"[^>]*><title>`), `第 ${level} 档没有被用到`);
  }
});

test('未来的日子画得更淡', () => {
  const svg = renderHeatmap({
    year: 2026,
    counts: new Map(),
    today: new Date(Date.UTC(2026, 0, 15)),
    footer: { title: '2026', line: '摘要' },
  });
  const faded = (svg.match(/opacity="0\.45"/g) || []).length;
  assert.strictEqual(faded, 365 - 15, '1 月 15 日之后的格子都该是淡的');
});

test('截断按估算宽度来，CJK 算整宽', () => {
  assert.strictEqual(truncate('short', 12, 500), 'short');
  assert.match(truncate('x'.repeat(200), 12, 100), /^x+…$/);
  assert.ok(truncate('x'.repeat(200), 12, 100).length < 20);
  // 同样字数下中文更宽，应该更早被截
  assert.ok(approxWidth('中文中文', 12) > approxWidth('abcd', 12));
});
