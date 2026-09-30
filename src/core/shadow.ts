// 그림자·마음 날씨 (스펙 §4.3.2, §4.4). Phaser 의존 없음. 경계 수치는 balance.shadow.weatherThresholds.

export type Weather = '맑음' | '흐림' | '비' | '폭우';
const WEATHERS: Weather[] = ['맑음', '흐림', '비', '폭우'];

/** thresholds = [흐림, 비, 폭우] 시작값. 그 미만은 맑음 */
export function weatherOf(shadow: number, thresholds: readonly [number, number, number]): Weather {
  let i = 0;
  while (i < thresholds.length && shadow >= thresholds[i]) i++;
  return WEATHERS[i];
}

export function clampShadow(v: number, max: number): number {
  return Math.max(0, Math.min(max, v));
}
