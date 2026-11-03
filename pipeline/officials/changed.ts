/// <reference types="node" />
// 任务 OF：每日流程要不要把 officials.json 提交回仓库。只看名单本身（contentHash：全国类 + 每州的人、党派、空缺）；
// generatedAt、按州的 asOf（抓取日）、fetched、dataVersion 每天都会变或跟着变，不算——名单没变就不提交（Pages 照旧每天发布当天那份）。
// 全国类的 asOf 取自题库 reviewed 日期，题库更新才变，算在名单里。
//
//   node pipeline/officials/changed.ts <上一版 officials.json> <这次的 officials.json>
//   打印 changed 或 same，退出码 0；读不出、格式不对 → 退出码 2（workflow 那一步跟着失败）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash } from './run.ts';
import { parseOfficials } from '../../src/officials/index.ts';

/** 名单真的变了（谁上谁下、党派、空缺）才返回 true */
export function listChanged(prev: unknown, next: unknown): boolean {
  const p = parseOfficials(prev), n = parseOfficials(next);
  if (!n) throw new Error('这次的 officials.json 格式不对');
  if (!p) return true;
  return contentHash(p) !== contentHash(n);
}

function main() {
  const [prevPath, nextPath] = process.argv.slice(2);
  if (!prevPath || !nextPath) { console.error('用法：node pipeline/officials/changed.ts <上一版 officials.json> <这次的 officials.json>'); process.exit(2); }
  const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
  console.log(listChanged(read(prevPath), read(nextPath)) ? 'changed' : 'same');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(`失败：${e instanceof Error ? e.message : e}`); process.exit(2); }
}
