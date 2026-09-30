// 자동 플레이 시뮬레이터 CLI (스펙 §8.1). Node 전용: core + data + layout 좌표만 import (Phaser 없음).
//
//   npm run sim -- --policy balanced --seeds 200 --grid 5x4 --until wave:30 [--dayReset 3] [--out 파일]
//   npm run sim -- --policy all --seeds 200 --grid 5x4 --dayMode m5      (M5 하루 구조 근사, 14일 = 42웨이브)
//   npm run sim -- --policy idle,random,alwaysHappy,hoarder,balanced ...   (여러 정책 + 비교 표)
//   npm run sim -- --compare a.json b.json
//
// JSON 수치를 파일 수정 없이 덮어쓰기 (여러 번 가능, 키는 balance.json 기준 — 다른 파일은 monsters.… 처럼 앞에 붙임)
//   npm run sim -- --policy all --dayMode m5 --set shadow.shadowAfterBossWin=50 --set abyss.unhappyStallShadowPerSec=0.15
// 한 키를 여러 값으로 돌려 비교 표 (§8.2 M4 목표 충족 여부 포함). --policy를 안 주면 전 정책
//   npm run sim -- --dayMode m5 --sweep abyss.unhappyStallShadowPerSec=0.1,0.2,0.3 [--set happy.atk=6]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPreset } from '../src/core/grid';
import { loadGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { applyOverrides, overridesRecord, parseSet, parseSweep, type Override } from './overrides';
import { POLICIES, POLICY_ALIASES } from './policies';
import {
  buildReport,
  checkM3Goals,
  checkM4Goals,
  formatComparison,
  formatCompare,
  formatGoals,
  formatReport,
  formatSweep,
  overridesLine,
  type PolicyReport,
  type SweepRow,
} from './report';
import { m5LastWave, runOne } from './runner';
import simJson from './sim.json';
import type { SimConfig } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

interface Args {
  policies: string[];
  policyGiven: boolean;
  seeds: number;
  grid: { cols: number; rows: number };
  untilWave: number;
  dayReset: number | null;
  dayMode: 'm5' | null;
  untilGiven: boolean;
  out: string | null;
  compare: [string, string] | null;
  sets: Override[];
  sweep: { key: string; values: Override[] } | null;
}

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
  const sets = getAll('set').map((s) => attempt(() => parseSet(s)));

  const policyArg = get('policy') ?? (sweep ? 'all' : 'balanced');
  const policies =
    policyArg === 'all'
      ? Object.keys(POLICIES)
      : policyArg.split(',').map((p) => {
          const name = POLICY_ALIASES[p] ?? p;
          if (!POLICIES[name]) fail(`알 수 없는 정책 "${p}" (가능: ${Object.keys(POLICIES).join(', ')}, all)`);
          return name;
        });

  const seeds = Number(get('seeds') ?? 200);
  if (!Number.isInteger(seeds) || seeds < 1) fail('--seeds는 1 이상의 정수');

  const gridArg = get('grid') ?? '5x4';
  const m = /^(\d+)x(\d+)$/.exec(gridArg);
  if (!m) fail('--grid는 5x4 형식');
  const grid = { cols: Number(m[1]), rows: Number(m[2]) };

  const untilArg = get('until') ?? 'wave:30';
  const u = /^wave:(\d+)$/.exec(untilArg);
  if (!u) fail('--until은 wave:N 형식 (life는 M5에서)');
  const untilWave = Number(u[1]);
  if (untilWave < 1) fail('--until wave:N은 1 이상');

  const dr = get('dayReset');
  const dayReset = dr === undefined ? null : Number(dr);
  if (dayReset !== null && (!Number.isInteger(dayReset) || dayReset < 1)) fail('--dayReset은 1 이상의 정수');

  const dm = get('dayMode');
  if (dm !== undefined && dm !== 'm5') fail('--dayMode는 m5만 지원');
  const dayMode = dm === 'm5' ? 'm5' : null;
  if (dayMode && dayReset !== null) fail('--dayMode m5는 생성 횟수 리셋을 포함하므로 --dayReset과 함께 쓰지 않습니다');

  return {
    policies,
    policyGiven: get('policy') !== undefined,
    seeds,
    grid,
    untilWave,
    dayReset,
    dayMode,
    untilGiven: get('until') !== undefined,
    out: get('out') ?? null,
    compare,
    sets,
    sweep,
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
  const untilWave = args.dayMode === 'm5' ? m5LastWave(data) : args.untilWave;
  const reports: PolicyReport[] = [];
  for (const name of args.policies) {
    const started = Date.now();
    const runs = Array.from({ length: args.seeds }, (_, i) =>
      runOne(data, cfg, POLICIES[name], {
        seed: i + 1,
        grid: args.grid,
        untilWave,
        dayReset: args.dayReset,
        dayMode: args.dayMode,
      }),
    );
    const report = buildReport(
      name,
      runs,
      {
        seeds: args.seeds,
        grid: `${args.grid.cols}x${args.grid.rows}`,
        untilWave,
        dayReset: args.dayReset,
        dayMode: args.dayMode,
        wavesPerDay: data.balance.wave.wavesPerDay,
        ...(sets.length ? { overrides: overridesRecord(sets) } : {}),
      },
      cfg,
    );
    reports.push(report);
    if (verbose) {
      const file =
        args.out ?? join(OUT_DIR, `${today()}_${name}${args.dayMode ? `_${args.dayMode}` : ''}${setsTag(sets)}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(formatReport(report));
      console.log(`→ ${file} (${((Date.now() - started) / 1000).toFixed(1)}초)\n`);
    }
  }
  return reports;
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
  const cfg = simJson as SimConfig;
  if (args.dayMode === 'm5' && args.untilGiven) {
    console.warn(`sim: --dayMode m5는 ${m5LastWave(base)}웨이브에서 끝나므로 --until은 무시합니다`);
  }
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
      const data = attempt(() => applyOverrides(base, sets));
      const started = Date.now();
      const reports = runPolicies(args, data, sets, cfg, false);
      rows.push({ value: v.value, reports, goals: checkM4Goals(reports, cfg.m4Goals) });
      console.log(`  ${key}=${JSON.stringify(v.value)} 완료 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
    }
    console.log();
    if (fixed.length) console.log(`고정 --set: ${fixed.map((o) => `${o.path.join('.')}=${JSON.stringify(o.value)}`).join(' ')}`);
    console.log(formatSweep(key, rows));
    if (args.dayMode !== 'm5') console.log('※ M4 목표는 --dayMode m5 기준입니다. 이번 표는 참고용.');

    const file = join(OUT_DIR, `${today()}_sweep_${values[0].path.slice(1).join('.')}${args.dayMode ? `_${args.dayMode}` : ''}.json`);
    const compact = rows.map((r) => ({
      value: r.value,
      goals: r.goals.map(({ id, label, pass, detail }) => ({ id, label, pass, detail })),
      policies: Object.fromEntries(r.reports.map((p) => [p.policy, { summary: p.summary, tierShare: p.tierShare }])),
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
  console.log(formatGoals(checkM3Goals(reports, cfg.m3Goals)));
  console.log();
  console.log(formatGoals(checkM4Goals(reports, cfg.m4Goals), '§8.2 M4 부분 목표'));
}

main();
