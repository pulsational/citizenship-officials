/// <reference types="node" />
// 任务 OL1：每日流程每跑一次，往 runs/<UTC 年-月>.md 追加一行运行记录，让人一眼看出「今天跑了没有、变了什么」。
// 一行写：日期（UTC 和太平洋时间）、Actions run 链接、结果。结果是下面之一：
//   没变化
//   名单变了：哪个州、哪个职位，旧名字 → 新名字（有空缺也写）
//   照片变了：谁的照片，新加、换了、撤下
//   失败：出错的那一步
// runs/ 只在本仓库里，不进网站（site-check.ts 只许 officials.json、photos-manifest.json、photos/）；
// app 只取网站上那两个文件，判断要不要换用的是 officials.json 的 asOf / dataVersion 和每张照片的 sha256，跟 runs/ 无关。
//
//   成功：node pipeline/officials/runlog.ts ok --prev public --next out --dir runs --run-url <链接> [--now <ISO>]
//   失败：node pipeline/officials/runlog.ts failure --step <出错的那一步> --dir runs --run-url <链接> [--now <ISO>]
//   打印结果那一句（workflow 拿来当提交说明），写进 runs/ 的那个文件路径打在 stderr。用法不对、读不出 → 退出码 2
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOfficials } from '../../src/officials/index.ts';
import type { Person, StateOfficials } from '../../src/officials/index.ts';
import type { PhotosManifest } from './photos.ts';

export const NO_CHANGE = '没变化';

/** 全国类：题号 → 职位（2008 版和 2025 版问的是同一个人，只是题号不同） */
const NATIONAL_LABEL: Record<string, string> = {
  '2025-30': '众议院议长', '2025-38': '总统', '2025-39': '副总统', '2025-57': '首席大法官',
  '2008-28': '总统', '2008-29': '副总统', '2008-39': '最高法院大法官人数', '2008-40': '首席大法官', '2008-46': '总统所属政党', '2008-47': '众议院议长',
};

const nameOf = (p: Person | null | undefined) => (p ? p.name : '（空）');
const withParty = (p: Person) => (p.party ? `${p.name}（${p.party}）` : p.name);

/** 名单变了的地方，一条一句；没变返回空数组。只看 contentHash 管的那些：全国类、每州的人、党派、空缺 */
export function listChanges(prevRaw: unknown, nextRaw: unknown): string[] {
  const next = parseOfficials(nextRaw);
  if (!next) throw new Error('这次的 officials.json 格式不对');
  const prev = parseOfficials(prevRaw);
  if (!prev) return ['上一版读不出，这次整份重新发布'];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys({ ...prev.national.answers, ...next.national.answers }).sort()) {
    const a = prev.national.answers[id]?.[0] ?? '（空）', b = next.national.answers[id]?.[0] ?? '（空）';
    if (a === b) continue;
    const line = `全国 ${NATIONAL_LABEL[id] ?? id}：${a} → ${b}`;
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  }
  const states = [...new Set([...Object.keys(prev.states.byState), ...Object.keys(next.states.byState)])].sort();
  for (const st of states) out.push(...stateChanges(st, prev.states.byState[st], next.states.byState[st]));
  return out;
}

function stateChanges(st: string, a: StateOfficials | undefined, b: StateOfficials | undefined): string[] {
  if (!a || !b) return [`${st}：整州${a ? '没了' : '新加'}`];
  const out: string[] = [];
  if (nameOf(a.governor) !== nameOf(b.governor)) out.push(`${st} 州长：${nameOf(a.governor)} → ${nameOf(b.governor)}`);
  else if (a.governor && b.governor && a.governor.party !== b.governor.party) out.push(`${st} 州长党派：${withParty(a.governor)} → ${withParty(b.governor)}`);
  if (a.capital.name !== b.capital.name) out.push(`${st} 首府：${a.capital.name} → ${b.capital.name}`);
  // 参议员不分席位：走了的对上来了的，按名字排序一一配对
  const sa = a.senators.map((p) => p.name), sb = b.senators.map((p) => p.name);
  const gone = sa.filter((n) => !sb.includes(n)).sort(), come = sb.filter((n) => !sa.includes(n)).sort();
  for (let i = 0; i < Math.max(gone.length, come.length); i++) out.push(`${st} 参议员：${gone[i] ?? '（空）'} → ${come[i] ?? '（空）'}`);
  for (const p of b.senators) {
    const q = a.senators.find((x) => x.name === p.name);
    if (q && q.party !== p.party) out.push(`${st} 参议员党派：${withParty(q)} → ${withParty(p)}`);
  }
  // 众议员按选区：人换了、党派变了、出了空缺、空缺补上
  const seat = (s: StateOfficials, d: string) => {
    const r = s.representatives.find((x) => x.district === d);
    if (r) return { who: r.name, party: r.party, label: withParty(r) };
    const v = (s.vacancies ?? []).find((x) => x.district === d);
    return v ? { who: null, party: undefined, label: `空缺（${v.note}）` } : null;
  };
  const districts = [...new Set([...a.representatives, ...(a.vacancies ?? []), ...b.representatives, ...(b.vacancies ?? [])].map((x) => x.district))]
    .sort((x, y) => (Number(x) || 0) - (Number(y) || 0) || x.localeCompare(y));
  for (const d of districts) {
    const x = seat(a, d), y = seat(b, d);
    const where = `${st} 第 ${d} 选区众议员`;
    if (!x || !y) { out.push(`${where}：${x?.label ?? '（没有这个选区）'} → ${y?.label ?? '（没有这个选区）'}`); continue; }
    if (x.who !== y.who) out.push(`${where}：${x.label} → ${y.label}`);
    else if (x.who && x.party !== y.party) out.push(`${where}党派：${x.label} → ${y.label}`);
    else if (!x.who && x.label !== y.label) out.push(`${where}：${x.label} → ${y.label}`);
  }
  return out;
}

/** 照片变了的地方：按 id 比清单条目，新加、换了（sha 不同或换了人）、撤下 */
export function photoChanges(prev: PhotosManifest | null, next: PhotosManifest): string[] {
  const before = new Map((prev?.entries ?? []).map((e) => [e.id, e]));
  const after = new Map(next.entries.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const [id, e] of [...after].sort(([x], [y]) => x.localeCompare(y))) {
    const o = before.get(id);
    if (!o) out.push(`${e.name}（${id}）新加`);
    else if (o.sha256 !== e.sha256 || o.name !== e.name) out.push(`${e.name}（${id}）换了${o.name !== e.name ? `，原来是 ${o.name}` : ''}`);
  }
  for (const [id, o] of [...before].sort(([x], [y]) => x.localeCompare(y))) if (!after.has(id)) out.push(`${o.name}（${id}）撤下`);
  return out;
}

/** 结果那一句：没变化 / 名单变了：… / 照片变了：…（两样都变就用「；」接起来） */
export function resultText(list: string[], photos: string[]): string {
  const parts: string[] = [];
  if (list.length) parts.push(`名单变了：${list.join('；')}`);
  if (photos.length) parts.push(`照片变了：${photos.join('；')}`);
  return parts.length ? parts.join('；') : NO_CHANGE;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 「2026-11-05 14:03 UTC / 太平洋时间 2026-11-05 06:03 PST」 */
export function whenText(now: Date): string {
  const utc = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${utc} / 太平洋时间 ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** 这次记在哪个文件：runs/<UTC 年-月>.md */
export function logFile(dir: string, now: Date): string {
  return join(dir, `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}.md`);
}

/** 一行运行记录（不带换行） */
export function logLine(now: Date, runUrl: string, result: string): string {
  const id = runUrl.match(/\/runs\/(\d+)/)?.[1];
  const link = id ? `[run ${id}](${runUrl})` : runUrl ? `[run](${runUrl})` : '（本机试跑，没有 run）';
  return `- ${whenText(now)} · ${link} · ${result.replace(/\n/g, ' ')}`;
}

/** 追加一行；文件不存在先写标题。返回文件路径 */
export function appendLog(dir: string, now: Date, line: string): string {
  mkdirSync(dir, { recursive: true });
  const f = logFile(dir, now);
  if (!existsSync(f)) appendFileSync(f, `# 官员名单每日运行记录 ${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}\n\n每跑一次记一行：时间、Actions run、结果（没变化 / 名单变了 / 照片变了 / 失败）。\n\n`);
  appendFileSync(f, `${line}\n`);
  return f;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : undefined; };
  const dir = opt('dir'), runUrl = opt('run-url') ?? '';
  const now = opt('now') ? new Date(opt('now')!) : new Date();
  const usage = '用法：runlog.ts ok --prev <上一版目录> --next <这次的产物目录> --dir runs --run-url <链接> [--now <ISO>]\n      runlog.ts failure --step <出错的那一步> --dir runs --run-url <链接> [--now <ISO>]';
  if (!dir || Number.isNaN(now.getTime()) || (mode !== 'ok' && mode !== 'failure')) { console.error(usage); process.exit(2); }
  let result: string;
  if (mode === 'failure') {
    result = `失败：${opt('step') || '（没查到是哪一步）'}`;
  } else {
    const prevDir = opt('prev'), nextDir = opt('next');
    if (!prevDir || !nextDir) { console.error(usage); process.exit(2); }
    const prevOfficials = existsSync(join(prevDir, 'officials.json')) ? readJson(join(prevDir, 'officials.json')) : null;
    const prevManifest = existsSync(join(prevDir, 'photos-manifest.json')) ? readJson(join(prevDir, 'photos-manifest.json')) as PhotosManifest : null;
    const nextManifest = readJson(join(nextDir, 'photos-manifest.json')) as PhotosManifest;
    if (!Array.isArray(nextManifest.entries)) throw new Error('这次的 photos-manifest.json 没有 entries');
    result = resultText(listChanges(prevOfficials, readJson(join(nextDir, 'officials.json'))), photoChanges(prevManifest, nextManifest));
  }
  const f = appendLog(dir, now, logLine(now, runUrl, result));
  console.error(`记在 ${f}`);
  console.log(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(`失败：${e instanceof Error ? e.message : e}`); process.exit(2); }
}

