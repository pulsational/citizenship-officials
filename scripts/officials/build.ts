/// <reference types="node" />
// C 块：从政府公开页面生成打包兜底用的 src/data/officials.json（会随选举变的答案）。
//   sh scripts/officials/fetch.sh            # 先抓原始页面（只在要更新时跑）
//   node scripts/officials/build.ts          # 解析，写 src/data/officials.json，打印对账结果
// 范围：全国类照题库现任答案；按州：两位参议员、州长、首府；
// 众议员：本州全部名单（名字 + 第几选区）+ 空缺席位（footnote 原文）；按 ZIP 查选区的表另由 build-zcta.ts 生成（任务 CN）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'scripts', 'officials', 'src');

/** party：D / R / I（任务 CR；众议员、参议员取 clerk / senate.gov XML 的 <party>，州长取 nga.org 每州页面的 Party）。
 *  bioguideId：参议员也带（读名字的预录音频按它找）。两个都可以没有：远程老格式照用。 */
export interface Person { name: string; accepted: string[]; party?: string; bioguideId?: string }
export interface Rep extends Person { district: string; bioguideId: string }
/** 空缺的众议员席位：note 是众议院书记官处 MemberData.xml 里那条 footnote 原文（任务 CN） */
export interface Vacancy { district: string; note: string }
export interface StateOfficials { name: string; senators: Person[]; governor: Person | null; capital: Person; representatives: Rep[]; vacancies?: Vacancy[] }
/** asOf 分开记：全国类来自题库（USCIS testupdates 的日期），按州的来自抓取日，不能共用一个日期。 */
export interface OfficialsData {
  version: 1;
  sources: Record<string, string>;
  national: { asOf: string; answers: Record<string, string[]> };
  states: { asOf: string; byState: Record<string, StateOfficials> };
}

// 首府：固定事实，我写的表；用 usa.gov 上州长办公室所在城市做第二来源对账（对不上的打印出来人工看）
export const CAPITALS: Record<string, string> = {
  AL: 'Montgomery', AK: 'Juneau', AZ: 'Phoenix', AR: 'Little Rock', CA: 'Sacramento', CO: 'Denver', CT: 'Hartford', DE: 'Dover',
  FL: 'Tallahassee', GA: 'Atlanta', HI: 'Honolulu', ID: 'Boise', IL: 'Springfield', IN: 'Indianapolis', IA: 'Des Moines',
  KS: 'Topeka', KY: 'Frankfort', LA: 'Baton Rouge', ME: 'Augusta', MD: 'Annapolis', MA: 'Boston', MI: 'Lansing', MN: 'Saint Paul',
  MS: 'Jackson', MO: 'Jefferson City', MT: 'Helena', NE: 'Lincoln', NV: 'Carson City', NH: 'Concord', NJ: 'Trenton', NM: 'Santa Fe',
  NY: 'Albany', NC: 'Raleigh', ND: 'Bismarck', OH: 'Columbus', OK: 'Oklahoma City', OR: 'Salem', PA: 'Harrisburg', RI: 'Providence',
  SC: 'Columbia', SD: 'Pierre', TN: 'Nashville', TX: 'Austin', UT: 'Salt Lake City', VT: 'Montpelier', VA: 'Richmond',
  WA: 'Olympia', WV: 'Charleston', WI: 'Madison', WY: 'Cheyenne',
};
const SLUG_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new-hampshire': 'NH', 'new-jersey': 'NJ', 'new-mexico': 'NM', 'new-york': 'NY',
  'north-carolina': 'NC', 'north-dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode-island': 'RI',
  'south-carolina': 'SC', 'south-dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west-virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/\s+/g, ' ').trim();
const tag = (xml: string, t: string) => { const m = xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };
const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];

/** 可接受的答法：全名、去掉中间名缩写和后缀的名+姓、只说姓 */
export function acceptedNames(first: string, last: string, full?: string): string[] {
  const firstPlain = first.split(/\s+/)[0];
  return uniq([full ?? `${first} ${last}`, `${first} ${last}`, `${firstPlain} ${last}`, last].map((s) => s.replace(/\s+/g, ' ').trim()));
}

export function parseSenators(xml: string): Record<string, Person[]> {
  const out: Record<string, Person[]> = {};
  for (const m of xml.matchAll(/<member>([\s\S]*?)<\/member>/g)) {
    const x = m[1], st = tag(x, 'state'), last = tag(x, 'last_name');
    // senate.gov 把后缀写在 first_name 里（「Angus S., Jr.」），挪到姓后面：Angus S. King, Jr.
    const fm = tag(x, 'first_name').match(/^(.*?),\s*((?:Jr|Sr)\.|I{2,3}|IV)$/);
    const first = fm ? fm[1] : tag(x, 'first_name');
    const full = fm ? `${first} ${last}, ${fm[2]}` : `${first} ${last}`;
    (out[st] ??= []).push({ name: full, accepted: acceptedNames(first, last, full), party: tag(x, 'party'), bioguideId: tag(x, 'bioguide_id') });
  }
  return out;
}

export function parseHouse(xml: string): Record<string, Rep[]> {
  const out: Record<string, Rep[]> = {};
  for (const m of xml.matchAll(/<member>([\s\S]*?)<\/member>/g)) {
    const x = m[1];
    const sd = tag(x, 'statedistrict');
    const info = x.match(/<member-info>([\s\S]*?)<\/member-info>/)?.[1] ?? '';
    const official = tag(info, 'official-name'), first = tag(info, 'firstname'), last = tag(info, 'lastname');
    if (!official || !last) continue;                    // 空缺席位：没有议员信息
    const st = sd.slice(0, 2), dnum = sd.slice(2);
    if (!(st in CAPITALS)) continue;                     // v0.1 只做 50 州（DC 和领地的无投票权代表不在范围）
    const district = dnum === '00' ? 'At Large' : String(+dnum);
    (out[st] ??= []).push({ name: official, district, bioguideId: tag(info, 'bioguideID'), accepted: acceptedNames(first, last, official), party: tag(info, 'party') });
  }
  for (const st of Object.keys(out)) out[st].sort((a, b) => (a.district === 'At Large' ? 0 : +a.district) - (b.district === 'At Large' ? 0 : +b.district));
  return out;
}

/** 空缺席位：member-info 里没有议员名字的那几条，取 footnote 原文（如「Vacancy due to the resignation of …, April 21, 2026.」） */
export function parseVacancies(xml: string): Record<string, Vacancy[]> {
  const out: Record<string, Vacancy[]> = {};
  for (const m of xml.matchAll(/<member>([\s\S]*?)<\/member>/g)) {
    const x = m[1];
    const info = x.match(/<member-info>([\s\S]*?)<\/member-info>/)?.[1] ?? '';
    if (tag(info, 'official-name')) continue;
    const sd = tag(x, 'statedistrict'), st = sd.slice(0, 2), dnum = sd.slice(2);
    if (!(st in CAPITALS)) continue;
    (out[st] ??= []).push({ district: dnum === '00' ? 'At Large' : String(+dnum), note: tag(info, 'footnote') || 'Vacancy' });
  }
  return out;
}

/** 州长党派：nga_governors_party.tsv（nga.org/governors/<state>/ 页面上的 Party 一栏，Chrome 里逐页读的原文）。
 *  「Democratic」「Democrat」都记成 D，「Republican」记成 R；认不出的抛异常，不悄悄丢。 */
export function parseGovernorParty(tsv: string): Record<string, { name: string; party: string }> {
  const out: Record<string, { name: string; party: string }> = {};
  for (const line of tsv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [slug, , name, party] = line.split('\t');
    const code = SLUG_TO_CODE[slug];
    const p = /^Democrat(ic)?$/.test(party) ? 'D' : party === 'Republican' ? 'R' : party === 'Independent' ? 'I' : null;
    if (!code || !p) throw new Error(`nga 州长党派这一行认不出：${line.slice(0, 80)}`);
    out[code] = { name, party: p };
  }
  return out;
}

export function parseGovernor(html: string): { governor: string | null; officeCity: string | null } {
  // 页面是「Governor」标签 + 下一行。50 州里见过两种写法：「Governor Gavin Newsom」（多数，MS 后面直接跟 Phone:）、
  // 「Contact Governor Dan McKee」（RI）。取标签下一行，去掉开头的 Governor / Contact Governor。
  const lines = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, '\n').split('\n').map(decode).filter(Boolean);
  const i = lines.indexOf('Governor');
  const m = i >= 0 ? lines[i + 1]?.match(/^(?:Contact )?Governor ([A-Z][A-Za-z.'’ -]+)$/) : null;
  const city = html.match(/field--name-field-city[^>]*>([^<]+)</);
  return { governor: m ? m[1].trim() : null, officeCity: city ? decode(city[1]) : null };
}

/** 从一份原始页面目录（src：senators_cfm.xml、MemberData.xml、usagov/<州>.html、nga_governors_party.tsv）生成官员数据。
 *  problems = 两个来源对不上、字段缺这一类要人看的；fetched = 按州数据的抓取日（YYYY-MM-DD）。pipeline/officials 也调它。 */
export function buildOfficials(SRC: string, bank: any, fetched: string): { data: OfficialsData; problems: string[]; vacancies: Record<string, Vacancy[]> } {
  const national: Record<string, string[]> = {};
  for (const k of ['civics_2025', 'civics_2008'])
    for (const q of bank[k]) if (q.variable && q.variable_kind === 'national' && q.current_answers) national[q.id] = q.current_answers;
  const sen = parseSenators(readFileSync(join(SRC, 'senators_cfm.xml'), 'utf8'));
  const houseXml = readFileSync(join(SRC, 'MemberData.xml'), 'utf8');
  const house = parseHouse(houseXml);
  const vacancies = parseVacancies(houseXml);
  const govParty = parseGovernorParty(readFileSync(join(SRC, 'nga_governors_party.tsv'), 'utf8'));
  const states: Record<string, StateOfficials> = {};
  const problems: string[] = [];
  for (const f of readdirSync(join(SRC, 'usagov')).sort()) {
    const code = SLUG_TO_CODE[f.replace(/\.html$/, '')];
    const html = readFileSync(join(SRC, 'usagov', f), 'utf8');
    const { governor, officeCity } = parseGovernor(html);
    const name = f.replace(/\.html$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    if (!governor) problems.push(`${code} 州长没解析出来`);
    if (officeCity && officeCity !== CAPITALS[code]) problems.push(`${code} 首府表写 ${CAPITALS[code]}，usa.gov 州长办公室在 ${officeCity}（人工看）`);
    if ((sen[code] ?? []).length !== 2) problems.push(`${code} 参议员 ${(sen[code] ?? []).length} 位`);
    if (!(house[code] ?? []).length) problems.push(`${code} 没有众议员`);
    // 州长名字两个来源对账：去掉中间名缩写以后 usa.gov 和 nga.org 要一致，不一致说明有一边过期了
    const strip = (n: string) => n.replace(/\b[A-Z]\.\s*/g, '').replace(/\s+/g, ' ').trim();
    if (governor && govParty[code] && strip(governor) !== strip(govParty[code].name)) problems.push(`${code} 州长 usa.gov 写 ${governor}，nga.org 写 ${govParty[code].name}`);
    if (!govParty[code]) problems.push(`${code} nga.org 没有州长党派`);
    const gParts = governor?.split(' ') ?? [];
    states[code] = {
      name, senators: sen[code] ?? [],
      governor: governor ? { name: governor, accepted: acceptedNames(gParts.slice(0, -1).join(' '), gParts[gParts.length - 1], governor), party: govParty[code]?.party } : null,
      capital: { name: CAPITALS[code], accepted: [CAPITALS[code]] },
      representatives: house[code] ?? [],
      ...(vacancies[code] ? { vacancies: vacancies[code] } : {}),
    };
  }
  const publish = houseXml.match(/publish-date="([^"]+)"/)?.[1] ?? '';
  const [mm, dd, yyyy] = String(bank.meta.testupdates_reviewed).split('/');
  const data: OfficialsData = {
    version: 1,
    sources: {
      national: `题库 current_answers（USCIS testupdates，题库记录 reviewed ${bank.meta.testupdates_reviewed}）`,
      senators: 'https://www.senate.gov/general/contact_information/senators_cfm.xml',
      representatives: `https://clerk.house.gov/xml/lists/MemberData.xml（publish-date ${publish}）`,
      governors: 'https://www.usa.gov/states/<state>（党派：https://www.nga.org/governors/<state>/）',
      party: '众议员 clerk MemberData.xml <party>、参议员 senators_cfm.xml <party>、州长 nga.org 每州页面 Party',
      capitals: '内置表，用 usa.gov 州长办公室城市对账',
    },
    national: { asOf: `${yyyy}-${mm}-${dd}`, answers: national },
    states: { asOf: fetched, byState: states },
  };
  return { data, problems, vacancies };
}

/** NGA 每州页面（nga.org/governors/<state>/）→ 姓名和党派原文；认不出返回 null */
export function parseNgaGovernorPage(html: string): { name: string; party: string; line: string } | null {
  const t = decode(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' '));
  const m = t.match(/Back to current governors (.+?) Gov\. (.+?) Terms (.+?) Party (Democratic|Democrat|Republican|Independent)\b/);
  return m ? { name: m[2].trim(), party: m[4], line: m[0] } : null;
}

function main() {
  const bank = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'bank.json'), 'utf8'));
  // 按州数据的抓取日：只看官员页面那几行（Census 的 ZCTA 文件另记，不能把它的下载日当成官员数据的日期）
  const fetched = readFileSync(join(SRC, '_index.tsv'), 'utf8').trim().split('\n').filter((l) => !l.includes('tab20_')).pop()!.split('\t')[0].slice(0, 10);
  const { data, problems, vacancies } = buildOfficials(SRC, bank, fetched);
  const states = data.states.byState;
  writeFileSync(join(ROOT, 'src', 'data', 'officials.json'), JSON.stringify(data, null, 1) + '\n');
  const nRep = Object.values(states).reduce((n, s) => n + s.representatives.length, 0);
  console.log(`空缺席位：${Object.entries(vacancies).flatMap(([st, v]) => v.map((x) => `${st}-${x.district}「${x.note}」`)).join('；') || '无'}`);
  console.log(`州 ${Object.keys(states).length}，参议员 ${Object.values(states).reduce((n, s) => n + s.senators.length, 0)}，州长 ${Object.values(states).filter((s) => s.governor).length}，众议员 ${nRep}，全国类 ${Object.keys(data.national.answers).length} 题`);
  console.log(problems.length ? `要人工看的 ${problems.length} 条：\n  ${problems.join('\n  ')}` : '对账全通过');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
