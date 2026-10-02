// 스킨 매니페스트 (§5.23-1, §5.16-2): 의미 키 → 팩 파일·프레임. Phaser 의존 없음 (테스트가 키만 검사).
// 팩(무료판, 비상업·크레딧)은 저장소에 넣지 않는다: public/packs/<dir>/ 에 사용자가 직접 압축을 푼다 (§5.16-1, .gitignore).
// 팩 폴더 구조는 버전마다 달라 실제 파일을 열어 보고 PACK_ENTRIES를 채운다. 2026-10-02 현재 이 기기에 팩이 없어 비어 있다 → 모든 키가 도형/직접 그림.
// 맞는 그림이 없는 키는 억지로 고르지 않고 GENERATED(코드로 그린 그림 기호, "임시")를 쓴다.

export type PackId = 'cute_fantasy' | 'sprout_lands' | 'sprout_ui';

/** 팩 정보 (크레딧·로드 경로). 로드된 팩만 크레딧에 표시 (§5.16-6) */
export const PACKS: Record<PackId, { name: string; author: string; url: string; dir: string }> = {
  cute_fantasy: { name: 'Cute Fantasy RPG', author: 'Kenmi', url: 'kenmi-art.itch.io', dir: 'packs/cute_fantasy' },
  sprout_lands: { name: 'Sprout Lands – Asset Pack', author: 'Cup Nooble', url: 'cupnooble.itch.io', dir: 'packs/sprout_lands' },
  sprout_ui: { name: 'Sprout Lands – UI Pack', author: 'Cup Nooble', url: 'cupnooble.itch.io', dir: 'packs/sprout_ui' },
};

/** 팩 그림 한 장: 시트면 frameW·frameH·frame. scale = 정수 배율 (픽셀 아트, NEAREST) */
export interface PackEntry {
  pack: PackId;
  /** pack dir 기준 상대 경로 */
  file: string;
  frameW?: number;
  frameH?: number;
  frame?: number;
  tint?: number;
  scale?: number;
  /** 맞는 그림이 아니라 임시로 고름 */
  temp?: boolean;
}

export const CHAINS = ['bone', 'bell', 'companion_animal', 'comfort_object'] as const;
export const HEROES = ['sapsal', 'haetae', 'nui', 'orabi'] as const;
export const ENEMIES = ['shadow', 'wildcat', 'mitten', 'boss'] as const;

/** 의미 키 전부 (§5.23-1 표) */
export const SKIN_KEYS: readonly string[] = [
  ...HEROES.map((h) => `hero.${h}`),
  ...ENEMIES.map((e) => `enemy.${e}`),
  ...CHAINS.map((c) => `soldier.${c}`),
  ...CHAINS.flatMap((c) => [1, 2, 3, 4, 5].map((t) => `piece.${c}.t${t}`)),
  'piece.wildcard',
  'ui.storybook',
  'ui.seed',
  'ui.well',
  'bg.day',
  'bg.night',
  'ui.button',
  'ui.panel',
];

/**
 * 팩 그림 (팩을 열어 보고 채운다). 예:
 *   'enemy.shadow': { pack: 'cute_fantasy', file: 'Enemies/Slime/Slime.png', frameW: 32, frameH: 32, frame: 0, scale: 1, temp: true },
 * 지금은 팩이 없어 비어 있다.
 */
export const PACK_ENTRIES: Partial<Record<string, PackEntry>> = {};

/**
 * 코드로 그린 그림 (generated.ts). ui.storybook·ui.seed·ui.well은 원래 직접 그리는 것(§5.23-1),
 * 나머지는 팩에 맞는 그림이 없을 때의 "임시" 그림 기호 (도형 + 기호).
 * ui.button·ui.panel은 직접 그리지 않는다 (팩이 없으면 지금 도형 버튼 그대로).
 */
export const GENERATED: ReadonlySet<string> = new Set(SKIN_KEYS.filter((k) => k !== 'ui.button' && k !== 'ui.panel'));

/** 의미 키 → Phaser 텍스처 키 */
export function textureKey(key: string): string {
  return `skin:${key}`;
}
