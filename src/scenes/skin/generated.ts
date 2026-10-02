// 코드로 그린 스킨 그림 (§5.23-1): ui.storybook·ui.seed·ui.well은 직접 그림, 나머지는 팩에 맞는 그림이 없을 때의 "임시" 그림 기호.
// 도형 + 기호 수준 (얼굴·과한 반짝임 없음, §5.16-3 원칙). RENDER_SCALE 배로 그려 화면에서는 논리 크기로 줄여 쓴다.
import Phaser from 'phaser';
import type { GameData } from '../../data/types';
import { RENDER_SCALE, WELL } from '../layout';
import { CHAINS, ENEMIES, HEROES, textureKey } from './manifest';

const K = RENDER_SCALE;

/** 논리 크기(px) — 화면에서 이 크기로 그린다 */
export const GEN_SIZE: Record<string, { w: number; h: number }> = {
  piece: { w: 44, h: 44 },
  hero: { w: 26, h: 26 },
  enemy: { w: 26, h: 26 },
  soldier: { w: 14, h: 14 },
  'ui.storybook': { w: 24, h: 18 },
  'ui.seed': { w: 14, h: 14 },
  bg: { w: 64, h: 64 },
};

export function genSize(key: string): { w: number; h: number } {
  return GEN_SIZE[key] ?? GEN_SIZE[key.split('.')[0]] ?? { w: 32, h: 32 };
}

const hex = (c: string) => parseInt(c.slice(1), 16);

function make(scene: Phaser.Scene, key: string, w: number, h: number, draw: (g: Phaser.GameObjects.Graphics) => void): void {
  const tk = textureKey(key);
  if (scene.textures.exists(tk)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.setScale(K);
  draw(g);
  g.generateTexture(tk, Math.ceil(w * K), Math.ceil(h * K));
  g.destroy();
}

/** 체인 그림 기호 (가운데 기준, 크기 s): 뼈다귀 / 방울 / 떡 / 동아줄 */
function chainGlyph(g: Phaser.GameObjects.Graphics, chain: string, cx: number, cy: number, s: number, ink: number): void {
  g.fillStyle(ink, 1);
  g.lineStyle(Math.max(1, s * 0.12), ink, 1);
  switch (chain) {
    case 'bone': {
      const w = s * 0.9;
      g.fillRect(cx - w / 2, cy - s * 0.1, w, s * 0.2);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) g.fillCircle(cx + sx * w * 0.5, cy + sy * s * 0.14, s * 0.15);
      break;
    }
    case 'bell': {
      g.fillTriangle(cx - s * 0.38, cy + s * 0.25, cx + s * 0.38, cy + s * 0.25, cx, cy - s * 0.4);
      g.fillCircle(cx, cy - s * 0.12, s * 0.27);
      g.fillCircle(cx, cy + s * 0.34, s * 0.09);
      break;
    }
    case 'companion_animal': {
      // 떡: 둥근 덩이 두 개 포개기
      g.fillEllipse(cx, cy + s * 0.15, s * 0.9, s * 0.42);
      g.fillEllipse(cx, cy - s * 0.15, s * 0.66, s * 0.36);
      break;
    }
    case 'comfort_object': {
      // 동아줄: 감긴 고리 세 개
      g.fillStyle(0, 0);
      for (let i = 0; i < 3; i++) g.strokeCircle(cx - s * 0.25 + i * s * 0.25, cy, s * 0.2);
      break;
    }
    default:
      g.fillCircle(cx, cy, s * 0.3);
  }
}

/** 조각: 체인 색 원 + 체인 그림 기호, 단계가 오를수록 테두리 고리가 늘고 5단계는 금테 */
function drawPiece(g: Phaser.GameObjects.Graphics, color: number, chain: string, tier: number, s: number): void {
  const c = s / 2;
  const r = s / 2 - 2;
  g.fillStyle(color, 1).fillCircle(c, c, r);
  g.fillStyle(0xffffff, 0.22).fillCircle(c - r * 0.35, c - r * 0.4, r * 0.3);
  chainGlyph(g, chain, c, c - 2, r * 0.95, 0x2a2130);
  // 단계 고리: 1~4 = 작은 점 n개 아래쪽, 5 = 금테
  if (tier >= 5) {
    g.lineStyle(3, 0xffd36b, 1).strokeCircle(c, c, r - 1);
  } else {
    g.fillStyle(0x2a2130, 0.8);
    for (let i = 0; i < tier; i++) g.fillCircle(c - (tier - 1) * 3 + i * 6, c + r * 0.62, 2);
  }
  g.lineStyle(1, 0x1b1d24, 1).strokeCircle(c, c, r);
}

/** 영웅 초상 (임시): 체인 색 얼굴 원 + 머리 장식 기호 — 삽살 털모자 / 해태 투구·뿔 / 누이 쪽머리 / 오라비 상투 */
function drawHero(g: Phaser.GameObjects.Graphics, id: string, color: number, s: number): void {
  const c = s / 2;
  const r = s / 2 - 1.5;
  g.fillStyle(color, 1).fillCircle(c, c + 1, r * 0.92);
  g.fillStyle(0xf3dcc0, 1).fillCircle(c, c + 3, r * 0.55); // 얼굴
  g.fillStyle(0x3b2d22, 1);
  switch (id) {
    case 'sapsal':
      g.fillStyle(0x8a6a4a, 1).fillEllipse(c, c - r * 0.35, r * 1.5, r * 0.75); // 털모자
      g.fillStyle(0xd8c6a0, 1).fillCircle(c, c - r * 0.75, r * 0.2);
      break;
    case 'haetae':
      g.fillStyle(0x8a94a8, 1).fillRect(c - r * 0.7, c - r * 0.6, r * 1.4, r * 0.45); // 투구
      g.fillStyle(0xd8dde8, 1).fillTriangle(c - 2, c - r * 0.6, c + 2, c - r * 0.6, c, c - r * 1.05); // 뿔
      break;
    case 'nui':
      g.fillCircle(c - r * 0.55, c - r * 0.45, r * 0.25).fillCircle(c + r * 0.55, c - r * 0.45, r * 0.25); // 쪽머리
      g.fillEllipse(c, c - r * 0.35, r * 1.1, r * 0.45);
      break;
    case 'orabi':
      g.fillEllipse(c, c - r * 0.3, r * 1.1, r * 0.4);
      g.fillCircle(c, c - r * 0.75, r * 0.2); // 상투
      break;
    default:
      g.fillEllipse(c, c - r * 0.3, r * 1.1, r * 0.4);
  }
  g.lineStyle(1, 0x1b1d24, 1).strokeCircle(c, c + 1, r * 0.92);
}

/** 적 (임시): 그림자 = 줄무늬 얼룩 / 살쾡이 = 귀 달린 머리 / 털장갑 손 = 벙어리장갑 / 보스 = 큰 몸 + 호랑이 줄무늬 */
function drawEnemy(g: Phaser.GameObjects.Graphics, type: string, s: number): void {
  const c = s / 2;
  switch (type) {
    case 'shadow':
      g.fillStyle(0x6e5a8a, 1).fillEllipse(c, c + 2, s * 0.8, s * 0.6);
      g.fillStyle(0x4a3a62, 1);
      for (let i = -1; i <= 1; i++) g.fillRect(c + i * s * 0.2 - 1, c - s * 0.12, 2, s * 0.32);
      break;
    case 'wildcat':
      g.fillStyle(0xd08a4a, 1).fillCircle(c, c + 2, s * 0.32);
      g.fillTriangle(c - s * 0.3, c - s * 0.05, c - s * 0.12, c - s * 0.12, c - s * 0.28, c - s * 0.38);
      g.fillTriangle(c + s * 0.3, c - s * 0.05, c + s * 0.12, c - s * 0.12, c + s * 0.28, c - s * 0.38);
      g.fillStyle(0x5a3a1a, 1).fillRect(c - s * 0.15, c + 1, 2, 2).fillRect(c + s * 0.1, c + 1, 2, 2);
      break;
    case 'mitten':
      g.fillStyle(0x8a6a52, 1).fillRoundedRect(c - s * 0.3, c - s * 0.32, s * 0.5, s * 0.7, s * 0.2);
      g.fillEllipse(c + s * 0.25, c - s * 0.02, s * 0.22, s * 0.36); // 엄지
      g.fillStyle(0xd8c6a0, 1).fillRect(c - s * 0.3, c + s * 0.28, s * 0.5, s * 0.1); // 소매
      break;
    case 'boss':
    default:
      g.fillStyle(0xc07a3a, 1).fillEllipse(c, c, s * 0.92, s * 0.78);
      g.fillStyle(0x2a1a12, 1);
      for (let i = -2; i <= 2; i++) g.fillTriangle(c + i * s * 0.16 - 2, c - s * 0.36, c + i * s * 0.16 + 2, c - s * 0.36, c + i * s * 0.16, c);
      g.fillStyle(0xff9e9e, 1).fillCircle(c - s * 0.15, c + s * 0.05, 1.5).fillCircle(c + s * 0.15, c + s * 0.05, 1.5);
      break;
  }
}

/** 이야기책 (직접 그림): 펼친 두 쪽 + 가운데 접힘 + 글줄 */
function drawBook(g: Phaser.GameObjects.Graphics, w: number, h: number): void {
  g.fillStyle(0x6b4f2f, 1).fillRoundedRect(0, 1, w, h - 1, 2);
  g.fillStyle(0xf5ecd2, 1).fillRect(2, 2, w / 2 - 2.5, h - 4).fillRect(w / 2 + 0.5, 2, w / 2 - 2.5, h - 4);
  g.fillStyle(0x8a5a3a, 1).fillRect(w / 2 - 0.75, 1, 1.5, h - 2);
  g.fillStyle(0xb9a882, 1);
  for (let i = 0; i < 3; i++) {
    g.fillRect(4, 5 + i * 3.5, w / 2 - 7, 0.8);
    g.fillRect(w / 2 + 3, 5 + i * 3.5, w / 2 - 7, 0.8);
  }
}

/** 이야기 씨앗 (직접 그림): 빛나는 씨앗 모양 + 새싹 */
function drawSeed(g: Phaser.GameObjects.Graphics, s: number): void {
  const c = s / 2;
  g.fillStyle(0xffe08a, 0.3).fillCircle(c, c, s / 2);
  g.fillStyle(0xffe08a, 1).fillEllipse(c, c + 1.5, s * 0.5, s * 0.62);
  g.fillStyle(0x9fe0a0, 1).fillEllipse(c - 2, c - s * 0.3, s * 0.28, s * 0.14).fillEllipse(c + 2, c - s * 0.3, s * 0.28, s * 0.14);
  g.lineStyle(0.8, 0xffffff, 1).strokeEllipse(c, c + 1.5, s * 0.5, s * 0.62);
}

/** 우물 (직접 그림): 돌테 + 물빛 (WellView 도형과 같은 자리·크기) */
function drawWell(g: Phaser.GameObjects.Graphics): void {
  const w = WELL;
  const ox = w.rim;
  const oy = w.rim;
  g.fillStyle(0x5d5a52, 1).fillRoundedRect(0, 0, w.w + w.rim * 2, w.h + w.rim * 2, w.r + w.rim);
  // 돌 이음매
  g.lineStyle(1, 0x46443e, 1);
  for (let x = 18; x < w.w; x += 26) {
    g.lineBetween(ox + x, 0, ox + x, oy);
    g.lineBetween(ox + x + 13, oy + w.h, ox + x + 13, oy * 2 + w.h);
  }
  g.fillStyle(0x1f4e6b, 1).fillRoundedRect(ox, oy, w.w, w.h, w.r);
  g.fillStyle(0x2c6a8a, 0.55).fillRoundedRect(ox + 18, oy + 18, w.w - 36, w.h - 36, w.r - 14);
  g.fillStyle(0x3d86a8, 0.25).fillEllipse(ox + w.w / 2, oy + w.h / 2, w.w * 0.55, w.h * 0.45);
  g.lineStyle(1, 0x9fd8ff, 0.18);
  for (let i = 0; i < 4; i++) g.strokeEllipse(ox + w.w * (0.25 + i * 0.17), oy + w.h * (0.3 + (i % 2) * 0.35), 26, 6);
  g.lineStyle(2, 0x10324a, 0.9).strokeRoundedRect(ox, oy, w.w, w.h, w.r);
}

/** 땅 바탕 (임시): 풀밭 / 밤 마당 무늬 한 칸 (tileSprite로 깔고 장면 tint) */
function drawGround(g: Phaser.GameObjects.Graphics, night: boolean, s: number): void {
  g.fillStyle(night ? 0x1c2436 : 0x3b3526, 1).fillRect(0, 0, s, s);
  g.fillStyle(night ? 0x26304a : 0x4a4230, 1);
  for (let i = 0; i < 9; i++) {
    const x = (i * 23) % s;
    const y = (i * 37) % s;
    g.fillRect(x, y, night ? 2 : 3, night ? 2 : 1);
  }
}

/** 생성 그림 전부 (PreloadScene에서 한 번) */
export function drawGeneratedTextures(scene: Phaser.Scene, data: GameData): void {
  const chainColor = (c: string) => hex(data.chains.find((x) => x.archetypeId === c)?.color ?? '#cccccc');
  const ps = GEN_SIZE.piece.w;
  for (const c of CHAINS) for (let t = 1; t <= 5; t++) make(scene, `piece.${c}.t${t}`, ps, ps, (g) => drawPiece(g, chainColor(c), c, t, ps));
  make(scene, 'piece.wildcard', ps, ps, (g) => {
    const c = ps / 2;
    g.fillStyle(0xffffff, 1).fillCircle(c, c, c - 2);
    for (const [i, ch] of CHAINS.entries()) chainGlyph(g, ch, c + (i % 2 ? 8 : -8), c + (i < 2 ? -8 : 8), 10, chainColor(ch));
    g.lineStyle(1, 0x1b1d24, 1).strokeCircle(c, c, c - 2);
  });
  const hs = GEN_SIZE.hero.w;
  for (const h of HEROES) {
    const chain = data.heroes.heroes.find((x) => x.id === h)?.chain ?? 'bone';
    make(scene, `hero.${h}`, hs, hs, (g) => drawHero(g, h, chainColor(chain), hs));
  }
  const es = GEN_SIZE.enemy.w;
  for (const e of ENEMIES) make(scene, `enemy.${e}`, es, es, (g) => drawEnemy(g, e, es));
  const ss = GEN_SIZE.soldier.w;
  for (const c of CHAINS)
    make(scene, `soldier.${c}`, ss, ss, (g) => {
      g.fillStyle(chainColor(c), 1).fillRoundedRect(0.5, 0.5, ss - 1, ss - 1, 2);
      chainGlyph(g, c, ss / 2, ss / 2, ss * 0.7, 0x2a2130);
      g.lineStyle(1, 0x1b1d24, 1).strokeRoundedRect(0.5, 0.5, ss - 1, ss - 1, 2);
    });
  const b = GEN_SIZE['ui.storybook'];
  make(scene, 'ui.storybook', b.w, b.h, (g) => drawBook(g, b.w, b.h));
  const sd = GEN_SIZE['ui.seed'].w;
  make(scene, 'ui.seed', sd, sd, (g) => drawSeed(g, sd));
  make(scene, 'ui.well', WELL.w + WELL.rim * 2, WELL.h + WELL.rim * 2, (g) => drawWell(g));
  const gs = GEN_SIZE.bg.w;
  make(scene, 'bg.day', gs, gs, (g) => drawGround(g, false, gs));
  make(scene, 'bg.night', gs, gs, (g) => drawGround(g, true, gs));
}
