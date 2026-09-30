// ?debug=1 디버그 패널. M7에서 정식 디버그 패널로 흡수.
// 기본은 접힘: 포탈 받침 왼쪽 빈 자리의 [DBG] 토글만 보인다. 펼치면 방어 레인 위에 겹쳐 뜬다 (심연 레인은 가리지 않음).
// 탭: 기본(그리드·기쁨·조각) / 웨이브(정지·다음·배속) / 심연(그림자·역류·층) / 하루(일차·하루 끝·이벤트·일기장)
//     / 결말(즉시 판정·미리보기 5종) / 저장(gating·저장 초기화·JSON 복사·시드)
import Phaser from 'phaser';
import { allEventIds } from '../core/day';
import { endingFixtures, judgeEnding, type EndingResult } from '../core/ending';
import type { GameState } from '../core/game';
import { WILDCARD, type GridSize } from '../core/grid';
import type { EndingId, GameData } from '../data/types';
import { dateOffset, setDateOffset, today } from '../platform/clock';
import { storageStatus } from '../platform/storage';
import { REGION } from '../scenes/layout';
import type { SaveSession } from '../scenes/session';
import { Button, text } from '../scenes/ui';
import { saveGridOverride } from './gridPreset';

const DEBUG_JOY = 100;
const SPEEDS = [1, 3, 10] as const;
// 모달(DayUi, depth 60~72) 위: "내일 또 만나요"·결과 화면에서도 우회·미리보기를 쓸 수 있게
const PANEL_DEPTH = 100;
const PANEL_BG = 0x111318;
const PANEL_ALPHA = 0.92;
const TABS = ['기본', '웨이브', '심연', '하루', '결말', '저장'] as const;
const ROWS = 5;
type Tab = (typeof TABS)[number];

export interface DebugControls {
  /** 배속: scene이 tick(dt × speed)로 적용 */
  setSpeed(speed: number): void;
  /** core 상태를 바꾼 뒤 표시 갱신 */
  onChange(): void;
  /** 일기장 열기 */
  openDiary(): void;
  /** 결과 화면만 띄움 (게임 상태·저장은 바꾸지 않음) */
  previewEnding(result: EndingResult): void;
  /** 저장을 바꾼 뒤 다시 부팅 */
  reboot(): void;
}

export function createDebugPanel(
  scene: Phaser.Scene,
  data: GameData,
  state: GameState,
  session: SaveSession,
  current: GridSize,
  controls: DebugControls,
): void {
  const lane = REGION.defenseLane;
  const x0 = lane.x + 8;
  const top = lane.y + 4;
  const pages = new Map<Tab, { buttons: Button[]; items: Phaser.GameObjects.GameObject[] }>();
  for (const t of TABS) pages.set(t, { buttons: [], items: [] });
  let page: Tab = '기본';

  const btn = (tab: Tab, ...args: ConstructorParameters<typeof Button>) => {
    const b = new Button(...args);
    b.container.setDepth(PANEL_DEPTH + 1);
    pages.get(tab)!.buttons.push(b);
    return b;
  };
  const label = (tab: Tab, y: number, s: string) => {
    const t = text(scene, x0, y, s, { fontSize: '9px', color: '#ff9e6b' }).setDepth(PANEL_DEPTH + 1);
    pages.get(tab)!.items.push(t);
    return t;
  };

  const header = text(scene, x0, top + 6, '', { fontSize: '9px', color: '#ff9e6b' }).setDepth(PANEL_DEPTH + 1);
  const syncHeader = () => {
    const h = `DEBUG seed=${state.seed}${storageStatus.lastError ? ' · 저장 실패' : ''}`;
    if (header.text !== h) header.setText(h).setColor(storageStatus.lastError ? '#ff5f5f' : '#ff9e6b');
  };
  const tabBtns = TABS.map((t, i) =>
    new Button(scene, x0 + 13 + i * 27, top + 28, 26, 18, t, () => {
      page = t;
      apply();
    }, '8px'),
  );
  for (const b of tabBtns) b.container.setDepth(PANEL_DEPTH + 1);
  const y0 = top + 56;

  // ── 기본: 그리드 프리셋·기쁨·조각 지급 ──
  {
    let y = y0;
    label('기본', y - 16, '그리드 (전환 시 게임 저장 초기화, gating 유지)');
    y += 10;
    data.balance.grid.gridPresets.forEach(([cols, rows], i) => {
      const active = cols === current.cols && rows === current.rows;
      btn('기본', scene, x0 + 20 + i * 44, y, 40, 20, `${cols}×${rows}`, () => {
        if (active) return;
        session.resetGame();
        saveGridOverride({ cols, rows });
        controls.reboot();
      }, '10px').setActive(active);
    });
    y += 26;
    btn('기본', scene, x0 + 40, y, 80, 20, `기쁨 +${DEBUG_JOY}`, () => {
      state.debugAddJoy(DEBUG_JOY);
      controls.onChange();
    }, '10px');
    y += 26;
    const { chains } = data;
    const maxTier = data.balance.grid.maxTier;
    let chainIdx = 0;
    let tier = 1;
    const chainLabel = () => chains[chainIdx].tierNames[maxTier - 1];
    const tierLabel = () => (tier >= maxTier ? `${tier}★` : `${tier}단계`);
    btn('기본', scene, x0 + 40, y, 80, 20, chainLabel(), (b) => {
      chainIdx = (chainIdx + 1) % chains.length;
      b.setLabel(chainLabel());
    }, '10px');
    btn('기본', scene, x0 + 106, y, 44, 20, tierLabel(), (b) => {
      tier = (tier % maxTier) + 1;
      b.setLabel(tierLabel());
    }, '10px');
    y += 26;
    const grant = (chain: string, t: number) => {
      if (state.debugGrant(chain, t) === null) console.info('[debug] 빈 칸 없음 — 지급 안 함');
      controls.onChange();
    };
    btn('기본', scene, x0 + 40, y, 80, 20, '조각 지급', () => grant(chains[chainIdx].archetypeId, tier), '10px');
    btn('기본', scene, x0 + 124, y, 80, 20, '와일드카드', () => grant(WILDCARD, 0), '10px');
  }

  // ── 웨이브: 정지·다음·배속 ──
  {
    let y = y0;
    label('웨이브', y - 16, '웨이브 · 배속');
    y += 10;
    const pauseLabel = () => (state.wave.paused ? '웨이브 재개' : '웨이브 정지');
    btn('웨이브', scene, x0 + 40, y, 80, 20, pauseLabel(), (b) => {
      state.wave.paused = !state.wave.paused;
      b.setLabel(pauseLabel()).setActive(state.wave.paused);
    }, '10px');
    btn('웨이브', scene, x0 + 124, y, 80, 20, '대기 건너뛰기', () => {
      state.wave.startNext();
      controls.onChange();
    }, '10px');
    y += 26;
    const speedBtns: Button[] = [];
    SPEEDS.forEach((s, i) => {
      const b = btn('웨이브', scene, x0 + 20 + i * 44, y, 40, 20, `×${s}`, () => {
        controls.setSpeed(s);
        speedBtns.forEach((o, j) => o.setActive(j === i));
      }, '10px').setActive(s === 1);
      speedBtns.push(b);
    });
  }

  // ── 심연: 그림자·역류·층 ──
  {
    let y = y0;
    label('심연', y - 16, '그림자 · 역류 · 심연');
    y += 10;
    const nearMax = Math.round(data.balance.shadow.shadowMax * 0.9);
    btn('심연', scene, x0 + 40, y, 80, 20, '그림자 0', () => {
      state.debugSetShadow(0);
      controls.onChange();
    }, '10px');
    btn('심연', scene, x0 + 124, y, 80, 20, `그림자 ${nearMax}`, () => {
      state.debugSetShadow(nearMax);
      controls.onChange();
    }, '10px');
    y += 26;
    btn('심연', scene, x0 + 40, y, 80, 20, '역류 예약', () => {
      state.debugScheduleBackflow();
      controls.onChange();
    }, '10px');
    btn('심연', scene, x0 + 124, y, 80, 20, '층 HP 0', () => {
      state.debugBreakLayer();
      controls.onChange();
    }, '10px');
    y += 26;
    btn('심연', scene, x0 + 40, y, 80, 20, '심연 전멸', () => {
      state.debugKillAbyssUnits();
      controls.onChange();
    }, '10px');
  }

  // ── 하루: 일차 이동·하루 끝·이벤트 강제·이정표·일기장 ──
  {
    let y = y0;
    label('하루', y - 16, '일차 · 이벤트 · 일기장');
    y += 10;
    let target = state.day;
    const dayLabel = () => `${target}일째`;
    btn('하루', scene, x0 + 14, y, 26, 20, '−', () => {
      target = Math.max(1, target - 1);
      dayBtn.setLabel(dayLabel());
    }, '11px');
    const dayBtn = btn('하루', scene, x0 + 58, y, 56, 20, dayLabel(), () => undefined, '10px');
    btn('하루', scene, x0 + 102, y, 26, 20, '+', () => {
      target = Math.min(state.lifeLengthDays, target + 1);
      dayBtn.setLabel(dayLabel());
    }, '11px');
    btn('하루', scene, x0 + 142, y, 44, 20, '이동', () => {
      state.debugGotoDay(target);
      controls.onChange();
    }, '10px');
    y += 26;
    btn('하루', scene, x0 + 40, y, 80, 20, '하루 끝', () => {
      state.debugEndDay();
      controls.onChange();
    }, '10px');
    btn('하루', scene, x0 + 124, y, 80, 20, '일기장', () => controls.openDiary(), '10px');
    y += 26;
    const ids = allEventIds(data);
    let evIdx = 0;
    btn('하루', scene, x0 + 52, y, 104, 20, ids[evIdx], (b) => {
      evIdx = (evIdx + 1) % ids.length;
      b.setLabel(ids[evIdx]);
    }, '9px');
    btn('하루', scene, x0 + 136, y, 56, 20, '강제', () => {
      // dayStart면 오늘 바로, 아니면 다음 날
      state.debugForceEvent(ids[evIdx]);
      controls.onChange();
    }, '10px');
    y += 26;
    const milestone = data.events.milestones[0]?.id;
    btn('하루', scene, x0 + 80, y, 160, 20, '이정표 즉시 열기', () => {
      if (!milestone) return;
      // 오늘 아침으로 돌아가 이정표 카드를 띄운다
      state.debugGotoDay(state.day);
      state.debugForceEvent(milestone);
      controls.onChange();
    }, '10px');
  }

  // ── 결말: 즉시 판정·미리보기 5종 ──
  {
    let y = y0;
    label('결말', y - 16, '결말 (미리보기는 상태·저장 불변)');
    y += 10;
    btn('결말', scene, x0 + 80, y, 160, 20, '즉시 결말 판정 → lifeEnd', () => {
      state.debugJudgeEnding(); // lifeEnd 이벤트 → 씬이 저장
      controls.onChange();
    }, '10px');
    y += 26;
    const ids: EndingId[] = ['hidden', 'solid', 'mask', 'quiet', 'rainy'];
    const fixtures = endingFixtures(data.endings);
    ids.forEach((id, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      btn('결말', scene, x0 + 28 + col * 56, y + row * 26, 52, 20, id, () => {
        const f = fixtures[id];
        controls.previewEnding(judgeEnding(f.stats, f.flags, data.endings));
      }, '9px');
    });
    y += 52;
    const now = label('결말', y - 8, '');
    scene.time.addEvent({
      delay: 500,
      loop: true,
      callback: () => {
        const r = judgeEnding(state.stats, state.flags, data.endings);
        now.setText(`지금 판정: ${r.id} · H ${Math.round(r.happy)} / U ${Math.round(r.unhappy)}`);
      },
    });
  }

  // ── 저장: gating·초기화·JSON·시드 ──
  {
    let y = y0;
    label('저장', y - 16, 'gating · 저장');
    y += 10;
    const bypassLabel = () => `우회 ${session.bypass ? 'ON' : 'OFF'}`;
    btn('저장', scene, x0 + 40, y, 80, 20, bypassLabel(), (b) => {
      session.bypass = !session.bypass;
      b.setLabel(bypassLabel()).setActive(session.bypass);
      controls.onChange();
    }, '10px');
    btn('저장', scene, x0 + 124, y, 80, 20, '열 수 있는 날 +1', () => {
      session.addOpenable(1);
      controls.onChange();
    }, '9px');
    y += 26;
    const shiftDate = (d: number) => {
      setDateOffset(dateOffset() + d);
      session.checkGrant(state);
      controls.onChange();
    };
    btn('저장', scene, x0 + 40, y, 80, 20, '날짜 −1일', () => shiftDate(-1), '10px');
    btn('저장', scene, x0 + 124, y, 80, 20, '날짜 +1일', () => shiftDate(1), '10px');
    y += 18;
    const status = label('저장', y, '');
    const syncStatus = () => {
      const g = session.gating;
      status.setText(
        `열 수 있는 날 ${g.openableDays} · last ${g.lastGrantDate ?? '-'}\n` +
          `forgotten ${g.forgottenDays} (log ${g.forgottenLog.length}) · 오늘 ${today()} (오프셋 ${dateOffset()})`,
      );
    };
    scene.time.addEvent({ delay: 500, loop: true, callback: () => (syncStatus(), syncHeader()) });
    syncStatus();
    y += 34;
    btn('저장', scene, x0 + 40, y, 80, 20, '초기화: 게임만', () => {
      session.resetGame();
      controls.reboot();
    }, '9px');
    btn('저장', scene, x0 + 124, y, 80, 20, '초기화: 전부', () => {
      session.resetAll();
      controls.reboot();
    }, '9px');
    y += 26;
    btn('저장', scene, x0 + 40, y, 80, 20, '저장 JSON 복사', () => {
      const raw = session.rawJson();
      console.info('[debug] 저장 JSON', raw);
      navigator.clipboard?.writeText(raw).catch(() => console.warn('[debug] 클립보드 복사 실패 — 콘솔 참고'));
    }, '9px');
  }

  const bottom = y0 + 26 * ROWS + 12;
  const bg = scene.add
    .rectangle(lane.x + 2, top, lane.w - 4, bottom - top, PANEL_BG, PANEL_ALPHA)
    .setOrigin(0)
    .setDepth(PANEL_DEPTH)
    .setInteractive(); // 패널 뒤로 입력이 새지 않게

  // 접기/펼치기 토글: 포탈 받침 왼쪽 빈 자리 (그리드·레인·포탈 밖)
  let open = false;
  const base = REGION.portalBase;
  const toggle = new Button(scene, base.x + 30, base.y + base.h / 2, 48, 20, '', () => {
    open = !open;
    apply();
  }, '10px');
  toggle.container.setDepth(PANEL_DEPTH + 2);

  function apply(): void {
    toggle.setLabel(open ? 'DBG ▾' : 'DBG ▸').setActive(open);
    bg.setVisible(open);
    if (bg.input) bg.input.enabled = open;
    header.setVisible(open);
    tabBtns.forEach((b, i) => b.setShown(open).setActive(TABS[i] === page));
    for (const [t, p] of pages) {
      const show = open && t === page;
      for (const b of p.buttons) b.setShown(show);
      for (const it of p.items) (it as unknown as Phaser.GameObjects.Components.Visible).setVisible(show);
    }
  }
  syncHeader();
  apply();
}
