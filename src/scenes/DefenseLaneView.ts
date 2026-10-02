// 밤(디펜스) 레인 표시 — 핵 지키기 (§4.3.1, §5.19-3): 가로 레인. 이야기책(핵)은 왼쪽, 적은 오른쪽에서 밀려온다.
// 우리 편 = 밤덱 영웅 + 전투 중 머지 병사. 영웅이 쓰러지면 거점 위에 일어나기까지 카운트다운. 거점 위에 핵 HP 막대.
// 상태는 항상 core에서 읽고 layout.toScreen()으로 화면에 옮긴다. 이벤트는 연출(가라앉음, 타격)에만 쓴다.
// 처치 드롭 조각은 WellView가 처치 지점에서 우물로 날린다 (§5.20-13). 동시 적 상한을 넘은 대기열 수는 오른쪽 위에.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import type { GameData } from '../data/types';
import { CORE, HOME, REGION, bossScale, progressX, toScreen } from './layout';
import { flashBody, flashUnit, makeEnemyView, storyBook, makeUnitView, syncEnemyView, syncUnitView, type EnemyView, type UnitView } from './laneUnits';
import { NIGHT_TINT } from './scenery';
import { skinOf } from './skin/Skin';
import { COLOR, text } from './ui';

/** 걱정은 방어선에 닿도록 중심을 진행 축으로 이만큼 앞(오른쪽)에 그린다 (core y 기준) */
const WORRY_DRAW_OFFSET = 9;
const CORE_BAR_W = 64;
const SINK_MS = 450;
/** 우리 편은 core 위치보다 이만큼 거점 쪽(진행 축)에 그린다 (방어선에서 걱정과 겹치지 않게) */
const UNIT_DRAW_OFFSET = CORE.homeY - CORE.lineY;
/** 타격 연출 (§4.3.3): 대상 위치 원 번쩍 + 맞은 쪽 흰색 깜빡임 */
const HIT_MS = 100;
const HIT_BY_US = 0xfff3b0;
const HIT_BY_WORRY = 0xd28cff;
/** 홈으로 돌아가는 중 */
const RETURNING_ALPHA = 0.85;

/** 방어선 빛 (이야기책 빛이 닿는 띠) */
const GUARD_GLOW = 0xfff1c4;
const GUARD_DANGER = 0xff5a5a;
const GUARD_ALPHA = { min: 0.1, max: 0.18 } as const;
const GUARD_BLINK_MS = 500;
/** 이야기책 빛 펄스 주기 (bookGlow와 방어선 빛이 같이 숨쉼) */
const GLOW_PULSE_MS = 1600;
/** 빛 테두리 휨 (가운데가 lineX, 위아래로 갈수록 이만큼 책 쪽으로) */
const GUARD_BULGE = 6;

/** 빛 테두리 점들: 가운데 x = lineX (규칙의 방어선), 위아래 끝은 살짝 안쪽 → 책에서 퍼진 반원 느낌 */
function guardEdgePoints(lineX: number, top: number, h: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 - 1;
    pts.push({ x: lineX - GUARD_BULGE * t * t, y: top + (i / n) * h });
  }
  return pts;
}

export class DefenseLaneView {
  /** 병사 층 / 영웅 층 (영웅이 위: 병사 단계 배지가 영웅을 가리지 않게) */
  private readonly soldierLayer: Phaser.GameObjects.Container;
  private readonly heroLayer: Phaser.GameObjects.Container;
  /** 밤 레인 전체 (낮에는 숨김) */
  readonly root: Phaser.GameObjects.Container;
  private readonly worries = new Map<number, EnemyView>();
  private readonly units = new Map<number, UnitView>();
  private readonly downLabel: Phaser.GameObjects.Text;
  private readonly teamLabel: Phaser.GameObjects.Text;
  private readonly spawnLabel: Phaser.GameObjects.Text;
  private readonly coreFill: Phaser.GameObjects.Rectangle;
  private readonly coreText: Phaser.GameObjects.Text;
  /** 방어선 빛 테두리 (붉게 깜빡임용, fx 꺼짐이면 null = 세로선 그대로) */
  private readonly guardEdge: Phaser.GameObjects.Graphics | null = null;
  private readonly guardDanger: Phaser.GameObjects.Graphics | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
  ) {
    const g = REGION.ground;
    // 밤 땅 띠(1챕터: 오두막 앞마당에 내려앉은 이야기책, 도형 단계는 배경색만) + 방어선(세로) + Happy 거점
    // 땅: 스킨이면 밤 마당 무늬 + 남색 tint (§5.23-2), 아니면 단색
    const sk = skinOf(scene);
    const bg = sk.has('bg.night')
      ? scene.add.tileSprite(g.x, g.y, g.w, g.h, sk.frame('bg.night').texture, sk.frame('bg.night').frame).setOrigin(0).setTileScale(sk.tileScale('bg.night')).setTint(NIGHT_TINT)
      : scene.add.rectangle(g.x, g.y, g.w, g.h, COLOR.abyss).setOrigin(0);
    // 팩 타일(풀빛)은 곱하기 tint만으로는 남색이 안 돼서 밤빛 덮개를 한 겹 더 (생성 그림은 무채색이라 tint로 충분)
    const nightVeil = scene.add.rectangle(g.x, g.y, g.w, g.h, COLOR.abyss, sk.has('bg.night') && sk.frame('bg.night').packed ? 0.7 : 0).setOrigin(0);
    const lineX = progressX(CORE.lineY);
    const line = scene.add.line(0, 0, lineX, g.y + 6, lineX, g.y + g.h - 6, COLOR.line).setOrigin(0).setLineWidth(1);
    // 방어선 = 이야기책 빛이 닿는 데까지 (규칙은 그대로 CORE.lineY). fx 꺼짐(?skin=0·팩 없음)이면 세로선 그대로
    const fx = skinOf(scene).fx;
    const glow = scene.add.graphics();
    if (fx) {
      line.setVisible(false);
      const edge = guardEdgePoints(lineX, g.y, g.h);
      glow.fillStyle(GUARD_GLOW, 1).fillPoints([{ x: g.x, y: g.y }, ...edge, { x: g.x, y: g.y + g.h }], true);
      glow.setAlpha(GUARD_ALPHA.max);
      // bookGlow 펄스와 같은 리듬
      scene.tweens.add({ targets: glow, alpha: GUARD_ALPHA.min, duration: GLOW_PULSE_MS, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      this.guardEdge = scene.add.graphics().lineStyle(1.5, GUARD_GLOW, 0.45).strokePoints(edge);
      this.guardDanger = scene.add.graphics().lineStyle(2, GUARD_DANGER, 0.9).strokePoints(edge).setVisible(false);
    }
    this.spawnLabel = text(scene, g.x + g.w - 6, g.y + 4, '← 씨앗을 노리는 무리', { fontSize: '10px', color: '#c9b98a' }).setOrigin(1, 0);
    this.teamLabel = text(scene, g.x + 8, g.y + 20, '', { fontSize: '10px', color: '#cfd6ea' });
    const laneLabel = text(scene, g.x + g.w * 0.38, g.y + g.h - 4, '밤 · 이야기 씨앗 지키기', { fontSize: '9px', color: '#8f835f' }).setOrigin(0.5, 1);
    const home = HOME.defense;
    // 본거지 이야기책 (핵을 품고 있음, D-056)
    const happy = storyBook(scene, home.x, home.y);
    // 밤: 이야기책 주변 은은한 빛 (§5.23-2)
    const bookGlow = scene.add.circle(home.x, home.y, 18, 0xfff1c4, skinOf(scene).fx ? 0.12 : 0);
    if (skinOf(scene).fx) scene.tweens.add({ targets: bookGlow, alpha: 0.04, scale: 1.25, duration: GLOW_PULSE_MS, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    // 핵 HP (§5.19-3): 레인 왼쪽 위 "◆ 핵 100/100" + 막대
    const cx = g.x + 8;
    const cy = g.y + 10;
    const coreGem = scene.add.rectangle(cx + 4, cy, 7, 7, 0xffe08a).setAngle(45).setStrokeStyle(1, 0xffffff);
    const coreFrame = scene.add.rectangle(cx + 14, cy, CORE_BAR_W, 6, 0x1b1d24).setOrigin(0, 0.5).setStrokeStyle(1, 0x8f835f);
    this.coreFill = scene.add.rectangle(cx + 14, cy, CORE_BAR_W, 6, 0xffe08a).setOrigin(0, 0.5);
    this.coreText = text(scene, cx + 18 + CORE_BAR_W, cy, '', { fontSize: '9px', color: '#ffe08a' }).setOrigin(0, 0.5);
    this.downLabel = text(scene, home.x + 4, home.y - 26, '', { fontSize: '9px', color: '#ff9e9e', backgroundColor: '#1b1d24', padding: { x: 3, y: 1 } })
      .setOrigin(0, 0.5)
      .setVisible(false);
    this.soldierLayer = scene.add.container(0, 0);
    this.heroLayer = scene.add.container(0, 0);
    this.root = scene.add
      .container(0, 0, [bg, nightVeil, glow, ...(this.guardEdge ? [this.guardEdge, this.guardDanger!] : []), line, this.spawnLabel, this.teamLabel, laneLabel, bookGlow, happy, this.soldierLayer, this.heroLayer, coreGem, coreFrame, this.coreFill, this.coreText, this.downLabel])
      .setDepth(1)
      .setVisible(false);
  }

  setShown(shown: boolean): void {
    this.root.setVisible(shown);
  }

  /** core 이벤트 → 연출. sync() 전에 호출 (사라질 표시의 마지막 위치를 쓰기 위해) */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'worryDie':
          this.removeWorry(e.worryId);
          break;
        case 'sink': {
          const v = this.worries.get(e.worryId);
          this.worries.delete(e.worryId);
          if (v) this.sinkAway(v.container);
          break;
        }
        case 'coreHit': {
          // 핵이 맞음: 막대 붉게 깜빡
          this.coreFill.setFillStyle(0xff6b6b);
          this.scene.time.delayedCall(180, () => this.coreFill.active && this.coreFill.setFillStyle(0xffe08a));
          break;
        }
        case 'unitDie':
          this.removeUnit(e.unitId);
          break;
        case 'attack': {
          if (e.attacker.kind === 'worry') {
            const t = this.units.get(e.targetId);
            if (t) {
              this.flash(t.container.x, t.container.y, HIT_BY_WORRY);
              flashUnit(this.scene, t, HIT_MS);
            }
          } else {
            const t = this.worries.get(e.targetId);
            if (t) {
              this.flash(t.container.x, t.container.y, HIT_BY_US);
              flashBody(this.scene, t.body, t.color, HIT_MS);
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** 표시를 core 상태에 맞춘다 (매 프레임) */
  sync(): void {
    const lane = this.state.defense;
    // 막는 유닛이 0명이고 적이 방어선을 지나기 시작하면 빛 테두리가 붉게 깜빡임 (0.5초 간격). 유닛이 다시 서면 원래대로
    if (this.guardEdge && this.guardDanger) {
      const breach = lane.units.length === 0 && lane.worries.some((w) => w.state === 'passing');
      const on = breach && Math.floor(this.scene.time.now / GUARD_BLINK_MS) % 2 === 0;
      this.guardDanger.setVisible(on);
      this.guardEdge.setVisible(!on);
    }
    const liveW = new Set<number>();
    for (const w of lane.worries) {
      liveW.add(w.id);
      let v = this.worries.get(w.id);
      if (!v) {
        v = makeEnemyView(this.scene, w.type, w.boss, w.boss ? bossScale(w.type) : undefined); // 보스 웨이브 적: guardian과 같은 배율
        this.root.add(v.container);
        this.worries.set(w.id, v);
      }
      const p = toScreen('defense', w.x, w.y - WORRY_DRAW_OFFSET);
      v.container.setPosition(p.x, p.y);
      syncEnemyView(v, w.hp, w.maxHp, w.slowTimer > 0);
    }
    for (const id of [...this.worries.keys()]) if (!liveW.has(id)) this.removeWorry(id);

    const liveU = new Set<number>();
    for (const u of lane.units) {
      liveU.add(u.id);
      let v = this.units.get(u.id);
      if (!v) {
        v = makeUnitView(this.scene, this.data, u, 'defense');
        (u.role === 'hero' ? this.heroLayer : this.soldierLayer).add(v.container);
        this.units.set(u.id, v);
      }
      // 제한 이동(§4.3.3): core의 u.x, u.y를 매 프레임 따라간다. 복귀 중에는 반투명
      const p = toScreen('defense', u.x, u.y + UNIT_DRAW_OFFSET);
      v.container.setPosition(p.x, p.y).setAlpha(u.returning ? RETURNING_ALPHA : 1);
      syncUnitView(v, u, this.state, 'defense');
    }
    for (const id of [...this.units.keys()]) if (!liveU.has(id)) this.removeUnit(id);

    // 핵 HP
    const max = this.data.balance.core.hp;
    const hp = this.state.coreHp;
    this.coreFill.width = CORE_BAR_W * Math.max(0, Math.min(1, hp / max));
    const ct = `씨앗 ${Math.ceil(hp)}/${max}`;
    if (this.coreText.text !== ct) this.coreText.setText(ct);

    // 쓰러짐 카운트다운 (§5.17-9)
    const s = this.state;
    const timers = [...s.reviveTimers.values()];
    const down = timers.length ? Math.min(...timers) : 0;
    const teams = s.teams('defense').length;
    this.downLabel.setVisible(down > 0);
    if (down > 0) this.downLabel.setText(`쓰러짐 ${timers.length} · ${Math.ceil(down)}초 뒤 일어남`);
    // 팀 표시 (§5.20-13): "1팀 출격 · 2팀 대기"
    const at = s.activeTeam.defense;
    const tl = s.phase === 'night' ? `${at + 1}팀 출격${at + 1 < teams ? ` · ${at + 2}팀 대기` : ''}` : '';
    if (this.teamLabel.text !== tl) this.teamLabel.setText(tl);
    const q = s.nightQueued;
    const sl = `← 씨앗을 노리는 무리${q > 0 ? ` (+${q} 대기)` : ''}`;
    if (this.spawnLabel.text !== sl) this.spawnLabel.setText(sl);
  }

  private flash(x: number, y: number, color: number): void {
    const f = this.scene.add.circle(x, y, 9, color, 0.9).setDepth(35);
    this.scene.tweens.add({ targets: f, scale: 1.6, alpha: 0, duration: HIT_MS, onComplete: () => f.destroy() });
  }

  private removeWorry(id: number): void {
    this.worries.get(id)?.container.destroy();
    this.worries.delete(id);
  }

  private removeUnit(id: number): void {
    const v = this.units.get(id);
    this.units.delete(id);
    if (!v) return;
    this.scene.tweens.killTweensOf(v.container);
    this.scene.tweens.add({ targets: v.container, alpha: 0, duration: 150, onComplete: () => v.container.destroy() });
  }

  /** 거점에 닿음: 방어선을 지나 왼쪽 이야기책으로 빨려 들어가며 사라진다 (핵 HP −) */
  private sinkAway(c: Phaser.GameObjects.Container): void {
    this.scene.tweens.add({
      targets: c,
      x: REGION.ground.x - 6,
      y: c.y + 18,
      scale: 0.5,
      alpha: 0,
      duration: SINK_MS,
      ease: 'Sine.easeIn',
      onComplete: () => c.destroy(),
    });
  }
}
