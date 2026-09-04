'use strict';

const { SqliteFile } = require('./sqlite');

const CDN = 'https://cdn.jsdelivr.net/gh/lfkdsk/gallery';

/** 原图和缩略图放在 gallery 仓库的两个分支上，缩略图统一是 1000px 宽的 webp。 */
function thumbUrl(path) {
  return `${CDN}@thumbnail/${path.replace(/\.[^./]+$/, '')}.webp`;
}
function originUrl(path) {
  return `${CDN}@master/${path}`;
}

/** feed 里的 image 指向原图，反查出仓库内的相对路径，用来和数据库对齐。 */
function pathFromFeedImage(image) {
  const m = /gallery@master\/(.+)$/.exec(image || '');
  return m ? m[1] : null;
}

/** EXIF 里的机型/镜头字段常带尾随空格（厂商写的），显示前统一收一下。 */
function clean(s) {
  return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
}

/** "FUJIFILM" + "X-S20" → "FUJIFILM X-S20"；机型已含厂商时不重复。 */
function cameraName(maker, model) {
  const mk = clean(maker);
  const md = clean(model);
  if (!md) return mk;
  if (!mk) return md;
  const head = mk.split(/[\s,]/)[0];
  return md.toUpperCase().startsWith(head.toUpperCase()) ? md : `${head} ${md}`;
}

/** "2026-08-16 19:07:21" —— 当作本地墙上时间解析，不做时区换算。 */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(clean(s));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se));
}

/** FNV-1a，用来把日期变成一个稳定的种子：同一天永远选到同一张照片。 */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * 把 sqlite.db 和 feed.json 合成一份照片列表。
 *
 * 两边各有各的权威部分：数据库有 EXIF / 相册 / 经纬度，feed 有站点上的固定链接，
 * 而且 feed 只收录已发布的条目（数据库里还躺着 189 张没有 EXIF 的）。所以以 feed
 * 为准决定「有哪些照片」，再从数据库补齐每张的元信息。
 */
function loadGallery(dbBuffer, feedJson) {
  const db = new SqliteFile(dbBuffer);
  const albums = db.indexBy('album');
  const exifs = db.indexBy('exifdata');
  const locations = db.indexBy('location');
  const byPath = new Map(db.table('photo').map((p) => [p.path, p]));

  const photos = [];
  for (const item of feedJson.items || []) {
    const path = pathFromFeedImage(item.image || item.id);
    const row = path && byPath.get(path);
    if (!row) continue;

    const exif = row.exif_data_id != null ? exifs.get(row.exif_data_id) : null;
    const loc = row.location_id != null ? locations.get(row.location_id) : null;
    const album = albums.get(row.dir_id);
    const date = parseDate(exif && exif.date) || parseDate(item.date_published);
    if (!date) continue;

    photos.push({
      path,
      name: clean(row.name) || path,
      album: album ? album.dir : '',
      livephoto: row.livephoto === 1,
      link: item.url || item.external_url || '',
      origin: originUrl(path),
      thumb: thumbUrl(path),
      date,
      maker: exif ? clean(exif.maker) : '',
      model: exif ? clean(exif.model) : '',
      camera: exif ? cameraName(exif.maker, exif.model) : '',
      shotAt: exif ? clean(exif.date) : '',
      lens: exif ? clean(exif.lens_model) : '',
      exposure: exif ? clean(exif.exposure_time) : '',
      aperture: exif ? clean(exif.f_number) : '',
      iso: exif ? clean(exif.iso) : '',
      focal: exif ? clean(exif.focal_length) : '',
      country: loc ? clean(loc.country) : '',
    });
  }

  photos.sort((a, b) => b.date - a.date);
  return { photos, albumCount: albums.size };
}

/** 当天选中的那张。同一天多次运行结果一致，换一天就换一张。 */
function pickDaily(photos, dayKey) {
  if (!photos.length) return null;
  return photos[hash(dayKey) % photos.length];
}

/** 按本地日期（YYYY-MM-DD）聚合拍摄量，热力图用。 */
function countsByDay(photos, year) {
  const counts = new Map();
  for (const p of photos) {
    if (p.date.getUTCFullYear() !== year) continue;
    const key = p.date.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** 出现次数最多的取值，用于「今年最常用的机身」这类摘要。 */
function topValue(photos, field) {
  const tally = new Map();
  for (const p of photos) {
    const v = p[field];
    if (v) tally.set(v, (tally.get(v) || 0) + 1);
  }
  let best = null;
  for (const [value, count] of tally) {
    if (!best || count > best.count) best = { value, count };
  }
  return best;
}

/**
 * 厂商 → logo 文件名，和站点 tools.js 里 wrapperData() 的 switch 保持一致。
 *
 * EXIF 里的厂商字段常带尾随空格（"RICOH IMAGING COMPANY, LTD.  "），站点是按原始
 * 字符串精确匹配的，这里改成规整后再比，多一两个空格也能命中。
 */
const MAKER_LOGOS = {
  hasselblad: 'hasselblad.jpg',
  apple: 'apple.png',
  'ricoh imaging company, ltd.': '384_ricoh.jpg',
  canon: 'canon.png',
  sony: 'sony.png',
  'nikon corporation': 'nikon.png',
  dji: 'dajiang.png',
  fujifilm: 'fujifilm.png',
  'om digital solutions': 'om-system.svg',
  'olympus corporation': 'OlympusLogoBlueAndGoldRGB.png',
  'olympus imaging corp.': 'OlympusLogoBlueAndGoldRGB.png',
};

function logoFile(maker) {
  return MAKER_LOGOS[clean(maker).toLowerCase()] || null;
}

module.exports = { loadGallery, pickDaily, countsByDay, topValue, logoFile, clean, hash };
