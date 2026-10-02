// 화면 표시 문구 도우미 (§5.15-2, §5.17-9). 구 growthText.ts에서 자라기 문구를 걷어낸 나머지.
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

/** 스테이지 이름 (§5.15-2): 밤 층 장면(보스 층은 bossName) / 낮 배경. "1-3 셋째 고개" */
export function stageLabel(data: GameData, stage: number, side: 'day' | 'night'): string {
  const ch = data.chapter;
  const i = Math.max(0, Math.min(stage, ch.sceneNames.length) - 1);
  const boss = stage === data.balance.chapter.length;
  const name = side === 'day' ? ch.dayScenes[i] : boss ? ch.bossName : ch.sceneNames[i];
  return `1-${stage} ${name}`;
}

export function recipeName(data: GameData, id: string): string {
  return data.recipes.recipes.find((r) => r.id === id)?.name ?? id;
}
