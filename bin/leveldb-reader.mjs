import fs from "node:fs";
import path from "node:path";

const LEVELDB_TABLE_MAGIC = 0xdb4775248b80fb57n;
const LEVELDB_LOG_BLOCK_SIZE = 32768;

function readVarint(buf, pos) {
  let res = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    res |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [Number(res), pos];
    }
    shift += 7n;
  }
  throw new Error("Unexpected EOF while reading varint");
}

export function snappyDecompress(src) {
  const input = Buffer.isBuffer(src) ? src : Buffer.from(src);
  const [uncompressedLen, startPos] = readVarint(input, 0);
  const out = Buffer.allocUnsafe(uncompressedLen);
  let pos = startPos;
  let outPos = 0;

  while (pos < input.length) {
    const tag = input[pos++];
    const tagType = tag & 0x03;

    if (tagType === 0) {
      const lenField = tag >> 2;
      let length;
      if (lenField < 60) {
        length = lenField + 1;
      } else {
        const numBytes = lenField - 59;
        length = input.readUIntLE(pos, numBytes) + 1;
        pos += numBytes;
      }
      input.copy(out, outPos, pos, pos + length);
      pos += length;
      outPos += length;
    } else {
      let length;
      let offset;
      if (tagType === 1) {
        length = ((tag >> 2) & 0x07) + 4;
        offset = ((tag & 0xe0) << 3) | input[pos++];
      } else if (tagType === 2) {
        length = (tag >> 2) + 1;
        offset = input.readUInt16LE(pos);
        pos += 2;
      } else {
        length = (tag >> 2) + 1;
        offset = input.readUInt32LE(pos);
        pos += 4;
      }
      if (offset === 0 || offset > outPos) {
        throw new Error(`Invalid Snappy copy offset: ${offset}`);
      }
      for (let i = 0; i < length; i++) {
        out[outPos + i] = out[outPos - offset + i];
      }
      outPos += length;
    }
  }

  return outPos === out.length ? out : out.subarray(0, outPos);
}

export function parseLevelDbTable(buf) {
  if (!buf || buf.length < 48) return [];
  const footer = buf.subarray(buf.length - 48);
  if (footer.readBigUInt64LE(40) !== LEVELDB_TABLE_MAGIC) return [];

  let p = 0;
  [, p] = readVarint(footer, p);
  [, p] = readVarint(footer, p);
  let idxOff;
  let idxSz;
  [idxOff, p] = readVarint(footer, p);
  [idxSz] = readVarint(footer, p);

  const readBlock = (off, sz) => {
    if (off < 0 || sz < 0 || off + sz + 1 > buf.length) return [];
    let raw = buf.subarray(off, off + sz);
    const ctype = buf[off + sz];
    if (ctype === 1) {
      raw = snappyDecompress(raw);
    }
    if (raw.length < 4) return [];
    const numRestarts = raw.readUInt32LE(raw.length - 4);
    const limit = raw.length - 4 - numRestarts * 4;
    const entries = [];
    let pos = 0;
    let prevKey = Buffer.alloc(0);

    while (pos < limit) {
      let shared;
      let nonShared;
      let valLen;
      [shared, pos] = readVarint(raw, pos);
      [nonShared, pos] = readVarint(raw, pos);
      [valLen, pos] = readVarint(raw, pos);
      const key = Buffer.concat([prevKey.subarray(0, shared), raw.subarray(pos, pos + nonShared)]);
      pos += nonShared;
      const val = Buffer.from(raw.subarray(pos, pos + valLen));
      pos += valLen;
      prevKey = key;
      entries.push({ key, val });
    }
    return entries;
  };

  const out = [];
  for (const { val: handle } of readBlock(idxOff, idxSz)) {
    const [boff, hp] = readVarint(handle, 0);
    const [bsz] = readVarint(handle, hp);
    for (const { key, val } of readBlock(boff, bsz)) {
      if (key.length < 8) continue;
      const userKey = key.subarray(0, key.length - 8);
      const tag = key.readBigUInt64LE(key.length - 8);
      out.push({
        seq: tag >> 8n,
        vtype: Number(tag & 0xffn),
        key: userKey,
        val,
      });
    }
  }
  return out;
}

export function parseLevelDbLog(buf) {
  if (!buf || buf.length < 7) return [];
  const records = [];
  let curChunks = [];
  let pos = 0;

  while (pos + 7 <= buf.length) {
    const remInBlock = LEVELDB_LOG_BLOCK_SIZE - (pos % LEVELDB_LOG_BLOCK_SIZE);
    if (remInBlock < 7) {
      pos += remInBlock;
      continue;
    }
    const length = buf.readUInt16LE(pos + 4);
    const rtype = buf[pos + 6];
    pos += 7;

    if (rtype === 0) {
      pos += remInBlock - 7;
      continue;
    }
    if (pos + length > buf.length) {
      break;
    }

    const payload = buf.subarray(pos, pos + length);
    pos += length;

    if (rtype === 1) {
      records.push(payload);
    } else if (rtype === 2) {
      curChunks = [payload];
    } else if (rtype === 3) {
      if (curChunks.length > 0) curChunks.push(payload);
    } else if (rtype === 4) {
      if (curChunks.length > 0) {
        curChunks.push(payload);
        records.push(Buffer.concat(curChunks));
        curChunks = [];
      }
    }
  }

  const out = [];
  for (const rec of records) {
    if (rec.length < 12) continue;
    const seq = rec.readBigUInt64LE(0);
    const count = rec.readUInt32LE(8);
    let p = 12;

    for (let i = 0; i < count; i++) {
      if (p >= rec.length) break;
      const vtype = rec[p++];
      let klen;
      [klen, p] = readVarint(rec, p);
      if (p + klen > rec.length) break;
      const key = Buffer.from(rec.subarray(p, p + klen));
      p += klen;

      let val = Buffer.alloc(0);
      if (vtype === 1) {
        let vlen;
        [vlen, p] = readVarint(rec, p);
        if (p + vlen > rec.length) break;
        val = Buffer.from(rec.subarray(p, p + vlen));
        p += vlen;
      }

      out.push({
        seq: seq + BigInt(i),
        vtype,
        key,
        val,
      });
    }
  }
  return out;
}

export function readLevelDbEntries(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const records = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    if (entry.name.endsWith(".ldb") || entry.name.endsWith(".sst")) {
      records.push(...parseLevelDbTable(fs.readFileSync(filePath)));
    } else if (entry.name.endsWith(".log")) {
      records.push(...parseLevelDbLog(fs.readFileSync(filePath)));
    }
  }

  records.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  const latest = new Map();
  for (const rec of records) {
    const mapKey = rec.key.toString("latin1");
    if (rec.vtype === 1) {
      latest.set(mapKey, { key: rec.key, val: rec.val });
    } else if (rec.vtype === 0) {
      latest.delete(mapKey);
    }
  }
  return latest;
}

export function decodeElectronLocalStorageValue(buf) {
  if (!buf || buf.length === 0) return "";
  if (buf[0] === 1) return buf.subarray(1).toString("latin1");
  if (buf[0] === 0) return buf.subarray(1).toString("utf16le");
  return buf.toString("utf8");
}

export function readElectronLocalStorage(dir, { origin = "t3code://app" } = {}) {
  try {
    const entries = readLevelDbEntries(dir);
    if (!entries) return null;
    const prefix = `_${origin}\x00\x01`;
    const prefixLen = Buffer.byteLength(prefix, "latin1");
    const out = new Map();

    for (const [latinKey, { key, val }] of entries) {
      if (!latinKey.startsWith(prefix)) continue;
      const shortKey = key.subarray(prefixLen).toString("utf8");
      out.set(shortKey, decodeElectronLocalStorageValue(val));
    }
    return out;
  } catch {
    return null;
  }
}
