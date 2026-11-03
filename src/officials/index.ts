// C 块：会随选举变的答案。app 用打包的 src/data/officials.json 兜底；远程 JSON 用同一格式，校验通过且更新才用。
// 范围：全国类（总统、副总统、议长、首席大法官、执政党……）+ 按州（参议员、州长、首府）+
// 众议员（任务 CN 起）：先按 ZIP 查选区（src/officials/zip.ts）——一个选区直接给出；跨选区只列那几位让用户点选；
//   空缺席位显示 footnote、不判对错；DC 和海外领地显示题库自带的官方说明；ZIP 查不到才回退到「本州名单点选」。
//   没填 ZIP 时还是原来的本州名单点选。点选结果存 bioguideId，之后照这个判对错。
// 这些答案都没有预录音频（人名会变），界面用系统朗读并标「系统朗读」。
import type { Question } from '../engine/index.ts';
import { lookupZip, TERRITORY_NAMES } from './zip.ts';
import type { ZipData, ZipIndex } from './zip.ts';

/** party：D / R / I（任务 CR；众议员、参议员取 clerk / senate.gov XML 的 <party>，州长取 nga.org 每州页面的 Party）。
 *  bioguideId：参议员也带（读名字的预录音频按它找）。两个都可以没有：远程老格式照用。 */
export interface Person { name: string; accepted: string[]; party?: string; bioguideId?: string }
export interface Rep extends Person { district: string; bioguideId: string }
/** 空缺的众议员席位（note = 众议院书记官处 footnote 原文） */
export interface Vacancy { district: string; note: string }
export interface StateOfficials { name: string; senators: Person[]; governor: Person | null; capital: Person; representatives: Rep[]; vacancies?: Vacancy[] }
export interface OfficialsData {
  version: 1;
  sources: Record<string, string>;
  national: { asOf: string; answers: Record<string, string[]> };
  states: { asOf: string; byState: Record<string, StateOfficials> };
}

/** 众议员那题界面上放的说明和链接 */
export const REPRESENTATIVE_HELP = {
  zh: '不知道是哪位？到 house.gov 输入地址查',
  url: 'https://www.house.gov/representatives/find-your-representative',
};

// 按州 / 按选区的题，题号沿用题库（2025 版、2008 版各一份）
const ROLE: Record<string, 'senators' | 'governor' | 'capital' | 'representative'> = {
  '2025-23': 'senators', '2008-20': 'senators',
  '2025-61': 'governor', '2008-43': 'governor',
  '2025-62': 'capital', '2008-44': 'capital',
  '2025-29': 'representative', '2008-23': 'representative',
};

/** 众议员那题的查法，按优先级：district（存的选区：存选区不存人）→ zip → 本州名单里点选的
 *  representativeBioguideId（老存档，兼容用）。zip、district 都可以不传。 */
export interface UserPlace { state: string | null; representativeBioguideId: string | null; zip?: string | null; district?: string | null }

/** 候选众议员带上州和选区写法（跨州的 ZCTA 会出现不同州的人）；用户点了就把 districtKey 存起来 */
export type RepCandidate = Rep & { state: string; districtKey: string };
type VacantDistrict = Vacancy & { state: string; districtKey: string };

/** 选区写法：「CA-16」，At Large 写「AK-AL」 */
export function districtKey(state: string, district: string): string {
  return `${state}-${district === 'At Large' ? 'AL' : district}`;
}
/** 拆选区写法；格式不对或州不认识返回 null（选区在不在数据里由 answersFor 判断） */
export function parseDistrictKey(key: string): { state: string; district: string } | null {
  const m = /^([A-Z]{2})-(AL|[1-9]\d?)$/.exec(key);
  if (!m || !STATE_CODES.has(m[1])) return null;
  return { state: m[1], district: m[2] === 'AL' ? 'At Large' : m[2] };
}
const STATE_CODES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

/** 老存档换算：bioguideId 在现任名单里就返回选区写法，找不到返回 null */
export function districtForBioguide(bioguideId: string, data: OfficialsData): string | null {
  for (const [st, s] of Object.entries(data.states.byState)) {
    const r = s.representatives.find((x) => x.bioguideId === bioguideId);
    if (r) return districtKey(st, r.district);
  }
  return null;
}

/** 选区数据的国会届次（现在 "119"）。界面存 districtSession 时用它；和存档不一样就提示「选区可能重划了，请重新确认」 */
export function districtSession(zipData: ZipData): string {
  return String(zipData.source.congress);
}

export type VariableAnswer =
  | { status: 'ok'; answers: string[]; display: string[]; asOf: string; scope: 'national' | 'state' | 'district' }
  /** zipNotFound：填了 ZIP 但查不到；districtNotFound：存的选区数据里没有（重划了或写法不对），当作没选 */
  | { status: 'need_state'; zipNotFound?: true; districtNotFound?: true }
  /** vacantDistricts：这个 ZIP 跨到的空缺选区（用户可能就住在那里，界面要给这个选项） */
  | { status: 'need_representative'; candidates: RepCandidate[]; vacantDistricts?: VacantDistrict[]; zipNotFound?: true; districtNotFound?: true }
  /** 用户所在选区的众议员席位空缺：显示 note 和截至日期，以 house.gov 为准，这题不判对错、让用户自评 */
  | { status: 'vacant'; state: string; district: string; note: string; asOf: string }
  /** DC 或海外领地的 ZIP：显示题库这题自带的官方英文说明（officialEn）和官方中文（officialZh，可能为 null），不判对错 */
  | { status: 'territory'; territory: string; territoryName: { en: string; zh: string }; officialEn: string; officialZh: string | null }
  /** ZIP 不是 5 位数字 */
  | { status: 'bad_zip' }
  | { status: 'not_variable' }
  | { status: 'no_data' };

/** 会变的题的可接受答案。answers = 判对错用的全部写法；display = 界面上显示的（每人一行全名）。 */
export function answersFor(q: Question, place: UserPlace, data: OfficialsData, zipIndex?: ZipIndex): VariableAnswer {
  if (!q.variable) return { status: 'not_variable' };
  if (q.variableKind === 'national') {
    const a = data.national.answers[q.id];
    return a?.length ? { status: 'ok', answers: a, display: [a[0]], asOf: data.national.asOf, scope: 'national' } : { status: 'no_data' };
  }
  const role = ROLE[q.id];
  if (!role) return { status: 'no_data' };
  let districtNotFound = false;
  if (role === 'representative' && place.district) {
    const r = byDistrict(place.district, data);
    if (r) return r;
    districtNotFound = true;
  }
  let zipNotFound = false;
  if (role === 'representative' && place.zip != null && zipIndex) {
    const r = byZip(q, place, data, zipIndex);
    if (r) return districtNotFound && r.status === 'need_representative' ? { ...r, districtNotFound: true } : r;
    zipNotFound = true;
  }
  const nf = { ...(zipNotFound ? { zipNotFound: true as const } : {}), ...(districtNotFound ? { districtNotFound: true as const } : {}) };
  if (!place.state) return { status: 'need_state', ...nf };
  const st = data.states.byState[place.state];
  if (!st) return { status: 'no_data' };
  const asOf = data.states.asOf;
  if (role === 'senators') {
    return st.senators.length ? { status: 'ok', answers: st.senators.flatMap((p) => p.accepted), display: st.senators.map((p) => p.name), asOf, scope: 'state' } : { status: 'no_data' };
  }
  if (role === 'governor') return st.governor ? { status: 'ok', answers: st.governor.accepted, display: [st.governor.name], asOf, scope: 'state' } : { status: 'no_data' };
  if (role === 'capital') return { status: 'ok', answers: st.capital.accepted, display: [st.capital.name], asOf, scope: 'state' };
  const rep = st.representatives.find((r) => r.bioguideId === place.representativeBioguideId);
  if (!rep) return { status: 'need_representative', candidates: st.representatives.map((r) => ({ ...r, state: place.state!, districtKey: districtKey(place.state!, r.district) })), ...nf };
  return { status: 'ok', answers: rep.accepted, display: [rep.name], asOf, scope: 'district' };
}

/** 按存的选区查；返回 null = 写法不对或数据里没有这个选区 */
function byDistrict(key: string, data: OfficialsData): VariableAnswer | null {
  const d = parseDistrictKey(key);
  const st = d && data.states.byState[d.state];
  if (!d || !st) return null;
  const asOf = data.states.asOf;
  const rep = st.representatives.find((r) => r.district === d.district);
  if (rep) return { status: 'ok', answers: rep.accepted, display: [rep.name], asOf, scope: 'district' };
  const v = st.vacancies?.find((x) => x.district === d.district);
  return v ? { status: 'vacant', state: d.state, district: d.district, note: v.note, asOf } : null;
}

/** 按 ZIP 查众议员；返回 null = 这个 ZIP 查不到，调用方回退到按州选 */
function byZip(q: Question, place: UserPlace, data: OfficialsData, idx: ZipIndex): VariableAnswer | null {
  const z = lookupZip(place.zip!, idx);
  if (z.kind === 'bad_format') return { status: 'bad_zip' };
  if (z.kind === 'not_found') return null;
  if (z.kind === 'territory') {
    return { status: 'territory', territory: z.territory, territoryName: TERRITORY_NAMES[z.territory],
      officialEn: q.answersEn[0], officialZh: q.zhHans?.answers?.[0] ?? null };
  }
  const asOf = data.states.asOf;
  const candidates: RepCandidate[] = [];
  const vacantDistricts: VacantDistrict[] = [];
  for (const d of z.districts) {
    const st = data.states.byState[d.state];
    const rep = st?.representatives.find((r) => r.district === d.district);
    if (rep) { candidates.push({ ...rep, state: d.state, districtKey: districtKey(d.state, d.district) }); continue; }
    const v = st?.vacancies?.find((x) => x.district === d.district);
    if (v) vacantDistricts.push({ ...v, state: d.state, districtKey: districtKey(d.state, d.district) });
    // 既没有议员也没记空缺 = 数据对不上（远程官员表比 ZIP 表旧之类），这个选区不列；全都对不上时回退到按州选
  }
  const picked = candidates.find((r) => r.bioguideId === place.representativeBioguideId);
  if (picked) return { status: 'ok', answers: picked.accepted, display: [picked.name], asOf, scope: 'district' };
  if (candidates.length === 1 && vacantDistricts.length === 0) {
    const r = candidates[0];
    return { status: 'ok', answers: r.accepted, display: [r.name], asOf, scope: 'district' };
  }
  if (candidates.length === 0 && vacantDistricts.length === 1) {
    const v = vacantDistricts[0];
    return { status: 'vacant', state: v.state, district: v.district, note: v.note, asOf };
  }
  if (candidates.length === 0 && vacantDistricts.length === 0) return null;
  return { status: 'need_representative', candidates, ...(vacantDistricts.length ? { vacantDistricts } : {}) };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isStrArr = (a: unknown) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === 'string' && s.length > 0);
const isPerson = (p: unknown) => isObj(p) && typeof p.name === 'string' && isStrArr(p.accepted)
  && (p.party === undefined || typeof p.party === 'string') && (p.bioguideId === undefined || typeof p.bioguideId === 'string');

/** 校验远程（或打包）JSON；格式不对返回 null，不抛异常。 */
export function parseOfficials(raw: unknown): OfficialsData | null {
  if (!isObj(raw) || raw.version !== 1) return null;
  const n = raw.national, s = raw.states;
  if (!isObj(n) || !isDate(n.asOf) || !isObj(n.answers) || !Object.values(n.answers).every(isStrArr)) return null;
  if (!isObj(s) || !isDate(s.asOf) || !isObj(s.byState)) return null;
  for (const st of Object.values(s.byState)) {
    if (!isObj(st) || !Array.isArray(st.senators) || !st.senators.every(isPerson) || !isPerson(st.capital)) return null;
    if (st.governor !== null && !isPerson(st.governor)) return null;
    if (!Array.isArray(st.representatives) || !st.representatives.every((r) => isPerson(r) && isObj(r) && typeof r.district === 'string' && typeof r.bioguideId === 'string')) return null;
    if (st.vacancies !== undefined && !(Array.isArray(st.vacancies) && st.vacancies.every((v) => isObj(v) && typeof v.district === 'string' && typeof v.note === 'string'))) return null;
  }
  return raw as unknown as OfficialsData;
}

/** 远程版本格式对、而且两类日期都不比打包的旧，才用远程的；否则用打包的。 */
export function pickOfficials(bundled: OfficialsData, remoteRaw: unknown): { data: OfficialsData; from: 'remote' | 'bundled' } {
  const r = parseOfficials(remoteRaw);
  if (r && r.national.asOf >= bundled.national.asOf && r.states.asOf >= bundled.states.asOf) return { data: r, from: 'remote' };
  return { data: bundled, from: 'bundled' };
}
