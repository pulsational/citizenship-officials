/// <reference types="node" />
// 任务 OL1 测试：运行记录 runs/<UTC 年-月>.md。三种结果（没变化、名单变了、照片变了）各出一行、失败也记一行；
// 按月分文件、只追加不覆盖；workflow 里先写记录再提交数据，记录单独提交、只带这一个文件；runs/ 不进网站。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, listChanges, logFile, logLine, photoChanges, resultText, whenText, NO_CHANGE } from '../pipeline/officials/runlog.ts';
import type { PhotosManifest } from '../pipeline/officials/photos.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = JSON.parse(readFileSync(join(ROOT, 'public', 'officials.json'), 'utf8'));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const WF = readFileSync(join(ROOT, '.github', 'workflows', 'officials-daily.yml'), 'utf8');
const at = (s: string) => { const i = WF.indexOf(s); assert.ok(i >= 0, `workflow 里没有「${s}」`); return i; };

const entry = (id: string, name: string, sha: string) => ({
  id, name, file: `photos/${id}.jpg`, sha256: sha, bytes: 9000, source: 'wikimedia-commons' as const, filePage: 'x', commonsFile: 'x',
  license: 'Public domain', licenseUrl: '', artist: '', credit: '', restrictions: '', attributionRequired: false, fetchedAt: '2026-11-04',
});
const manifest = (entries: ReturnType<typeof entry>[]): PhotosManifest => ({ version: 1, generatedAt: '2026-11-05T00:00:00Z', entries, missing: [] });

test('名单没变（只有日期变）→ 没变化', () => {
  const next = clone(PUB);
  next.generatedAt = '2099-01-01T00:00:00Z';
  next.states.asOf = '2099-01-01';
  assert.deepEqual(listChanges(PUB, next), []);
  assert.equal(resultText([], []), NO_CHANGE);
});

test('名单变了：州长换人、众议员出空缺、空缺补上、参议员换人，逐条写出州、职位、旧名字 → 新名字', () => {
  const next = clone(PUB);
  const ca = next.states.byState.CA;
  const oldGov = ca.governor.name;
  ca.governor = { ...ca.governor, name: 'Test Governor', accepted: ['Test Governor'] };
  const rep = ca.representatives[0];
  ca.representatives = ca.representatives.slice(1);
  ca.vacancies = [...(ca.vacancies ?? []), { district: rep.district, note: 'Vacant since test' }];
  const tx = next.states.byState.TX;
  const oldSen = tx.senators[0].name;
  tx.senators[0] = { ...tx.senators[0], name: 'New Senator', accepted: ['New Senator'] };
  const lines = listChanges(PUB, next);
  assert.ok(lines.includes(`CA 州长：${oldGov} → Test Governor`), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`CA 第 ${rep.district} 选区众议员：${rep.name}`) && l.endsWith('空缺（Vacant since test）')), lines.join('\n'));
  assert.ok(lines.includes(`TX 参议员：${oldSen} → New Senator`), lines.join('\n'));
  // 反过来：空缺补上
  const back = listChanges(next, PUB);
  assert.ok(back.some((l) => l.startsWith(`CA 第 ${rep.district} 选区众议员：空缺（Vacant since test） → ${rep.name}`)), back.join('\n'));
  assert.match(resultText(lines, []), /^名单变了：/);
});

test('全国类：总统换人只写一次（2008 和 2025 两个题号问的是同一个人）', () => {
  const next = clone(PUB);
  next.national.answers['2025-38'] = ['Next President'];
  next.national.answers['2008-28'] = ['Next President'];
  const lines = listChanges(PUB, next);
  assert.equal(lines.filter((l) => l.startsWith('全国 总统')).length, 1, lines.join('\n'));
});

test('照片变了：新加、换了、撤下都写出谁', () => {
  const a = manifest([entry('gov-CA', 'Old Name', 'a'.repeat(64)), entry('sen-X', 'Gone Person', 'b'.repeat(64))]);
  const b = manifest([entry('gov-CA', 'New Name', 'c'.repeat(64)), entry('rep-NY-3', 'New Face', 'd'.repeat(64))]);
  const lines = photoChanges(a, b);
  assert.deepEqual(lines, ['New Name（gov-CA）换了，原来是 Old Name', 'New Face（rep-NY-3）新加', 'Gone Person（sen-X）撤下']);
  assert.deepEqual(photoChanges(a, a), []);
  assert.match(resultText([], lines), /^照片变了：/);
  assert.match(resultText(['CA 州长：A → B'], lines), /^名单变了：CA 州长：A → B；照片变了：/);
});

test('时间：UTC 和太平洋时间都写，夏令时和冬令时都对', () => {
  assert.equal(whenText(new Date('2026-11-05T14:03:00Z')), '2026-11-05 14:03 UTC / 太平洋时间 2026-11-05 06:03 PST');
  assert.equal(whenText(new Date('2026-07-01T03:30:00Z')), '2026-07-01 03:30 UTC / 太平洋时间 2026-06-30 20:30 PDT');
});

test('一行里有 run 链接和结果；按 UTC 月份分文件；只追加，第一次写标题', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runs-'));
  const url = 'https://github.com/pulsational/citizenship-officials/actions/runs/41844736552';
  const d1 = new Date('2026-11-30T23:00:00Z'), d2 = new Date('2026-12-01T00:30:00Z');
  const line = logLine(d1, url, NO_CHANGE);
  assert.equal(line, `- 2026-11-30 23:00 UTC / 太平洋时间 2026-11-30 15:00 PST · [run 41844736552](${url}) · 没变化`);
  appendLog(dir, d1, line);
  appendLog(dir, d1, logLine(d1, url, '失败：抓取、生成、校验'));
  appendLog(dir, d2, logLine(d2, url, NO_CHANGE));
  const nov = readFileSync(logFile(dir, d1), 'utf8');
  assert.equal(logFile(dir, d1), join(dir, '2026-11.md'));
  assert.equal(logFile(dir, d2), join(dir, '2026-12.md'), '按 UTC 月份：太平洋时间还是 11 月 30 日，也记进 12 月');
  assert.equal((nov.match(/^# /gm) ?? []).length, 1, '标题只写一次');
  assert.equal((nov.match(/^- /gm) ?? []).length, 2, '追加，不覆盖');
  assert.match(nov, /失败：抓取、生成、校验/);
});

test('命令行：三种情况各出一行（没变化、名单变了、照片变了），失败那种也出一行；打印的就是结果那一句', () => {
  const work = mkdtempSync(join(tmpdir(), 'runlog-cli-'));
  const prev = join(work, 'prev'), next = join(work, 'next'), runs = join(work, 'runs');
  mkdirSync(prev); mkdirSync(next);
  cpSync(join(ROOT, 'public', 'officials.json'), join(prev, 'officials.json'));
  writeFileSync(join(prev, 'photos-manifest.json'), JSON.stringify(manifest([])));
  const cli = (args: string[]) => spawnSync(process.execPath, [join(ROOT, 'pipeline', 'officials', 'runlog.ts'), ...args, '--dir', runs, '--run-url', 'https://github.com/x/y/actions/runs/1', '--now', '2026-11-05T14:03:00Z'], { encoding: 'utf8' });
  // 1. 没变化
  cpSync(join(prev, 'officials.json'), join(next, 'officials.json'));
  writeFileSync(join(next, 'photos-manifest.json'), JSON.stringify(manifest([])));
  let r = cli(['ok', '--prev', prev, '--next', next]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '没变化');
  // 2. 名单变了
  const o = clone(PUB); o.states.byState.CA.capital = { ...o.states.byState.CA.capital, name: 'Testville' };
  writeFileSync(join(next, 'officials.json'), JSON.stringify(o));
  r = cli(['ok', '--prev', prev, '--next', next]);
  assert.match(r.stdout.trim(), /^名单变了：CA 首府：Sacramento → Testville$/);
  // 3. 照片变了
  cpSync(join(prev, 'officials.json'), join(next, 'officials.json'));
  writeFileSync(join(next, 'photos-manifest.json'), JSON.stringify(manifest([entry('gov-CA', 'Someone', 'e'.repeat(64))])));
  r = cli(['ok', '--prev', prev, '--next', next]);
  assert.equal(r.stdout.trim(), '照片变了：Someone（gov-CA）新加');
  // 4. 失败
  r = cli(['failure', '--step', '抓取、生成、校验']);
  assert.equal(r.stdout.trim(), '失败：抓取、生成、校验');
  const lines = readFileSync(join(runs, '2026-11.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 4);
  // 用法不对 → 退出码 2，不写文件
  assert.equal(cli(['oops']).status, 2);
  assert.equal(readFileSync(join(runs, '2026-11.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).length, 4);
});

test('workflow：记录在「提交回本仓库」之前写（那一步会把 out 拷进 public）；记录单独提交、只带 runs/ 这个月的文件；失败也记', () => {
  const write = at('- name: 写运行记录'), commit = at('- name: 提交回本仓库'), commitLog = at('- name: 提交运行记录'), upload = at('actions/upload-pages-artifact@');
  assert.ok(at('node pipeline/officials/site-check.ts site') < write && write < commit && commit < commitLog && commitLog < upload);
  const step = WF.slice(write, commit);
  assert.match(step, /runlog\.ts ok --prev public --next out --dir runs --run-url /);
  const logStep = WF.slice(commitLog, upload);
  assert.match(logStep, /git commit -m "run log：\$SUMMARY" -- "\$LOGFILE"/);
  assert.doesNotMatch(logStep, /git add -A|git add \.|public\//, '运行记录那个提交只带 runs/ 的文件');
  const fail = WF.slice(at('- name: 失败时记运行记录'), at('- name: 失败时开 issue'));
  assert.match(fail, /if: failure\(\)/);
  assert.match(fail, /runlog\.ts failure --step "\$FAILED"/);
  assert.match(fail, /git commit -m "run log：\$s" -- "\$f"/);
  for (const id of ['test', 'fetch', 'site', 'runlog', 'commit', 'commitlog']) assert.match(fail, new RegExp(`steps\\.${id}\\.outcome == 'failure'`), `失败那一步要能认出 ${id}`);
});

test('runs/ 不进网站：网站目录只拷 officials.json、photos-manifest.json、photos', () => {
  const copies = [...WF.matchAll(/cp (?:-R )?(\S+) site\/(\S+)/g)].map((m) => m[1]);
  assert.ok(copies.every((c) => !c.startsWith('runs')));
  assert.doesNotMatch(WF, /site\/runs/);
});
