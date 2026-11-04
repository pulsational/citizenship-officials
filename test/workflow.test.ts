/// <reference types="node" />
// 任务 OF 测试：每日 workflow 和公开仓库本身。网站上只放 officials.json；校验通过才提交、才发布；仓库里不出现邮箱、密钥、内部消息 id；名单没变不提交。
// 任务 PH：网站上加了 photos-manifest.json 和 photos/*.jpg（只给 app 没打包照片的人），网站目录检查改成只许这三类（site-check.ts，跑法测试在 photos-remote.test.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { listChanged } from '../pipeline/officials/changed.ts';
import { siteProblems } from '../pipeline/officials/site-check.ts';
import { loadBundledIds } from '../pipeline/officials/bundled-ids.ts';
import { parseOfficials } from '../src/officials/index.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const WF = readFileSync(join(ROOT, '.github', 'workflows', 'officials-daily.yml'), 'utf8');
const at = (s: string) => { const i = WF.indexOf(s); assert.ok(i >= 0, `workflow 里没有「${s}」`); return i; };

test('发布用 deploy-pages，网站目录只拷 officials.json、photos-manifest.json、photos/，并且用 site-check.ts 拦多余文件', () => {
  at('actions/deploy-pages@');
  assert.match(WF, /upload-pages-artifact@v\d+\s+with:\s+path: site\n/);
  const copies = [...WF.matchAll(/cp (?:-R )?(\S+) site\/(\S+)/g)];
  assert.deepEqual(copies.map((m) => m[2]), ['officials.json', 'photos-manifest.json', 'photos']);
  assert.deepEqual(copies.map((m) => m[1]), ['out/officials.json', 'out/photos-manifest.json', 'out/photos']);
  const step = WF.slice(at('- name: 准备网站目录'), at('- name: 提交回本仓库'));
  assert.match(step, /\n\s+node pipeline\/officials\/site-check\.ts site\n/);
  assert.doesNotMatch(WF, /path: (out|\.)\s*$/m);
});

test('顺序：抓取校验 → 准备并检查网站目录 → 提交回本仓库 → 上传；deploy 依赖前一个 job', () => {
  const run = at('node pipeline/officials/run.ts');
  const site = at('mkdir site');
  const check = at('node pipeline/officials/site-check.ts site');
  const commit = at('git commit -m');
  const upload = at('actions/upload-pages-artifact@');
  // 网站目录检查不过 = 不提交：所以检查必须在提交之前
  assert.ok(run < site && site < check && check < commit && commit < upload);
  assert.match(WF, /exit \$\{PIPESTATUS\[0\]\}/);
  assert.match(WF, /deploy:\s+needs: officials/);
});

test('只用本仓库的 GITHUB_TOKEN：不读 secrets，权限按 job 给', () => {
  assert.doesNotMatch(WF, /secrets\./);
  assert.match(WF, /^permissions:\s+contents: read$/m);
  assert.match(WF, /contents: write/);
  assert.match(WF, /pages: write\s+id-token: write/);
  // 任务 PH：照片要抓（只给没打包的人），上一版照片取 public/
  assert.doesNotMatch(WF, /--no-photos/);
  assert.match(WF, /run\.ts --out out --prev public\/officials\.json --prev-photos public /);
  assert.match(WF, /41898282\+github-actions\[bot\]@users\.noreply\.github\.com/);
});

test('public/ 里只有 officials.json（加上每日流程提交的 photos-manifest.json、photos/），app 的 parseOfficials 认它；有照片时和网站一样过 site-check', () => {
  const have = readdirSync(join(ROOT, 'public')).sort();
  assert.ok(have.includes('officials.json'));
  assert.deepEqual(have.filter((f) => !['officials.json', 'photos-manifest.json', 'photos'].includes(f)), []);
  assert.ok(parseOfficials(JSON.parse(readFileSync(join(ROOT, 'public', 'officials.json'), 'utf8'))));
  if (have.includes('photos-manifest.json')) assert.deepEqual(siteProblems(join(ROOT, 'public'), loadBundledIds()), []);
});

const SELF = new URL(import.meta.url).pathname;
const SECRET = /gmail\.com|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY/;

// 照片是二进制，按文字扫会误报（随机字节里凑出数字串）：不扫 jpg。照片清单是 Commons 原文（作者、来源说明），按数据文件对待
const PHOTO_DATA = (rel: string) => rel === 'public/photos-manifest.json';
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f === '.git' || f === 'node_modules' || f === 'out' || f === 'site' || /\.jpe?g$/i.test(f)) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('仓库里没有私人邮箱、key、token', () => {
  const all = files(ROOT);
  assert.ok(all.length > 50, `只找到 ${all.length} 个文件，尺子不对`);
  // 尺子：workflow 里的 bot 地址必须被下面的邮箱正则认出来
  const EMAIL = /[A-Za-z0-9._%+\[\]-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/g;
  assert.ok((WF.match(EMAIL) ?? []).length > 0);
  const ALLOWED = /noreply\.github\.com$|@house\.gov$|@senate\.gov$|@mail\.house\.gov$|@usa\.gov$|@gsa\.gov$|@nga\.org$/i;
  const bad: string[] = [];
  for (const f of all) {
    if (PHOTO_DATA(relative(ROOT, f))) continue;
    const t = readFileSync(f, 'utf8');
    for (const m of t.match(EMAIL) ?? []) if (!ALLOWED.test(m) && !/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(m)) bad.push(`${relative(ROOT, f)}: ${m}`);
    // 本文件里有下面这串正则的原文，会认出自己：跳过本文件（这一条也就是密钥正则的尺子）
    if (f !== SELF && SECRET.test(t)) bad.push(`${relative(ROOT, f)}: 像密钥或私人邮箱`);
  }
  assert.ok(SECRET.test(readFileSync(SELF, 'utf8')));
  assert.deepEqual(bad, []);
});

// —— 只在名单真的变了时提交（不看 generatedAt）——
const PUB = JSON.parse(readFileSync(join(ROOT, 'public', 'officials.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(PUB));

test('只有 generatedAt 变 → 不提交；按州的 asOf、fetched、dataVersion 一起变也不提交', () => {
  const a = clone(); a.generatedAt = '2026-11-03T14:00:05.000Z';
  assert.equal(listChanged(PUB, a), false);
  const b = clone(); b.generatedAt = '2026-11-04T14:00:05.000Z'; b.states.asOf = '2026-11-04'; b.dataVersion = 9;
  b.fetched = [{ url: 'https://clerk.house.gov/xml/lists/MemberData.xml', fetchedAt: '2026-11-04T14:00:01Z', status: 200, bytes: 1, sha256: 'x' }];
  assert.equal(listChanged(PUB, b), false);
});

test('名单真的变了（换人、改党派、出空缺）→ 提交；上一版读不出也提交', () => {
  const a = clone(); a.states.byState.CA.governor.name = 'Someone New'; a.generatedAt = 'x';
  assert.equal(listChanged(PUB, a), true);
  const b = clone(); b.states.byState.TX.senators[0].party = b.states.byState.TX.senators[0].party === 'R' ? 'D' : 'R';
  assert.equal(listChanged(PUB, b), true);
  const c = clone(); const r = c.states.byState.CA.representatives.shift(); c.states.byState.CA.vacancies = [{ district: r.district, note: 'Vacant' }];
  assert.equal(listChanged(PUB, c), true);
  const e = clone(); e.national.asOf = '2026-01-01';
  assert.equal(listChanged(PUB, e), true, '全国类 asOf 取自题库 reviewed 日期，题库更新了算变');
  assert.equal(listChanged({ version: 0 }, PUB), true);
  assert.throws(() => listChanged(PUB, { version: 1 }));
});

test('命令行：只改 generatedAt 打印 same；换了人打印 changed；坏文件退出码 2', () => {
  const d = mkdtempSync(join(tmpdir(), 'changed-'));
  const w = (n: string, x: unknown) => { const p = join(d, n); writeFileSync(p, typeof x === 'string' ? x : JSON.stringify(x)); return p; };
  const g = clone(); g.generatedAt = '2099-01-01T00:00:00.000Z';
  const ch = clone(); ch.states.byState.CA.governor.name = 'Someone New';
  const cli = (a: string, b: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(ROOT, 'pipeline/officials/changed.ts'), a, b], { encoding: 'utf8' });
  const prev = w('prev.json', PUB);
  let r = cli(prev, w('g.json', g)); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'same');
  r = cli(prev, w('c.json', ch)); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'changed');
  r = cli(prev, w('bad.json', '{"version":')); assert.equal(r.status, 2);
});

test('workflow：提交那一步先问 changed.ts 和 photos-changed.ts，两个都 same 就在 git commit 之前退出；不再用 git diff 判断', () => {
  const step = WF.slice(at('- name: 提交回本仓库'), at('- uses: actions/configure-pages@'));
  const ask = step.indexOf('r=$(node pipeline/officials/changed.ts public/officials.json out/officials.json)');
  const askP = step.indexOf('p=$(node pipeline/officials/photos-changed.ts public out)');
  const same = step.indexOf('if [ "$r" = same ] && [ "$p" = same ]; then');
  const commit = step.indexOf('git commit');
  assert.ok(ask >= 0 && askP > ask && same > askP && commit > same, step);
  assert.doesNotMatch(step, /git diff --quiet/);
  // 照片变了才拷照片、只提交 public/ 下这几个路径
  assert.match(step, /if \[ "\$p" != same \]; then\n\s+rm -rf public\/photos\n\s+cp -R out\/photos public\/photos\n\s+cp out\/photos-manifest\.json public\/photos-manifest\.json/);
  assert.match(step, /git commit -m "[^\n]*" -- "\$\{paths\[@\]\}"/);
});

// —— 公开仓库里不出现内部的 Discord 消息 id 和名字（官方数据文件除外：原始页面、产出的 officials.json）——
const INTERNAL = /(^|[^0-9A-Za-z])[0-9]{17,20}([^0-9A-Za-z]|$)|TroiBot|TuanBot|ToniBot|TiaoBot|浣熊/;
const DATA_EXEMPT = (rel: string) => rel.startsWith('scripts/officials/src/') || rel === 'public/officials.json' || PHOTO_DATA(rel);

test('没有 17–20 位纯数字的消息 id，也没有 TroiBot / TuanBot / ToniBot / TiaoBot / 浣熊王', () => {
  // 尺子：正则认得出一条真的消息 id 和名字，也不会把官方数据里的 9 位数、sha 当成 id
  assert.ok(INTERNAL.test('（TroiBot 1234567890123456789）') && INTERNAL.test('id 12345678901234567。') && INTERNAL.test('浣熊王'));
  assert.ok(!INTERNAL.test('24924174+pulsational') && !INTERNAL.test('sha256 57fad59f65af51234567890123456789ab'));
  const bad: string[] = [];
  for (const f of files(ROOT)) {
    const rel = relative(ROOT, f);
    if (f === SELF || DATA_EXEMPT(rel)) continue;
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (INTERNAL.test(l)) bad.push(`${rel}:${i + 1}: ${l.slice(0, 120)}`); });
  }
  assert.deepEqual(bad, []);
  // 本文件里只在这两行正则和尺子里出现
  assert.ok(INTERNAL.test(readFileSync(SELF, 'utf8')));
});
