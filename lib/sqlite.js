'use strict';

// 只读的 SQLite 文件解析器。
//
// 之所以不用 better-sqlite3 / node:sqlite：这个仓库跑在 GitHub Actions 上，每天
// 一次，读的是一个 700KB 的数据库、几张表全量扫一遍就完事。为此装一个带原生编译
// 的依赖（或者绑死在某个 Node 版本的实验特性上）不划算——手写一个够用的读取器，
// 整个仓库就能做到零依赖，workflow 里连 `npm install` 都不需要。
//
// 实现的是文件格式里我们真正用得到的那部分：表 b-tree 的全表扫描。索引 b-tree
// （type 2/10）用不上就不解析——没有 WHERE 下推，读完在 JS 里过滤。

/** 读一个 varint，返回 [值, 消耗的字节数]。第 9 个字节整字节参与。 */
function readVarint(buf, off) {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = buf[off + i];
    if (i === 8) break;
    if (byte & 0x80) {
      value = (value << 7n) | BigInt(byte & 0x7f);
    } else {
      value = (value << 7n) | BigInt(byte);
      return [value, i + 1];
    }
  }
  // 走到这里说明前 8 个字节都带了续位，第 9 个字节贡献完整 8 位
  value = (value << 8n) | BigInt(buf[off + 8]);
  return [value, 9];
}

/** varint 在我们的场景里都是小数值（长度、rowid、serial type），直接收成 Number。 */
function readVarintNum(buf, off) {
  const [v, n] = readVarint(buf, off);
  return [Number(BigInt.asIntN(64, v)), n];
}

/** 大端有符号整数，SQLite 的 serial type 1..6 用。 */
function readIntBE(buf, off, bytes) {
  let v = 0n;
  for (let i = 0; i < bytes; i++) v = (v << 8n) | BigInt(buf[off + i]);
  v = BigInt.asIntN(bytes * 8, v);
  // id / 计数这类值远在安全整数范围内，超出了才退回 BigInt
  return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v;
}

/**
 * 从 CREATE TABLE 语句里取列名。
 *
 * gallery 的 schema 是 peewee 生成的，列名都带双引号，但这里还是按通用写法处理：
 * 扫最外层括号内的顶层逗号，每段取第一个 token，跳过表级约束。
 */
function parseColumns(sql) {
  const open = sql.indexOf('(');
  const body = sql.slice(open + 1, sql.lastIndexOf(')'));
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);

  const TABLE_CONSTRAINT = /^(constraint|primary|unique|check|foreign)\b/i;
  const columns = [];
  for (const raw of parts) {
    const def = raw.trim();
    if (!def || TABLE_CONSTRAINT.test(def)) continue;
    const m = def.match(/^"([^"]+)"|^`([^`]+)`|^\[([^\]]+)\]|^(\w+)/);
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4];
    const rest = def.slice(m[0].length);
    columns.push({
      name,
      // `INTEGER PRIMARY KEY` 是 rowid 的别名：记录里存的是 NULL，真值要从 rowid 取
      rowidAlias: /\bINTEGER\b/i.test(rest) && /\bPRIMARY\s+KEY\b/i.test(rest),
    });
  }
  return columns;
}

class SqliteFile {
  constructor(buf) {
    if (buf.length < 100 || buf.toString('latin1', 0, 15) !== 'SQLite format 3') {
      throw new Error('不是 SQLite 数据库文件');
    }
    this.buf = buf;
    const declared = buf.readUInt16BE(16);
    this.pageSize = declared === 1 ? 65536 : declared;
    this.usableSize = this.pageSize - buf.readUInt8(20);
    this.utf16 = buf.readUInt32BE(56) !== 1;
    this.maxLocal = this.usableSize - 35;
    this.minLocal = Math.floor(((this.usableSize - 12) * 32) / 255) - 23;
    this.schema = this._readSchema();
  }

  _page(n) {
    const start = (n - 1) * this.pageSize;
    return this.buf.subarray(start, start + this.pageSize);
  }

  /** 拼出一条 cell 的完整 payload，必要时跟着溢出页链走。 */
  _payload(page, off, payloadSize) {
    let local = payloadSize;
    if (payloadSize > this.maxLocal) {
      const k = this.minLocal + ((payloadSize - this.minLocal) % (this.usableSize - 4));
      local = k <= this.maxLocal ? k : this.minLocal;
    }
    if (local === payloadSize) return page.subarray(off, off + local);

    const chunks = [page.subarray(off, off + local)];
    let next = page.readUInt32BE(off + local);
    let remaining = payloadSize - local;
    while (next && remaining > 0) {
      const overflow = this._page(next);
      const take = Math.min(remaining, this.usableSize - 4);
      chunks.push(overflow.subarray(4, 4 + take));
      remaining -= take;
      next = overflow.readUInt32BE(0);
    }
    return Buffer.concat(chunks);
  }

  /** 解一条记录，返回值数组。 */
  _record(payload) {
    const [headerSize, n] = readVarintNum(payload, 0);
    const types = [];
    let off = n;
    while (off < headerSize) {
      const [t, len] = readVarintNum(payload, off);
      types.push(t);
      off += len;
    }
    const values = [];
    for (const t of types) {
      if (t === 0) {
        values.push(null);
      } else if (t >= 1 && t <= 6) {
        const bytes = [0, 1, 2, 3, 4, 6, 8][t];
        values.push(readIntBE(payload, off, bytes));
        off += bytes;
      } else if (t === 7) {
        values.push(payload.readDoubleBE(off));
        off += 8;
      } else if (t === 8) {
        values.push(0);
      } else if (t === 9) {
        values.push(1);
      } else if (t >= 12 && t % 2 === 0) {
        const len = (t - 12) / 2;
        values.push(Buffer.from(payload.subarray(off, off + len)));
        off += len;
      } else if (t >= 13) {
        const len = (t - 13) / 2;
        values.push(payload.toString(this.utf16 ? 'utf16le' : 'utf8', off, off + len));
        off += len;
      } else {
        // 10 / 11 是内部保留类型，正常的数据库里不会出现
        throw new Error(`未知的 serial type: ${t}`);
      }
    }
    return values;
  }

  /** 从某个根页开始全表扫描，对每行回调 (rowid, 值数组)。 */
  _scan(rootPage, onRow) {
    const stack = [rootPage];
    while (stack.length) {
      const pageNo = stack.pop();
      const page = this._page(pageNo);
      const base = pageNo === 1 ? 100 : 0;
      const type = page.readUInt8(base);
      const cellCount = page.readUInt16BE(base + 3);
      const headerLen = type === 5 || type === 2 ? 12 : 8;

      if (type === 5) {
        // 内部页：每个 cell 的左孩子，最右子页排在最后。
        // 倒着压栈，弹出时才是从左到右——也就是 rowid 升序。顺序错了不会报错，
        // 只会安静地打乱行序，所以这里的方向是有测试盯着的。
        const children = [];
        for (let i = 0; i < cellCount; i++) {
          const off = page.readUInt16BE(base + headerLen + i * 2);
          children.push(page.readUInt32BE(off));
        }
        children.push(page.readUInt32BE(base + 8));
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      } else if (type === 13) {
        for (let i = 0; i < cellCount; i++) {
          let off = page.readUInt16BE(base + headerLen + i * 2);
          const [payloadSize, a] = readVarintNum(page, off);
          off += a;
          const [rowid, b] = readVarintNum(page, off);
          off += b;
          onRow(rowid, this._record(this._payload(page, off, payloadSize)));
        }
      } else {
        throw new Error(`不支持的页类型 ${type}（page ${pageNo}）——只处理表 b-tree`);
      }
    }
  }

  _readSchema() {
    const tables = new Map();
    // sqlite_master 固定在 page 1，列是 type / name / tbl_name / rootpage / sql
    this._scan(1, (_rowid, [type, name, , rootpage, sql]) => {
      if (type === 'table' && sql) {
        tables.set(name, { rootPage: rootpage, columns: parseColumns(sql) });
      }
    });
    return tables;
  }

  /** 全表读成对象数组。 */
  table(name) {
    const meta = this.schema.get(name);
    if (!meta) throw new Error(`表不存在：${name}`);
    const rows = [];
    this._scan(meta.rootPage, (rowid, values) => {
      const row = {};
      meta.columns.forEach((col, i) => {
        const v = values[i];
        row[col.name] = col.rowidAlias && v === null ? rowid : v;
      });
      rows.push(row);
    });
    return rows;
  }

  /** 全表读成 Map<主键, 行>，用于后面按 id join。 */
  indexBy(name, key = 'id') {
    const map = new Map();
    for (const row of this.table(name)) map.set(row[key], row);
    return map;
  }
}

module.exports = { SqliteFile };
