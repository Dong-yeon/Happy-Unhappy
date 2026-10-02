// 기기 로컬 날짜·시각 (metrics 기록용). v0.15에서 gating(하루 열림)이 없어져 디버그 날짜 오프셋도 없다 (D-054).

function localDate(d: Date): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 오늘 (기기 로컬 날짜, metrics realDate) */
export function realToday(): string {
  return localDate(new Date());
}
