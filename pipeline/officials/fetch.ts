/// <reference types="node" />
// 任务 CS：抓官员名单的原始页面。全是公开的官方页面：
//   MemberData.xml       https://clerk.house.gov/xml/lists/MemberData.xml（众议院书记官处：众议员、党派、空缺）
//   senators_cfm.xml     https://www.senate.gov/general/contact_information/senators_cfm.xml（参议院：参议员、党派、bioguideId）
//   usagov/<州>.html     https://www.usa.gov/states/<州>（州长姓名、州长办公室城市）
//   nga/<州>.html        https://www.nga.org/governors/<州>/（州长党派，顺便和 usa.gov 对州长名字）
// 规矩：UA 固定 shortvideo-skill/1.0；一次只发一个请求、间隔 1 秒；403 / 429 / 其他非 200 一律失败退出，不换头、不换路径、不换站点重试。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseNgaGovernorPage } from '../../scripts/officials/build.ts';

export const UA = 'shortvideo-skill/1.0';
export const STATE_SLUGS = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new-hampshire', 'new-jersey', 'new-mexico', 'new-york',
  'north-carolina', 'north-dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode-island', 'south-carolina', 'south-dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west-virginia', 'wisconsin', 'wyoming'];

export interface Fetched { url: string; file: string; fetchedAt: string; status: number; bytes: number; sha256: string }

export class FetchBlocked extends Error {}

/** 抓全部来源到 dir（覆盖写），返回每个文件的抓取记录；任何一个不是 200 就抛 FetchBlocked */
export async function fetchAll(dir: string, log: (s: string) => void = console.log): Promise<Fetched[]> {
  const jobs: { url: string; file: string }[] = [
    { url: 'https://clerk.house.gov/xml/lists/MemberData.xml', file: 'MemberData.xml' },
    { url: 'https://www.senate.gov/general/contact_information/senators_cfm.xml', file: 'senators_cfm.xml' },
    ...STATE_SLUGS.map((s) => ({ url: `https://www.usa.gov/states/${s}`, file: `usagov/${s}.html` })),
    ...STATE_SLUGS.map((s) => ({ url: `https://www.nga.org/governors/${s}/`, file: `nga/${s}.html` })),
  ];
  const out: Fetched[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const r = await fetch(j.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) throw new FetchBlocked(`${j.url} 返回 ${r.status}，停手（不换头、不换站点重试）`);
    mkdirSync(dirname(join(dir, j.file)), { recursive: true });
    writeFileSync(join(dir, j.file), buf);
    out.push({ url: j.url, file: j.file, fetchedAt: new Date().toISOString(), status: r.status, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    if ((i + 1) % 20 === 0) log(`  抓了 ${i + 1}/${jobs.length}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  writeFileSync(join(dir, '_index.tsv'), out.map((f) => [f.fetchedAt, f.status, f.url, f.file, f.bytes, f.sha256].join('\t')).join('\n') + '\n');
  return out;
}

/** nga/<州>.html → build.ts 认的 nga_governors_party.tsv；哪一页认不出就抛异常（宁可失败，不悄悄缺一个州长的党派） */
export function ngaTsv(pages: { slug: string; html: string }[]): string {
  const rows = pages.map(({ slug, html }) => {
    const g = parseNgaGovernorPage(html);
    if (!g) throw new Error(`nga.org ${slug} 页面认不出州长和党派（页面改版了？）`);
    return [slug, 200, g.name, g.party, g.line].join('\t');
  });
  return `# 由 pipeline/officials 从 nga/<州>.html 生成\n${rows.join('\n')}\n`;
}
