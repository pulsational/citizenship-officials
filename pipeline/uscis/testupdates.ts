/// <reference types="node" />
// 任务 OF2：每日流程看一眼 USCIS「Check for Test Updates」页有没有变。
// 背景：全国类答案（总统、副总统、众议院议长、首席大法官、总统所属党派、大法官人数）取自题库 current_answers，
// 题库 meta 记着那一页的地址（testupdates_url）和上次核对的日期（testupdates_reviewed）。每日名单只抓州里的人，不看这一页。
//
// 做法：
//   1. 抓 testupdates_url（一次请求，UA 固定 citizenship-officials/1.0，30 秒超时）。403 / 429 / 其他非 200 / 超时 → 失败，不换头、不换路径、不重试。
//   2. 规范化：只取 <main> 里「Civics Test … Updates」那两节，到「Last Reviewed/Updated」为止。
//      导航、脚本、样式、日期戳都不在里面；行内标签（a、strong、span…）直接去掉、块级标签换行，空白并成一个。
//      每道题留题面；答案是「Answers will vary」的（参议员、众议员、州长，各州不同）只留题面，别的题（全国类）留每一条答案。
//   3. 结构检查：页面空、没有 <main>、找不到那两节、找不到总统 / 副总统 / 首席大法官 / 众议院议长的题或它们没有答案 → 失败。
//      失败绝不报「没变」。
//   4. 算 sha256，和仓库里 uscis/testupdates.json 存的上一次比：一样 → 「USCIS 没变」；不一样 → 「USCIS 变了」，开 issue 放新旧 diff。
//      不改 officials.json、不改答案、也不自动改 uscis/testupdates.json：人核过、改完题库之后，把这次 --out 里的 testupdates.json 拷过去提交。
//
//   node pipeline/uscis/testupdates.ts check --baseline uscis/testupdates.json --out <目录> [--url <地址> | --html <本地文件>] [--run-url <链接>] [--timeout-ms 30000]
//     写进 <目录>：result.json（status same / changed / failed）、summary.txt（运行记录那一句）、testupdates.json（这次的规范化存档，成功时）、
//                  issue-title.txt + issue-body.md（变了或失败时；workflow 拿去开 issue）
//     退出码：没变、变了 → 0（变了不算这一步出错）；抓取或结构失败 → 1；用法不对、存档读不出 → 2
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BANK = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'bank.json'), 'utf8'));
export const TESTUPDATES_URL: string = BANK.meta.testupdates_url;
export const UA = 'citizenship-officials/1.0';
export const TITLE_CHANGED = 'USCIS testupdates 变了';
export const TITLE_FAILED = 'USCIS testupdates 抓取失败';

export type Normalized = { ok: true; lines: string[]; sha256: string; reviewed: string | null } | { ok: false; reason: string };
export type Snapshot = { url: string; reviewed: string | null; sha256: string; lines: string[] };
export type Compared = { status: 'same' | 'changed' | 'failed'; reason?: string; oldSha?: string; newSha?: string; diff: string };

const sha = (lines: string[]) => createHash('sha256').update(lines.join('\n') + '\n').digest('hex');

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', shy: '',
};
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n === 0xa0 ? ' ' : String.fromCodePoint(n); }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK = /^(p|div|li|ul|ol|h[1-6]|br|hr|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|dl|dt|dd|blockquote|main|form|fieldset|figure|figcaption|details|summary|time)$/i;

/** HTML → 去掉标签后的文字行（块级标签换行、行内标签直接去掉、空白并成一个） */
function textLines(html: string): string[] {
  const t = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, '\n')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_m, tag: string) => (BLOCK.test(tag) ? '\n' : ''));
  return decode(t).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const SECTION = /^Civics Test\b.*\bUpdates$/i;
const QUESTION = /^(\d{1,3})\.\s+(.+)$/;
const VARIES = /^Answers will vary\b/i;
/** 必须找得到、并且有答案的全国类题：找不到就是页面结构变了 */
const REQUIRED: [string, RegExp][] = [
  ['总统', /\bname of the President of the United States now\b/i],
  ['副总统', /\bname of the Vice President of the United States now\b/i],
  ['首席大法官', /\bChief Justice of the United States now\b/i],
  ['众议院议长', /\bSpeaker of the House of Representatives now\b/i],
];

/** 规范化：只留「答案更新」那几节的题和全国类答案 */
export function normalize(html: string): Normalized {
  if (!html || !html.trim()) return { ok: false, reason: '页面是空的' };
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  if (!main) return { ok: false, reason: '页面结构变了：没有 <main>' };
  const all = textLines(main[1]);
  const start = all.findIndex((l) => SECTION.test(l));
  if (start < 0) return { ok: false, reason: '页面结构变了：找不到「Civics Test … Updates」那几节' };
  let end = all.findIndex((l, i) => i > start && /^Last Reviewed\/Updated/i.test(l));
  if (end < 0) end = all.length;
  // 日期戳只拿来写进报告，不进 hash
  const reviewed = end < all.length ? (all.slice(end, end + 2).join(' ').match(/\b(\d{2}\/\d{2}\/\d{4})\b/)?.[1] ?? null) : null;
  // 只剩标点的行（「?」「*」）接回上一行：题面里 <strong>…now</strong>? 这种
  const raw: string[] = [];
  for (const l of all.slice(start, end)) {
    if (/^[?*.:;,!)\]]+$/.test(l) && raw.length) raw[raw.length - 1] += l;
    else raw.push(l);
  }
  type Q = { head: string; body: string[] };
  const out: string[] = [];
  const questions: Q[] = [];
  let cur: Q | null = null;
  const flush = () => {
    if (!cur) return;
    if (cur.body.length && VARIES.test(cur.body[0])) out.push(cur.head);
    else out.push(cur.head, ...cur.body.map((b) => `- ${b}`));
    questions.push(cur);
    cur = null;
  };
  for (const l of raw) {
    if (SECTION.test(l)) { flush(); out.push(`## ${l}`); continue; }
    const q = l.match(QUESTION);
    if (q) { flush(); cur = { head: `${q[1]}. ${q[2]}`, body: [] }; continue; }
    if (cur) cur.body.push(l);
    else out.push(l); // 节标题和第一题之间的说明文字（现在没有），有就照留
  }
  flush();
  for (const [label, re] of REQUIRED) {
    const hit = questions.filter((q) => re.test(q.head));
    if (!hit.length) return { ok: false, reason: `页面结构变了：找不到${label}那道题` };
    const empty = hit.find((q) => !q.body.length);
    if (empty) return { ok: false, reason: `页面结构变了：${label}那道题（${empty.head.split('.')[0]}）没有答案` };
  }
  const blank = questions.find((q) => !q.body.length);
  if (blank) return { ok: false, reason: `页面结构变了：第 ${blank.head.split('.')[0]} 题没有答案` };
  return { ok: true, lines: out, sha256: sha(out), reviewed };
}

export function snapshotOf(n: Extract<Normalized, { ok: true }>, url = TESTUPDATES_URL): Snapshot {
  return { url, reviewed: n.reviewed, sha256: n.sha256, lines: n.lines };
}

export function loadBaseline(path: string): Snapshot {
  const b = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (!Array.isArray(b.lines) || typeof b.sha256 !== 'string') throw new Error(`${path} 不是 testupdates 存档`);
  return b;
}

/** 行级 diff：只列变了的行，前后各带一行上下文；没变返回空串 */
export function diffLines(a: string[], b: string[]): string {
  const n = a.length, m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: '-', s: a[i++] });
    else ops.push({ t: '+', s: b[j++] });
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });
  const keep = ops.map((o, k) => o.t !== ' ' || ops[k - 1]?.t !== undefined && ops[k - 1].t !== ' ' || ops[k + 1] !== undefined && ops[k + 1].t !== ' ');
  const lines: string[] = [];
  ops.forEach((o, k) => {
    if (!keep[k]) return;
    if (lines.length && !keep[k - 1]) lines.push('…');
    lines.push(`${o.t}${o.s}`);
  });
  return ops.some((o) => o.t !== ' ') ? lines.join('\n') : '';
}

/** 和上一次比。上一次的存档自己 hash 对不上也算失败：不能拿一份坏存档报「没变」 */
export function compare(prev: Snapshot, next: Normalized): Compared {
  if (!next.ok) return { status: 'failed', reason: next.reason, oldSha: prev.sha256, diff: '' };
  if (sha(prev.lines) !== prev.sha256) return { status: 'failed', reason: '仓库里存的上一次（uscis/testupdates.json）hash 和内容对不上', oldSha: prev.sha256, newSha: next.sha256, diff: '' };
  if (prev.sha256 === next.sha256) return { status: 'same', oldSha: prev.sha256, newSha: next.sha256, diff: '' };
  return { status: 'changed', oldSha: prev.sha256, newSha: next.sha256, diff: diffLines(prev.lines, next.lines) };
}

/** 抓一次：非 200、超时、网络错 → 抛出原因。不重试、不换头 */
export async function fetchOnce(url: string, timeoutMs: number): Promise<{ html: string; finalUrl: string }> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`超时（${Math.round(timeoutMs / 1000)} 秒没拿到）`);
    throw new Error(`连不上：${e instanceof Error ? e.message : String(e)}`);
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}（按规矩不换头、不重试）`);
  try {
    return { html: await r.text(), finalUrl: r.url || url };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`超时（${Math.round(timeoutMs / 1000)} 秒没读完）`);
    throw e;
  }
}

function issueBody(c: Compared, url: string, finalUrl: string, runUrl: string, reviewed: string | null): string {
  const run = runUrl ? `运行：${runUrl}` : '运行：（本机试跑，没有 run）';
  if (c.status === 'failed') {
    return [`每日流程看 USCIS testupdates 页这一步没做成，原因：**${c.reason}**`, '', run, `地址：${url}`, '',
      '这一步失败不影响官员名单的更新。没有加头或换地址重试。', '要人看一下：页面是不是改版了、是不是被拦了。'].join('\n');
  }
  return [
    'USCIS「Check for Test Updates」页的答案部分和仓库里存的上一次不一样了。',
    '',
    run,
    `地址：${url}${finalUrl && finalUrl !== url ? `（跳到 ${finalUrl}）` : ''}`,
    `页面上的 Last Reviewed/Updated：${reviewed ?? '（没读到）'}`,
    `上一次 sha256：${c.oldSha}`,
    `这一次 sha256：${c.newSha}`,
    '',
    '新旧 diff（规范化后的文字；- 是上一次，+ 是这一次）：',
    '',
    '```diff',
    c.diff,
    '```',
    '',
    '每日流程**不改 officials.json、不改答案**。要人核过之后：',
    '1. 改题库的 current_answers（和 testupdates_reviewed）；',
    '2. 把这次运行产出的 testupdates.json 拷到 uscis/testupdates.json 提交，之后才会回到「USCIS 没变」。',
  ].join('\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : undefined; };
  const usage = '用法：testupdates.ts check --baseline uscis/testupdates.json --out <目录> [--url <地址> | --html <本地文件>] [--run-url <链接>] [--timeout-ms 30000]';
  const baselinePath = opt('baseline'), outDir = opt('out');
  const timeoutMs = Number(opt('timeout-ms') ?? 30000);
  if (args[0] !== 'check' || !baselinePath || !outDir || !(timeoutMs > 0)) { console.error(usage); return 2; }
  let prev: Snapshot;
  try { prev = loadBaseline(baselinePath); } catch (e) { console.error(`读不出上一次的存档：${e instanceof Error ? e.message : e}`); return 2; }
  const url = opt('url') ?? TESTUPDATES_URL, htmlFile = opt('html'), runUrl = opt('run-url') ?? '';
  let next: Normalized, finalUrl = url;
  try {
    let html: string;
    if (htmlFile) html = readFileSync(htmlFile, 'utf8');
    else ({ html, finalUrl } = await fetchOnce(url, timeoutMs));
    next = normalize(html);
  } catch (e) {
    next = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const c = compare(prev, next);
  const reviewed = next.ok ? next.reviewed : null;
  mkdirSync(outDir, { recursive: true });
  const w = (f: string, s: string) => writeFileSync(join(outDir, f), s);
  w('result.json', JSON.stringify({ ...c, url, finalUrl, reviewed }, null, 1) + '\n');
  if (next.ok) w('testupdates.json', JSON.stringify(snapshotOf(next, prev.url || TESTUPDATES_URL), null, 1) + '\n');
  let summary: string;
  if (c.status === 'same') summary = 'USCIS 没变';
  else if (c.status === 'changed') summary = `USCIS 变了（${c.diff.split('\n').filter((l) => /^[+-]/.test(l)).length} 行不同，见 issue，等人工核）`;
  else summary = `USCIS 检查失败：${c.reason}`;
  w('summary.txt', summary + '\n');
  if (c.status !== 'same') {
    w('issue-title.txt', (c.status === 'changed' ? TITLE_CHANGED : TITLE_FAILED) + '\n');
    w('issue-body.md', issueBody(c, url, finalUrl, runUrl, reviewed) + '\n');
  }
  console.log(summary);
  if (c.status === 'changed') console.log(c.diff);
  return c.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code), (e) => { console.error(`失败：${e instanceof Error ? e.message : e}`); process.exit(2); });
}
