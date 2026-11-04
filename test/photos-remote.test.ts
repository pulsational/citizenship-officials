/// <reference types="node" />
// 任务 PH 测试：远程照片。app 已打包的人一律跳过；上次发布的照片原样沿用；网站目录只许有三类东西；照片真的变了才提交。
// 网络全是假的，不联网；照片是测试里现做的几十字节假 JPEG（不需要 ffmpeg）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOfficials } from '../src/officials/index.ts';
import type { OfficialsData } from '../src/officials/index.ts';
import { peopleForNameAudio } from '../src/officials/nameAudio.ts';
import { photoStep } from '../pipeline/officials/photos.ts';
import type { PhotoEntry, PhotosManifest } from '../pipeline/officials/photos.ts';
import { BUNDLED_IDS_FILE, bundledIdsFrom, loadBundledIds } from '../pipeline/officials/bundled-ids.ts';
import { siteProblems } from '../pipeline/officials/site-check.ts';
import { photosChanged } from '../pipeline/officials/photos-changed.ts';
import { run } from '../pipeline/officials/run.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const data = parseOfficials(JSON.parse(readFileSync(join(ROOT, 'public', 'officials.json'), 'utf8'))) as OfficialsData;
const people = peopleForNameAudio(data);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const quiet = () => {};
/** 假 JPEG：开头 FF D8，后面一点字节，按 seed 区分 */
const jpg = (seed: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed & 255, 1, 2, 3, 0xff, 0xd9]);

function entry(id: string, name: string, b: Buffer, extra: Partial<PhotoEntry> = {}): PhotoEntry {
  return { id, name, file: `photos/${id}.jpg`, sha256: sha(b), bytes: b.length, source: 'wikimedia-commons',
    filePage: `https://commons.wikimedia.org/wiki/File:${id}.jpg`, commonsFile: `${id}.jpg`, license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0',
    artist: 'Someone', credit: '', restrictions: '', attributionRequired: true, fetchedAt: '2026-11-01T00:00:00Z', ...extra };
}

/** 一个网站目录（或 public/ 那样的上一版目录）：officials.json + 清单 + 照片 */
function makeSite(photos: { id: string; name: string; b: Buffer }[], dir = tmp('site-')): string {
  mkdirSync(join(dir, 'photos'), { recursive: true });
  writeFileSync(join(dir, 'officials.json'), '{}');
  for (const p of photos) writeFileSync(join(dir, 'photos', `${p.id}.jpg`), p.b);
  const m: PhotosManifest = { version: 1, generatedAt: '2026-11-01T00:00:00Z', entries: photos.map((p) => entry(p.id, p.name, p.b)), missing: [] };
  writeFileSync(join(dir, 'photos-manifest.json'), JSON.stringify(m, null, 1));
  return dir;
}

// —— 打包名单 ——

test('bundled-photo-ids.json：读得出、582 个、和 app 打包清单的生成规则一致（排序、去重、count 对得上）', () => {
  const ids = loadBundledIds();
  assert.equal(ids.size, 582);
  const f = JSON.parse(readFileSync(BUNDLED_IDS_FILE, 'utf8'));
  assert.deepEqual(f.ids, [...f.ids].sort());
  assert.match(f.appCommit, /^[0-9a-f]{7,40}$/);
  // 生成器：同一批 id 生成出来的 ids 和提交的一样
  assert.deepEqual(bundledIdsFrom({ entries: f.ids.map((id: string) => ({ id })).reverse() }, f.appCommit).ids, f.ids);
  assert.throws(() => bundledIdsFrom({ entries: [{ id: 'A1' }, { id: 'A1' }] }, 'abcdef0'), /重复/);
  assert.throws(() => bundledIdsFrom({ entries: [{ id: '../x' }] }, 'abcdef0'), /不像 id/);
  // 文件坏了（count 对不上）→ 读的时候就抛，整次运行失败，不会退回「全部重新找」
  const bad = join(tmp('ids-'), 'b.json'); writeFileSync(bad, JSON.stringify({ ...f, count: 1 }));
  assert.throws(() => loadBundledIds(bad), /count/);
});

test('照片这一步：打包过的 id 不找、不沿用、不进清单也不算还缺；只给其余的人发查询', async () => {
  // 只留两个人不在打包名单里：一位众议员、一位州长
  const rep = people.find((p) => p.role === 'representative')!;
  const gov = people.find((p) => p.role === 'governor')!;
  const skip = new Set(people.map((p) => p.id).filter((id) => id !== rep.id && id !== gov.id));
  // 上一版里有一张打包过的人的照片：也不能沿用进新清单
  const other = people.find((p) => skip.has(p.id) && p.role !== 'governor')!;
  const prev = makeSite([{ id: other.id, name: other.name, b: jpg(1) }]);
  const queries: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://query.wikidata.org/sparql')) {
      queries.push(String(new URLSearchParams(String(init?.body)).get('query')));
      return new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 });
    }
    throw new Error(`不该请求 ${url}`);
  }) as typeof fetch;
  const out = tmp('out-');
  const r = await photoStep({ data, prevDir: prev, outDir: out, fetch: fakeFetch, wait429Ms: 0, log: quiet, skipIds: skip });
  assert.deepEqual(r.manifest.entries, []);
  assert.deepEqual(r.missing.map((m) => m.id).sort(), [gov.id, rep.id].sort());
  const q = queries.join('\n');
  assert.ok(q.includes(JSON.stringify(rep.id)), q);
  assert.ok(!q.includes(JSON.stringify(other.id)), '打包过的人不该出现在查询里');
  // 尺子：不传 skipIds 时，同一个人会被查（证明上面的「不出现」是跳过造成的，不是查询本来就不带它）
  queries.length = 0;
  await photoStep({ data, prevDir: null, outDir: tmp('out-'), fetch: fakeFetch, wait429Ms: 0, log: quiet });
  assert.ok(queries.join('\n').includes(JSON.stringify(other.id)));
  assert.deepEqual(readdirSync(join(out, 'photos')), []);
});

test('上一版发布的远程照片（public/）原样沿用：不联网、字节不变', async () => {
  const keep = people.find((p) => p.role === 'senator')!;
  const skip = new Set(people.map((p) => p.id).filter((id) => id !== keep.id));
  const b = jpg(7);
  const prev = makeSite([{ id: keep.id, name: keep.name, b }]);
  const out = tmp('out-');
  const noNet = (async (u: string) => { throw new Error(`不该联网：${u}`); }) as typeof fetch;
  const r = await photoStep({ data, prevDir: prev, outDir: out, fetch: noNet, wait429Ms: 0, log: quiet, skipIds: skip });
  assert.equal(r.kept, 1);
  assert.deepEqual(readFileSync(join(out, 'photos', `${keep.id}.jpg`)), b);
  assert.equal(photosChanged(prev, out), false, '沿用 = 没变，不提交');
});

// —— 网站目录检查 ——

test('网站目录：officials.json + photos-manifest.json + photos/<id>.jpg 通过；没有照片也通过', () => {
  assert.deepEqual(siteProblems(makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }, { id: 'X000001', name: 'X', b: jpg(2) }])), []);
  assert.deepEqual(siteProblems(makeSite([])), []);
});

test('网站目录：多一个文件就不过（顶层、photos 里的非 jpg、子目录、符号链接、清单外的 jpg）', () => {
  const cases: [string, (d: string) => void, RegExp][] = [
    ['顶层多一个 CHANGES.md', (d) => writeFileSync(join(d, 'CHANGES.md'), 'x'), /多了：CHANGES\.md/],
    ['顶层多一个 manifest.json', (d) => writeFileSync(join(d, 'manifest.json'), '{}'), /多了：manifest\.json/],
    ['photos 里多一个 html', (d) => writeFileSync(join(d, 'photos', 'x.html'), '<script>'), /多了：photos\/x\.html/],
    ['photos 里套一层目录', (d) => { mkdirSync(join(d, 'photos', 'sub')); writeFileSync(join(d, 'photos', 'sub', 'A1.jpg'), jpg(3)); }, /多了：photos\/sub/],
    ['jpg 不在清单里', (d) => writeFileSync(join(d, 'photos', 'Z000009.jpg'), jpg(4)), /目录里有、清单里没有：photos\/Z000009\.jpg/],
    ['符号链接', (d) => symlinkSync('/etc/hosts', join(d, 'photos', 'L000001.jpg')), /符号链接/],
    ['少了清单', (d) => rmSync(join(d, 'photos-manifest.json')), /缺：photos-manifest\.json/],
  ];
  for (const [what, mutate, re] of cases) {
    const d = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }]);
    mutate(d);
    const bad = siteProblems(d);
    assert.ok(bad.some((x) => re.test(x)), `${what}：应该报 ${re}，实际 ${JSON.stringify(bad)}`);
  }
});

test('网站目录：清单和照片对不上（sha、大小、file 不是 photos/<id>.jpg、不是 JPEG）或者出现打包过的 id 都不过', () => {
  const d1 = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }]);
  writeFileSync(join(d1, 'photos', 'gov-IA.jpg'), jpg(9));
  assert.ok(siteProblems(d1).some((x) => /sha256 对不上/.test(x)));
  const d2 = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }]);
  const m = JSON.parse(readFileSync(join(d2, 'photos-manifest.json'), 'utf8'));
  m.entries[0].file = 'photos/../officials.json';
  writeFileSync(join(d2, 'photos-manifest.json'), JSON.stringify(m));
  assert.ok(siteProblems(d2).some((x) => /id \/ file 不对/.test(x)));
  const d3 = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: Buffer.from('not a jpeg') }]);
  assert.ok(siteProblems(d3).some((x) => /不是 JPEG/.test(x)));
  const d4 = makeSite([{ id: 'A000055', name: 'Robert B. Aderholt', b: jpg(1) }]);
  assert.ok(siteProblems(d4, loadBundledIds()).some((x) => /app 已打包/.test(x)));
});

// —— workflow 里那一步本身：拿 yml 原文到临时目录里用 bash 跑。检查被放宽（删掉 site-check、换成只看顶层）这条就会红 ——
const WF = readFileSync(join(ROOT, '.github', 'workflows', 'officials-daily.yml'), 'utf8');
function siteStepScript(): string {
  const i = WF.indexOf('- name: 准备网站目录');
  assert.ok(i >= 0, 'workflow 里没有「准备网站目录」那一步');
  const block = WF.slice(i).split('\n');
  const start = block.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  const indent = /^\s*/.exec(block[start + 1])![0].length;
  const lines: string[] = [];
  for (const l of block.slice(start + 1)) { if (l.trim() && /^\s*/.exec(l)![0].length < indent) break; lines.push(l.slice(indent)); }
  // 脚本里用相对路径 node pipeline/…：换成本仓库的绝对路径，在临时目录里跑
  return lines.join('\n').replaceAll('node pipeline/', `node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ${ROOT}pipeline/`);
}
function runSiteStep(out: string): { status: number | null; stderr: string; cwd: string } {
  const cwd = tmp('wf-');
  cpSync(out, join(cwd, 'out'), { recursive: true });
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', siteStepScript()], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH}` } });
  return { status: r.status, stderr: r.stderr + r.stdout, cwd };
}

test('workflow「准备网站目录」：正常产物通过，site/ 里正好是三类东西', () => {
  const out = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }]);
  writeFileSync(join(out, 'CHANGES.md'), 'x'); writeFileSync(join(out, 'manifest.json'), '{}'); // 产物目录里本来就有、但不该发布的
  const r = runSiteStep(out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(join(r.cwd, 'site')).sort(), ['officials.json', 'photos', 'photos-manifest.json']);
  assert.deepEqual(readdirSync(join(r.cwd, 'site', 'photos')), ['gov-IA.jpg']);
});

test('workflow「准备网站目录」：产物的 photos/ 里多一个文件 → 这一步失败（不发布）', () => {
  for (const extra of ['evil.html', 'gov-IA.jpg.bak', 'notes.txt']) {
    const out = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }]);
    writeFileSync(join(out, 'photos', extra), 'x');
    const r = runSiteStep(out);
    assert.notEqual(r.status, 0, `多了 photos/${extra} 却通过了：${r.stderr}`);
    assert.match(r.stderr, new RegExp(`多了：photos/${extra.replace(/\./g, '\\.')}`));
  }
  // 清单里写了、目录里不该有的打包 id（照片这一步出错时）→ 也失败
  const out = makeSite([{ id: 'A000055', name: 'Robert B. Aderholt', b: jpg(1) }]);
  const r = runSiteStep(out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /app 已打包/);
});

// —— 照片真的变了才提交 ——

test('photosChanged：条目一样 → same；换了照片、多一个人、上一版没有清单、仓库里的文件被改坏 → changed', () => {
  const a = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }]);
  const same = makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }]);
  // generatedAt 不一样不算变
  const m = JSON.parse(readFileSync(join(same, 'photos-manifest.json'), 'utf8')); m.generatedAt = '2099-01-01T00:00:00Z';
  writeFileSync(join(same, 'photos-manifest.json'), JSON.stringify(m));
  assert.equal(photosChanged(a, same), false);
  assert.equal(photosChanged(a, makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(2) }])), true);
  assert.equal(photosChanged(a, makeSite([{ id: 'gov-IA', name: 'Kim Reynolds', b: jpg(1) }, { id: 'X000001', name: 'X', b: jpg(3) }])), true);
  const empty = tmp('prev-');
  assert.equal(photosChanged(empty, same), true);
  writeFileSync(join(a, 'photos', 'gov-IA.jpg'), jpg(5));
  assert.equal(photosChanged(a, same), true);
});

// —— 整条流程离线跑一遍（存好的原始页面 + 假网络）：照片这一步只查没打包的人，产物过得了网站检查 ——
test('run()：带打包名单离线跑，照片只查没打包的人（现在只有 gov-IA），产物过 siteProblems；命令行读不到打包名单就失败', async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push(String(new URLSearchParams(String(init?.body)).get('query')));
    return new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 });
  }) as typeof fetch;
  const out = join(tmp('run-'), 'o');
  const r = await run({ out, src: join(ROOT, 'scripts', 'officials', 'src'), prev: join(ROOT, 'public', 'officials.json'), now: new Date('2026-11-02T03:00:00Z'),
    log: quiet, prevPhotos: tmp('prevp-'), photosFetch: fakeFetch, wait429Ms: 0, photoSkipIds: loadBundledIds() });
  assert.ok(r.ok, r.errors.join('\n'));
  const m = JSON.parse(readFileSync(join(out, 'photos-manifest.json'), 'utf8'));
  assert.deepEqual(m.missing.map((x: { id: string }) => x.id), ['gov-IA']);
  assert.equal(seen.length, 1, '只该有州长那一条查询（众议员、参议员全打包了）');
  assert.match(seen[0], /"Governor of Iowa"@en/);
  // 网站目录 = officials.json + 清单 + photos/（产物里的 CHANGES.md、manifest.json 不拷）
  const site = tmp('site-');
  cpSync(join(out, 'officials.json'), join(site, 'officials.json'));
  cpSync(join(out, 'photos-manifest.json'), join(site, 'photos-manifest.json'));
  cpSync(join(out, 'photos'), join(site, 'photos'), { recursive: true });
  assert.deepEqual(siteProblems(site, loadBundledIds()), []);
  // 命令行：--bundled-ids 指向不存在的文件 → 退出码非 0，不出产物（不会退回「全部重新找」）
  const out2 = join(tmp('run-'), 'o');
  const cli = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(ROOT, 'pipeline/officials/run.ts'),
    '--out', out2, '--src', join(ROOT, 'scripts', 'officials', 'src'), '--prev', join(ROOT, 'public', 'officials.json'), '--bundled-ids', join(tmp('x-'), 'nope.json')], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /nope\.json/);
  assert.equal(readdirSync(join(out2, '..')).length, 0);
});
