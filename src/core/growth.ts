// 자라는 날 (스펙 §5.14-2, D-030): 정해진 날 아침 그리드의 전설 추억이 모두 양분이 되어 성장치·기억·특성으로 남는다.
// Phaser 의존 없음. 처리 자체(소진·나이)는 GameState.grow()가 하고, 계산은 여기 순수 함수로 둔다.
import type { Balance, LegendKind, Recipe } from '../data/types';

/** 이번 자라기의 갈래: 행복만 / 정화만 / 둘 다 / 전설 없음("천천히 자란") */
export type Branch = 'happy' | 'unhappy' | 'together' | 'slow';
export const BRANCHES: readonly Branch[] = ['happy', 'unhappy', 'together', 'slow'];

/** 기억 앨범 한 칸: 행복 1 + 정화 1이 짝지어진 기억 */
export interface AlbumEntry {
  day: number;
  happy: string;
  purified: string;
}

export interface GrowthState {
  /** 행복한 추억 쪽 성장치 */
  happy: number;
  /** 정화된 추억 쪽 성장치 */
  unhappy: number;
  memories: number;
  /** 자라기마다의 갈래 (순서대로) */
  branches: Branch[];
  album: AlbumEntry[];
  /** 양분으로 준 전설 수 (결과 화면) */
  given: { happy: number; purified: number };
}

/** 특성 키: `${체인}:${종류}` (happy = 낮 방어 레인에서만, purified = 밤 심연 레인에서만) */
export type TraitKey = `${string}:${LegendKind}`;
export type Traits = Record<string, number>;

export function emptyGrowth(): GrowthState {
  return { happy: 0, unhappy: 0, memories: 0, branches: [], album: [], given: { happy: 0, purified: 0 } };
}

export function traitKey(chain: string, kind: LegendKind): TraitKey {
  return `${chain}:${kind}`;
}

export function branchOf(happy: number, purified: number): Branch {
  if (happy > 0 && purified > 0) return 'together';
  if (happy > 0) return 'happy';
  if (purified > 0) return 'unhappy';
  return 'slow';
}

/** 한 번의 자라기 결과 (연출·metrics·테스트) */
export interface GrowthResult {
  day: number;
  /** 몇 번째 자라기 (1부터) */
  index: number;
  /** 소진한 전설 (조합 id, 소진 순서: 그리드 칸 순 → 대기열 순) */
  consumed: { recipe: string; kind: LegendKind; chain: string; cell: number | null }[];
  happyCount: number;
  purifiedCount: number;
  /** 이번에 생긴 기억 수 (= min(행복, 정화)) */
  pairs: number;
  branch: Branch;
  /** 이번에 오른 성장치 */
  gained: { happy: number; unhappy: number };
  /** 이번에 스택이 오른 특성 (상한에 막힌 것은 빠짐) */
  traitsUp: Record<string, number>;
  /** 자란 뒤 특성 스택 전체 */
  traits: Record<string, number>;
}

/**
 * 소진 목록 → 성장치·기억·특성·갈래를 growth·traits에 반영 (제자리 수정).
 * 성장치: 종류별 전설 수 × growthPerLegend, 기억(min 짝)마다 양쪽 + memoryBonus.
 * 특성: 소진한 전설마다 (첫 재료 체인 × 종류) 스택 +1, 상한 traitMaxStacks.
 */
export function applyGrowth(
  growth: GrowthState,
  traits: Traits,
  consumed: GrowthResult['consumed'],
  cfg: Balance['growth'],
  day: number,
): GrowthResult {
  const happyList = consumed.filter((c) => c.kind === 'happy');
  const purifiedList = consumed.filter((c) => c.kind === 'purified');
  const pairs = Math.min(happyList.length, purifiedList.length);
  const gained = {
    happy: happyList.length * cfg.growthPerLegend + pairs * cfg.memoryBonus,
    unhappy: purifiedList.length * cfg.growthPerLegend + pairs * cfg.memoryBonus,
  };
  growth.happy += gained.happy;
  growth.unhappy += gained.unhappy;
  growth.memories += pairs;
  for (let i = 0; i < pairs; i++) growth.album.push({ day, happy: happyList[i].recipe, purified: purifiedList[i].recipe });
  growth.given.happy += happyList.length;
  growth.given.purified += purifiedList.length;
  const traitsUp: Record<string, number> = {};
  for (const c of consumed) {
    const k = traitKey(c.chain, c.kind);
    if ((traits[k] ?? 0) >= cfg.traitMaxStacks) continue;
    traits[k] = (traits[k] ?? 0) + 1;
    traitsUp[k] = (traitsUp[k] ?? 0) + 1;
  }
  const branch = branchOf(happyList.length, purifiedList.length);
  growth.branches.push(branch);
  return {
    day,
    index: growth.branches.length,
    consumed,
    happyCount: happyList.length,
    purifiedCount: purifiedList.length,
    pairs,
    branch,
    gained,
    traitsUp,
    traits: { ...traits },
  };
}

/** 특성 배수: 해당 체인 유닛 hp·atk × (1 + traitPerStack × 스택). happy 특성은 낮(방어), purified는 밤(심연) */
export function traitMult(traits: Traits, chain: string, lane: 'defense' | 'abyss', cfg: Balance['growth']): number {
  const stacks = traits[traitKey(chain, lane === 'defense' ? 'happy' : 'purified')] ?? 0;
  return 1 + cfg.traitPerStack * stacks;
}

/** 조합 id → 종류 */
export function kindOf(recipes: readonly Recipe[], id: string): LegendKind {
  const r = recipes.find((x) => x.id === id);
  if (!r) throw new Error(`알 수 없는 전설: ${id}`);
  return r.kind;
}
