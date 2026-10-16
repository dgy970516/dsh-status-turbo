import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'D:/deepseek-harness/sessions';
const SID = 'session-9e44e9a9-f3b0-4b33-b141-10d4fe99aebb';

function findFile(dir, id) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (!e.isDirectory()) continue;
    if (e.name === id) {
      const inner = fs.readdirSync(p).filter((f) => f.endsWith('.zstd'));
      if (inner.length) return path.join(p, inner[0]);
      continue;
    }
    const hit = findFile(p, id);
    if (hit) return hit;
  }
  return null;
}

const file = findFile(ROOT, SID);
if (!file) { console.log('session file not found'); process.exit(0); }
const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offs = [];
let i = buf.indexOf(MAGIC);
while (i !== -1) { offs.push(i); i = buf.indexOf(MAGIC, i + 4); }
offs.push(buf.length);

const local = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '');
const perType = new Map();
const top = [];
let total = 0, scanned = 0, lines = 0;

for (let f = 0; f < offs.length - 1; f++) {
  let text;
  try { text = zlib.zstdDecompressSync(buf.subarray(offs[f], offs[f + 1])).toString('utf8'); } catch { continue; }
  scanned += text.length;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l[0] !== '{') continue;
    lines++;
    total += l.length;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const t = String(o.type || '?');
    const d = perType.get(t) || { n: 0, bytes: 0 };
    d.n++; d.bytes += l.length;
    perType.set(t, d);
    if (l.length > 200000) {
      const data = o.data && typeof o.data === 'object' ? o.data : {};
      let hint = '';
      for (const k of ['message', 'text', 'content', 'data', 'tool', 'name']) {
        const v = data[k];
        const s = typeof v === 'string' ? v : v ? JSON.stringify(v) : '';
        if (s && s.length > 200) { hint = k + '=' + s.slice(0, 160).replace(/\s+/g, ' '); break; }
      }
      top.push({ bytes: l.length, type: t, seq: o.seq, time: local(o.time), hint });
    }
    if (scanned > 2.5e9) break;
  }
  if (scanned > 2.5e9) break;
}

const out = [];
out.push(`file=${file}`);
out.push(`fileBytes=${buf.length} frames=${offs.length - 1} lines=${lines} decompressedChars=${total} scannedChars=${scanned}`);
out.push('\n### 按事件类型的累计字符数（前 15）');
[...perType.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15)
  .forEach(([t, v]) => out.push(`  ${t.padEnd(26)} n=${String(v.n).padEnd(7)} chars=${v.bytes}`));
out.push(`\n### 单条 > 200 KB 的事件（共 ${top.length} 条，按大小降序前 20）`);
top.sort((a, b) => b.bytes - a.bytes).slice(0, 20)
  .forEach((t) => out.push(`  ${String(t.bytes).padStart(10)} B  ${t.type.padEnd(22)} seq=${String(t.seq).padEnd(7)} ${t.time}  ${t.hint}`));

fs.writeFileSync('D:/project/.tmp-sess/oversize-report.txt', out.join('\n') + '\n', 'utf8');
console.log('wrote D:/project/.tmp-sess/oversize-report.txt  topCount=' + top.length);
