'use strict';

// 两张图都是手写 SVG：不跑浏览器，也不做位图合成。
//
// 相框那张固定白底，跟站点「下载带相框的图」保持一致；热力图跟随深色主题，用
// CSS 变量 + prefers-color-scheme 写两套值——站点自己也是这么做的（tools.js 里的
// heatmapPalette 从 --hm-* 读色）。GitHub 给用户内容的 CSP 带了
// style-src 'unsafe-inline'，内联 <style> 是允许的。

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";

// 取自站点 css/tokens.css 的 --hm-* 变量，和 /status 页那张 echarts 热力图同色
const LEVELS_LIGHT = ['rgba(15,23,42,0.09)', '#9be9a8', '#40c463', '#216e39'];
const LEVELS_DARK = ['rgba(255,255,255,0.09)', '#0e4429', '#26a641', '#39d353'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 粗略估算文本宽度。
 *
 * SVG 里没法真的量字，但截断要有个依据。西文按 0.52em、CJK 按 1em 估，够用来决定
 * 「这行放不下要不要截」——宁可估宽一点，也不要让两侧文字撞到一起。
 */
function approxWidth(text, size) {
  let units = 0;
  for (const ch of String(text)) {
    units += /[⺀-鿿가-힯＀-｠]/.test(ch) ? 1 : 0.52;
  }
  return units * size;
}

function truncate(text, size, maxWidth) {
  if (approxWidth(text, size) <= maxWidth) return text;
  const chars = [...String(text)];
  while (chars.length && approxWidth(chars.join('') + '…', size) > maxWidth) chars.pop();
  return chars.join('').trimEnd() + '…';
}

/** 用 · 连接，自动丢掉空段，避免出现 "a ·  · b"。 */
function join(parts, sep = ' · ') {
  return parts.filter((p) => p != null && String(p).trim() !== '').join(sep);
}

/** 主题变量：同一份 SVG 在浅色/深色下各取一套颜色。 */
function themeStyle(vars) {
  const decl = (obj) =>
    Object.entries(obj)
      .map(([k, v]) => `--${k}:${v}`)
      .join(';');
  return `
    :root{${decl(vars.light)}}
    @media (prefers-color-scheme: dark){:root{${decl(vars.dark)}}}
    text{font-family:${FONT};}
  `;
}

// ---------------------------------------------------------------- 今日一图

/** 相框左侧那行参数。顺序照抄站点 tools.js 里 wrapperData() 的拼法。 */
function paramLine(photo) {
  return join(
    [
      photo.iso ? `ISO ${photo.iso}` : '',
      photo.aperture ? `F${photo.aperture}` : '',
      photo.focal ? `${photo.focal}mm` : '',
      photo.exposure ? `${photo.exposure}s` : '',
    ],
    ' '
  );
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/** 单行文字在给定中线上的基线位置。0.355em 是常见西文字体 cap height 的一半。 */
function baseline(centerY, size) {
  return Number((centerY + size * 0.355).toFixed(1));
}

/**
 * 今日一图。
 *
 * 版式跟着站点的「下载带相框的图」走：白色卡纸 + 一圈细边，底下一条 EXIF 栏——左边
 * 是拍摄参数和时间，右边是厂商 logo、一条竖分隔线，然后机型 / 镜头 / 作者。区别只
 * 在于这里是直接拼 SVG，不过浏览器也不过 canvas。
 *
 * 卡纸固定白色、不跟随深色主题，这一点也和站点一致（tools.js 里那句「暗色模式下相
 * 框是白的」）——相框模拟的是实体照片的卡纸，跟着变黑反而不像。
 *
 * 图片以 data URI 内联，用 gallery 的 thumbnail 分支（1000px webp，几十 KB）。外链
 * 在 GitHub 上不会加载——README 里的 SVG 是当图片渲染的，取不到外部资源——所以必须
 * 内嵌；用缩略图而不是原图，是因为这个文件每天都要提交一次。
 */
function renderDaily({
  photo,
  image,
  logo = null,
  author = 'lfkdsk',
  width = 1000,
  minWidth = 720,
  maxPhotoHeight = 680,
}) {
  const border = 1;
  const framePad = 16; // .pic-area 的 padding
  const barPadX = 10; // .pic-wrapper 的左右 padding
  const barH = 78;
  const inset = border + framePad;

  const ratio = image.height / image.width;
  let photoW = width - inset * 2;
  let photoH = Math.round(photoW * ratio);
  if (photoH > maxPhotoHeight) {
    photoH = maxPhotoHeight;
    photoW = Math.round(maxPhotoHeight / ratio);
  }
  // 卡纸跟着照片收窄，竖构图才不会两边空一大片；下限保证 EXIF 栏排得开
  const cardW = Math.min(width, Math.max(minWidth, photoW + inset * 2));
  const photoX = Math.round((cardW - photoW) / 2);

  const barTop = inset + photoH;
  const height = barTop + barH + border;
  const cy = barTop + barH / 2;
  const textInset = inset + barPadX;

  const param = paramLine(photo);
  const hasExif = Boolean(param || photo.model || photo.lens);

  let bar;
  if (!hasExif) {
    // 站点在没有 EXIF 时走 #normal-wrapper：整条栏只居中一句话
    bar = `<text x="${cardW / 2}" y="${baseline(cy, 17)}" font-size="17" font-weight="300" fill="#1f2328" text-anchor="middle">Shot By ${esc(author)}</text>`;
  } else {
    const R_MAIN = 13.5;
    const R_SUB = 12;
    const L_MAIN = 14;
    const L_SUB = 12.5;
    const lineH = 17;
    const shotAt = photo.shotAt || ymd(photo.date);
    const available = cardW - textInset * 2;

    // logo 按高度等比缩放（站点是 height: 40px + width auto），太宽的截住
    const logoH = 38;
    const logoW = logo ? Math.min(140, Math.round((logoH * logo.width) / logo.height)) : 0;
    const logoGap = logo ? 10 : 0;
    const fixed = logoW + logoGap + 1 + 10; // logo + 间距 + 分隔线 + 内缩

    // 左边先要够。参数和时间是定长的短句，右边的机型镜头本来就带省略号截断，
    // 所以宽度不够时该让右边先让——不然会出现 "ISO 16000 F2 213mm 1/6…" 这种
    // 把关键参数吃掉的截法。
    const leftNeeded = Math.min(
      Math.round(available * 0.5),
      Math.ceil(Math.max(approxWidth(paramLine(photo), L_MAIN), approxWidth(shotAt, L_SUB)))
    );
    const maxRight = Math.max(120, Math.round(available - leftNeeded - 20 - fixed));

    const rightLines = [
      { text: truncate(photo.model || photo.camera, R_MAIN, maxRight), size: R_MAIN, fill: '#1f2328', weight: 400 },
      { text: truncate(photo.lens, R_SUB, maxRight), size: R_SUB, fill: 'gray', weight: 300 },
      { text: truncate(`By ${author}`, R_SUB, maxRight), size: R_SUB, fill: 'gray', weight: 300 },
    ].filter((l) => l.text);

    const textW = Math.ceil(Math.max(...rightLines.map((l) => approxWidth(l.text, l.size))));
    const groupW = fixed + textW;
    const groupX = Math.round(cardW - textInset - groupW);
    const dividerX = groupX + logoW + logoGap;
    const dividerH = Math.max(logoH, rightLines.length * lineH);
    const rightX = dividerX + 11;

    const firstY = cy - ((rightLines.length - 1) * lineH) / 2;
    const right = rightLines.map(
      (l, i) =>
        `<text x="${rightX}" y="${baseline(firstY + i * lineH, l.size)}" font-size="${l.size}" font-weight="${l.weight}" fill="${l.fill}">${esc(l.text)}</text>`
    );

    const leftMax = Math.max(80, groupX - textInset - 20);

    bar = [
      logo
        ? `<image x="${groupX}" y="${cy - logoH / 2}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet" xlink:href="${logo.dataUri}"/>`
        : '',
      `<rect x="${dividerX}" y="${cy - dividerH / 2}" width="1" height="${dividerH}" fill="black"/>`,
      ...right,
      `<text x="${textInset}" y="${baseline(cy - 9.5, L_MAIN)}" font-size="${L_MAIN}" font-weight="700" fill="#1f2328">${esc(truncate(param, L_MAIN, leftMax))}</text>`,
      `<text x="${textInset}" y="${baseline(cy + 9.5, L_SUB)}" font-size="${L_SUB}" font-weight="300" fill="gray">${esc(truncate(shotAt, L_SUB, leftMax))}</text>`,
    ]
      .filter(Boolean)
      .join('\n  ');
  }

  const caption = join([photo.name, photo.album, photo.model, photo.lens, param]);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cardW}" height="${height}" viewBox="0 0 ${cardW} ${height}" role="img" aria-label="${esc(caption)}">
  <title>${esc(caption)}</title>
  <style>text{font-family:${FONT};}</style>
  <rect x="0" y="0" width="${cardW}" height="${height}" fill="#ffffff"/>
  <image x="${photoX}" y="${inset}" width="${photoW}" height="${photoH}" preserveAspectRatio="xMidYMid slice" xlink:href="${image.dataUri}"/>
  ${bar}
  <rect x="0.5" y="0.5" width="${cardW - 1}" height="${height - 1}" fill="none" stroke="rgba(22,22,22,0.48)"/>
</svg>
`;
}

// ---------------------------------------------------------------- 年度热力图

/**
 * 按当年非零天数的分位切档，而不是写死阈值。
 *
 * 出片量逐年差很多（2023 年 643 张、2026 年到目前 197 张），固定阈值要么全年一片
 * 深绿，要么一片浅色。用分位数能保证每年都看得出疏密。
 */
function levelScale(counts) {
  const sorted = [...counts.values()].filter((c) => c > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const t2 = at(0.5);
  const t3 = at(0.85);
  return (c) => {
    if (!c) return 0;
    if (c >= t3) return 3;
    if (c >= t2) return 2;
    return 1;
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * GitHub 贡献图那种年度热力图，一格一天，颜色深浅是当天的出片量。
 *
 * 数据全部来自 sqlite.db 的 EXIF 拍摄时间，所以画的是「哪天在拍」，不是「哪天上传」。
 */
function renderHeatmap({ year, counts, today, footer, width = 1000 }) {
  const cell = 13;
  const gap = 4;
  const step = cell + gap;
  const pad = 22;
  const gutter = 30; // 星期标签
  const headerH = 26;
  const monthH = 16;

  const gridX = pad + gutter;
  const gridY = pad + headerH + monthH;

  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dec31 = new Date(Date.UTC(year, 11, 31));
  const firstCol = jan1.getUTCDay(); // 第一周里 1 月 1 日之前的空格
  const totalDays = Math.round((dec31 - jan1) / 86400000) + 1;
  const weeks = Math.ceil((firstCol + totalDays) / 7);
  const gridW = weeks * step - gap;

  const level = levelScale(counts);
  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(jan1.getTime() + i * 86400000);
    const idx = firstCol + i;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const key = date.toISOString().slice(0, 10);
    const count = counts.get(key) || 0;
    const x = gridX + col * step;
    const y = gridY + row * step;
    const future = date > today;

    cells.push(
      `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="var(--l${level(count)})"${
        future ? ' opacity="0.45"' : ''
      }><title>${key} · ${count}</title></rect>`
    );

    const month = date.getUTCMonth();
    if (month !== lastMonth && date.getUTCDate() <= 7) {
      // 月标签对齐到该月第一格所在的列
      monthLabels.push(
        `<text x="${x}" y="${gridY - 6}" font-size="10.5" fill="var(--muted)">${MONTHS[month]}</text>`
      );
      lastMonth = month;
    }
  }

  const dayLabels = WEEKDAYS.map(
    (d, i) =>
      `<text x="${gridX - 8}" y="${gridY + i * step + cell - 3}" font-size="9.5" fill="var(--muted)" text-anchor="end">${d}</text>`
  );

  // 图例贴右边缘：5 个色块 + Less/More
  const legendW = 5 * (cell + 3) - 3;
  const legendX = pad + gutter + gridW - legendW;
  const legendY = pad + 6;
  const legend = [
    `<text x="${legendX - 10}" y="${legendY + cell - 3}" font-size="10.5" fill="var(--muted)" text-anchor="end">Less</text>`,
    // 描边是必需的：深色主题下 0 级色块和背景几乎同色，不描边就少一格
    ...LEVELS_LIGHT.map(
      (_, i) =>
        `<rect x="${legendX + i * (cell + 3)}" y="${legendY}" width="${cell}" height="${cell}" rx="3" fill="var(--l${i})" stroke="var(--border)" stroke-width="0.5"/>`
    ),
    `<text x="${legendX + legendW + 8}" y="${legendY + cell - 3}" font-size="10.5" fill="var(--muted)">More</text>`,
  ];

  const footerY = gridY + 7 * step - gap + 24;
  const height = footerY + pad - 6;
  const svgWidth = Math.max(width, gridX + gridW + pad);

  const style = themeStyle({
    light: {
      bg: '#ffffff',
      border: '#d0d7de',
      fg: '#1f2328',
      muted: '#636c76',
      ...Object.fromEntries(LEVELS_LIGHT.map((c, i) => [`l${i}`, c])),
    },
    dark: {
      bg: '#0d1117',
      border: '#30363d',
      fg: '#e6edf3',
      muted: '#8d96a0',
      ...Object.fromEntries(LEVELS_DARK.map((c, i) => [`l${i}`, c])),
    },
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${height}" viewBox="0 0 ${svgWidth} ${height}" role="img" aria-label="${esc(footer.title)} — ${esc(footer.line)}">
  <title>${esc(footer.title)} — ${esc(footer.line)}</title>
  <style>${style}</style>
  <rect x="0.5" y="0.5" width="${svgWidth - 1}" height="${height - 1}" rx="12" fill="var(--bg)" stroke="var(--border)"/>
  <text x="${pad}" y="${pad + 16}" font-size="15" font-weight="600" fill="var(--fg)">${esc(footer.title)}</text>
  ${legend.join('\n  ')}
  ${monthLabels.join('\n  ')}
  ${dayLabels.join('\n  ')}
  ${cells.join('\n  ')}
  <text x="${pad}" y="${footerY}" font-size="12" fill="var(--muted)">${esc(truncate(footer.line, 12, svgWidth - pad * 2))}</text>
</svg>
`;
}

module.exports = { renderDaily, renderHeatmap, esc, truncate, approxWidth, join };
