# Gallery Daily

每天从 [gallery](https://gallery.lfkdsk.org) 的数据里生成两张 SVG，推到 `daily` 分支。

![](https://github.com/lfkdsk/gallery-daily/blob/daily/daily.svg)
![](https://github.com/lfkdsk/gallery-daily/blob/daily/year0.svg)

## 做了什么

- **`daily.svg`** —— 当天的一张照片，版式跟着站点「下载带相框的图」走：白卡纸、细边框，
  底下一条 EXIF 栏（左边参数和时间，右边厂商 logo、机型、镜头、作者）。选片按日期做
  确定性哈希，同一天跑多少次都是同一张。
- **`year0.svg`** —— 当年的拍摄热力图，一格一天，取自 EXIF 的拍摄时间，配色和站点
  `/status` 那张一致，跟随系统深浅色。

数据来自 gallery 发布的两个文件，两边各有各的权威部分：

| 来源 | 提供 |
| --- | --- |
| [`sqlite.db`](https://gallery.lfkdsk.org/sqlite.db) | EXIF、相册、经纬度 |
| [`feed.json`](https://gallery.lfkdsk.org/feed.json) | 收录哪些照片、站内固定链接 |

照片用的是 gallery 仓库 `thumbnail` 分支的 1000px WebP，以 data URI 内联进 SVG——
README 里的 SVG 是当图片渲染的，取不到外部资源，必须内嵌。

## 为什么不再用 puppeteer

原来这一步是开一个 headless Chrome 打开站点、点「下载」按钮、把浏览器生成的位图接下来。
几个问题：

- 装 puppeteer 要连带下载一整个 Chromium；
- 页面一直在从 CDN 拉图，`waitUntil: 'networkidle0'` 基本等不到「网络空闲」，会卡到超时；
- 产物是 3MB 起的原图，每天往 `daily` 分支提交三份。

现在整个过程就是三次 HTTP 请求加一次字符串拼接，零依赖、几秒钟跑完，每天提交的体积
从 ~10MB 降到 ~200KB。

## 本地跑

需要 Node 18+（用到了全局 `fetch`），没有别的依赖。

```sh
node build.js        # 生成 daily.svg 和 year0.svg
node --test          # 跑测试
```

`OUT_DIR` 可以改输出目录，`GALLERY_BASE` 可以指向别的站点。

## 代码结构

| 文件 | 作用 |
| --- | --- |
| `build.js` | 取数据、选片、写文件 |
| `lib/sqlite.js` | 只读的 SQLite 解析器（为了零依赖手写的，见下） |
| `lib/gallery.js` | 把 sqlite.db 和 feed.json 合成一份照片列表 |
| `lib/render.js` | 两张 SVG 的排版 |
| `lib/imagesize.js` | 从字节里读 WebP / JPEG / PNG 的宽高 |

`lib/sqlite.js` 只实现了表 b-tree 的全表扫描——这里的需求就是把几张小表读进内存，
为此装一个带原生编译的依赖不划算。它是这个仓库里唯一有风险的部分（解析错了不会报错，
只会安静地给出错数据），所以 `test/fixture.db` 特意覆盖了各种取值形态：rowid 别名、
各宽度整数、浮点、NULL、空串、BLOB、UTF-8、跨溢出页的长文本，以及需要走内部页的行数。

两个测试用的数据库是 Python 生成的：

```sh
python3 - <<'PY'
import sqlite3
c = sqlite3.connect('test/fixture.db')
c.execute('PRAGMA page_size=512')   # 页小一点，长文本才会走到溢出页
...
PY
```
