// 화면 표시 문구 도우미 (§5.15-2, §5.17-9, §5.19-1).
import type { FailReason } from '../core/day';
import type { GameData } from '../data/types';

/** 체인 짧은 이름 (영웅 슬롯 점수·먹이기 태그): 1챕터 떡 / 동아줄. 모르는 체인은 1단계 이름 */
const CHAIN_SHORT: Record<string, string> = {
  companion_animal: '떡',
  comfort_object: '동아줄',
};

export function chainShort(data: GameData, chain: string): string {
  if (CHAIN_SHORT[chain]) return CHAIN_SHORT[chain];
  return data.chains.find((c) => c.archetypeId === chain)?.tierNames[0] ?? chain;
}

/** 스테이지 이름 (§5.19-1): "1-3 · 셋째 고개" (stages.json title) */
export function stageLabel(data: GameData, stage: number): string {
  const s = data.stages.stages[Math.max(0, Math.min(stage, data.stages.stages.length) - 1)];
  return `1-${stage} · ${s?.title ?? ''}`;
}

/** 실패 사유 한 줄 (재도전 장면 카드) */
export const FAIL_LINE: Record<FailReason, string> = {
  dayTime: '해가 졌다 — 핵을 찾지 못했다.',
  dayFall: '가는 길에 쓰러졌다 — 핵을 찾지 못했다.',
  returnTime: '해가 졌다 — 핵을 이야기책까지 가져오지 못했다.',
  night: '밤에 핵을 빼앗겼다.',
};

export function recipeName(data: GameData, id: string): string {
  return data.recipes.recipes.find((r) => r.id === id)?.name ?? id;
}
