'use strict';

// 每天生成两张 SVG：今日一图和年度热力图。
//
// 以前这一步是开一个 headless Chrome 去 gallery 站点上点「下载」按钮，把浏览器
// 生成的位图接下来。代价很大：要装 puppeteer（连带下载一整个 Chromium），页面还
// 一直在从 CDN 拉图，`waitUntil: 'networkidle0'` 基本等不到「网络空闲」，于是整个
// job 经常卡到超时；产物又是 3MB 起的原图，每天往 daily 分支提交三份。
//
// 现在直接读 gallery 自己发布的两个数据文件——sqlite.db（EXIF / 相册 / 地理）和
// feed.json（已发布条目和固定链接）——在 Node 里把 SVG 拼出来。没有浏览器，没有
// 依赖，整个过程就是三次 HTTP 请求。

const fs = require('fs');
const path = require('path');

const { loadGallery, pickDaily, countsByDay, topValue, logoFile } = require('./lib/gallery');
const { imageSize } = require('./lib/imagesize');
const { renderDaily, renderHeatmap, join } = require('./lib/render');

const BASE = process.env.GALLERY_BASE || 'https://gallery.lfkdsk.org';
const OUT = process.env.OUT_DIR || path.resolve(__dirname);
// 缩略图偶尔会缺（新照片还没进 thumbnail 分支），换下一张候选，不要让整个任务失败
const DAILY_CANDIDATES = 12;
// 内嵌图片的上限。缩略图正常在 100KB 上下，超出说明取到的不是缩略图
const MAX_EMBED_BYTES = 1_500_000;

/** 带退避重试的下载；CDN 偶发 5xx 不该让每日任务挂掉。 */
async function fetchBuffer(url, { attempts = 4, optional = false } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status === 404 && optional) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  if (optional) return null;
  throw new Error(`下载失败 ${url}：${lastError.message}`);
}

/** 把图片字节转成可以直接塞进 SVG 的 data URI。 */
function embed(buf) {
  const size = imageSize(buf);
  if (!size) return null;
  return { ...size, bytes: buf.length, dataUri: `data:${size.mime};base64,${buf.toString('base64')}` };
}

/**
 * 相框右边的厂商 logo，和站点用的是同一批图。
 *
 * 取不到就返回 null——logo 只是锦上添花，机型和镜头文字仍在，不该为它让整个任务失败。
 * 矢量 logo（om-system.svg）这里会被 imageSize 判成识别不了而跳过：SVG 套 SVG 在
 * 「当作图片渲染」的场景里各浏览器行为不一致，不值得赌。
 */
async function loadLogo(maker) {
  const file = logoFile(maker);
  if (!file) return null;
  const buf = await fetchBuffer(`${BASE}/img/${file}`, { attempts: 2, optional: true });
  if (!buf || buf.length > MAX_EMBED_BYTES) return null;
  return embed(buf);
}

/** 拿到能内嵌的图片字节；缩略图取不到就退回原图。 */
async function loadImage(photo) {
  for (const url of [photo.thumb, photo.origin]) {
    const buf = await fetchBuffer(url, { attempts: 2, optional: true });
    if (!buf) continue;
    if (buf.length > MAX_EMBED_BYTES) {
      console.warn(`  跳过 ${url}：${(buf.length / 1e6).toFixed(1)}MB，超过内嵌上限`);
      continue;
    }
    const image = embed(buf);
    if (!image) {
      console.warn(`  跳过 ${url}：识别不出图片格式`);
      continue;
    }
    return image;
  }
  return null;
}

/**
 * 选出今天这张，并确保它的图能取到。
 *
 * pickDaily 只按日期做确定性选择，本身不看图在不在。这里往后顺延几张候选，
 * 用 `日期#序号` 换个种子，避免某张图挂了就整个任务失败。
 */
async function resolveDaily(photos, dayKey) {
  for (let i = 0; i < DAILY_CANDIDATES; i++) {
    const photo = pickDaily(photos, i === 0 ? dayKey : `${dayKey}#${i}`);
    if (!photo) break;
    const image = await loadImage(photo);
    if (image) return { photo, image };
    console.warn(`  ${photo.path} 取不到可用图片，换下一张候选`);
  }
  throw new Error(`连续 ${DAILY_CANDIDATES} 张候选都取不到图片`);
}

function write(name, content) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, content);
  console.log(`${name}  ${(content.length / 1024).toFixed(1)} KB`);
  return file;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`读取 ${BASE}/sqlite.db 和 ${BASE}/feed.json`);
  const [dbBuffer, feedBuffer] = await Promise.all([
    fetchBuffer(`${BASE}/sqlite.db`),
    fetchBuffer(`${BASE}/feed.json`),
  ]);

  const { photos, albumCount } = loadGallery(dbBuffer, JSON.parse(feedBuffer.toString('utf8')));
  if (!photos.length) throw new Error('数据里一张照片都没有，八成是上游文件坏了');
  console.log(`  ${photos.length} 张照片 / ${albumCount} 个相册`);

  const today = new Date();
  const dayKey = today.toISOString().slice(0, 10);
  const year = today.getUTCFullYear();

  const { photo, image } = await resolveDaily(photos, dayKey);
  const logo = await loadLogo(photo.maker);
  console.log(`今日一图 ${photo.path}（${image.width}x${image.height}, ${(image.bytes / 1024).toFixed(0)} KB）`);
  write('daily.svg', renderDaily({ photo, image, logo }));

  const counts = countsByDay(photos, year);
  const shots = [...counts.values()].reduce((a, b) => a + b, 0);
  const thisYear = photos.filter((p) => p.date.getUTCFullYear() === year);
  const camera = topValue(thisYear, 'camera');
  const lens = topValue(thisYear, 'lens');
  write(
    'year0.svg',
    renderHeatmap({
      year,
      counts,
      today,
      footer: {
        title: `${year} · ${shots} 张`,
        line: join([
          `${counts.size} 天有拍`,
          `全部 ${photos.length} 张 / ${albumCount} 个相册`,
          camera && `最常用 ${camera.value} (${camera.count})`,
          lens && lens.value,
        ]),
      },
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
