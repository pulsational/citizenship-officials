/// <reference types="node" />
// 任务 PH：发布前检查网站目录（site/）。网站上只许有三类东西，别的一律让这次运行失败（不发布）：
//   officials.json · photos-manifest.json · photos/<id>.jpg
// 另外核对：清单里的每张照片都在、sha256 和大小对得上、是 JPEG、小于 15 KB；目录里的每张 jpg 都在清单里；
// app 已经打包了照片的人（id 和名字都一样）不该出现在这里（照片这一步应该已经跳过了，这里再拦一次）；
// 同一个 id 换了人（名字不一样）可以出现——那是给新的人找的照片。
//
//   node pipeline/officials/site-check.ts site      没问题退出码 0；有问题逐条打印、退出码 1
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BYTES } from './photos.ts';
import { PHOTO_ID_RE, isBundled, loadBundledIds } from './bundled-ids.ts';

const TOP = new Set(['officials.json', 'photos-manifest.json', 'photos']);
const JPG_RE = new RegExp(`^photos/(${PHOTO_ID_RE.source.slice(1, -1)})\\.jpg$`);

/** 递归列出目录里的一切（相对路径，用 / 分隔）；符号链接也列出来，不跟进去 */
function walk(dir: string, rel = ''): { rel: string; kind: 'file' | 'dir' | 'other' }[] {
  return readdirSync(join(dir, rel)).sort().flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    const st = lstatSync(join(dir, r));
    if (st.isDirectory()) return [{ rel: r, kind: 'dir' as const }, ...walk(dir, r)];
    return [{ rel: r, kind: st.isFile() ? 'file' as const : 'other' as const }];
  });
}

/** 返回问题列表；空 = 可以发布 */
export function siteProblems(dir: string, bundled: ReadonlyMap<string, string> = new Map()): string[] {
  const bad: string[] = [];
  const all = walk(dir);
  const jpgs = new Set<string>();
  for (const f of all) {
    if (f.kind === 'other') { bad.push(`不是普通文件（符号链接之类）：${f.rel}`); continue; }
    if (!f.rel.includes('/')) {
      if (!TOP.has(f.rel)) bad.push(`多了：${f.rel}`);
      else if ((f.rel === 'photos') !== (f.kind === 'dir')) bad.push(`类型不对：${f.rel}`);
      continue;
    }
    const m = JPG_RE.exec(f.rel);
    if (!m || f.kind !== 'file') { bad.push(`多了：${f.rel}`); continue; }
    jpgs.add(f.rel);
  }
  for (const need of ['officials.json', 'photos-manifest.json']) if (!existsSync(join(dir, need))) bad.push(`缺：${need}`);
  if (bad.length) return bad;

  let manifest: { entries?: unknown };
  try { manifest = JSON.parse(readFileSync(join(dir, 'photos-manifest.json'), 'utf8')); } catch { return ['photos-manifest.json 不是 JSON']; }
  if (!Array.isArray(manifest.entries)) return ['photos-manifest.json 没有 entries'];
  const listed = new Set<string>();
  for (const e of manifest.entries as { id?: unknown; name?: unknown; file?: unknown; sha256?: unknown; bytes?: unknown }[]) {
    const id = typeof e.id === 'string' ? e.id : '';
    if (!PHOTO_ID_RE.test(id) || e.file !== `photos/${id}.jpg`) { bad.push(`清单条目 id / file 不对：${String(e.id)} → ${String(e.file)}`); continue; }
    if (listed.has(e.file)) { bad.push(`清单里重复：${id}`); continue; }
    listed.add(e.file);
    if (typeof e.name !== 'string' || !e.name.trim()) bad.push(`清单条目没有名字：${id}`);
    else if (isBundled(bundled, id, e.name)) bad.push(`app 已打包这个人的照片，不该发布：${id} ${e.name}`);
    if (!jpgs.has(e.file)) { bad.push(`清单里有、目录里没有：${e.file}`); continue; }
    const b = readFileSync(join(dir, e.file));
    if (b.length !== e.bytes) bad.push(`大小对不上：${e.file}（清单 ${String(e.bytes)}，实际 ${b.length}）`);
    if (b.length >= MAX_BYTES) bad.push(`超过 ${MAX_BYTES} 字节：${e.file}`);
    if (b[0] !== 0xff || b[1] !== 0xd8) bad.push(`不是 JPEG：${e.file}`);
    if (createHash('sha256').update(b).digest('hex') !== e.sha256) bad.push(`sha256 对不上：${e.file}`);
  }
  for (const j of jpgs) if (!listed.has(j)) bad.push(`目录里有、清单里没有：${j}`);
  return bad;
}

function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('用法：node pipeline/officials/site-check.ts <网站目录>'); process.exit(2); }
  const bad = siteProblems(dir, loadBundledIds());
  if (bad.length) { console.error(`网站目录里只许有 officials.json、photos-manifest.json、photos/*.jpg，而且要和清单对得上：\n  ${bad.join('\n  ')}`); process.exit(1); }
  console.log(`网站目录检查通过：${walk(dir).filter((f) => f.kind === 'file').length} 个文件`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(`失败：${e instanceof Error ? e.message : e}`); process.exit(1); }
}
