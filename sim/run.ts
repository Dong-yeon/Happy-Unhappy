// 자동 플레이 시뮬레이터 CLI (스펙 §8.1). Node 전용: core + data + layout 좌표만 import (Phaser 없음).
//
//   npm run sim -- --policy balanced --seeds 200 --grid 5x4 --until wave:30 [--dayReset 3] [--out 파일]
//   npm run sim -- --policy idle,random,alwaysHappy,hoarder,balanced ...   (여러 정책 + 비교 표)
//   npm run sim -- --policy all ...
//   npm run sim -- --compare a.json b.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPreset } from '../src/core/grid';
import { loadGameData } from '../src/data';
import { POLICIES, POLICY_ALIASES } from './policies';
import {
  buildReport,
  checkM3Goals,
  formatComparison,
  formatCompare,
  formatGoals,
  formatReport,
  type PolicyReport,
} from './report';
import { runOne } from './runner';
import simJson from './sim.json';
import type { SimConfig } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

interface Args {
  policies: string[];
  seeds: number;
  grid: { cols: number; rows: number };
  untilWave: number;
  dayReset: number | null;
  out: string | null;
  compare: [string, string] | null;
}

function fail(msg: string): never {
  console.error(`sim: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cmp = argv.indexOf('--compare');
  const compare: [string, string] | null =
    cmp >= 0 ? (argv[cmp + 1] && argv[cmp + 2] ? [argv[cmp + 1], argv[cmp + 2]] : fail('--compare a.json b.json')) : null;

  const policyArg = get('policy') ?? 'balanced';
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

  return { policies, seeds, grid, untilWave, dayReset, out: get('out') ?? null, compare };
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
  const data = loaded.data;
  if (!isPreset(data.balance.grid.gridPresets, args.grid)) {
    fail(`--grid ${args.grid.cols}x${args.grid.rows}는 gridPresets에 없음`);
  }
  const cfg = simJson as SimConfig;
  if (args.out && args.policies.length > 1) fail('--out은 정책 하나일 때만');

  mkdirSync(OUT_DIR, { recursive: true });
  const reports: PolicyReport[] = [];
  for (const name of args.policies) {
    const started = Date.now();
    const runs = Array.from({ length: args.seeds }, (_, i) =>
      runOne(data, cfg, POLICIES[name], { seed: i + 1, grid: args.grid, untilWave: args.untilWave, dayReset: args.dayReset }),
    );
    const report = buildReport(
      name,
      runs,
      { seeds: args.seeds, grid: `${args.grid.cols}x${args.grid.rows}`, untilWave: args.untilWave, dayReset: args.dayReset },
      cfg,
    );
    const file = args.out ?? join(OUT_DIR, `${today()}_${name}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    reports.push(report);
    console.log(formatReport(report));
    console.log(`→ ${file} (${((Date.now() - started) / 1000).toFixed(1)}초)\n`);
  }

  if (reports.length > 1) {
    console.log('■ 정책 비교');
    console.log(formatComparison(reports));
    console.log();
  }
  console.log(formatGoals(checkM3Goals(reports, cfg.m3Goals)));
}

main();
