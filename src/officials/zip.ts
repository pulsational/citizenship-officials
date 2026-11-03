// C 块：ZIP → 国会选区（众议员那题用）。任务 CN。
// 数据：Census 2020 「ZCTA 对第 119 届国会选区」关系文件，打包成 src/data/zctaDistricts.json（scripts/officials/build-zcta.ts 生成）。
//   - ZCTA（邮编统计区）不等于邮政 ZIP：大多数住宅 ZIP 有对应的 ZCTA，但只给邮政信箱、单位用的 ZIP 往往没有，
//     而且边界是按人口普查区块拼的，跟邮局的投递范围不完全一样。查不到就回退到「按州选」。
//   - 一个 ZCTA 可能跨好几个选区，这时只列那几位让用户点选。
//   - DC 和海外领地（无投票权代表）单独存在 territories 里，界面显示题库自带的官方说明，不回退到按州选。
// 远程更新：和官员数据一样，app 打包一份兜底；远程文件格式对、sha256 对得上、dataVersion 不比打包的旧，才用远程的。
import { sha256Hex } from './sha256.ts';

export interface ZipData {
  format: 1;
  /** 数据版本，内容变了就加 1；远程版本比打包的旧就不用 */
  dataVersion: number;
  /** 生成日期 YYYY-MM-DD */
  generatedAt: string;
  source: { url: string; file: string; sha256: string; congress: number };
  /** zipDataDigest(districts, territories)：远程文件下载后用它校验，内容被截断或改坏就对不上 */
  sha256: string;
  /** 「州:选区」→ 这个选区里所有 ZCTA 拼成的一串（每个 5 位）。选区写法和 officials.json 一致：「17」「At Large」 */
  districts: Record<string, string>;
  /** DC / PR / GU / VI / MP / AS → 同上 */
  territories: Record<string, string>;
}

export const TERRITORY_NAMES: Record<string, { en: string; zh: string }> = {
  DC: { en: 'District of Columbia', zh: '哥伦比亚特区（DC）' },
  PR: { en: 'Puerto Rico', zh: '波多黎各' },
  GU: { en: 'Guam', zh: '关岛' },
  VI: { en: 'U.S. Virgin Islands', zh: '美属维尔京群岛' },
  MP: { en: 'Northern Mariana Islands', zh: '北马里亚纳群岛' },
  AS: { en: 'American Samoa', zh: '美属萨摩亚' },
};

/** ZIP 输入框下面「到 house.gov 查」按钮的链接 */
export const ZIP_NOTE = {
  url: 'https://www.house.gov/representatives/find-your-representative',
};

/** 远程 ZIP 表的托管地址。null = 只用打包的。 */
export const ZIP_REMOTE: { url: string | null } = { url: null };

const lines = (m: Record<string, string>) => Object.keys(m).sort().map((k) => `${k}=${m[k]}`).join('\n');
/** 规范化以后取 sha256：键排序、一行一条，和 JSON 里的键顺序、空白无关 */
export function zipDataDigest(districts: Record<string, string>, territories: Record<string, string>): string {
  return sha256Hex(`districts\n${lines(districts)}\nterritories\n${lines(territories)}\n`);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isZipRun = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length % 5 === 0 && /^\d+$/.test(v);
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const isDistrictKey = (k: string) => { const m = k.match(/^([A-Z]{2}):(?:[1-9]\d?|At Large)$/); return !!m && STATES.has(m[1]); };

/** 校验远程（或打包）的 ZIP 表；格式不对、sha256 对不上都返回 null，不抛异常。 */
export function parseZipData(raw: unknown): ZipData | null {
  if (!isObj(raw) || raw.format !== 1) return null;
  if (typeof raw.dataVersion !== 'number' || !Number.isInteger(raw.dataVersion) || raw.dataVersion < 1) return null;
  if (typeof raw.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.generatedAt)) return null;
  if (typeof raw.sha256 !== 'string' || !isObj(raw.source)) return null;
  const d = raw.districts, t = raw.territories;
  if (!isObj(d) || !isObj(t) || Object.keys(d).length === 0) return null;
  if (!Object.entries(d).every(([k, v]) => isDistrictKey(k) && isZipRun(v))) return null;
  if (!Object.entries(t).every(([k, v]) => k in TERRITORY_NAMES && isZipRun(v))) return null;
  if (zipDataDigest(d as Record<string, string>, t as Record<string, string>) !== raw.sha256) return null;
  return raw as unknown as ZipData;
}

/** 远程的格式对、sha 对、dataVersion 不比打包的旧，才用远程的；否则用打包的。 */
export function pickZipData(bundled: ZipData, remoteRaw: unknown): { data: ZipData; from: 'remote' | 'bundled' } {
  const r = parseZipData(remoteRaw);
  if (r && r.dataVersion >= bundled.dataVersion) return { data: r, from: 'remote' };
  return { data: bundled, from: 'bundled' };
}

/** 后台取远程 JSON：没配地址、网络错、超时、不是 JSON 一律返回 null（调用方接着用打包的）。 */
export async function fetchRemoteJson(url: string | null, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<unknown> {
  if (!url) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface DistrictRef { state: string; district: string }
export interface ZipIndex { districts: Map<string, DistrictRef[]>; territories: Map<string, string> }

/** 建查找索引（3 万多个键，第一次用到时建一次就行） */
export function buildZipIndex(data: ZipData): ZipIndex {
  const districts = new Map<string, DistrictRef[]>();
  for (const [key, run] of Object.entries(data.districts)) {
    const i = key.indexOf(':');
    const ref = { state: key.slice(0, i), district: key.slice(i + 1) };
    for (let p = 0; p < run.length; p += 5) {
      const z = run.slice(p, p + 5);
      const list = districts.get(z);
      if (list) list.push(ref); else districts.set(z, [ref]);
    }
  }
  const territories = new Map<string, string>();
  for (const [code, run] of Object.entries(data.territories)) for (let p = 0; p < run.length; p += 5) territories.set(run.slice(p, p + 5), code);
  return { districts, territories };
}

export type ZipLookup =
  | { kind: 'bad_format' }
  | { kind: 'not_found' }
  | { kind: 'territory'; territory: string }
  | { kind: 'districts'; districts: DistrictRef[] };

/** 5 位数字（前后空格去掉）才查；不是 5 位数字 = bad_format */
export function lookupZip(zip: string, idx: ZipIndex): ZipLookup {
  const z = zip.trim();
  if (!/^\d{5}$/.test(z)) return { kind: 'bad_format' };
  const d = idx.districts.get(z);
  if (d) return { kind: 'districts', districts: d };
  const t = idx.territories.get(z);
  if (t) return { kind: 'territory', territory: t };
  return { kind: 'not_found' };
}

/** 资料页填了 ZIP 以后，界面可以用它自动带出州（跨州的 ZCTA 会返回不止一个） */
export function statesForZip(zip: string, idx: ZipIndex): string[] {
  const r = lookupZip(zip, idx);
  return r.kind === 'districts' ? [...new Set(r.districts.map((d) => d.state))] : [];
}
