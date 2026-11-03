// C 块：议员、州长名字的预录读音（任务 CR）。
// 预录的是打包时 officials.json 里的现任，声音和公民题一样（Andrew，F0 免费档）。远程官员数据换了人、
// 或者名字写法变了，预录的就不对了——pickNameAudio 返回 null，界面改用系统朗读。
// 音频表 src/audio/namesAudioIndex.ts 由 scripts/audio/names.ts 生成：NAME_AUDIO[id] = { name, src }。
import type { OfficialsData, Person } from './index.ts';

export type Role = 'representative' | 'senator' | 'governor';

/** 预录音频的 id：众议员、参议员用 bioguideId；州长用 gov-州（州长没有 bioguideId） */
export function nameAudioId(role: Role, state: string, p: Person): string {
  return role === 'governor' ? `gov-${state}` : p.bioguideId ?? `${role}-${state}-${p.name}`;
}

/** 念的文本：引号里的小名念成插入语（Eric A. "Rick" Crawford → Eric A., Rick, Crawford），其余照官方全名 */
export function spokenName(name: string): string {
  return name.replace(/\s*"([^"]+)"\s*/g, ', $1, ').replace(/\s+/g, ' ').trim();
}

/** 要预录的全部人：每州的众议员、参议员、州长 */
export function peopleForNameAudio(data: OfficialsData): { id: string; name: string; role: Role; state: string }[] {
  const out: { id: string; name: string; role: Role; state: string }[] = [];
  for (const [st, s] of Object.entries(data.states.byState)) {
    for (const r of s.representatives) out.push({ id: nameAudioId('representative', st, r), name: r.name, role: 'representative', state: st });
    for (const p of s.senators) out.push({ id: nameAudioId('senator', st, p), name: p.name, role: 'senator', state: st });
    if (s.governor) out.push({ id: nameAudioId('governor', st, s.governor), name: s.governor.name, role: 'governor', state: st });
  }
  return out;
}

/** 有这个 id、而且预录时的名字和现在显示的一样，才返回预录音频；否则 null（界面用系统朗读） */
export function pickNameAudio<T>(map: Record<string, { name: string; src: T }>, id: string, currentName: string): T | null {
  const e = map[id];
  return e && e.name === currentName ? e.src : null;
}
