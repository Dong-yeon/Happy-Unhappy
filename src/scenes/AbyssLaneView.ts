// 낮(오펜스) 레인 표시 — 핵 찾아 돌아오기 (§5.19-2): 가로 레인. 이야기책은 왼쪽, 핵을 쥔 그림자(guardian)는 오른쪽 끝.
// 우리 편 = 낮덱 영웅 + 전투 중 머지 병사, 적 = 가는 길 무리 + 돌아오는 길 추격 무리.
// 핵: guardian이 쥠 → 운반자 머리 위 → 떨어지면 땅 위. 운반 중엔 레인 위에 "핵 → 이야기책" 진행 막대.
// guardian을 쓰러뜨리면 핵 카드(핵 이름 + 한 줄)를 잠깐 띄운다 (시간은 멈추지 않음).
// 상태는 항상 core에서 읽고 layout.toScreen()으로 화면에 옮긴다. 이벤트는 연출(지급 조각, 타격, 소멸, 핵 카드)에만 쓴다.
import Phaser from 'phaser';
import { enemyName, type CoreEvent, type GameState, type Grant } from '../core/game';
import { isWildcard } from '../core/grid';
import type { GameData } from '../data/types';
import { CORE, ENEMY_BASE_SIZE, GUARDIAN_Y, REGION, bossScale, cellCenter, progressX, toScreen } from './layout';
import { flashBody, flashUnit, makeEnemyView, popIn, storyBook, makeUnitView, syncEnemyView, syncUnitView, type EnemyView, type UnitView } from './laneUnits';
import { skinOf } from './skin/Skin';
import { stageTint } from './scenery';
import { COLOR, text } from './ui';

const GRANT_MS = 450; // 지급 조각: 레인 → 그리드 칸
const HIT_MS = 100;
const BOSS_WALL = 0x3a1626;
const BOSS_EDGE = 0xd0607a;
const CORE_COLOR = 0xffe08a;
const CORE_CARD_MS = 3200;
const BAR_W = 140;

export class AbyssLaneView {
  /** 낮 레인 전체 (밤에는 숨김) */
  readonly root: Phaser.GameObjects.Container;
  private readonly units = new Map<number, UnitView>();
  private readonly enemies = new Map<number, EnemyView>();
  private readonly chainColor = new Map<string, number>();
  private readonly wallLabel: Phaser.GameObjects.Text;
  private readonly wallBar: Phaser.GameObjects.Rectangle;
  private readonly wallRect: Phaser.GameObjects.Rectangle;
  private readonly core: Phaser.GameObjects.Container;
  private readonly carryFrame: Phaser.GameObjects.Container;
  private readonly carryFill: Phaser.GameObjects.Rectangle;
  private readonly downLabel: Phaser.GameObjects.Text;
  private card: Phaser.GameObjects.Container | null = null;
  private ground!: Phaser.GameObjects.Rectangle | Phaser.GameObjects.TileSprite;
  private tintStage = 0;
  private book!: Phaser.GameObjects.Container;
  private corePulse: Phaser.Tweens.Tween | null = null;
  private bossShown: boolean | null = null;
  /** guardian 몬스터 (벽 앞에 서 있음, 표시만 — 벽·HP 막대는 그대로) */
  private readonly guardianLayer: Phaser.GameObjects.Container;
  private guardianView: EnemyView | null = null;
  private guardianKey = '';
  /** 병사 층 / 영웅 층 (영웅이 위: 병사 단계 배지가 영웅을 가리지 않게) */
  private readonly soldierLayer: Phaser.GameObjects.Container;
  private readonly heroLayer: Phaser.GameObjects.Container;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
  ) {
    for (const c of data.chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
    const g = REGION.ground;
    // 낮 땅 띠 (밝은 고갯길, 도형 단계는 배경색만)
    // 땅: 스킨이면 바탕 무늬 + 장면 tint (§5.23-2), 아니면 단색
    const bg = skinOf(scene).has('bg.day')
      ? scene.add.tileSprite(g.x, g.y, g.w, g.h, skinOf(scene).frame('bg.day').texture, skinOf(scene).frame('bg.day').frame).setOrigin(0).setTileScale(skinOf(scene).tileScale('bg.day'))
      : scene.add.rectangle(g.x, g.y, g.w, g.h, COLOR.defense).setOrigin(0);
    this.ground = bg;
    // guardian: 진행 축 끝(오른쪽) 세로 띠 + 남은 HP 막대(세로) + 이름 hp/max
    const wallX = progressX(CORE.wallY);
    this.wallRect = scene.add.rectangle(wallX, g.y, g.x + g.w - wallX, g.h, COLOR.wall).setOrigin(0);
    this.wallBar = scene.add.rectangle(wallX + 2, g.y + g.h, 3, g.h, COLOR.unhappy).setOrigin(0, 1);
    this.wallLabel = text(scene, wallX - 4, g.y + 4, '', { fontSize: '9px', color: '#8796c2' }).setOrigin(1, 0);
    // 본거지 이야기책 (출발·도착·밤에 지키는 곳, D-056): 왼쪽 끝 펼친 책
    const hutX = progressX(CORE.lineY);
    const hutY = g.y + g.h / 2;
    const book = storyBook(scene, hutX - 10, hutY);
    this.book = book;
    const hutLabel = text(scene, hutX - 10, hutY + 10, '이야기책', { fontSize: '8px', color: '#5d6a91' }).setOrigin(0.5, 0);
    const label = text(scene, g.x + g.w * 0.38, g.y + g.h - 4, '낮 · 이야기 씨앗 찾아 돌아오기 →', { fontSize: '9px', color: '#5d6a91' }).setOrigin(0.5, 1);
    // 핵 (작은 빛나는 마름모)
    // 이야기 씨앗: 스킨이면 직접 그린 씨앗 (§5.23-1 ui.seed), 아니면 빛나는 마름모
    const sk = skinOf(scene);
    const gem = sk.has('ui.seed') ? sk.image(scene, 'ui.seed', 0, 0, 14) : scene.add.rectangle(0, 0, 8, 8, CORE_COLOR).setAngle(45).setStrokeStyle(1, 0xffffff);
    const glow = scene.add.circle(0, 0, 8, CORE_COLOR, 0.25);
    this.core = scene.add.container(0, 0, [glow, gem]).setDepth(3);
    // 운반 진행 막대 "핵 → 이야기책"
    const fx = g.x + g.w / 2 - BAR_W / 2;
    const barY = g.y + 24;
    const frame = scene.add.rectangle(fx, barY, BAR_W, 6, 0x1b1d24).setOrigin(0, 0.5).setStrokeStyle(1, 0x5d6a91);
    this.carryFill = scene.add.rectangle(fx, barY, 0, 6, CORE_COLOR).setOrigin(0, 0.5);
    const cap = text(scene, fx - 4, barY, '이야기책 ←', { fontSize: '8px', color: '#ffe08a' }).setOrigin(1, 0.5);
    const cap2 = text(scene, fx + BAR_W + 4, barY, '◆ 씨앗', { fontSize: '8px', color: '#ffe08a' }).setOrigin(0, 0.5);
    this.carryFrame = scene.add.container(0, 0, [frame, this.carryFill, cap, cap2]).setVisible(false);
    this.downLabel = text(scene, g.x + 8, g.y + 6, '', { fontSize: '10px', color: '#cfd6ea' }).setVisible(false);
    this.guardianLayer = scene.add.container(0, 0);
    this.soldierLayer = scene.add.container(0, 0);
    this.heroLayer = scene.add.container(0, 0);
    this.root = scene.add
      .container(0, 0, [bg, this.wallRect, this.wallBar, this.wallLabel, this.guardianLayer, book, hutLabel, label, this.soldierLayer, this.heroLayer, this.carryFrame, this.core, this.downLabel])
      .setDepth(1);
  }

  setShown(shown: boolean): void {
    this.root.setVisible(shown);
    if (!shown) this.closeCard();
  }

  /** core 이벤트 → 연출. sync() 전에 호출 */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'offenseUnitDie':
          this.removeUnit(e.unitId);
          break;
        case 'enemyDie':
          this.removeEnemy(e.enemyId);
          break;
        case 'counter':
        case 'enemyAttack': {
          const v = this.units.get(e.unitId);
          if (v) flashUnit(this.scene, v, HIT_MS);
          break;
        }
        case 'unitHit': {
          const t = this.enemies.get(e.enemyId);
          if (t) {
            flashBody(this.scene, t.body, t.color, HIT_MS);
          }
          break;
        }
        case 'coreFound':
          this.showCoreCard(e.stage);
          if (skinOf(this.scene).fx) this.sparkle(progressX(CORE.wallY) + 10, REGION.ground.y + REGION.ground.h / 2);
          break;
        case 'heroEnter':
          // 이야기책에서 팀이 뛰어나옴 (§5.23-2): 책에서 작은 빛 + 영웅이 톡 튀어나옴
          if (e.role === 'offense' && !e.revive && skinOf(this.scene).fx) this.burstFromBook();
          break;
        case 'coreHome':
          // 씨앗이 이야기책에 들어가면 책장이 살짝 넘어감
          if (skinOf(this.scene).fx) this.flipBook();
          break;
        case 'bossReward':
          for (const g of e.rewards) this.grantFlow(g);
          break;
        case 'guardianHit':
          if (this.guardianView) flashBody(this.scene, this.guardianView.body, this.guardianView.color, HIT_MS);
          break;
        case 'dayBegin':
          this.closeCard();
          if (this.guardianView) popIn(this.scene, this.guardianView.container);
          break;
        default:
          break;
      }
    }
  }

  /** 표시를 core 상태에 맞춘다 (매 프레임) */
  sync(): void {
    const s = this.state;
    const ex = s.abyss;
    if (this.ground instanceof Phaser.GameObjects.TileSprite && this.tintStage !== s.stage) {
      this.tintStage = s.stage;
      this.ground.setTint(stageTint(s.stage));
    }
    // 낮이 아니면(장면 카드 등) 이번 스테이지 guardian을 가득 찬 채로 보여준다
    const day = s.phase === 'day';
    const sd = s.stageDef.day;
    const gd = day ? ex.guardian : { type: sd.guardian, hp: sd.guardianHp, maxHp: sd.guardianHp, boss: sd.boss ?? false };
    const boss = gd.boss;
    const name = enemyName(this.data, gd.type);
    const label = gd.hp > 0 ? `${boss ? '◆ ' : '▓ '}${name}  ${Math.ceil(gd.hp)}/${Math.ceil(gd.maxHp)}` : '이야기 씨앗을 찾았다';
    if (this.wallLabel.text !== label) this.wallLabel.setText(label).setColor(boss ? '#ff9e9e' : '#8796c2');
    if (boss !== this.bossShown) {
      this.bossShown = boss;
      this.wallRect.setFillStyle(boss ? BOSS_WALL : COLOR.wall).setStrokeStyle(boss ? 3 : 0, BOSS_EDGE);
      this.wallBar.setFillStyle(boss ? BOSS_EDGE : COLOR.unhappy);
    }
    this.wallBar.height = REGION.ground.h * Math.max(0, Math.min(1, gd.hp / gd.maxHp));
    this.wallRect.setAlpha(gd.hp > 0 ? 1 : 0.35);
    // guardian 몬스터: 벽 앞에 크게 (일반 ×1.5 · 털장갑 손 ×2 · 성난 호랑이 그림자 ×2.5)
    const gKey = `${s.stage}:${gd.type}:${gd.boss}`;
    if (gKey !== this.guardianKey) {
      this.guardianKey = gKey;
      this.guardianView?.container.destroy();
      const k = bossScale(gd.type);
      this.guardianView = makeEnemyView(this.scene, gd.type, gd.boss, k);
      this.guardianView.container.setPosition(progressX(CORE.wallY) - (ENEMY_BASE_SIZE * k) / 2 - 6, GUARDIAN_Y);
      this.guardianLayer.add(this.guardianView.container);
    }
    const gv = this.guardianView!;
    gv.container.setVisible(gd.hp > 0);
    if (gd.hp > 0) syncEnemyView(gv, gd.hp, gd.maxHp, day && ex.guardian.slowTimer > 0);

    const liveU = new Set<number>();
    for (const u of ex.units) {
      liveU.add(u.id);
      let v = this.units.get(u.id);
      if (!v) {
        v = makeUnitView(this.scene, this.data, u, 'offense');
        (u.role === 'hero' ? this.heroLayer : this.soldierLayer).add(v.container);
        this.units.set(u.id, v);
      }
      const p = toScreen('abyss', u.x, u.y);
      v.container.setPosition(p.x, p.y).setAlpha(u.returning ? 0.85 : 1);
      syncUnitView(v, u, this.state, 'offense');
    }
    for (const id of [...this.units.keys()]) if (!liveU.has(id)) this.removeUnit(id);

    const liveE = new Set<number>();
    for (const e of ex.enemies) {
      liveE.add(e.id);
      let v = this.enemies.get(e.id);
      if (!v) {
        v = makeEnemyView(this.scene, e.type, false);
        this.root.add(v.container);
        this.enemies.set(e.id, v);
      }
      const p = toScreen('abyss', e.x, e.y);
      v.container.setPosition(p.x + 6, p.y);
      syncEnemyView(v, e.hp, e.maxHp, e.slowTimer > 0);
    }
    for (const id of [...this.enemies.keys()]) if (!liveE.has(id)) this.removeEnemy(id);

    // 핵 위치
    const c = ex.core;
    const g = REGION.ground;
    let cp: { x: number; y: number } | null = null;
    if (s.phase !== 'day') cp = null;
    else if (c.at === 'guardian') cp = { x: progressX(CORE.wallY) + 10, y: g.y + g.h / 2 };
    else if (c.at === 'carried') {
      const u = ex.carrier;
      if (u) {
        const p = toScreen('abyss', u.x, u.y);
        cp = { x: p.x, y: p.y - 20 };
      }
    } else if (c.at === 'dropped') cp = { x: progressX(c.y), y: g.y + g.h / 2 };
    this.core.setVisible(cp !== null);
    if (cp) this.core.setPosition(cp.x, cp.y);
    // 운반 중 씨앗이 운반자 머리 위에서 빛남 (§5.23-2)
    const carried = c.at === 'carried' && s.phase === 'day' && skinOf(this.scene).fx;
    if (carried && !this.corePulse) this.corePulse = this.scene.tweens.add({ targets: this.core, scale: 1.35, duration: 420, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    else if (!carried && this.corePulse) {
      this.corePulse.remove();
      this.corePulse = null;
      this.core.setScale(1);
    }
    // 운반 진행 막대
    const carrying = s.phase === 'day' && (c.at === 'carried' || c.at === 'dropped');
    this.carryFrame.setVisible(carrying);
    if (carrying) {
      const y = c.at === 'carried' ? (ex.carrier?.y ?? ex.geo.wallY) : c.y;
      this.carryFill.width = BAR_W * Math.max(0, Math.min(1, (y - ex.geo.wallY) / ex.length));
    }
    // 팀 표시 (전장 왼쪽 위, §5.20-13): "1팀 출격 · 2팀 대기 · 쓰러짐 n" (낮 쓰러짐은 그 낮 동안 안 일어남, §5.20-3)
    const teams = s.teams('offense').length;
    const alive = s.teamUnits('offense').length;
    const size = s.activeTeamIds('offense').length;
    const at = s.activeTeam.offense;
    const tl =
      s.phase === 'day' ? `${at + 1}팀 출격${at + 1 < teams ? ` · ${at + 2}팀 대기` : ''}${alive < size ? ` · 쓰러짐 ${size - alive}` : ''}` : '';
    this.downLabel.setVisible(tl !== '');
    if (this.downLabel.text !== tl) this.downLabel.setText(tl);
  }

  /** 이야기 씨앗 획득 반짝임: 작은 빛 조각이 사방으로 */
  private sparkle(x: number, y: number): void {
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI * 2 * i) / 10;
      const p = this.scene.add.rectangle(x, y, 3, 3, 0xffe08a).setAngle(45).setDepth(30);
      this.scene.tweens.add({ targets: p, x: x + Math.cos(a) * 26, y: y + Math.sin(a) * 26, alpha: 0, scale: 0.4, duration: 520, ease: 'Sine.easeOut', onComplete: () => p.destroy() });
    }
    const ring = this.scene.add.circle(x, y, 6, 0xffe08a, 0).setStrokeStyle(2, 0xffe08a).setDepth(30);
    this.scene.tweens.add({ targets: ring, scale: 4, alpha: 0, duration: 480, onComplete: () => ring.destroy() });
  }

  private burstFromBook(): void {
    const b = this.book;
    const glow = this.scene.add.circle(b.x, b.y, 8, 0xfff1c4, 0.6).setDepth(2);
    this.scene.tweens.add({ targets: glow, scale: 2.4, alpha: 0, duration: 380, onComplete: () => glow.destroy() });
    this.scene.tweens.add({ targets: b, scaleY: 1.18, duration: 120, yoyo: true });
  }

  /** 책장 넘김: 책이 가로로 접혔다 펴짐 */
  private flipBook(): void {
    this.scene.tweens.add({ targets: this.book, scaleX: 0.15, duration: 160, yoyo: true, repeat: 1, ease: 'Sine.easeInOut' });
  }

  /** 핵 카드: 핵 이름 + 한 줄 (stages.json coreName·coreText), 시간은 계속 흐름 */
  private showCoreCard(stage: number): void {
    this.closeCard();
    const st = this.data.stages.stages[stage - 1];
    if (!st) return;
    const g = REGION.ground;
    const w = 248;
    const h = st.coreText ? 64 : 50;
    const x = g.x + g.w / 2;
    const y = g.y + 30;
    const box = this.scene.add.rectangle(0, 0, w, h, 0x2a2312, 0.95).setOrigin(0.5, 0).setStrokeStyle(2, 0xf2c94c);
    const head = text(this.scene, 0, 6, '◆ 이야기 씨앗을 찾았다', { fontSize: '9px', color: '#ffd36b' }).setOrigin(0.5, 0);
    const nm = text(this.scene, 0, 20, st.coreName, { fontSize: '13px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5, 0);
    const objs: Phaser.GameObjects.GameObject[] = [box, head, nm];
    if (st.coreText) objs.push(text(this.scene, 0, 40, st.coreText, { fontSize: '10px', color: '#ffe08a' }).setOrigin(0.5, 0));
    objs.push(text(this.scene, 0, h - 2, '이야기책까지 가지고 돌아가자', { fontSize: '8px', color: '#cfd6ea' }).setOrigin(0.5, 1));
    const card = this.scene.add.container(x, y, objs).setDepth(42).setAlpha(0);
    this.card = card;
    this.scene.tweens.add({ targets: card, alpha: 1, duration: 200 });
    this.scene.time.delayedCall(CORE_CARD_MS, () => {
      if (this.card !== card) return;
      this.scene.tweens.add({ targets: card, alpha: 0, duration: 300, onComplete: () => card.destroy() });
      this.card = null;
    });
  }

  private closeCard(): void {
    this.card?.destroy();
    this.card = null;
  }

  private removeUnit(id: number): void {
    const v = this.units.get(id);
    this.units.delete(id);
    if (!v) return;
    this.scene.tweens.killTweensOf(v.container);
    this.scene.tweens.add({ targets: v.container, alpha: 0, duration: 150, onComplete: () => v.container.destroy() });
  }

  private removeEnemy(id: number): void {
    this.enemies.get(id)?.container.destroy();
    this.enemies.delete(id);
  }

  /** 지급 조각 (갈림길 보너스·보스 와일드카드): 레인에서 그리드 칸으로 (칸이 없으면 사라짐) */
  private grantFlow(g: Grant): void {
    const fill = isWildcard(g.piece) ? COLOR.wildcard : (this.chainColor.get(g.piece.chain) ?? 0xffffff);
    const from = toScreen('abyss', g.x, g.y);
    const light = this.scene.add.rectangle(from.x, from.y, 12, 12, fill).setStrokeStyle(1, 0xffffff).setDepth(40);
    const { cols, rows } = this.state.grid;
    const board = REGION.board;
    const dest = g.placedAt !== null ? cellCenter(cols, rows, g.placedAt) : { x: board.x + board.w / 2, y: board.y + board.h / 2 };
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
