const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const OUT = path.resolve();

// 站点的「下载带相框的图」在 2026-07-29 的重构里换了实现（html2canvas + toDataURL
// → 自绘 canvas + toBlob），产物也从固定的 download.png 变成了 <照片名>.jpg。
// gallery 站 08-19 重建上线后，第二天的定时任务就开始 `cp: cannot stat
// 'download.png'`。
//
// 所以这里不再假设对方吐出什么文件名：点完之后看目录里新出现了什么，再规整成固定
// 名字。站点那边以后再改格式或文件名，也不会把这个任务带崩。

function listDir() {
  return new Set(fs.readdirSync(OUT));
}

/**
 * 等一个新文件真正落盘。
 *
 * 原来是 waitForTimeout(10000) 硬等——文件名对的时候也可能因为网速慢而漏掉，
 * 而且下载没发生时也会静默走过去，最后由 cp 报一个跟原因无关的错。改成轮询：
 * 等新文件出现、且大小连续 settle 毫秒不再变化（Chrome 下载中的临时文件是
 * .crdownload，要排除）。超时就抛错，让 CI 停在真正出问题的那一步。
 */
async function waitForDownload(before, { timeout = 90000, settle = 1500 } = {}) {
  const deadline = Date.now() + timeout;
  let name = null;
  let lastSize = -1;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    if (!name) {
      const fresh = fs
        .readdirSync(OUT)
        .filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
      if (fresh.length) {
        name = fresh[0];
        lastSize = -1;
        stableSince = Date.now();
      }
    }
    if (name) {
      const { size } = fs.statSync(path.join(OUT, name));
      if (size > 0 && size === lastSize) {
        if (Date.now() - stableSince >= settle) return name;
      } else {
        lastSize = size;
        stableSince = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等下载超时：${timeout}ms 内没有新文件落盘（before=${before.size} 个文件）`);
}

/** 点一个下载按钮，把产物改成固定的 basename，返回最终文件名。 */
async function grab(page, client, url, selector, basename) {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: OUT,
  });
  const before = listDir();
  await page.click(selector);
  const got = await waitForDownload(before);
  // 保留真实扩展名——内容已经是 JPEG 了，叫 .png 只会让下游更难查
  const ext = path.extname(got) || '.png';
  const target = basename + ext;
  fs.renameSync(path.join(OUT, got), path.join(OUT, target));
  console.log(`${selector} → ${got} → ${target}`);
  return target;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2560, height: 1440 });
    const client = await page.target().createCDPSession();

    console.log('Start downloading');
    await grab(page, client, 'https://lfkdsk.github.io/gallery/random?daily=true',
               '[id="downloadbox"]', 'download');
    await grab(page, client, 'https://lfkdsk.github.io/gallery/status',
               '[id="download"]', 'year0');
    console.log('Complete');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  // 之前脚本里的异常不会让这一步失败，错误要等到后面 cp 才暴露出来
  console.error(err);
  process.exit(1);
});
