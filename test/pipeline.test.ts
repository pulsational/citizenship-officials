/// <reference types="node" />
// 任务 CS 测试：官员名单定时抓取。用仓库里存的原始页面（scripts/officials/src）离线跑，再故意喂坏数据，每种都要失败、不出产物。
// 跑法：source scripts/env.sh && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../pipeline/officials/run.ts';
import { FetchBlocked, fetchAll } from '../pipeline/officials/fetch.ts';
import { changesMarkdown, diffOfficials, validateOfficials } from '../pipeline/officials/validate.ts';
import type { PipelineOfficials } from '../pipeline/officials/validate.ts';

const SRC = new URL('../scripts/officials/src', import.meta.url).pathname;
const BUNDLED = new URL('../public/officials.json', import.meta.url).pathname;
const quiet = () => {};
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const srcCopy = () => { const d = tmp('src-'); cpSync(SRC, d, { recursive: true }); return d; };
const now = new Date('2026-11-02T03:00:00Z');

test('正常跑：离线用存好的原始页面，和打包版比 0 处变动；三个产物都在，manifest 里的 sha 对得上', async () => {
  const out = join(tmp('out-'), 'o');
  const r = await run({ out, src: SRC, prev: BUNDLED, now, log: quiet, photos: false });
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok && existsSync(join(out, 'officials.json')) && existsSync(join(out, 'CHANGES.md')) && existsSync(join(out, 'manifest.json')));
  const man = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  for (const f of man.files) assert.equal(createHash('sha256').update(readFileSync(join(out, f.path))).digest('hex'), f.sha256, f.path);
  assert.match(readFileSync(join(out, 'CHANGES.md'), 'utf8'), /没有变动/);
  assert.equal(r.data!.dataVersion, 1);
});

async function mustFail(src: string, re: RegExp, extra: Partial<Parameters<typeof run>[0]> = {}) {
  const out = join(tmp('out-'), 'o');
  const r = await run({ out, src, prev: BUNDLED, now, log: quiet, photos: false, ...extra });
  assert.equal(r.ok, false, '应该失败');
  assert.ok(r.errors.some((e) => re.test(e)), `错误里没有 ${re}：\n${r.errors.join('\n')}`);
  assert.equal(existsSync(out), false, '失败了不该留产物');
}

test('坏数据：少一个州（usa.gov 怀俄明那页没了）→ 失败', async () => {
  const d = srcCopy(); rmSync(join(d, 'usagov', 'wyoming.html'));
  await mustFail(d, /少了州：WY/);
});

test('坏数据：加州参议员 3 位 → 失败', async () => {
  const d = srcCopy(); const f = join(d, 'senators_cfm.xml');
  const xml = readFileSync(f, 'utf8');
  writeFileSync(f, xml.replace('</contact_information>', '<member><last_name>Extra</last_name><first_name>Ann</first_name><party>D</party><state>CA</state><bioguide_id>X000001</bioguide_id></member></contact_information>'));
  await mustFail(d, /CA 参议员 3 位/);
});

test('坏数据：一个众议院席位既没人也没记空缺（435 对不上）→ 失败', async () => {
  const d = srcCopy(); const f = join(d, 'MemberData.xml');
  const xml = readFileSync(f, 'utf8');
  const i = xml.indexOf('<statedistrict>CA16</statedistrict>');
  const a = xml.lastIndexOf('<member>', i), b = xml.indexOf('</member>', i) + '</member>'.length;
  writeFileSync(f, xml.slice(0, a) + xml.slice(b));
  await mustFail(d, /应为 435/);
});

test('坏数据：两个来源的州长对不上（nga.org 换了人、usa.gov 没换）→ 失败', async () => {
  const d = srcCopy(); const f = join(d, 'nga_governors_party.tsv');
  writeFileSync(f, readFileSync(f, 'utf8').replace('california\t200\tGavin Newsom', 'california\t200\tSomeone Else'));
  await mustFail(d, /来源对不上：CA 州长/);
});

test('坏数据：版本比上一版旧 → 失败', () => {
  const prev = { ...JSON.parse(readFileSync(BUNDLED, 'utf8')), dataVersion: 7 } as PipelineOfficials;
  const next = { ...prev, dataVersion: 6, generatedAt: now.toISOString(), fetched: [] } as PipelineOfficials;
  const { errors } = validateOfficials(next, prev, []);
  assert.ok(errors.some((e) => /比上一版 7 旧/.test(e)), errors.join('\n'));
  assert.deepEqual(validateOfficials({ ...next, dataVersion: 7 }, prev, []).errors, []);
});

test('变动太多（25 位州长同时换人）→ 拦下；加 allowBigChange 放行', async () => {
  const p = JSON.parse(readFileSync(BUNDLED, 'utf8'));
  Object.values(p.states.byState).slice(0, 25).forEach((s: any, i) => { s.governor.name = `Old Gov ${i}`; });
  const prevPath = join(tmp('prev-'), 'officials.json'); writeFileSync(prevPath, JSON.stringify(p));
  await mustFail(SRC, /变了 25 个席位/, { prev: prevPath });
  const r = await run({ out: join(tmp('out-'), 'o'), src: SRC, prev: prevPath, now, log: quiet, photos: false, allowBigChange: true });
  assert.ok(r.ok, r.errors.join('\n'));
  assert.equal(r.data!.dataVersion, 1);
});

test('CHANGES.md：空缺补上、离任、换人、党派变化都写成人话；参议员顺序变了不算变动', () => {
  const p = JSON.parse(readFileSync(BUNDLED, 'utf8'));
  const n = structuredClone(p);
  const fl = n.states.byState.FL; fl.vacancies = []; fl.representatives.push({ name: 'New Member', district: '20', bioguideId: 'N000001', party: 'D', accepted: ['New Member'] });
  const ca = n.states.byState.CA; const r16 = ca.representatives.find((r: any) => r.district === '16');
  ca.representatives = ca.representatives.filter((r: any) => r !== r16); ca.vacancies = [{ district: '16', note: 'test' }];
  n.states.byState.TX.governor.party = 'D';
  n.states.byState.ME.senators.reverse();
  const c = diffOfficials(p, n);
  assert.deepEqual(c.map((x) => x.seat).sort(), ['CA-16', 'FL-20', 'TX 州长']);
  const md = changesMarkdown(c, 'test', { ...n, dataVersion: 2, generatedAt: 'x', fetched: [] });
  assert.match(md, /众议员 FL-20：空缺补上了，现在是 New Member \(D\)/);
  assert.match(md, new RegExp(`众议员 CA-16：${r16.name} \\(D\\) 离任，现在空缺`));
  assert.match(md, /TX 州长：Greg Abbott \(R\) → Greg Abbott \(D\)/);
});

test('抓取被拦（403）：直接失败，不重试', async () => {
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('blocked', { status: 403 }); }) as typeof fetch;
  try {
    await assert.rejects(fetchAll(tmp('f-'), quiet), (e) => e instanceof FetchBlocked && /403/.test(String(e.message)));
    assert.equal(calls, 1, '403 以后不该再发请求');
  } finally { globalThis.fetch = real; }
});

test('validateOfficials 自己的检查（不靠 build.ts 的对账）：参议员 3 位、少州长、少党派、少一个州都报', () => {
  const base = { ...JSON.parse(readFileSync(BUNDLED, 'utf8')), dataVersion: 1, generatedAt: 'x', fetched: [] } as PipelineOfficials;
  assert.deepEqual(validateOfficials(base, null, []).errors, []);
  const three = structuredClone(base); three.states.byState.CA.senators.push({ ...three.states.byState.CA.senators[0], bioguideId: 'X000002' });
  assert.ok(validateOfficials(three, null, []).errors.some((e) => e === 'CA 参议员 3 位（应为 2）'));
  const noGov = structuredClone(base); noGov.states.byState.TX.governor = null;
  assert.ok(validateOfficials(noGov, null, []).errors.includes('TX 没有州长'));
  const noParty = structuredClone(base); delete noParty.states.byState.NY.representatives[0].party;
  assert.ok(validateOfficials(noParty, null, []).errors.some((e) => /^NY 众议员缺字段/.test(e)));
  const noState = structuredClone(base); delete (noState.states.byState as Record<string, unknown>).WY;
  assert.ok(validateOfficials(noState, null, []).errors.includes('少了州：WY'));
});
