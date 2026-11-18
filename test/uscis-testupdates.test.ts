/// <reference types="node" />
// 任务 OF2 测试：每日流程看一眼 USCIS「Check for Test Updates」页（全国类答案的来源）有没有变。
// 规范化只留「答案更新」那两节里的题和全国类答案，去掉导航、脚本、日期戳；变了开 issue，不改 officials.json、不改答案。
// 尺子：test/fixtures/uscis/ 里是 2025-09-18 前后的真实页面（Wayback 原样字节 + 2026-10-31、2026-11-18 直接抓的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, compare, diffLines, loadBaseline, snapshotOf, TESTUPDATES_URL } from '../pipeline/uscis/testupdates.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FX = (n: string) => readFileSync(join(ROOT, 'test', 'fixtures', 'uscis', `${n}.html`), 'utf8');
const LIVE = FX('2026-11-18');
const ok = (html: string) => { const r = normalize(html); assert.ok(r.ok, r.ok ? '' : r.reason); return r; };

test('地址取自题库 meta 的 testupdates_url', () => {
  const bank = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'bank.json'), 'utf8'));
  assert.equal(TESTUPDATES_URL, bank.meta.testupdates_url);
  assert.equal(TESTUPDATES_URL, 'https://www.uscis.gov/citizenship/testupdates');
});

test('规范化结果：两节标题、全国类题和答案都在；「答案因州而异」的题只留题面；没有日期戳、导航、脚本', () => {
  const r = ok(LIVE);
  const t = r.lines.join('\n');
  assert.match(t, /^## Civics Test \(2008 Version\) Updates$/m);
  assert.match(t, /^## Civics Test \(2025 Naturalization Civics Test\) Updates$/m);
  // 题面里拆开的「now」+「?」、「now?」+「*」要接回去
  assert.match(t, /^57\. Who is the Chief Justice of the United States now\?$/m);
  assert.match(t, /^38\. What is the name of the President of the United States now\?\*$/m);
  for (const a of ['Donald J. Trump', 'JD Vance', 'John G. Roberts, Jr.', 'Mike Johnson', 'James Michael Johnson (birth name)', 'Republican (Party)', 'nine (9)']) assert.ok(r.lines.includes(`- ${a}`), a);
  assert.match(t, /^20\. Who is one of your state's U\.S\. Senators now\?\*$/m);
  assert.doesNotMatch(t, /Answers will vary|senate\.gov|Last Reviewed|09\/18\/2025|Was this page helpful|Sign up|<|>/);
  assert.equal(r.reviewed, '09/18/2025');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

test('尺子：2025-09-18 之后的三份真实页面（2025-09-20 Wayback、2026-10-31、2026-11-18）规范化后一模一样 → 没变', () => {
  const a = ok(FX('2025-09-20')), b = ok(FX('2026-10-31')), c = ok(LIVE);
  // 原始字节确实不一样（导航、脚本、缓存标记每次都变），尺子是活的
  assert.notEqual(FX('2025-09-20'), FX('2026-10-31'));
  assert.notEqual(FX('2026-10-31'), LIVE);
  assert.equal(a.sha256, c.sha256);
  assert.equal(b.sha256, c.sha256);
  assert.equal(compare(snapshotOf(a), c).status, 'same');
});

test('尺子：2025-09-17（之前，没有 2025 版那一节）对 2025-09-20（之后）→ 变了，diff 里有新加的 2025 版一节', () => {
  const before = ok(FX('2025-09-17')), after = ok(FX('2025-09-20'));
  const r = compare(snapshotOf(before), after);
  assert.equal(r.status, 'changed');
  assert.match(r.diff, /^\+## Civics Test \(2025 Naturalization Civics Test\) Updates$/m);
  assert.match(r.diff, /^\+57\. Who is the Chief Justice of the United States now\?$/m);
  assert.equal(before.reviewed, '01/21/2025');
});

test('尺子：2025-01-07（Biden、Harris）对 2025-09-17（Trump、Vance）→ 变了，diff 里是换掉的人名', () => {
  const r = compare(snapshotOf(ok(FX('2025-01-07'))), ok(FX('2025-09-17')));
  assert.equal(r.status, 'changed');
  for (const x of ['-- Joseph R. Biden, Jr.', '-- Kamala D. Harris', '-- Democratic (Party)', '+- Donald J. Trump', '+- JD Vance', '+- Republican (Party)']) assert.ok(r.diff.split('\n').includes(x), `${x}\n${r.diff}`);
  // 没变的人不出现在 +/- 行里
  assert.ok(!r.diff.split('\n').some((l) => /^[+-]- Mike Johnson$/.test(l)));
});

// —— 任务要求的三种情况 ——

test('只改日期戳（Last Reviewed/Updated）→ 不算变；同时换掉导航、脚本、缓存标记也不算变', () => {
  const base = ok(LIVE);
  const html = LIVE.replace('09/18/2025', '11/30/2026')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/, '<script>window.x = "' + Date.now() + '";</script>')
    .replace(/<nav\b/, '<nav data-build="abc123"><a href="/new">New menu item</a></nav><nav');
  assert.notEqual(html, LIVE);
  assert.ok(html.includes('11/30/2026'));
  const r = ok(html);
  assert.equal(r.reviewed, '11/30/2026');
  assert.equal(compare(snapshotOf(base), r).status, 'same');
});

test('改一个人名 → 算变；diff 写出旧名字和新名字', () => {
  const base = ok(LIVE);
  const html = LIVE.split('JD Vance').join('Jane Q. Example');
  const r = compare(snapshotOf(base), ok(html));
  assert.equal(r.status, 'changed');
  assert.ok(r.diff.split('\n').includes('-- JD Vance'), r.diff);
  assert.ok(r.diff.split('\n').includes('+- Jane Q. Example'), r.diff);
});

test('页面为空、结构变了 → 报失败，绝不报「没变」', () => {
  const base = snapshotOf(ok(LIVE));
  const cases: [string, string, RegExp][] = [
    ['空字符串', '', /空/],
    ['只有空白', '  \n\t ', /空/],
    ['没有 <main>', LIVE.replace(/<main\b[^>]*>[\s\S]*<\/main>/, '<div>moved</div>'), /main/],
    ['main 是空的', LIVE.replace(/(<main\b[^>]*>)[\s\S]*(<\/main>)/, '$1$2'), /Updates/],
    ['两节标题改了名', LIVE.split(' Updates<').join(' Changes<'), /Updates/],
    ['总统那题没了', LIVE.split('name of the President of the United States now').join('name of the leader now'), /总统/],
    ['首席大法官的答案没了', LIVE.replace(/(Chief Justice of the United States now[\s\S]*?)John Roberts[\s\S]*?(<\/ul>)/g, '$1$2'), /首席大法官/],
  ];
  for (const [name, html, why] of cases) {
    const r = normalize(html);
    assert.equal(r.ok, false, `${name} 应该报失败`);
    if (!r.ok) assert.match(r.reason, why, `${name}：${r.reason}`);
    const c = compare(base, r);
    assert.equal(c.status, 'failed', name);
    assert.notEqual(c.status, 'same', name);
  }
});

test('上一次的存档自己算 hash 对不上 → 报失败（存档被手改坏了），不报没变', () => {
  const snap = snapshotOf(ok(LIVE));
  const bad = { ...snap, lines: snap.lines.slice(1) };
  assert.equal(compare(bad, ok(LIVE)).status, 'failed');
});

test('仓库里存的上一次（uscis/testupdates.json）就是 2025-09-18 版页面规范化的结果', () => {
  const b = loadBaseline(join(ROOT, 'uscis', 'testupdates.json'));
  assert.equal(b.sha256, ok(LIVE).sha256);
  assert.equal(b.reviewed, '09/18/2025');
  assert.equal(b.url, TESTUPDATES_URL);
});

test('diffLines：只列变了的行，前后各带一行上下文', () => {
  const d = diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'X', 'd', 'e']);
  assert.equal(d, ' b\n-c\n+X\n d');
  assert.equal(diffLines(['a'], ['a']), '');
});

// —— 命令行：抓取（本机起一个假 USCIS）——

const NODE = [process.execPath, '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];
const SCRIPT = join(ROOT, 'pipeline', 'uscis', 'testupdates.ts');

async function withServer(handler: (path: string, ua: string | undefined) => { status: number; body?: string; hang?: boolean }, fn: (base: string, hits: { path: string; ua?: string }[]) => Promise<void>) {
  const hits: { path: string; ua?: string }[] = [];
  const srv = createServer((req, res) => {
    hits.push({ path: req.url ?? '', ua: req.headers['user-agent'] });
    const r = handler(req.url ?? '', req.headers['user-agent']);
    if (r.hang) return; // 不回：给超时用
    res.writeHead(r.status, { 'content-type': 'text/html' });
    res.end(r.body ?? '');
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try { await fn(base, hits); } finally { srv.closeAllConnections(); srv.close(); }
}

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const p = spawn(NODE[0], [...NODE.slice(1), SCRIPT, ...args]);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => ok({ status, stdout, stderr }));
  });
}

function baselineFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'uscis-'));
  const f = join(d, 'baseline.json');
  writeFileSync(f, JSON.stringify(snapshotOf(ok(LIVE), TESTUPDATES_URL)));
  return f;
}
const out = () => mkdtempSync(join(tmpdir(), 'uscis-out-'));
const read = (d: string, f: string) => readFileSync(join(d, f), 'utf8');

test('命令行：没变 → 退出 0，summary「USCIS 没变」，不写 issue 文件；UA 是 citizenship-officials/1.0', async () => {
  await withServer(() => ({ status: 200, body: LIVE }), async (base, hits) => {
    const o = out();
    const r = await run(['check', '--baseline', baselineFile(), '--out', o, '--url', `${base}/citizenship/testupdates`, '--run-url', 'https://example.test/runs/1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(o, 'summary.txt').trim(), 'USCIS 没变');
    assert.ok(!existsSync(join(o, 'issue-title.txt')));
    assert.equal(JSON.parse(read(o, 'result.json')).status, 'same');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ua, 'citizenship-officials/1.0');
  });
});

test('命令行：变了 → 退出 0（不拖垮名单），写 issue：标题「USCIS testupdates 变了」，正文有 diff 和 run 链接；新存档写到 --out', async () => {
  await withServer(() => ({ status: 200, body: LIVE.split('Mike Johnson').join('Pat Example') }), async (base) => {
    const o = out();
    const r = await run(['check', '--baseline', baselineFile(), '--out', o, '--url', `${base}/x`, '--run-url', 'https://example.test/runs/42']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(o, 'issue-title.txt').trim(), 'USCIS testupdates 变了');
    const body = read(o, 'issue-body.md');
    assert.match(body, /https:\/\/example\.test\/runs\/42/);
    assert.match(body, /```diff\n[\s\S]*^-- Mike Johnson$[\s\S]*^\+- Pat Example$[\s\S]*```/m);
    assert.match(body, /不改 officials\.json/);
    assert.match(read(o, 'summary.txt'), /^USCIS 变了/);
    const snap = JSON.parse(read(o, 'testupdates.json'));
    assert.ok(snap.lines.includes('- Pat Example'));
  });
});

test('命令行：403 → 退出 1，只发一次请求（不加头重试），写失败 issue 和原因', async () => {
  await withServer(() => ({ status: 403, body: 'Access Denied' }), async (base, hits) => {
    const o = out();
    const r = await run(['check', '--baseline', baselineFile(), '--out', o, '--url', `${base}/x`, '--run-url', 'https://example.test/runs/7']);
    assert.equal(r.status, 1);
    assert.equal(hits.length, 1, '403 之后不许再发请求');
    assert.equal(read(o, 'issue-title.txt').trim(), 'USCIS testupdates 抓取失败');
    assert.match(read(o, 'issue-body.md'), /HTTP 403/);
    assert.match(read(o, 'summary.txt'), /^USCIS 检查失败：HTTP 403/);
    assert.equal(JSON.parse(read(o, 'result.json')).status, 'failed');
  });
});

test('命令行：超时 → 退出 1，原因写超时；页面是空的 → 退出 1，不报没变', async () => {
  await withServer(() => ({ status: 200, hang: true }), async (base, hits) => {
    const o = out();
    const r = await run(['check', '--baseline', baselineFile(), '--out', o, '--url', `${base}/x`, '--timeout-ms', '500']);
    assert.equal(r.status, 1);
    assert.equal(hits.length, 1);
    assert.match(read(o, 'summary.txt'), /超时/);
  });
  await withServer(() => ({ status: 200, body: '' }), async (base) => {
    const o = out();
    const r = await run(['check', '--baseline', baselineFile(), '--out', o, '--url', `${base}/x`]);
    assert.equal(r.status, 1);
    assert.match(read(o, 'summary.txt'), /^USCIS 检查失败：.*空/);
  });
});

test('命令行：--html 读本地文件不联网；参数不对 → 退出 2 并给用法，不写任何文件', () => {
  const o = out();
  let r = spawnSync(NODE[0], [...NODE.slice(1), SCRIPT, 'check', '--baseline', baselineFile(), '--out', o, '--html', join(ROOT, 'test', 'fixtures', 'uscis', '2026-10-31.html')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(o, 'summary.txt').trim(), 'USCIS 没变');
  const o2 = out();
  r = spawnSync(NODE[0], [...NODE.slice(1), SCRIPT, 'check', '--out', o2], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /用法/);
  assert.ok(!existsSync(join(o2, 'summary.txt')));
});

// —— workflow：这一步不拖垮名单、不改答案 ——

const WF = readFileSync(join(ROOT, '.github', 'workflows', 'officials-daily.yml'), 'utf8');
const at = (s: string) => { const i = WF.indexOf(s); assert.ok(i >= 0, `workflow 里没有「${s}」`); return i; };

test('workflow：USCIS 这一步在测试之后、名单之前，continue-on-error；失败标黄（::warning::）再退出 1；开 issue 先查有没有开着的同名 issue', () => {
  const step = WF.slice(at('- name: 看 USCIS testupdates 页'), at('- name: 抓取、生成、校验'));
  assert.ok(at('run: npm test') < at('- name: 看 USCIS testupdates 页'));
  assert.match(step, /\n\s+id: uscis\n\s+continue-on-error: true\n/);
  assert.match(step, /node pipeline\/uscis\/testupdates\.ts check --baseline uscis\/testupdates\.json --out uscis-out --run-url "\$RUN_URL"/);
  assert.match(step, /echo "summary=\$s" >> "\$GITHUB_OUTPUT"/);
  assert.match(step, /gh issue list --state open[^\n]*select\(\.title == \\"\$title\\"\)/);
  assert.match(step, /gh issue create --title "\$title" --body-file uscis-out\/issue-body\.md/);
  assert.match(step, /if \[ "\$code" -ne 0 \]; then echo "::warning title=USCIS testupdates::\$s"; exit 1; fi/);
  // 不改名单、不改答案、不改存档、不提交；不加头、不换工具重抓
  const code = step.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // 注释里可以提 officials.json，命令里不许
  assert.doesNotMatch(code, /officials\.json|bank\.json|git (add|commit|push)|cp [^\n]*uscis\/testupdates\.json|curl|wget|-H |user-agent|referer|cookie/i);
});

test('workflow：USCIS 的结果接进运行记录（成功和失败两条路都接）；没跑时也写明', () => {
  const ok = WF.slice(at('- name: 写运行记录'), at('- name: 提交回本仓库'));
  assert.match(ok, /USCIS: \$\{\{ steps\.uscis\.outputs\.summary \|\| 'USCIS 这一步没跑' \}\}/);
  assert.match(ok, /runlog\.ts ok [^\n]*--also "\$USCIS"/);
  const fail = WF.slice(at('- name: 失败时记运行记录'), at('- name: 失败时开 issue'));
  assert.match(fail, /USCIS: \$\{\{ steps\.uscis\.outputs\.summary \|\| 'USCIS 这一步没跑' \}\}/);
  assert.match(fail, /runlog\.ts failure --step "\$FAILED" --also "\$USCIS"/);
  // 名单失败时开的那个 issue 不认 USCIS 这一步（它出事只标黄，不算名单失败）
  assert.doesNotMatch(fail, /steps\.uscis\.outcome/);
});

test('uscis-out/ 不进仓库、不进网站', () => {
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^uscis-out\/$/m);
  assert.doesNotMatch(WF, /cp [^\n]*uscis[^\n]* site\//);
});

// —— UA：整个仓库只用 citizenship-officials/1.0（shortvideo-skill 是别的项目名）——
import { UA as FETCH_UA } from '../pipeline/officials/fetch.ts';
import { UA as PHOTOS_UA } from '../pipeline/officials/photos.ts';
import { UA as USCIS_UA } from '../pipeline/uscis/testupdates.ts';

test('三处抓取的 UA 都是 citizenship-officials/1.0；代码和说明里不再出现 shortvideo-skill', () => {
  assert.deepEqual([FETCH_UA, PHOTOS_UA, USCIS_UA], ['citizenship-officials/1.0', 'citizenship-officials/1.0', 'citizenship-officials/1.0']);
  for (const f of ['pipeline/officials/fetch.ts', 'pipeline/officials/photos.ts', 'pipeline/uscis/testupdates.ts', 'README.md']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /shortvideo-skill/, f);
  }
});
