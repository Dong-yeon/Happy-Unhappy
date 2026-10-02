// 레인 우리 편 표시 (§5.17-9, [11]-5, §5.20, 도형만): 영웅 = 체인 색 초상 원 + 이름 첫 글자 + hp 바 + 기세 표시
//   (원거리는 테두리 금색 + 작은 점, 보호막이 있으면 흰 고리) /
// 병사 = 영웅보다 작은 사각형 + 체인 색 + 단 + 얇은 수명 바. 적 = 종류별 색·크기 원 + hp 바 (§5.19-5). 두 레인 뷰가 같이 쓴다.
// §5.23-1: 스킨에 hero.<id>·soldier.<chain>·enemy.<type>·ui.storybook이 있으면 그림, 없으면 이 도형 그대로.
import Phaser from 'phaser';
import type { GameState, Role } from '../core/game';
import type { Unit } from '../core/lane';
import type { GameData } from '../data/types';
import { BOSS_HP, BOSS_POP, ENEMY_BASE_SIZE, HERO_PIC_SIZE, SOLDIER_PIC_SIZE } from './layout';
import { skinOf } from './skin/Skin';
import { COLOR, text } from './ui';

const HERO_R = 11;
const SOLDIER = 10;
const HP_W = 22;
const S_HP_W = 12;

export interface UnitView {
  container: Phaser.GameObjects.Container;
  body: Body;
  hp: Phaser.GameObjects.Rectangle;
  hpW: number;
  /** 병사 수명 바 */
  life: Phaser.GameObjects.Rectangle | null;
  /** 영웅 기세 표시 */
  momentum: Phaser.GameObjects.Text | null;
  /** 보호막 고리 */
  shield: Phaser.GameObjects.Arc | null;
  color: number;
}

/** 도형 또는 스킨 그림 */
export type Body = Phaser.GameObjects.Shape | Phaser.GameObjects.Image;

/** 타격 깜빡임: 도형은 흰색 채움, 그림은 흰색 tint */
export function flashBody(scene: Phaser.Scene, body: Body, color: number, ms: number): void {
  if (body instanceof Phaser.GameObjects.Image) {
    body.setTintFill(0xffffff);
    // 원래 tint(체인 색·적 색)가 있으면 그 색으로 되돌린다
    const base = body.getData('tint') as number | undefined;
    scene.time.delayedCall(ms, () => body.active && (base === undefined ? body.clearTint() : body.setTint(base)));
    return;
  }
  body.setFillStyle(0xffffff);
  scene.time.delayedCall(ms, () => body.active && body.setFillStyle(color));
}

/** 그림에 색 입히기 (타격 깜빡임 뒤 되돌릴 색으로도 기억) */
function tintBody(img: Phaser.GameObjects.Image, color: number): void {
  img.setTint(color).setData('tint', color);
}

/** 영웅 초상 색: 낮덱 = 해, 밤덱 = 달 (편성 카드 등 역할 표시용) */
export function heroColor(role: Role): number {
  return role === 'offense' ? COLOR.happy : COLOR.unhappy;
}

/** 영웅 자기 체인 색 (§5.20-1) */
export function heroChainColor(data: GameData, id: string): number {
  const chain = data.heroes.heroes.find((h) => h.id === id)?.chain;
  return parseInt((data.chains.find((c) => c.archetypeId === chain)?.color ?? '#cccccc').slice(1), 16);
}

export function heroName(data: GameData, id: string): string {
  return data.heroes.heroes.find((h) => h.id === id)?.name ?? id;
}

export function makeUnitView(scene: Phaser.Scene, data: GameData, u: Unit, role: Role): UnitView {
  if (u.role === 'hero') {
    void role;
    const color = heroChainColor(data, u.chain);
    const ranged = u.attackType === 'ranged';
    const skin = skinOf(scene);
    const pic = skin.has(`hero.${u.chain}`);
    // 그림이면 병사보다 확실히 크게 (HERO_PIC_SIZE, 팩은 정수 배율 반올림)
    const body: Body = pic ? skin.image(scene, `hero.${u.chain}`, 0, 0, HERO_PIC_SIZE, true) : scene.add.circle(0, 0, HERO_R, color).setStrokeStyle(2, ranged ? 0xf2c94c : 0x1b1d24);
    const half = body instanceof Phaser.GameObjects.Image ? body.displayHeight / 2 : HERO_R;
    const label = text(scene, 0, 0, pic ? '' : heroName(data, u.chain).slice(0, 1), { fontSize: '11px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    const bg = scene.add.rectangle(-HP_W / 2, half + 4, HP_W, 3, 0x1b1d24).setOrigin(0, 0.5);
    const hp = scene.add.rectangle(-HP_W / 2, half + 4, HP_W, 3, 0x7ed67e).setOrigin(0, 0.5);
    const momentum = text(scene, 0, -half - 7, '', { fontSize: '8px', color: '#ffb46b', fontStyle: 'bold' }).setOrigin(0.5);
    const shield = scene.add.circle(0, 0, half + 3).setStrokeStyle(2, 0xffffff, 0.8).setVisible(false);
    const parts: Phaser.GameObjects.GameObject[] = [shield, body, label, bg, hp, momentum];
    // 그림 영웅: 발밑 그림자 + 체인 색 테두리 (병사와 구분). 도형 영웅은 원 자체가 체인 색이라 그대로
    if (pic) parts.unshift(scene.add.ellipse(0, half - 2, half * 1.5, 8, 0x000000, 0.35).setStrokeStyle(2, color));
    if (ranged) parts.push(scene.add.circle(HERO_R - 2, -HERO_R + 2, 2.5, 0xf2c94c));
    const container = scene.add.container(0, 0, parts);
    return { container, body, hp, hpW: HP_W, life: null, momentum, shield, color };
  }
  const color = parseInt((data.chains.find((c) => c.archetypeId === u.chain)?.color ?? '#999999').slice(1), 16);
  const skin = skinOf(scene);
  const pic = skin.has(`soldier.${u.chain}`);
  const body: Body = pic
    ? skin.image(scene, `soldier.${u.chain}`, 0, 0, SOLDIER_PIC_SIZE) // 영웅 그림의 0.75배 이하 (팩은 정수 배율 내림)
    : scene.add.rectangle(0, 0, SOLDIER, SOLDIER, color).setStrokeStyle(1, u.soldier === 'shield' ? 0xf5f2e8 : 0x1b1d24);
  const sHalf = body instanceof Phaser.GameObjects.Image ? body.displayHeight / 2 : SOLDIER / 2;
  if (pic && skin.tintByView(`soldier.${u.chain}`)) tintBody(body as Phaser.GameObjects.Image, color); // 팩 동물 + 체인 색
  // 단 숫자는 그림 위에도 작게 남긴다 (§5.16-2)
  // 단 숫자: 그림이면 오른쪽 아래 작은 배지 (영웅은 위 층에 그려져 가려지지 않는다 — 레인 뷰의 heroLayer)
  const label = text(scene, pic ? sHalf - 1 : 0, pic ? sHalf - 3 : 0, String(u.tier), { fontSize: '7px', color: pic ? '#ffffff' : '#1b1d24', fontStyle: 'bold', ...(pic ? { stroke: '#1b1d24', strokeThickness: 2 } : {}) }).setOrigin(0.5);
  const bg = scene.add.rectangle(-S_HP_W / 2, sHalf + 2, S_HP_W, 2, 0x1b1d24).setOrigin(0, 0.5);
  const hp = scene.add.rectangle(-S_HP_W / 2, sHalf + 2, S_HP_W, 2, 0x7ed67e).setOrigin(0, 0.5);
  const life = scene.add.rectangle(-S_HP_W / 2, sHalf + 4, S_HP_W, 1, 0xe6e9f5).setOrigin(0, 0.5);
  const container = scene.add.container(0, 0, [body, label, bg, hp, life]);
  return { container, body, hp, hpW: S_HP_W, life, momentum: null, shield: null, color };
}

/** 매 프레임: hp·수명·기세 */
export function syncUnitView(v: UnitView, u: Unit, state: GameState, role: Role): void {
  v.hp.width = v.hpW * Math.max(0, Math.min(1, u.hp / u.maxHp));
  if (v.life && u.life !== undefined && u.lifeMax) v.life.width = v.hpW * Math.max(0, Math.min(1, u.life / u.lifeMax));
  v.shield?.setVisible(u.shield > 0.5);
  if (v.momentum) {
    const m = state.momentum[role];
    const t = m.stacks > 0 ? `기세 ${m.stacks}` : '';
    if (v.momentum.text !== t) v.momentum.setText(t);
  }
}

/** 타격: 맞은 쪽 흰색 깜빡임 */
export function flashUnit(scene: Phaser.Scene, v: UnitView, ms: number): void {
  flashBody(scene, v.body, v.color, ms);
}

// ── 적 (§5.19-5): 줄무늬 그림자 = 보라 / 덤불 살쾡이 = 주황, 작음 / 털장갑 손 = 갈색, 큼 / 보스 = 붉음 ──
const ENEMY_LOOK: Record<string, { color: number; r: number; face: string }> = {
  shadow: { color: 0x9b7fb8, r: 8, face: '~' },
  wildcat: { color: 0xd08a4a, r: 7, face: '^' },
  mitten: { color: 0x8a6a52, r: 11, face: 'w' },
  boss: { color: 0xc0506a, r: 13, face: '!' },
};
const ENEMY_HP_W = 16;

export interface EnemyView {
  container: Phaser.GameObjects.Container;
  body: Body;
  bar: Phaser.GameObjects.Rectangle;
  /** HP 막대 가득 찬 폭 */
  hpW: number;
  color: number;
}

/**
 * 적 표시. boss: 보스 웨이브 적 (테두리 굵게·붉게).
 * scale: 보스·guardian 표시 배율 (layout.bossScale, 일반 적 크기 기준) — 있으면 크게 + 몸 위 굵은 HP 막대 + 등장 때 커지는 연출. 표시만 (판정 불변).
 */
export function makeEnemyView(scene: Phaser.Scene, type: string, boss: boolean, scale?: number): EnemyView {
  const look = ENEMY_LOOK[type] ?? ENEMY_LOOK.shadow;
  const big = scale !== undefined;
  const r = big ? ENEMY_LOOK.shadow.r * scale : look.r + (boss ? 2 : 0);
  const skin = skinOf(scene);
  const key = `enemy.${type}`;
  const pic = skin.has(key);
  const body: Body = pic
    ? skin.image(scene, key, 0, 0, big ? ENEMY_BASE_SIZE * scale : r * 2 + 4, big)
    : scene.add.circle(0, 0, r, look.color).setStrokeStyle(boss ? 2 : big ? 2 : 1, boss ? 0xff9e9e : 0x3b2d4a);
  if (pic && skin.tintByView(key)) tintBody(body as Phaser.GameObjects.Image, look.color); // 팩 그림 + 적 색
  if (pic && boss) tintBody(body as Phaser.GameObjects.Image, 0xffc0c0); // 보스 웨이브 적: 붉은 기
  const face = text(scene, 0, 0, pic ? '' : look.face, { fontSize: big ? `${Math.round(r)}px` : r >= 11 ? '11px' : '9px', color: '#2a1f35', fontStyle: 'bold' }).setOrigin(0.5);
  const half = body instanceof Phaser.GameObjects.Image ? body.displayHeight / 2 : r;
  const hpW = big ? BOSS_HP.w : ENEMY_HP_W;
  const hpH = big ? BOSS_HP.h : 3;
  const hpY = big ? -half - BOSS_HP.gap - hpH / 2 : -r - 4;
  const bg = scene.add.rectangle(-hpW / 2, hpY, hpW, hpH, 0x1b1d24).setOrigin(0, 0.5);
  if (big) bg.setStrokeStyle(1, 0x000000);
  const bar = scene.add.rectangle(-hpW / 2, hpY, hpW, hpH, big ? 0xff7a7a : 0x7ed67e).setOrigin(0, 0.5);
  const container = scene.add.container(0, 0, [body, face, bg, bar]);
  if (big) popIn(scene, container);
  return { container, body, bar, hpW, color: look.color };
}

/** 보스 등장: 0.6배 → 1배 (0.3초) */
export function popIn(scene: Phaser.Scene, obj: Phaser.GameObjects.Container): void {
  obj.setScale(BOSS_POP.from);
  scene.tweens.add({ targets: obj, scale: 1, duration: BOSS_POP.ms, ease: 'Back.easeOut' });
}

export function syncEnemyView(v: EnemyView, hp: number, maxHp: number, slowed: boolean): void {
  v.bar.width = v.hpW * Math.max(0, Math.min(1, hp / maxHp));
  v.container.setAlpha(slowed ? 0.7 : 1);
}

export function enemyColor(type: string): number {
  return (ENEMY_LOOK[type] ?? ENEMY_LOOK.shadow).color;
}

/** 본거지 "날아다니는 이야기책" (D-056, 도형): 펼친 책 두 쪽 + 가운데 접힘 */
export function storyBook(scene: Phaser.Scene, x: number, y: number): Phaser.GameObjects.Container {
  const skin = skinOf(scene);
  if (skin.has('ui.storybook')) return scene.add.container(x, y, [skin.image(scene, 'ui.storybook', 0, 0, 18)]);
  const left = scene.add.rectangle(-5, 0, 10, 13, 0xf5ecd2).setStrokeStyle(1, 0x8a5a3a);
  const right = scene.add.rectangle(5, 0, 10, 13, 0xf5ecd2).setStrokeStyle(1, 0x8a5a3a);
  const spine = scene.add.rectangle(0, 0, 2, 15, 0x8a5a3a);
  const line1 = scene.add.rectangle(-5, -2, 6, 1, 0xb9a882);
  const line2 = scene.add.rectangle(5, -2, 6, 1, 0xb9a882);
  return scene.add.container(x, y, [left, right, spine, line1, line2]);
}
