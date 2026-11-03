/// <reference types="node" />
// 任务 CS：官员名单定时抓取，一条命令跑完。
//
//   source scripts/env.sh
//   node pipeline/officials/run.ts --out pipeline/officials/out                 # 抓取 → 生成 → 校验 → 写产物
//   node pipeline/officials/run.ts --out … --prev <上一版 officials.json>      # 默认和 public/officials.json（上次发布的）比
//   node pipeline/officials/run.ts --out … --src <已经抓好的目录>              # 不联网，用现成的原始页面（测试、复跑用）
//   node pipeline/officials/run.ts --out … --allow-big-change                  # 换届那天手动放行「变动太多」
//
// 产物（--out 目录，校验全过才写；任何一步失败退出码 1，不留产物）：
//   officials.json  app 用的格式 + dataVersion、generatedAt、fetched（每个来源的 URL、抓取时间、状态、大小、sha256）
//   manifest.json   产物文件的 sha256 和大小
//   CHANGES.md      和上一版比：谁上谁下、空缺变化（人话），加一节「照片：新增几张、还缺谁」
//   photos-manifest.json + photos/<id>.jpg   照片（pipeline/officials/photos.ts：新面孔才去 Commons 找，已有的沿用；--no-photos 跳过）
//   上一版照片默认取 app 里打包的 assets/officials/（--prev-photos 可改）
// ZIP 表（Census ZCTA × 国会选区）不进每日流程，手动跑 scripts/officials/build-zcta.ts（换届时一起换）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOfficials } from '../../scripts/officials/build.ts';
import { parseOfficials } from '../../src/officials/index.ts';
import { STATE_SLUGS, fetchAll, ngaTsv } from './fetch.ts';
import type { Fetched } from './fetch.ts';
import { changesMarkdown, validateOfficials } from './validate.ts';
import { photoStep, photosMarkdown } from './photos.ts';
import type { PipelineOfficials } from './validate.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** 内容指纹：不算 asOf / generatedAt / fetched 这些每天都变的字段，人和党派没变就是同一版 */
export function contentHash(d: { national: unknown; states: { byState: unknown } }): string {
  return sha(JSON.stringify({ national: d.national, byState: d.states.byState }));
}

export interface RunOptions {
  out: string; src?: string; prev?: string; allowBigChange?: boolean; now?: Date; log?: (s: string) => void;
  /** 照片：photos=false 跳过；prevPhotos 默认 assets/officials；photosFetch / wait429Ms 给测试换成假的 */
  photos?: boolean; prevPhotos?: string; photosFetch?: typeof fetch; wait429Ms?: number;
}

export async function run(o: RunOptions): Promise<{ ok: boolean; errors: string[]; data?: PipelineOfficials }> {
  const log = o.log ?? console.log;
  // 1. 抓取（或用现成目录）
  let src = o.src, fetched: Fetched[];
  if (!src) {
    src = mkdtempSync(join(tmpdir(), 'officials-src-'));
    log(`抓取到 ${src}`);
    fetched = await fetchAll(src, log);
  } else {
    const idx = join(src, '_index.tsv');
    fetched = existsSync(idx) ? readFileSync(idx, 'utf8').trim().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
      const [fetchedAt, status, url, file, bytes, h] = l.split('\t');
      return { fetchedAt, status: Number(status), url, file, bytes: Number(bytes), sha256: h };
    }) : [];
  }
  // 2. 生成：nga 页面 → 州长党派表，再走 build.ts 同一套解析
  const ngaDir = join(src, 'nga');
  if (existsSync(ngaDir)) {
    writeFileSync(join(src, 'nga_governors_party.tsv'), ngaTsv(STATE_SLUGS.map((slug) => ({ slug, html: readFileSync(join(ngaDir, `${slug}.html`), 'utf8') }))));
  }
  const bank = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'bank.json'), 'utf8'));
  const fetchedDate = (fetched.map((f) => f.fetchedAt).sort().pop() ?? (o.now ?? new Date()).toISOString()).slice(0, 10);
  const { data, problems } = buildOfficials(src, bank, fetchedDate);
  // 3. 版本：和上一版比内容变了才 +1
  const prevPath = o.prev ?? join(ROOT, 'public', 'officials.json');
  const prevRaw = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : null;
  const prev = prevRaw && parseOfficials(prevRaw) ? prevRaw : null;
  const prevVersion: number = prev?.dataVersion ?? 0;
  const same = prev && contentHash(prev) === contentHash(data);
  // generatedAt 取生成这一刻（抓取之后），不是程序启动的时间
  const next: PipelineOfficials = { ...data, dataVersion: same ? Math.max(prevVersion, 1) : prevVersion + 1, generatedAt: (o.now ?? new Date()).toISOString(), fetched };
  // 4. 校验（选区表 = 打包的 ZIP 表里的 435 个选区）
  const zips = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'zctaDistricts.json'), 'utf8'));
  const { errors, changes } = validateOfficials(next, prev, problems, { expectedDistricts: new Set(Object.keys(zips.districts)), allowBigChange: o.allowBigChange });
  if (parseOfficials(next) === null) errors.push('app 端的 parseOfficials 不认这份数据');
  if (errors.length) {
    log(`校验没过，${errors.length} 条，不出产物：\n  ${errors.join('\n  ')}`);
    return { ok: false, errors };
  }
  // 5. 写产物：先写临时目录，全写好再整个换过去（不会留下半份）
  const outDir = resolve(o.out);
  const tmp = `${outDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const offJson = JSON.stringify(next, null, 1) + '\n';
  const changesMd = changesMarkdown(changes, prev ? `${prevPath.replace(ROOT + '/', '')}（dataVersion ${prevVersion || '无'}，按州数据截至 ${prev.states.asOf}）` : '（没有上一版）', next);
  let photoMd = '';
  const outFiles = ['officials.json', 'CHANGES.md'];
  if (o.photos !== false) {
    // 照片：找不到的留空、下次再找；被拦（403）就整次失败，不留产物
    try {
      const prevPhotos = o.prevPhotos ?? join(ROOT, 'assets', 'officials');
      const r = await photoStep({ data: next, prevDir: existsSync(prevPhotos) ? prevPhotos : null, outDir: tmp, fetch: o.photosFetch, now: o.now, wait429Ms: o.wait429Ms, log });
      photoMd = photosMarkdown(r);
      outFiles.push('photos-manifest.json', ...r.manifest.entries.map((e) => e.file));
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      const msg = `照片这一步失败：${err instanceof Error ? err.message : err}`;
      log(msg);
      return { ok: false, errors: [msg] };
    }
  }
  writeFileSync(join(tmp, 'officials.json'), offJson);
  writeFileSync(join(tmp, 'CHANGES.md'), changesMd + photoMd);
  const files = outFiles.map((f) => { const b = readFileSync(join(tmp, f)); return { path: f, sha256: sha(b), bytes: b.length }; });
  writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ dataVersion: next.dataVersion, generatedAt: next.generatedAt, contentHash: contentHash(next), files }, null, 1) + '\n');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(dirname(outDir), { recursive: true });
  renameSync(tmp, outDir);
  log(`通过：dataVersion ${next.dataVersion}，${changes.length} 处变动；产物在 ${outDir}（${readdirSync(outDir).join('、')}）`);
  return { ok: true, errors: [], data: next };
}

async function main() {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = arg('out');
  if (!out) { console.error('用法：node pipeline/officials/run.ts --out <产物目录> [--prev <上一版 officials.json>] [--src <原始页面目录>] [--allow-big-change] [--no-photos] [--prev-photos <目录>]'); process.exit(2); }
  const r = await run({ out, src: arg('src'), prev: arg('prev'), allowBigChange: process.argv.includes('--allow-big-change'),
    photos: !process.argv.includes('--no-photos'), prevPhotos: arg('prev-photos') });
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(`失败：${e instanceof Error ? e.message : e}`); process.exit(1); });
