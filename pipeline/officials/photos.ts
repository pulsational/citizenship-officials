/// <reference types="node" />
// 任务 CR / CS：议员和州长照片，每日流程里单独一步。
// 照片从 Wikimedia Commons 取，定时任务也下载新议员的照片；授权按白名单，人格权标记照收但记下来。bioguide 照旧不碰。
//
// 逻辑：
//   - 上一版 photos-manifest 里已有的人（id 和名字都一样、文件 sha 对得上）直接沿用，不重复下载
//   - 新面孔（和上一版缺的人）才去找：Wikidata 按 bioguideId（P1157）或「Governor of 某州」在任（P39）找到 Commons 图（P18），
//     再用 Commons API（imageinfo + extmetadata）读授权字段；授权在白名单里才下载
//   - 找不到 / 授权不行 / 压不到 15 KB 的这次留空（界面显示首字母），记进 missing，下次再找
//   - 缩略图：160px 宽 JPEG，去掉 EXIF / ICC / XMP 这类元数据段，每张 < 15 KB
// 网络和 ffmpeg 都通过参数传进来，测试可以换成假的。UA 固定 shortvideo-skill/1.0；403 失败退出，429 等一会儿原样重试。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OfficialsData } from '../../src/officials/index.ts';
import { peopleForNameAudio } from '../../src/officials/nameAudio.ts';

export const UA = 'shortvideo-skill/1.0';
export const MAX_BYTES = 15000;
export const WIDTH = 160;

export interface PhotoEntry {
  id: string; name: string; file: string; sha256: string; bytes: number;
  source: 'wikimedia-commons'; filePage: string; commonsFile: string;
  license: string; licenseUrl: string; artist: string; credit: string; restrictions: string;
  /** 要不要在关于页注明作者（CC BY / CC BY-SA） */
  attributionRequired: boolean;
  fetchedAt: string;
}
export interface PhotosManifest { version: 1; generatedAt: string; entries: PhotoEntry[]; missing: { id: string; name: string; why: string }[] }

/** 授权白名单。返回 null = 可以用；否则是不用的原因 */
export function licenseProblem(m: { license: string; artist: string; nonFree: string }): string | null {
  if (m.nonFree.toLowerCase() === 'true') return '文件页标了 NonFree';
  const l = m.license.trim();
  if (l === 'Public domain' || l === 'CC0' || l === 'Copyrighted free use' || l === 'PDM-owner') return null;
  if (/^CC BY(-SA)? [0-9.]+$/.test(l)) return m.artist ? null : `${l} 但文件页没写作者`;
  return `授权「${l || '（空）'}」不在白名单里`;
}
export const needsAttribution = (license: string) => /^CC BY(-SA)? /.test(license);

/** 去掉 JPEG 里的 APP1–APP15（EXIF、ICC、XMP、Photoshop）和 COM 段，只留 APP0 和图像数据；像素不重新编码 */
export function stripJpegMetadata(b: Buffer): Buffer {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('不是 JPEG');
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (b[i] !== 0xff) throw new Error(`JPEG 段格式不对（位置 ${i}）`);
    const m = b[i + 1];
    if (m === 0xda) { out.push(b.subarray(i)); return Buffer.concat(out); }
    const len = b.readUInt16BE(i + 2);
    if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
}

/** 原图 → 160 宽 JPEG（ffmpeg），去元数据；质量从高到低试，压不到 15 KB 返回 null */
export function makeThumb(original: Buffer, ffmpeg = 'ffmpeg'): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), 'thumb-'));
  try {
    writeFileSync(join(dir, 'in'), original);
    for (const q of [4, 6, 8, 10]) {
      execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', join(dir, 'in'), '-map_metadata', '-1', '-vf', `scale=${WIDTH}:-2,format=yuvj420p`, '-q:v', String(q), join(dir, 'out.jpg')]);
      const t = stripJpegMetadata(readFileSync(join(dir, 'out.jpg')));
      if (t.length < MAX_BYTES) return t;
    }
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 作者清洗：Commons 的 Artist 字段是 HTML 转来的，会带页面上的链接提示。
 *  去掉：「( see here )」「(talk)」「(talk · contribs)」「(page does not exist)」这类括号提示；名字后面「 - 网址」；
 *  HTML 里名字和缩写各出现一次造成的「X X」重复。括号里的实在内容（机构、党派州名、Image courtesy…）不动。 */
export function cleanArtist(s: string): string {
  let t = s.replace(/\(\s*(?:see here|talk(?:\s*[·•|]\s*contribs)?|contribs|page does not exist)\s*\)/gi, ' ');
  t = t.replace(/\s+-\s*https?:\/\/\S+\s*$/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  const dup = /^(.+?)\s+\1$/.exec(t);
  return dup ? dup[1] : t;
}

const html2txt = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET/POST 带固定 UA；403 抛异常（不绕），429 等 wait429Ms 原样重试最多 3 次 */
export async function politeFetch(f: typeof fetch, url: string, init: RequestInit = {}, wait429Ms = 90_000): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await f(url, { ...init, headers: { ...(init.headers ?? {}), 'user-agent': UA } });
    if (r.status === 429 && attempt < 3) { await sleep(wait429Ms); continue; }
    if (r.status !== 200) throw new Error(`${url.slice(0, 80)} 返回 ${r.status}，停手`);
    return r;
  }
}

async function sparql(f: typeof fetch, q: string, wait: number): Promise<Record<string, { value: string }>[]> {
  const r = await politeFetch(f, 'https://query.wikidata.org/sparql', {
    method: 'POST', body: new URLSearchParams({ query: q, format: 'json' }), headers: { accept: 'application/sparql-results+json' } }, wait);
  return (await r.json()).results.bindings;
}

/** 新面孔 → Commons 文件名（找不到的不在结果里）。众议员、参议员按 bioguideId；州长按「Governor of 州名」在任 + 姓对得上 */
export async function findCommonsFiles(f: typeof fetch, want: { id: string; name: string; state: string; stateName: string }[], wait = 90_000): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const fileOf = (url: string) => decodeURIComponent(url.split('/').pop()!);
  const bg = want.filter((w) => !w.id.startsWith('gov-'));
  if (bg.length) {
    const rows = await sparql(f, `SELECT ?bg ?img WHERE { VALUES ?bg { ${bg.map((w) => JSON.stringify(w.id)).join(' ')} } ?item wdt:P1157 ?bg . ?item wdt:P18 ?img }`, wait);
    for (const r of rows.sort((a, b) => a.img.value.localeCompare(b.img.value))) if (!out.has(r.bg.value)) out.set(r.bg.value, fileOf(r.img.value));
  }
  const gov = want.filter((w) => w.id.startsWith('gov-'));
  if (gov.length) {
    const labels = gov.map((w) => `"Governor of ${w.stateName}"@en`).join(' ');
    const rows = await sparql(f, `SELECT ?label ?itemLabel ?img WHERE { VALUES ?label { ${labels} } ?pos rdfs:label ?label . ?item p:P39 ?st . ?st ps:P39 ?pos . FILTER NOT EXISTS { ?st pq:P582 ?end } ?item wdt:P18 ?img . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`, wait);
    const last = (n: string) => n.replace(/\b[A-Z]\.\s*/g, '').replace(/,.*$/, '').trim().split(/\s+/).pop()!.toLowerCase();
    for (const w of gov) {
      const hits = rows.filter((r) => r.label.value === `Governor of ${w.stateName}` && last(r.itemLabel.value) === last(w.name)).map((r) => fileOf(r.img.value)).sort();
      if (hits.length) out.set(w.id, hits[0]);
    }
  }
  return out;
}

export interface CommonsInfo { file: string; filePage: string; thumbUrl: string; license: string; licenseUrl: string; artist: string; credit: string; restrictions: string; nonFree: string }

/** Commons API：每 50 个文件一次，读 extmetadata 授权字段和 160 宽缩略图地址 */
export async function commonsInfo(f: typeof fetch, files: string[], wait = 90_000): Promise<Map<string, CommonsInfo>> {
  const out = new Map<string, CommonsInfo>();
  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    const qs = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: String(WIDTH), titles: chunk.map((x) => `File:${x}`).join('|') });
    const d = await (await politeFetch(f, `https://commons.wikimedia.org/w/api.php?${qs}`, {}, wait)).json();
    const norm = new Map<string, string>((d.query?.normalized ?? []).map((n: { from: string; to: string }) => [n.to, n.from]));
    for (const pg of Object.values(d.query?.pages ?? {}) as { title: string; imageinfo?: { descriptionurl: string; thumburl: string; extmetadata?: Record<string, { value: string }> }[] }[]) {
      const ii = pg.imageinfo?.[0]; if (!ii) continue;
      const em = ii.extmetadata ?? {}, g = (k: string) => html2txt(em[k]?.value ?? '');
      const file = (norm.get(pg.title) ?? pg.title).replace(/^File:/, '');
      out.set(file, { file, filePage: ii.descriptionurl, thumbUrl: ii.thumburl, license: g('LicenseShortName'), licenseUrl: g('LicenseUrl'),
        artist: cleanArtist(g('Artist')), credit: g('Credit').slice(0, 300), restrictions: g('Restrictions'), nonFree: g('NonFree') });
    }
    if (i + 50 < files.length) await sleep(1000);
  }
  return out;
}

const STATE_NAMES = (d: OfficialsData) => Object.fromEntries(Object.entries(d.states.byState).map(([k, s]) => [k, s.name]));

export interface PhotoStepResult { manifest: PhotosManifest; added: PhotoEntry[]; kept: number; missing: PhotosManifest['missing'] }

/**
 * 跑照片这一步。prevDir = 上一版产物里的 photos/ 和 photos-manifest.json 所在目录（没有就当全是新面孔）；outDir 写 photos/<id>.jpg 和 photos-manifest.json。
 * 只给现任的人：卸任的人不再出现在新 manifest 里。
 */
export async function photoStep(o: { data: OfficialsData; prevDir: string | null; outDir: string; fetch?: typeof fetch; ffmpeg?: string; now?: Date; wait429Ms?: number; log?: (s: string) => void;
  /** 任务 PH：app 里已经打包了照片的 id（bundled-photo-ids.json）。这些人不找、不沿用、不进 manifest，也不算「还缺」 */
  skipIds?: ReadonlySet<string> }): Promise<PhotoStepResult> {
  const f = o.fetch ?? fetch, log = o.log ?? console.log, now = (o.now ?? new Date()).toISOString();
  const all = peopleForNameAudio(o.data);
  const people = all.filter((p) => !o.skipIds?.has(p.id)).map((p) => ({ ...p, stateName: STATE_NAMES(o.data)[p.state] }));
  if (o.skipIds) log(`照片：app 已打包 ${all.length - people.length} 人，跳过；只看其余 ${people.length} 人`);
  const prevPath = o.prevDir ? join(o.prevDir, 'photos-manifest.json') : null;
  const prev: PhotosManifest | null = prevPath && existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : null;
  const prevById = new Map((prev?.entries ?? []).map((e) => [e.id, e]));
  mkdirSync(join(o.outDir, 'photos'), { recursive: true });
  const entries: PhotoEntry[] = [], added: PhotoEntry[] = [], missing: PhotosManifest['missing'] = [];
  const todo: typeof people = [];
  for (const p of people) {
    const e = prevById.get(p.id);
    const src = e && o.prevDir ? join(o.prevDir, e.file) : null;
    if (e && e.name === p.name && src && existsSync(src) && createHash('sha256').update(readFileSync(src)).digest('hex') === e.sha256) {
      writeFileSync(join(o.outDir, e.file), readFileSync(src)); entries.push({ ...e, artist: cleanArtist(e.artist) });
    } else todo.push(p);
  }
  log(`照片：沿用 ${entries.length}，要找 ${todo.length}`);
  if (todo.length) {
    const files = await findCommonsFiles(f, todo, o.wait429Ms);
    const info = await commonsInfo(f, [...new Set(files.values())], o.wait429Ms);
    for (const p of todo) {
      const file = files.get(p.id);
      if (!file) { missing.push({ id: p.id, name: p.name, why: 'Wikidata 上找不到照片' }); continue; }
      const m = info.get(file);
      if (!m) { missing.push({ id: p.id, name: p.name, why: `Commons 读不到 ${file}` }); continue; }
      const bad = licenseProblem(m);
      if (bad) { missing.push({ id: p.id, name: p.name, why: bad }); continue; }
      const thumb = makeThumb(Buffer.from(await (await politeFetch(f, m.thumbUrl, {}, o.wait429Ms)).arrayBuffer()), o.ffmpeg);
      if (!thumb) { missing.push({ id: p.id, name: p.name, why: `压不到 ${MAX_BYTES} 字节以下` }); continue; }
      const rel = `photos/${p.id}.jpg`;
      writeFileSync(join(o.outDir, rel), thumb);
      const e: PhotoEntry = { id: p.id, name: p.name, file: rel, sha256: createHash('sha256').update(thumb).digest('hex'), bytes: thumb.length,
        source: 'wikimedia-commons', filePage: m.filePage, commonsFile: file, license: m.license, licenseUrl: m.licenseUrl, artist: m.artist,
        credit: m.credit, restrictions: m.restrictions, attributionRequired: needsAttribution(m.license), fetchedAt: now };
      entries.push(e); added.push(e);
      await sleep(o.wait429Ms === 0 ? 0 : 1000);
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const manifest: PhotosManifest = { version: 1, generatedAt: now, entries, missing: missing.sort((a, b) => a.id.localeCompare(b.id)) };
  writeFileSync(join(o.outDir, 'photos-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  return { manifest, added, kept: entries.length - added.length, missing };
}

/** CHANGES.md 里的「照片」一节 */
export function photosMarkdown(r: PhotoStepResult): string {
  const lines = ['', '## 照片', '', `现有 ${r.manifest.entries.length} 张（沿用 ${r.kept}，这次新增 ${r.added.length}）；还缺 ${r.missing.length} 人（界面显示首字母，下次再找）。`];
  if (r.added.length) lines.push('', '新增：', ...r.added.map((e) => `- ${e.name}（${e.id}）：${e.license}${e.attributionRequired ? `，作者 ${e.artist}` : ''}${e.restrictions ? `，文件页标注 ${e.restrictions}` : ''}`));
  if (r.missing.length) lines.push('', '还缺：', ...r.missing.map((m) => `- ${m.name}（${m.id}）：${m.why}`));
  return lines.join('\n') + '\n';
}
