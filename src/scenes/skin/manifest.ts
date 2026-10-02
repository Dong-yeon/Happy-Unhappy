// 스킨 매니페스트 (§5.23-1, §5.16-2): 의미 키 → 팩 파일·프레임. Phaser 의존 없음 (테스트가 키만 검사).
// 팩(무료판, 비상업·크레딧)은 저장소에 넣지 않는다: public/packs/<dir>/ 에 사용자가 직접 압축을 푼다 (§5.16-1, .gitignore).
// 팩 폴더 구조는 버전마다 달라 실제 파일을 열어 보고 PACK_ENTRIES를 채웠다 (2026-10-02, 무료판: Cute_Fantasy_Free · Sprout Lands Sprites/UI Basic pack).
// 폴더 이름은 public/packs/cute_fantasy · sprout_lands · sprout_ui 로 바꿔 둔다 (압축 안의 안쪽 폴더를 그대로).
// 맞는 그림이 없는 키는 억지로 고르지 않고 GENERATED(코드로 그린 그림 기호, "임시")를 쓴다.

export type PackId = 'cute_fantasy' | 'sprout_lands' | 'sprout_ui';

/** 팩 정보 (크레딧·로드 경로). 로드된 팩만 크레딧에 표시 (§5.16-6) */
export const PACKS: Record<PackId, { name: string; author: string; url: string; dir: string }> = {
  cute_fantasy: { name: 'Cute Fantasy RPG', author: 'Kenmi', url: 'kenmi-art.itch.io', dir: 'packs/cute_fantasy' },
  sprout_lands: { name: 'Sprout Lands – Asset Pack', author: 'Cup Nooble', url: 'cupnooble.itch.io', dir: 'packs/sprout_lands' },
  sprout_ui: { name: 'Sprout Lands – UI Pack', author: 'Cup Nooble', url: 'cupnooble.itch.io', dir: 'packs/sprout_ui' },
};

/**
 * 팩 그림 한 장. 시트면 frameW·frameH·frame(이미지 크기 ÷ 프레임 크기로 검증, tests/skin.test.ts).
 * rect = 시트에서 그림이 실제로 차 있는 칸 [x, y, w, h] (프레임의 투명 여백을 뺀 것 — 크기 맞춤을 그림 높이로 하려고).
 * scale = 정수 배율 (없으면 요청 크기 ÷ 그림 높이 내림, 최소 1). slice = 9칸 늘이기 모서리 px (버튼·패널).
 */
export interface PackEntry {
  pack: PackId;
  /** pack dir 기준 상대 경로 */
  file: string;
  /** 원본 이미지 크기 (검증용) */
  size: [number, number];
  frameW?: number;
  frameH?: number;
  frame?: number;
  rect?: [number, number, number, number];
  /** 화면 쪽 색(체인 색·적 색)을 tint로 입힘 — 색 값은 데이터·View에서 (매니페스트에 색 숫자를 두지 않는다) */
  tintByView?: boolean;
  scale?: number;
  slice?: number;
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

const CF = 'cute_fantasy' as const;
const SL = 'sprout_lands' as const;
const SU = 'sprout_ui' as const;

/**
 * 팩 그림 (실제 파일을 열어 보고 채움). 여기 없는 키 = 맞는 그림이 없어 GENERATED(직접 그린 그림 기호) 그대로.
 * 비워 둔 키: hero.haetae(갑옷 캐릭터 없음)·hero.nui(여자아이 캐릭터 없음), enemy.wildcat·mitten·boss(고양이·장갑·큰 적 없음),
 *            piece.*·piece.wildcard(뼈·방울·떡·밧줄 아이콘 없음), ui.storybook·seed·well(원래 직접 그림).
 */
export const PACK_ENTRIES: Partial<Record<string, PackEntry>> = {
  // 영웅: 서양풍 캐릭터 2종뿐 → 둘 다 임시
  'hero.orabi': { pack: CF, file: 'Player/Player.png', size: [192, 320], frameW: 32, frameH: 32, frame: 0, rect: [9, 5, 13, 20], temp: true }, // 소년
  'hero.sapsal': { pack: SL, file: 'Characters/Basic Charakter Spritesheet.png', size: [192, 192], frameW: 48, frameH: 48, frame: 0, rect: [17, 16, 14, 16], temp: true }, // 귀 달린 모자 아이 (털모자 아이 느낌)
  // 적: 줄무늬 그림자 = 흰 해골(갈비뼈 = 줄무늬)에 그림자 보라 tint (임시). 초록 슬라임은 tint를 받으면 검게 뭉개져 안 씀
  'enemy.shadow': { pack: CF, file: 'Enemies/Skeleton.png', size: [192, 320], frameW: 32, frameH: 32, frame: 0, rect: [10, 5, 13, 20], tintByView: true, temp: true },
  // 병사: 작은 팩 동물 + 체인 색 (임시, §5.23-1 "작은 팩 캐릭터 + 체인 색")
  'soldier.bone': { pack: CF, file: 'Animals/Chicken/Chicken.png', size: [64, 64], frameW: 32, frameH: 32, frame: 0, rect: [10, 10, 13, 14], tintByView: true, temp: true },
  'soldier.bell': { pack: CF, file: 'Animals/Sheep/Sheep.png', size: [64, 64], frameW: 32, frameH: 32, frame: 0, rect: [5, 8, 19, 16], tintByView: true, temp: true },
  'soldier.companion_animal': { pack: CF, file: 'Animals/Pig/Pig.png', size: [64, 64], frameW: 32, frameH: 32, frame: 0, rect: [5, 9, 21, 15], tintByView: true, temp: true },
  'soldier.comfort_object': { pack: CF, file: 'Animals/Cow/Cow.png', size: [64, 64], frameW: 32, frameH: 32, frame: 0, rect: [5, 6, 24, 21], tintByView: true, temp: true },
  // 땅: 낮 고갯길 = 흙길 타일(장면 tint), 밤 앞마당 = 풀 타일(남색 tint)
  'bg.day': { pack: CF, file: 'Tiles/Path_Middle.png', size: [16, 16], scale: 1 },
  'bg.night': { pack: SL, file: 'Tilesets/Grass.png', size: [176, 112], frameW: 16, frameH: 16, frame: 56, rect: [16, 80, 16, 16], scale: 1 },
  // UI: Sprout Lands UI 네모 버튼 (9칸 늘이기, 색은 tint)
  'ui.button': { pack: SU, file: 'Sprite sheets/buttons/Square Buttons 26x26.png', size: [96, 192], frameW: 48, frameH: 48, frame: 2, rect: [11, 59, 26, 28], slice: 7 },
  'ui.panel': { pack: SU, file: 'Sprite sheets/buttons/Square Buttons 26x26.png', size: [96, 192], frameW: 48, frameH: 48, frame: 3, rect: [59, 59, 26, 26], slice: 7 },
};

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
