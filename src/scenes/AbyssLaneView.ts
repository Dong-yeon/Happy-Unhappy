// 밤의 심연 레인 표시 (§4.3.2, §5.11-2): 가로 레인. Unhappy 출발점은 왼쪽, 그림자 벽은 오른쪽 끝.
// 상태는 항상 core에서 읽고 layout.toScreen()으로 화면에 옮긴다. 이벤트는 연출(해질녘 하강, 귀환 빛 조각, 소멸)에만 쓴다.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import { isWildcard, type Piece } from '../core/grid';
import type { Unit } from '../core/lane';
import type { Balance, Chain } from '../data/types';
import { isBossFloor } from '../core/lane';
import { CORE, HOME, PORTAL, REGION, cellCenter, progressX, toScreen } from './layout';
import { COLOR, text } from './ui';

const UNIT_SIZE = 16;
const HP_BAR_W = 16;
const SUMMON_MS = 250; // 조각 → 손거울 → 출발선
const DUSK_MS = 600; // 해질녘: 맡긴 추억 줄 → 손거울 → 출발선
const RETURN_MS = 450; // 유닛 자리 → 손거울 → 그리드 칸
/** 보스 층 벽 (§5.13-4) */
const BOSS_WALL = 0x3a1626;
const BOSS_EDGE = 0xd0607a;

interface UnitView {
  container: Phaser.GameObjects.Container;
  bar: Phaser.GameObjects.Rectangle;
  /** 소환 연출 중에는 core 위치로 옮기지 않는다 */
  tweening: boolean;
}

export class AbyssLaneView {
  /** 밤 레인 전체 (낮에는 숨김) */
  readonly root: Phaser.GameObjects.Container;
  private readonly units = new Map<number, UnitView>();
  private readonly chainColor = new Map<string, number>();
  private readonly wallLabel: Phaser.GameObjects.Text;
  private readonly wallBar: Phaser.GameObjects.Rectangle;
  private readonly wallX: number;
  private readonly wallRect: Phaser.GameObjects.Rectangle;
  private bossShown = false;
  private readonly unhappy: Phaser.GameObjects.Arc;
  private readonly unhappyLabel: Phaser.GameObjects.Text;
  private stalledShown = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    chains: Chain[],
    /** 해질녘 연출 시작점: 맡긴 추억 줄의 i번째 칸 */
    private readonly partySlot: (i: number) => { x: number; y: number },
    /** 보스 층 판정용 (balance.abyss) */
    private readonly abyssStats: Balance['abyss'],
    /** 벽 라벨 "1-3 셋째 고개" (§5.15-2) */
    private readonly stageName: (stage: number) => string,
  ) {
    for (const c of chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
    const g = REGION.ground;
    const bg = scene.add.rectangle(g.x, g.y, g.w, g.h, COLOR.abyss).setOrigin(0);
    // 그림자 벽: 진행 축 끝(오른쪽) 세로 띠 + 남은 HP 막대(세로) + "N층 hp/max"
    this.wallX = progressX(CORE.wallY);
    this.wallRect = scene.add.rectangle(this.wallX, g.y, g.x + g.w - this.wallX, g.h, COLOR.wall).setOrigin(0);
    const wall = this.wallRect;
    this.wallBar = scene.add.rectangle(this.wallX + 2, g.y + g.h, 3, g.h, COLOR.unhappy).setOrigin(0, 1);
    this.wallLabel = text(scene, this.wallX - 4, g.y + 4, '', { fontSize: '9px', color: '#8796c2' }).setOrigin(1, 0);
    const startX = progressX(CORE.lineY);
    const start = scene.add.line(0, 0, startX, g.y + 6, startX, g.y + g.h - 6, COLOR.portalUnhappy, 0.4).setOrigin(0).setLineWidth(1);
    const label = text(scene, g.x + g.w / 2, g.y + g.h - 4, '밤 · 꿈속 심연 →', { fontSize: '9px', color: '#5d6a91' }).setOrigin(0.5, 1);
    const home = HOME.abyss;
    this.unhappy = scene.add.circle(home.x, home.y, 10, COLOR.unhappy);
    this.unhappyLabel = text(scene, 2, home.y - 17, 'Unhappy', { fontSize: '8px', color: '#9fb0e0' }).setOrigin(0, 0.5) // 화면 왼쪽 끝이라 왼쪽 정렬;
    this.root = scene.add
      .container(0, 0, [bg, wall, this.wallBar, this.wallLabel, start, label, this.unhappy, this.unhappyLabel])
      .setDepth(1)
      .setVisible(false);
  }

  setShown(shown: boolean): void {
    this.root.setVisible(shown);
  }

  /** 밤의 즉시 소환 연출: 드롭 지점 → ◐ 손거울 포탈 → 출발선 슬롯. core에서는 이미 전진 시작 */
  onSummon(unit: Unit, fromX: number, fromY: number): void {
    this.flyIn(unit, [{ x: fromX, y: fromY }, PORTAL.unhappy], SUMMON_MS);
  }

  /** core 이벤트 → 연출. sync() 전에 호출 */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type === 'abyssUnitDie') this.removeUnit(e.unitId, true);
      else if (e.type === 'dusk') {
        // 해질녘: 맡긴 추억이 줄에서 손거울을 지나 출발선으로 내려간다
        e.units.forEach((u, i) => this.flyIn(u, [this.partySlot(i), PORTAL.unhappy], DUSK_MS));
      } else if (e.type === 'injured' && e.side === 'unhappy') {
        // 영웅·전설 밤 부상: 손거울을 지나 그리드로 (§5.13-2)
        const from = toScreen('abyss', e.ret.x, e.ret.y);
        this.returnFlow(e.ret.piece, from.x, from.y, e.ret.placedAt, e.ret.lost);
      } else if (e.type === 'layerClear' || e.type === 'bossFloorClear' || (e.type === 'dayReturn' && e.side === 'unhappy')) {
        for (const r of e.returns) {
          const v = this.units.get(r.unitId);
          const from = v ? { x: v.container.x, y: v.container.y } : toScreen('abyss', r.x, r.y);
          this.removeUnit(r.unitId, false);
          this.returnFlow(r.piece, from.x, from.y, r.placedAt, r.lost);
        }
      }
    }
  }

  /** 표시를 core 상태에 맞춘다 (매 프레임) */
  sync(): void {
    const s = this.state;
    const w = s.abyss.wall;
    // 보스 층 (§5.13-4): 붉은 벽 + 굵은 테두리 + "보스 층"
    const boss = isBossFloor(this.abyssStats, w.layer);
    const label = `${boss ? '◆ ' : '▓ '}${this.stageName(w.layer)}  ${Math.max(0, Math.ceil(w.hp))}/${Math.ceil(w.maxHp)}`;
    if (this.wallLabel.text !== label) this.wallLabel.setText(label).setColor(boss ? '#ff9e9e' : '#8796c2');
    if (boss !== this.bossShown) {
      this.bossShown = boss;
      this.wallRect.setFillStyle(boss ? BOSS_WALL : COLOR.wall).setStrokeStyle(boss ? 3 : 0, BOSS_EDGE);
      this.wallBar.setFillStyle(boss ? BOSS_EDGE : COLOR.unhappy);
    }
    this.wallBar.height = REGION.ground.h * Math.max(0, Math.min(1, w.hp / w.maxHp));

    if (s.unhappyStalled !== this.stalledShown) {
      this.stalledShown = s.unhappyStalled;
      this.unhappy.setAlpha(s.unhappyStalled ? 0.45 : 1);
      this.unhappyLabel.setText(s.unhappyStalled ? 'Unhappy · 멈춤' : 'Unhappy').setColor(s.unhappyStalled ? '#ff9e9e' : '#9fb0e0');
    }

    const live = new Set<number>();
    for (const u of s.abyss.units) {
      live.add(u.id);
      const v = this.units.get(u.id) ?? this.makeUnit(u);
      if (!v.tweening) {
        const p = toScreen('abyss', u.x, u.y);
        v.container.setPosition(p.x, p.y);
      }
      v.bar.width = HP_BAR_W * Math.max(0, Math.min(1, u.hp / u.maxHp));
    }
    for (const id of [...this.units.keys()]) if (!live.has(id)) this.removeUnit(id, true);
  }

  /** 경유점들을 지나 유닛 자리로 (도착 전에는 core 위치를 따라가지 않는다) */
  private flyIn(unit: Unit, via: { x: number; y: number }[], ms: number): void {
    const v = this.units.get(unit.id) ?? this.makeUnit(unit);
    v.tweening = true;
    this.root.remove(v.container);
    v.container.setPosition(via[0].x, via[0].y).setDepth(15).setScale(0.6);
    const live = () => this.state.abyss.units.find((u) => u.id === unit.id) ?? unit;
    const steps = via.slice(1).map((p) => ({ x: p.x, y: p.y, duration: ms / via.length, ease: 'Sine.easeIn' }));
    this.scene.tweens.chain({
      targets: v.container,
      tweens: [
        ...steps,
        {
          x: { getEnd: () => toScreen('abyss', live().x, live().y).x },
          y: { getEnd: () => toScreen('abyss', live().x, live().y).y },
          scale: 1,
          duration: ms / via.length,
          ease: 'Sine.easeOut',
        },
      ],
      onComplete: () => {
        v.tweening = false;
        if (!v.container.active) return;
        v.container.setDepth(0);
        this.root.add(v.container);
      },
    });
  }

  private makeUnit(u: Unit): UnitView {
    const maxTier = this.state.grid.maxTier;
    const fill = this.chainColor.get(u.chain) ?? 0x999999;
    // 꿈속 = 차가운 팔레트: 같은 체인 색에 차가운 테두리
    const body = this.scene.add
      .rectangle(0, 0, UNIT_SIZE, UNIT_SIZE, fill)
      .setStrokeStyle(u.legend ? 3 : 2, u.legend ? 0xf2c94c : u.shining ? 0xfff1a8 : COLOR.portalUnhappy);
    const label = text(this.scene, 0, 0, u.legend ? '◆' : u.tier >= maxTier ? '★' : String(u.tier), {
      fontSize: '10px',
      color: '#1b1d24',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    const bg = this.scene.add.rectangle(-HP_BAR_W / 2, UNIT_SIZE / 2 + 3, HP_BAR_W, 3, 0x1b1d24).setOrigin(0, 0.5);
    const bar = this.scene.add.rectangle(-HP_BAR_W / 2, UNIT_SIZE / 2 + 3, HP_BAR_W, 3, 0x9fc3ff).setOrigin(0, 0.5);
    const p = toScreen('abyss', u.x, u.y);
    const container = this.scene.add.container(p.x, p.y, [body, label, bg, bar]);
    this.root.add(container);
    const v = { container, bar, tweening: false };
    this.units.set(u.id, v);
    return v;
  }

  private removeUnit(id: number, fade: boolean): void {
    const v = this.units.get(id);
    this.units.delete(id);
    if (!v) return;
    this.scene.tweens.killTweensOf(v.container);
    if (!fade) {
      v.container.destroy();
      return;
    }
    this.scene.tweens.add({ targets: v.container, alpha: 0, duration: 150, onComplete: () => v.container.destroy() });
  }

  /** 층 돌파·새벽 귀환: 빛 조각이 ◐ 손거울 포탈을 지나 그리드 칸으로 (대기열이면 귀환 대기 표시, 소실이면 포탈에서 사라짐) */
  private returnFlow(piece: Piece, x: number, y: number, placedAt: number | null, lost: boolean): void {
    const fill = isWildcard(piece) ? COLOR.wildcard : (this.chainColor.get(piece.chain) ?? 0xffffff);
    const light = this.scene.add.rectangle(x, y, 12, 12, fill).setStrokeStyle(1, 0xffffff).setDepth(40);
    const { cols, rows } = this.state.grid;
    const dest =
      placedAt !== null
        ? cellCenter(cols, rows, placedAt)
        : lost
          ? { x: PORTAL.unhappy.x, y: PORTAL.unhappy.y }
          : { x: PORTAL.happy.x - 40, y: PORTAL.happy.y };
    this.scene.tweens.chain({
      targets: light,
      tweens: [
        { x: PORTAL.unhappy.x, y: PORTAL.unhappy.y, duration: RETURN_MS / 2, ease: 'Sine.easeIn' },
        { x: dest.x, y: dest.y, alpha: lost ? 0 : 1, duration: RETURN_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => light.destroy(),
    });
  }
}
