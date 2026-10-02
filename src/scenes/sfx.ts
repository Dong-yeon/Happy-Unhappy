// 손맛 효과음·진동 자리 (D-073, §5.24-4). 파일은 나중 — 지금은 음 높이만 정하고 재생하지 않는다.
// 진동은 navigator.vibrate가 있을 때만 (iOS Safari 등은 없음).

/** 머지 효과음 음 높이 배율: 단계가 오를수록 ↑ (1단계 결과 = 1.0, 단계마다 반음 둘) */
export function mergePitch(tier: number): number {
  return Math.pow(2, (Math.max(1, tier) - 1) * (2 / 12));
}

/** 머지 손맛: 효과음(자리만) + 짧은 진동 */
export function mergeFeel(tier: number): void {
  void mergePitch(tier); // TODO(효과음 파일): 이 배율로 재생
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { vibrate?: (ms: number) => boolean }) : undefined;
  nav?.vibrate?.(15);
}
