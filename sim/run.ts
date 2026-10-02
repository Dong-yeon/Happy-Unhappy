// 자동 플레이 시뮬레이터 CLI (스펙 §8.1). Node 전용: core + data + layout 좌표만 import (Phaser 없음).
//
//   npm run sim -- --policy balanced --seeds 200 --grid 5x4 [--until chapter] [--maxAttempts 50] [--out 파일]   (한 판 = 1챕터, 시도 상한까지)
//   npm run sim -- --policy all [--roster start|all]   (전 정책 + 비교 표. roster all = 디버그 6명 지급, §5.20-10)
//   npm run sim -- --policy bondOn,bondOff --roster all   (인연 켬/끔 비교)
//   npm run sim -- --policy all --session attempts=6,offlineHours=8 [--replayPerfect]   (§5.22-8 세션 모델: 시도 6번마다 8시간 쉼, 잉크 누적)
//   npm run sim -- --compare a.json b.json
//
// JSON 수치를 파일 수정 없이 덮어쓰기 (여러 번 가능, 키는 balance.json 기준 — 다른 파일은 monsters.… 처럼 앞에 붙임)
//   npm run sim -- --policy all --set carry.speedMult=0.8 --set core.hp=120
// 한 키를 여러 값으로 돌려 비교 표 (§5.19-6 진행 목표 충족 여부 포함). --policy를 안 주면 전 정책
//   npm run sim -- --sweep offense.seconds=100,120,140 [--set happy.atk=6]
// 저장 누락 필드 검출 (§5.19-7): 경계마다 저장 round-trip한 실행이 끈 실행과 완전히 같은지 비교
//   npm run sim -- --policy all --seeds 200 --saveRoundTrip
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPreset } from '../src/core/grid';
import { loadGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { applyOverrides, overridesRecord, parseSet, parseSweep, type Override } from './overrides';
import { EXTRA_POLICIES, POLICY_ALIASES } from './policies';
import { POLICIES } from './policies';
import {
  buildReport,
  checkM810Goals,
  checkM811Goals,
  checkM812Goals,
  formatComparison,
  formatCompare,
  formatGoals,
  formatReport,
  formatSweep,
  overridesLine,
  type PolicyReport,
  type RoundTripCheck,
  type SweepRow,
} from './report';
import { runLife, runOne, type Roster } from './runner';
import { serializeGame } from '../src/core/save';
import simJson from './sim.json';
import type { SimConfig } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

interface Args {
  policies: string[];
  policyGiven: boolean;
  seeds: number;
  grid: { cols: number; rows: number };
  out: string | null;
  compare: [string, string] | null;
  sets: Override[];
  /** sim.json 봇 설정 덮어쓰기 (chainSkill 등) */
  simSets: { key: string; value: number }[];
  sweep: { key: string; values: Override[] } | null;
  saveRoundTrip: boolean;
  maxAttempts: number;
  roster: Roster;
  session: { attempts: number; offlineHours: number } | null;
  replayPerfect: boolean;
}

const ALL_POLICIES = { ...POLICIES, ...EXTRA_POLICIES };

function fail(msg: string): never {
  console.error(`sim: ${msg}`);
  process.exit(1);
}

function attempt<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    fail((e as Error).message);
  }
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const getAll = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const cmp = argv.indexOf('--compare');
  const compare: [string, string] | null =
    cmp >= 0 ? (argv[cmp + 1] && argv[cmp + 2] ? [argv[cmp + 1], argv[cmp + 2]] : fail('--compare a.json b.json')) : null;

  const sweepArgs = getAll('sweep');
  if (sweepArgs.length > 1) fail('--sweep은 한 번만 (키 하나)');
  const sweep = sweepArgs.length ? attempt(() => parseSweep(sweepArgs[0])) : null;
  // sim.json 숫자 키(예: chainSkill)나 sim. 접두는 봇 설정 덮어쓰기, 그 밖은 데이터(balance 등)
  const isSimKey = (k: string) => k.startsWith('sim.') || typeof (simJson as Record<string, unknown>)[k] === 'number';
  const rawSets = getAll('set');
  const simSets = rawSets
    .filter((s) => isSimKey(s.slice(0, Math.max(0, s.indexOf('='))).trim()))
    .map((s) => {
      const i = s.indexOf('=');
      const key = s.slice(0, i).trim().replace(/^sim\./, '');
      const value = Number(s.slice(i + 1));
      if (typeof (simJson as Record<string, unknown>)[key] !== 'number' || !Number.isFinite(value)) fail(`--set ${key}: sim.json의 숫자 키가 아님`);
      return { key, value };
    });
  const sets = rawSets.filter((s) => !isSimKey(s.slice(0, Math.max(0, s.indexOf('='))).trim())).map((s) => attempt(() => parseSet(s)));

  const policyArg = get('policy') ?? (sweep ? 'all' : 'balanced');
  const policies =
    policyArg === 'all'
      ? Object.keys(POLICIES)
      : policyArg.split(',').map((p) => {
          const name = POLICY_ALIASES[p] ?? p;
          if (!ALL_POLICIES[name]) fail(`알 수 없는 정책 "${p}" (가능: ${Object.keys(ALL_POLICIES).join(', ')}, all)`);
          return name;
        });

  const seeds = Number(get('seeds') ?? 200);
  if (!Number.isInteger(seeds) || seeds < 1) fail('--seeds는 1 이상의 정수');

  const gridArg = get('grid') ?? '5x4';
  const m = /^(\d+)x(\d+)$/.exec(gridArg);
  if (!m) fail('--grid는 5x4 형식');
  const grid = { cols: Number(m[1]), rows: Number(m[2]) };

  const untilArg = get('until') ?? 'chapter';
  if (untilArg !== 'chapter' && untilArg !== 'life') fail(`--until ${untilArg}: 한 판(1챕터, --until chapter)만 지원합니다`);
  for (const gone of ['dayReset', 'dayMode']) {
    if (get(gone) !== undefined) fail(`--${gone}: 없어졌습니다. 한 판(--until chapter)이 기본입니다`);
  }
  const maxAttempts = Number(get('maxAttempts') ?? (simJson as SimConfig).maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) fail('--maxAttempts는 1 이상의 정수');
  const roster = get('roster') ?? 'start';
  if (roster !== 'start' && roster !== 'all') fail('--roster는 start 또는 all');
  const sessionArg = get('session');
  let session: Args['session'] = null;
  if (sessionArg !== undefined) {
    const kv = Object.fromEntries(sessionArg.split(',').map((x) => x.split('=').map((y) => y.trim())));
    const at = Number(kv.attempts);
    const oh = Number(kv.offlineHours);
    if (!Number.isInteger(at) || at < 1 || !(oh >= 0)) fail('--session attempts=6,offlineHours=8 형식');
    session = { attempts: at, offlineHours: oh };
  }

  return {
    policies,
    policyGiven: get('policy') !== undefined,
    seeds,
    grid,
    out: get('out') ?? null,
    compare,
    sets,
    simSets,
    sweep,
    saveRoundTrip: argv.includes('--saveRoundTrip'),
    maxAttempts,
    roster,
    session,
    replayPerfect: argv.includes('--replayPerfect'),
  };
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 파일 이름에 넣을 --set 요약 (마지막 키 마디=값) */
function setsTag(sets: Override[]): string {
  if (sets.length === 0) return '';
  const tag = sets.map((o) => `${o.path[o.path.length - 1]}=${String(o.value)}`).join('+');
  return `_set_${tag.replace(/[^\w.=+-]/g, '_')}`;
}

/** 정책들을 한 데이터로 돌려 리포트 목록 (verbose면 정책별 요약·파일 저장) */
function runPolicies(args: Args, data: GameData, sets: Override[], cfg: SimConfig, verbose: boolean): PolicyReport[] {
  const reports: PolicyReport[] = [];
  for (const name of args.policies) {
    const started = Date.now();
    const runs = Array.from({ length: args.seeds }, (_, i) =>
      runOne(data, cfg, ALL_POLICIES[name], {
        seed: i + 1,
        grid: args.grid,
        maxAttempts: args.maxAttempts,
        roster: args.roster,
        session: args.session,
        replayPerfect: args.replayPerfect,
      }),
    );
    const report = buildReport(
      name,
      runs,
      {
        seeds: args.seeds,
        grid: `${args.grid.cols}x${args.grid.rows}`,
        maxAttempts: args.maxAttempts,
        roster: args.roster,
        session: args.session ? `attempts=${args.session.attempts},offlineHours=${args.session.offlineHours}` : null,
        replayPerfect: args.replayPerfect,
        ...(sets.length ? { overrides: overridesRecord(sets) } : {}),
      },
      cfg,
    );
    reports.push(report);
    if (verbose) {
      const file =
        args.out ?? join(OUT_DIR, `${today()}_${name}_${args.roster}${setsTag(sets)}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(formatReport(report));
      console.log(`→ ${file} (${((Date.now() - started) / 1000).toFixed(1)}초)\n`);
    }
  }
  return reports;
}

/**
 * --saveRoundTrip: 정책별 시드마다 (a) 끊김 없이 (b) 경계마다 저장 round-trip → RunResult와 최종 상태(serializeGame)가 같은지.
 * 봇 rng는 게임 rng와 별개라 그대로 유지된다.
 */
function checkRoundTrip(args: Args, data: GameData, cfg: SimConfig): RoundTripCheck[] {
  return args.policies.map((name) => {
    let matched = 0;
    const mismatchSeeds: number[] = [];
    for (let seed = 1; seed <= args.seeds; seed++) {
      const opt = { seed, grid: args.grid, maxAttempts: args.maxAttempts, roster: args.roster, session: args.session, replayPerfect: args.replayPerfect };
      const a = runLife(data, cfg, ALL_POLICIES[name], opt);
      const b = runLife(data, cfg, ALL_POLICIES[name], { ...opt, saveRoundTrip: true });
      const boundary = (s: typeof a.state) => s.phase === 'chapterComplete' || s.phase === 'dayStart' || s.phase === 'diary';
      const fin = (s: typeof a.state) => (boundary(s) ? JSON.stringify(serializeGame(s)) : '');
      if (JSON.stringify(a.result) === JSON.stringify(b.result) && fin(a.state) === fin(b.state)) matched += 1;
      else if (mismatchSeeds.length < 5) mismatchSeeds.push(seed);
    }
    return { policy: name, matched, total: args.seeds, mismatchSeeds };
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.compare) {
    const [a, b] = args.compare.map((f) => JSON.parse(readFileSync(f, 'utf8')) as PolicyReport);
    console.log(formatCompare(a, b));
    return;
  }

  const loaded = loadGameData();
  if (!loaded.ok) {
    for (const i of loaded.issues) console.error(`  ${i.path}: ${i.reason}`);
    fail('데이터 검증 실패');
  }
  const base = loaded.data;
  if (!isPreset(base.balance.grid.gridPresets, args.grid)) {
    fail(`--grid ${args.grid.cols}x${args.grid.rows}는 gridPresets에 없음`);
  }
  const cfg = { ...(simJson as SimConfig) } as SimConfig;
  for (const o of args.simSets) (cfg as unknown as Record<string, number>)[o.key] = o.value;
  if (args.simSets.length) console.log(`봇 설정: ${args.simSets.map((o) => `${o.key}=${o.value}`).join(' ')}`);
  mkdirSync(OUT_DIR, { recursive: true });

  // ── --sweep: 값마다 전 정책 → 비교 표 ──
  if (args.sweep) {
    const { key, values } = args.sweep;
    const sweepPath = values[0].path.join('.');
    const fixed = args.sets.filter((s) => s.path.join('.') !== sweepPath);
    if (fixed.length !== args.sets.length) console.warn(`sim: --sweep ${key}와 같은 키의 --set은 무시합니다`);
    if (args.out) fail('--out은 --sweep과 함께 쓰지 않습니다');
    if (!args.policyGiven) console.log('(--policy가 없어 전 정책으로 돌립니다)');

    const rows: SweepRow[] = [];
    for (const v of values) {
      const sets = [...fixed, v];
      const runCfg: SimConfig = cfg;
      const data = attempt(() => applyOverrides(base, sets));
      const started = Date.now();
      const reports = runPolicies(args, data, sets, runCfg, false);
      rows.push({
        value: v.value,
        reports,
        goals: checkM810Goals(reports, runCfg.m810Goals, null).filter((g) => g.id && g.id !== 'roundTrip'),
      });
      console.log(`  ${key}=${JSON.stringify(v.value)} 완료 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
    }
    console.log();
    if (fixed.length) console.log(`고정 --set: ${fixed.map((o) => `${o.path.join('.')}=${JSON.stringify(o.value)}`).join(' ')}`);
    console.log(formatSweep(key, rows));

    // 같은 키를 다른 값으로 다시 돌려도 덮어쓰지 않도록 값 목록과 고정 --set을 이름에 넣는다
    const valuesTag = values.map((v) => String(v.value)).join(',');
    const file = join(
      OUT_DIR,
      `${today()}_sweep_${values[0].path.slice(1).join('.')}=${valuesTag}${setsTag(fixed)}_chapter.json`.replace(/[^\w.=+,-]/g, '_'),
    );
    const compact = rows.map((r) => ({
      value: r.value,
      goals: r.goals.map(({ id, label, pass, detail }) => ({ id, label, pass, detail })),
      policies: Object.fromEntries(
        r.reports.map((p) => [p.policy, { summary: p.summary, completedRate: p.completedRate, completeAttempts: p.completeAttempts, stages: p.stages, soldiersByKind: p.soldiersByKind }]),
      ),
    }));
    writeFileSync(
      file,
      JSON.stringify(
        { version: 1, key: sweepPath, fixed: overridesRecord(fixed), options: rows[0]?.reports[0]?.options, rows: compact },
        null,
        2,
      ),
    );
    console.log(`→ ${file}`);
    return;
  }

  // ── 일반 실행 (--set 적용) ──
  if (args.out && args.policies.length > 1) fail('--out은 정책 하나일 때만');
  const data = args.sets.length ? attempt(() => applyOverrides(base, args.sets)) : base;
  const reports = runPolicies(args, data, args.sets, cfg, true);

  if (reports.length > 1) {
    console.log('■ 정책 비교');
    const ov = overridesLine(reports[0]);
    if (ov) console.log(ov);
    console.log(formatComparison(reports));
    console.log();
  }

  let roundTrip: RoundTripCheck[] | null = null;
  if (args.saveRoundTrip) {
    const started = Date.now();
    roundTrip = checkRoundTrip(args, data, cfg);
    console.log(
      `--saveRoundTrip (${((Date.now() - started) / 1000).toFixed(1)}초): ` +
        roundTrip.map((r) => `${r.policy} ${r.matched}/${r.total}`).join(' · '),
    );
    console.log();
  }
  console.log(formatGoals(checkM810Goals(reports, cfg.m810Goals, roundTrip), '§5.19-6 M8.10 진행 목표 (참고, 판정 출력만)'));
  console.log();
  console.log(formatGoals(checkM811Goals(reports, cfg.m811Goals), '§5.20-10 M8.11 목표 (참고, 판정 출력만)'));
  console.log();
  console.log(formatGoals(checkM812Goals(reports, cfg.m812Goals), '§5.22-8 M8.12 진행 목표 (판정 출력만, 튜닝은 (b))'));
}

main();
