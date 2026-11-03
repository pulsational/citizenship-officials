// 任务 CS：官员名单定时抓取——校验和变动对比（纯函数，测试直接喂坏数据）。
// 规矩：校验不过就失败、不出产物；和上一版比变动太多就拦下等人看，换届那天可以手动放行。
import type { OfficialsData, StateOfficials } from '../../src/officials/index.ts';

/** 定时程序产出的官员数据：在 app 用的格式上多三项（app 不读，多出来的字段 parseOfficials 不管） */
export interface PipelineOfficials extends OfficialsData {
  dataVersion: number;
  generatedAt: string;
  fetched: { url: string; file: string; fetchedAt: string; status: number; bytes: number; sha256: string }[];
}

export const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
export const BIG_CHANGE_THRESHOLD = 20;

export interface Change { kind: 'representative' | 'senator' | 'governor'; seat: string; before: string | null; after: string | null }

const seatName = (p: { name: string; party?: string } | null | undefined) => (p ? `${p.name}${p.party ? ` (${p.party})` : ''}` : null);
const VACANT = '（空缺）';

/** 众议员按选区（空缺记「（空缺）」）、州长按州：席位 → 现在是谁 */
export function seats(d: OfficialsData): Map<string, { kind: 'representative' | 'governor'; who: string | null }> {
  const m = new Map<string, { kind: 'representative' | 'governor'; who: string | null }>();
  for (const [st, s] of Object.entries(d.states.byState)) {
    for (const r of s.representatives) m.set(`${st}-${r.district === 'At Large' ? 'AL' : r.district}`, { kind: 'representative', who: seatName(r) });
    for (const v of s.vacancies ?? []) m.set(`${st}-${v.district === 'At Large' ? 'AL' : v.district}`, { kind: 'representative', who: VACANT });
    m.set(`${st} 州长`, { kind: 'governor', who: seatName(s.governor) });
  }
  return m;
}

/** 和上一版比：谁上谁下、空缺变化、党派变化（名字一样党派变了也算一条）。
 *  参议员两席没有编号，按每州的名单集合比：下去的和上来的按顺序配成对。 */
export function diffOfficials(prev: OfficialsData, next: OfficialsData): Change[] {
  const a = seats(prev), b = seats(next), out: Change[] = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(k), y = b.get(k);
    if ((x?.who ?? null) !== (y?.who ?? null)) out.push({ kind: (y ?? x)!.kind, seat: k, before: x?.who ?? null, after: y?.who ?? null });
  }
  for (const st of [...new Set([...Object.keys(prev.states.byState), ...Object.keys(next.states.byState)])].sort()) {
    const was = (prev.states.byState[st]?.senators ?? []).map(seatName) as string[];
    const now = (next.states.byState[st]?.senators ?? []).map(seatName) as string[];
    const gone = was.filter((n) => !now.includes(n)), came = now.filter((n) => !was.includes(n));
    for (let i = 0; i < Math.max(gone.length, came.length); i++)
      out.push({ kind: 'senator', seat: `${st} 参议员`, before: gone[i] ?? null, after: came[i] ?? null });
  }
  return out;
}

export interface ValidateOptions { expectedDistricts?: Set<string>; allowBigChange?: boolean; threshold?: number }

/** 校验：返回错误清单，空 = 通过。prev 是上一版产物（第一次跑没有）。 */
export function validateOfficials(d: PipelineOfficials, prev: PipelineOfficials | OfficialsData | null, buildProblems: string[], opt: ValidateOptions = {}): { errors: string[]; changes: Change[] } {
  const e: string[] = [...buildProblems.map((p) => `来源对不上：${p}`)];
  const by = d.states?.byState ?? {};
  const missing = STATES.filter((s) => !by[s]);
  const extra = Object.keys(by).filter((s) => !STATES.includes(s));
  if (missing.length) e.push(`少了州：${missing.join(', ')}`);
  if (extra.length) e.push(`多出不认识的州：${extra.join(', ')}`);
  let nSen = 0, nGov = 0, nRep = 0, nVac = 0;
  const districts = new Set<string>();
  for (const [st, s] of Object.entries(by) as [string, StateOfficials][]) {
    if (s.senators.length !== 2) e.push(`${st} 参议员 ${s.senators.length} 位（应为 2）`);
    for (const p of s.senators) {
      nSen++;
      if (!p.name || !p.accepted?.length || !p.party || !p.bioguideId) e.push(`${st} 参议员缺字段：${JSON.stringify(p).slice(0, 80)}`);
    }
    if (!s.governor) e.push(`${st} 没有州长`);
    else { nGov++; if (!s.governor.name || !s.governor.accepted?.length || !s.governor.party) e.push(`${st} 州长缺字段：${s.governor.name || '（无名）'}`); }
    if (!s.capital?.name) e.push(`${st} 没有首府`);
    const seen = new Set<string>();
    for (const r of s.representatives) {
      nRep++;
      if (!r.name || !r.accepted?.length || !r.party || !r.bioguideId || !r.district) e.push(`${st} 众议员缺字段：${r.name || '（无名）'} ${r.district}`);
      if (seen.has(r.district)) e.push(`${st}-${r.district} 有两位众议员`);
      seen.add(r.district); districts.add(`${st}:${r.district}`);
    }
    for (const v of s.vacancies ?? []) {
      nVac++;
      if (seen.has(v.district)) e.push(`${st}-${v.district} 既有众议员又记了空缺`);
      seen.add(v.district); districts.add(`${st}:${v.district}`);
    }
    if (!seen.size) e.push(`${st} 一个众议院席位都没有`);
  }
  if (nSen !== 100) e.push(`参议员一共 ${nSen} 位（应为 100）`);
  if (nGov !== 50) e.push(`州长一共 ${nGov} 位（应为 50）`);
  if (nRep + nVac !== 435) e.push(`众议院 ${nRep} 位现任 + ${nVac} 个空缺 = ${nRep + nVac}（应为 435）`);
  if (opt.expectedDistricts) {
    const lack = [...opt.expectedDistricts].filter((k) => !districts.has(k));
    const more = [...districts].filter((k) => !opt.expectedDistricts!.has(k));
    if (lack.length) e.push(`这些选区既没有众议员也没记空缺：${lack.slice(0, 10).join(', ')}${lack.length > 10 ? ` 等 ${lack.length} 个` : ''}`);
    if (more.length) e.push(`这些选区不在选区表里：${more.slice(0, 10).join(', ')}`);
  }
  if (!Number.isInteger(d.dataVersion) || d.dataVersion < 1) e.push(`dataVersion 不对：${d.dataVersion}`);
  const prevVersion = prev && 'dataVersion' in prev ? (prev as PipelineOfficials).dataVersion : null;
  if (prevVersion != null && d.dataVersion < prevVersion) e.push(`dataVersion ${d.dataVersion} 比上一版 ${prevVersion} 旧`);
  const changes = prev ? diffOfficials(prev, d) : [];
  const limit = opt.threshold ?? BIG_CHANGE_THRESHOLD;
  if (changes.length > limit && !opt.allowBigChange)
    e.push(`和上一版比变了 ${changes.length} 个席位（超过 ${limit}），先拦下等人看；确认是换届就加 --allow-big-change 重跑`);
  return { errors: e, changes };
}

/** CHANGES.md：人话写和上一版比的变动 */
export function changesMarkdown(changes: Change[], prevLabel: string, next: PipelineOfficials): string {
  const kindZh = { representative: '众议员', senator: '参议员', governor: '州长' } as const;
  const lines = [`# 官员名单变动（dataVersion ${next.dataVersion}，${next.generatedAt}）`, '', `和上一版比：${prevLabel}`, ''];
  if (!changes.length) lines.push('**没有变动**：所有席位的人和党派都和上一版一样。');
  else {
    lines.push(`一共 ${changes.length} 处变动：`, '');
    for (const c of changes) {
      const seat = c.kind === 'representative' ? `众议员 ${c.seat}` : c.seat;
      if (c.before === VACANT) lines.push(`- ${seat}：空缺补上了，现在是 ${c.after}`);
      else if (c.after === VACANT) lines.push(`- ${seat}：${c.before} 离任，现在空缺`);
      else if (!c.before) lines.push(`- ${seat}（新出现的${kindZh[c.kind]}席位）：${c.after}`);
      else if (!c.after) lines.push(`- ${seat}（这个${kindZh[c.kind]}席位没了）：原来是 ${c.before}`);
      else lines.push(`- ${seat}：${c.before} → ${c.after}`);
    }
  }
  const vac = Object.entries(next.states.byState).flatMap(([st, s]) => (s.vacancies ?? []).map((v) => `${st}-${v.district}（${v.note}）`));
  lines.push('', `现在空缺的众议员席位：${vac.length ? vac.join('；') : '无'}`);
  return lines.join('\n') + '\n';
}
