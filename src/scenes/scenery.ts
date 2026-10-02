// 1챕터 장면 색 (§5.23-2): 스테이지마다 배경 tint 한 가지 (장면마다 그림을 따로 두지 않는다, §5.16-3).
// 장면 카드 배경·이야기책 장 썸네일·낮 땅(스킨 그림일 때) tint에 같이 쓴다. 화면 연출 값이라 data가 아니라 여기 둔다.

/** 1-1 ~ 1-10: 고갯길 아침 → 숲 → 해 질 녘 → 수수밭 → 하늘 */
const DAY_TINTS = [0xf2e3b8, 0xe8d9a8, 0xd9e2b0, 0xc8d8a8, 0xe0c0a0, 0xb8d0b0, 0xd8b890, 0xc8a878, 0xe0a888, 0xb8c8e8];

export function stageTint(stage: number): number {
  return DAY_TINTS[(Math.max(1, stage) - 1) % DAY_TINTS.length];
}

/** 밤 tint (남색) */
export const NIGHT_TINT = 0x8090c8;

/** 장면 카드 패널 배경: 스테이지 tint를 어둡게 섞은 색 */
export function sceneCardColor(stage: number): number {
  const t = stageTint(stage);
  const mix = (sh: number) => Math.round(((t >> sh) & 0xff) * 0.28 + 0x22 * 0.72);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}
