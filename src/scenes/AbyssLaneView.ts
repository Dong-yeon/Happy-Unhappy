// 낮(오펜스)의 심연 레인 표시 (§4.3.2, §5.17-9·10): 가로 레인. 출발점은 왼쪽, 그림자 벽(층)은 오른쪽 끝.
// 우리 편 = 오펜스 영웅 + 전투 중 머지 병사. 층을 돌파해도 그대로 다음 층을 친다 (귀환 없음).
// 상태는 항상 core에서 읽고 layout.toScreen()으로 화면에 옮긴다. 이벤트는 연출(지급 조각, 타격, 소멸)에만 쓴다.
import Phaser from 'phaser';
import type { CoreEvent, GameState, Grant } from '../core/game';
import { isWildcard } from '../core/grid';
import type { Balance, GameData } from '../data/types';
import { isBossFloor } from '../core/lane';
import { CORE, HERO_SLOT, HOME, REGION, cellCenter, progressX, toScreen } from './layout';
import { flashUnit, makeUnitView, syncUnitView, type UnitView } from './laneUnits';
import { COLOR, text } from './ui';

const GRANT_MS = 450; // 지급 조각: 층 → 그리드 칸
const HIT_MS = 100;
/** 보스 층 벽 (§5.13-4) */
const BOSS_WALL = 0x3a1626;
const BOSS_EDGE = 0xd0607a;

export class AbyssLaneView {
  /** 낮 레인 전체 (밤에는 숨김) */
  readonly root: Phaser.GameObjects.Container;
  private readonly units = new Map<number, UnitView>();
  private readonly chainColor = new Map<string, number>();
  private readonly wallLabel: Phaser.GameObjects.Text;
  private readonly wallBar: Phaser.GameObjects.Rectangle;
  private readonly wallX: number;
  private readonly wallRect: Phaser.GameObjects.Rectangle;
  private bossShown = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    /** 보스 층 판정용 (balance.abyss) */
    private readonly abyssStats: Balance['abyss'],
    /** 벽 라벨 "1-3 셋째 고개" (§5.15-2) */
    private readonly stageName: (stage: number) => string,
  ) {
    for (const c of data.chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
    const g = REGION.ground;
    // 낮 땅 띠 (밝은 고갯길에 그림자 웅덩이, 도형 단계는 배경색만, §5.17-10)
    const bg = scene.add.rectangle(g.x, g.y, g.w, g.h, COLOR.defense).setOrigin(0);
    // 그림자 벽: 진행 축 끝(오른쪽) 세로 띠 + 남은 HP 막대(세로) + "1-3 셋째 고개 hp/max"
    this.wallX = progressX(CORE.wallY);
    this.wallRect = scene.add.rectangle(this.wallX, g.y, g.x + g.w - this.wallX, g.h, COLOR.wall).setOrigin(0);
    this.wallBar = scene.add.rectangle(this.wallX + 2, g.y + g.h, 3, g.h, COLOR.unhappy).setOrigin(0, 1);
    this.wallLabel = text(scene, this.wallX - 4, g.y + 4, '', { fontSize: '9px', color: '#8796c2' }).setOrigin(1, 0);
    const startX = progressX(CORE.lineY);
    const start = scene.add.line(0, 0, startX, g.y + 6, startX, g.y + g.h - 6, COLOR.portalUnhappy, 0.4).setOrigin(0).setLineWidth(1);
    const label = text(scene, g.x + g.w / 2, g.y + g.h - 4, '낮 · 오펜스 (그림자 정화) →', { fontSize: '9px', color: '#5d6a91' }).setOrigin(0.5, 1);
    const home = HOME.abyss;
    const mark = scene.add.circle(home.x, home.y, 6, COLOR.unhappy);
    this.root = scene.add.container(0, 0, [bg, this.wallRect, this.wallBar, this.wallLabel, start, label, mark]).setDepth(1);
  }

  setShown(shown: boolean): void {
    this.root.setVisible(shown);
  }

  /** core 이벤트 → 연출. sync() 전에 호출 */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type === 'abyssUnitDie') this.removeUnit(e.unitId);
      else if (e.type === 'counter') {
        const v = this.units.get(e.unitId);
        if (v) flashUnit(this.scene, v, HIT_MS);
      } else if (e.type === 'layerClear') for (const g of e.bonus) this.grantFlow(g);
      else if (e.type === 'bossFloorClear') for (const g of e.rewards) this.grantFlow(g);
    }
  }

  /** 표시를 core 상태에 맞춘다 (매 프레임) */
  sync(): void {
    const s = this.state;
    const w = s.abyss.wall;
    // 보스 층 (§5.13-4): 붉은 벽 + 굵은 테두리
    const boss = isBossFloor(this.abyssStats, w.layer);
    const label = `${boss ? '◆ ' : '▓ '}${this.stageName(w.layer)}  ${Math.max(0, Math.ceil(w.hp))}/${Math.ceil(w.maxHp)}`;
    if (this.wallLabel.text !== label) this.wallLabel.setText(label).setColor(boss ? '#ff9e9e' : '#8796c2');
    if (boss !== this.bossShown) {
      this.bossShown = boss;
      this.wallRect.setFillStyle(boss ? BOSS_WALL : COLOR.wall).setStrokeStyle(boss ? 3 : 0, BOSS_EDGE);
      this.wallBar.setFillStyle(boss ? BOSS_EDGE : COLOR.unhappy);
    }
    this.wallBar.height = REGION.ground.h * Math.max(0, Math.min(1, w.hp / w.maxHp));

    const live = new Set<number>();
    for (const u of s.abyss.units) {
      live.add(u.id);
      let v = this.units.get(u.id);
      if (!v) {
        v = makeUnitView(this.scene, this.data, u, 'offense');
        this.root.add(v.container);
        this.units.set(u.id, v);
      }
      const p = toScreen('abyss', u.x, u.y);
      v.container.setPosition(p.x, p.y);
      syncUnitView(v, u, this.state, 'offense');
    }
    for (const id of [...this.units.keys()]) if (!live.has(id)) this.removeUnit(id);
  }

  private removeUnit(id: number): void {
    const v = this.units.get(id);
    this.units.delete(id);
    if (!v) return;
    this.scene.tweens.killTweensOf(v.container);
    this.scene.tweens.add({ targets: v.container, alpha: 0, duration: 150, onComplete: () => v.container.destroy() });
  }

  /** 지급 조각 (갈림길 보너스·보스 층 와일드카드): 층에서 그리드 칸으로 (칸이 없으면 사라짐) */
  private grantFlow(g: Grant): void {
    const fill = isWildcard(g.piece) ? COLOR.wildcard : (this.chainColor.get(g.piece.chain) ?? 0xffffff);
    const from = toScreen('abyss', g.x, g.y);
    const light = this.scene.add.rectangle(from.x, from.y, 12, 12, fill).setStrokeStyle(1, 0xffffff).setDepth(40);
    const { cols, rows } = this.state.grid;
    const slot = HERO_SLOT.offense;
    const dest = g.placedAt !== null ? cellCenter(cols, rows, g.placedAt) : { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 };
    this.scene.tweens.add({
      targets: light,
      x: dest.x,
      y: dest.y,
      alpha: g.lost ? 0 : 1,
      duration: GRANT_MS,
      ease: 'Sine.easeInOut',
      onComplete: () => light.destroy(),
    });
  }
}
