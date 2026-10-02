// 레인 우리 편 표시 (§5.17-9, [11]-5, 도형만): 영웅 = 초상 원 + 이름 첫 글자 + hp 바 + 기세 표시 /
// 병사 = 영웅보다 작은 사각형 + 체인 색 + 단 + 얇은 수명 바. 적 = 종류별 색·크기 원 + hp 바 (§5.19-5). 두 레인 뷰가 같이 쓴다.
import Phaser from 'phaser';
import type { GameState, Role } from '../core/game';
import type { Unit } from '../core/lane';
import type { GameData } from '../data/types';
import { COLOR, text } from './ui';

const HERO_R = 11;
const SOLDIER = 10;
const HP_W = 22;
const S_HP_W = 12;

export interface UnitView {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Shape;
  hp: Phaser.GameObjects.Rectangle;
  hpW: number;
  /** 병사 수명 바 */
  life: Phaser.GameObjects.Rectangle | null;
  /** 영웅 기세 표시 */
  momentum: Phaser.GameObjects.Text | null;
  color: number;
}

/** 영웅 초상 색: 낮덱 = 해, 밤덱 = 달 */
export function heroColor(role: Role): number {
  return role === 'offense' ? COLOR.happy : COLOR.unhappy;
}

export function heroName(data: GameData, id: string): string {
  return data.heroes.heroes.find((h) => h.id === id)?.name ?? id;
}

export function makeUnitView(scene: Phaser.Scene, data: GameData, u: Unit, role: Role): UnitView {
  if (u.role === 'hero') {
    const color = heroColor(role);
    const body = scene.add.circle(0, 0, HERO_R, color).setStrokeStyle(2, 0x1b1d24);
    const label = text(scene, 0, 0, heroName(data, u.chain).slice(0, 1), { fontSize: '11px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    const bg = scene.add.rectangle(-HP_W / 2, HERO_R + 4, HP_W, 3, 0x1b1d24).setOrigin(0, 0.5);
    const hp = scene.add.rectangle(-HP_W / 2, HERO_R + 4, HP_W, 3, 0x7ed67e).setOrigin(0, 0.5);
    const momentum = text(scene, 0, -HERO_R - 7, '', { fontSize: '8px', color: '#ffb46b', fontStyle: 'bold' }).setOrigin(0.5);
    const container = scene.add.container(0, 0, [body, label, bg, hp, momentum]);
    return { container, body, hp, hpW: HP_W, life: null, momentum, color };
  }
  const color = parseInt((data.chains.find((c) => c.archetypeId === u.chain)?.color ?? '#999999').slice(1), 16);
  const body = scene.add.rectangle(0, 0, SOLDIER, SOLDIER, color).setStrokeStyle(1, u.soldier === 'shield' ? 0xf5f2e8 : 0x1b1d24);
  const label = text(scene, 0, 0, String(u.tier), { fontSize: '7px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
  const bg = scene.add.rectangle(-S_HP_W / 2, SOLDIER / 2 + 2, S_HP_W, 2, 0x1b1d24).setOrigin(0, 0.5);
  const hp = scene.add.rectangle(-S_HP_W / 2, SOLDIER / 2 + 2, S_HP_W, 2, 0x7ed67e).setOrigin(0, 0.5);
  const life = scene.add.rectangle(-S_HP_W / 2, SOLDIER / 2 + 4, S_HP_W, 1, 0xe6e9f5).setOrigin(0, 0.5);
  const container = scene.add.container(0, 0, [body, label, bg, hp, life]);
  return { container, body, hp, hpW: S_HP_W, life, momentum: null, color };
}

/** 매 프레임: hp·수명·기세 */
export function syncUnitView(v: UnitView, u: Unit, state: GameState, role: Role): void {
  v.hp.width = v.hpW * Math.max(0, Math.min(1, u.hp / u.maxHp));
  if (v.life && u.life !== undefined && u.lifeMax) v.life.width = v.hpW * Math.max(0, Math.min(1, u.life / u.lifeMax));
  if (v.momentum) {
    const m = state.heroes[role].momentum;
    const t = m.stacks > 0 ? `기세 ${m.stacks}` : '';
    if (v.momentum.text !== t) v.momentum.setText(t);
  }
}

/** 타격: 맞은 쪽 흰색 깜빡임 */
export function flashUnit(scene: Phaser.Scene, v: UnitView, ms: number): void {
  v.body.setFillStyle(0xffffff);
  scene.time.delayedCall(ms, () => v.body.active && v.body.setFillStyle(v.color));
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
  body: Phaser.GameObjects.Shape;
  bar: Phaser.GameObjects.Rectangle;
  color: number;
}

/** 적 표시. boss: 보스 웨이브 적 (테두리 굵게·붉게) */
export function makeEnemyView(scene: Phaser.Scene, type: string, boss: boolean): EnemyView {
  const look = ENEMY_LOOK[type] ?? ENEMY_LOOK.shadow;
  const r = look.r + (boss ? 2 : 0);
  const body = scene.add.circle(0, 0, r, look.color).setStrokeStyle(boss ? 2 : 1, boss ? 0xff9e9e : 0x3b2d4a);
  const face = text(scene, 0, 0, look.face, { fontSize: r >= 11 ? '11px' : '9px', color: '#2a1f35', fontStyle: 'bold' }).setOrigin(0.5);
  const bg = scene.add.rectangle(-ENEMY_HP_W / 2, -r - 4, ENEMY_HP_W, 3, 0x1b1d24).setOrigin(0, 0.5);
  const bar = scene.add.rectangle(-ENEMY_HP_W / 2, -r - 4, ENEMY_HP_W, 3, 0x7ed67e).setOrigin(0, 0.5);
  const container = scene.add.container(0, 0, [body, face, bg, bar]);
  return { container, body, bar, color: look.color };
}

export function syncEnemyView(v: EnemyView, hp: number, maxHp: number, slowed: boolean): void {
  v.bar.width = ENEMY_HP_W * Math.max(0, Math.min(1, hp / maxHp));
  v.container.setAlpha(slowed ? 0.7 : 1);
}

export function enemyColor(type: string): number {
  return (ENEMY_LOOK[type] ?? ENEMY_LOOK.shadow).color;
}

/** 본거지 "날아다니는 이야기책" (D-056, 도형): 펼친 책 두 쪽 + 가운데 접힘 */
export function storyBook(scene: Phaser.Scene, x: number, y: number): Phaser.GameObjects.Container {
  const left = scene.add.rectangle(-5, 0, 10, 13, 0xf5ecd2).setStrokeStyle(1, 0x8a5a3a);
  const right = scene.add.rectangle(5, 0, 10, 13, 0xf5ecd2).setStrokeStyle(1, 0x8a5a3a);
  const spine = scene.add.rectangle(0, 0, 2, 15, 0x8a5a3a);
  const line1 = scene.add.rectangle(-5, -2, 6, 1, 0xb9a882);
  const line2 = scene.add.rectangle(5, -2, 6, 1, 0xb9a882);
  return scene.add.container(x, y, [left, right, spine, line1, line2]);
}
