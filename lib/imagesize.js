'use strict';

// 从图片字节里读出宽高。
//
// SVG 里放 <image> 得先知道原始比例，不然要么变形要么留白。为这点需求引入 sharp
// 之类的依赖不值当——WebP 和 JPEG 的尺寸都写在文件头里，直接读就行。

function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // 有损：3 字节 frame tag + 3 字节 sync code，之后是 14 位宽 / 14 位高
    if (buf.readUInt8(23) !== 0x9d || buf.readUInt8(24) !== 0x01 || buf.readUInt8(25) !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // 无损：1 字节签名，之后 14 位 (宽-1)、14 位 (高-1)
    if (buf.readUInt8(20) !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // 扩展：4 字节 flags，之后各 3 字节的画布宽高（都是实际值减一，小端）
    const w = buf.readUIntLE(24, 3) + 1;
    const h = buf.readUIntLE(27, 3) + 1;
    return { width: w, height: h };
  }
  return null;
}

function jpegSize(buf) {
  if (buf.readUInt16BE(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    // SOF0..SOF15，跳过 DHT(c4)/JPG(c8)/DAC(cc) 这几个不是帧头的
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 返回 { width, height, mime }，识别不了就返回 null。 */
function imageSize(buf) {
  const webp = webpSize(buf);
  if (webp) return { ...webp, mime: 'image/webp' };
  const png = pngSize(buf);
  if (png) return { ...png, mime: 'image/png' };
  const jpeg = jpegSize(buf);
  if (jpeg) return { ...jpeg, mime: 'image/jpeg' };
  return null;
}

module.exports = { imageSize };
