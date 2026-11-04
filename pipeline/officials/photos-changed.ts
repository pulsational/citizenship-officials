/// <reference types="node" />
// 任务 PH：每日流程要不要把远程照片提交回仓库（public/photos-manifest.json + public/photos/<id>.jpg）。
//
// 为什么要提交回仓库：Pages 每次部署都是整份替换，上一次发布的照片不会留在任何地方。照片不进仓库的话，
// 每天都得把「app 没打包的人」的照片从 Commons 重新找、重新下一遍（Wikidata、Commons 各打一次，还要每天重新转码，
// 转出来的字节也可能变 → app 那边 sha 变了又得重下）。提交回 main 以后，下一次用 --prev-photos public 原样沿用，
// 只有新面孔才联网。规矩和 officials.json 一样：真的变了才提交——比的是清单条目（谁、哪张、sha、授权），
// 不看每天都会变的 generatedAt，也不看「还缺谁」（还缺的人每天照旧再找，不值得每天一个提交）。
//
//   node pipeline/officials/photos-changed.ts <上一版目录，如 public> <这次的产物目录，如 out>
//   打印 changed 或 same，退出码 0；这次的清单读不出 → 退出码 2（workflow 那一步跟着失败）
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhotosManifest } from './photos.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function photosChanged(prevDir: string, nextDir: string): boolean {
  const next = JSON.parse(readFileSync(join(nextDir, 'photos-manifest.json'), 'utf8')) as PhotosManifest;
  if (!Array.isArray(next.entries)) throw new Error('这次的 photos-manifest.json 没有 entries');
  const prevPath = join(prevDir, 'photos-manifest.json');
  if (!existsSync(prevPath)) return true;
  let prev: PhotosManifest;
  try { prev = JSON.parse(readFileSync(prevPath, 'utf8')); } catch { return true; }
  if (JSON.stringify(prev.entries) !== JSON.stringify(next.entries)) return true;
  // 条目一样，再核文件本身：仓库里的照片被改坏或缺了，也算变了（这次的覆盖回去）
  return next.entries.some((e) => {
    const p = join(prevDir, e.file);
    return !existsSync(p) || sha(readFileSync(p)) !== e.sha256;
  });
}

function main() {
  const [prevDir, nextDir] = process.argv.slice(2);
  if (!prevDir || !nextDir) { console.error('用法：node pipeline/officials/photos-changed.ts <上一版目录> <这次的产物目录>'); process.exit(2); }
  console.log(photosChanged(prevDir, nextDir) ? 'changed' : 'same');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(`失败：${e instanceof Error ? e.message : e}`); process.exit(2); }
}
