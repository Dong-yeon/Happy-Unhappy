// 화면 표시 문구 도우미 (§5.15-2, §5.17-9, §5.19-1).
import type { FailReason } from '../core/day';
import type { GameData } from '../data/types';

/** 스테이지 이름 (§5.19-1): "1-3 · 셋째 고개" (stages.json title) */
export function stageLabel(data: GameData, stage: number): string {
  const s = data.stages.stages[Math.max(0, Math.min(stage, data.stages.stages.length) - 1)];
  return `1-${stage} · ${s?.title ?? ''}`;
}

/** 실패 사유 한 줄 (재도전 장면 카드) */
export const FAIL_LINE: Record<FailReason, string> = {
  dayTime: '해가 졌다 — 이야기 씨앗을 찾지 못했다.',
  dayFall: '가는 길에 쓰러졌다 — 이야기 씨앗을 찾지 못했다.',
  returnTime: '해가 졌다 — 이야기 씨앗을 이야기책까지 가져오지 못했다.',
  night: '밤에 이야기 씨앗을 빼앗겼다.',
};

export function recipeName(data: GameData, id: string): string {
  return data.recipes.recipes.find((r) => r.id === id)?.name ?? id;
}
