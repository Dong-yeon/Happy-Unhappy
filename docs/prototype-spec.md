# Happy And Unhappy — 프로토타입 스펙 v0.1 (2026-09-29)

> 이 문서는 Claude Code에서 프로토타입을 구현하기 위한 스펙이다. 세계관·기획 배경은 `docs/worldview.md` 참고.
> **프로토타입은 버리는 코드다.** 목적은 재미 검증이며, 본 개발(Godot)로 넘기는 것은 코드가 아니라 이 규칙과 JSON 수치다.

---

## 1. 목적과 판정 기준

### 검증할 가설
"양의 세계(머지 디펜스)를 하다 보면 자연스럽게 음의 세계를 외면하게 되고, 그 결과(그림자 누적 → 역류)가 짜증이 아니라 긴장감으로 느껴지며, 정화한 기억이 양의 세계로 올라오는 연결이 두 세계를 오가게 만든다."

### 재미 판정 기준 (타임박스 종료 시 평가)
| 기준 | 확인 방법 |
|---|---|
| 3일 연속 스스로 켜게 되는가 | metrics: 날짜별 세션 수 |
| 음의 세계를 확인하러 내려가고 싶은가 | metrics: 음 패널 확장 횟수, 정화 확정까지 걸린 시간 |
| 역류가 짜증이 아니라 긴장감인가 | 플레이 후 주관 평가 (메모) |
| 결말 판정이 납득되는가 | 챕터 종료 후 주관 평가 |

### 타임박스
2~4주. 기간 안에 판정이 안 나면 범위를 더 줄이지, 늘리지 않는다.

---

## 2. 범위

### 포함 (In scope)
1. 양의 세계: 3×3 머지 그리드, 조각 3단계, 몬스터 1종 + 역류 보스 1종, 웨이브 10개(= 1챕터)
2. 음의 세계: Unhappy 자동 전투, 층 진행(선형), 정화 확정(수동), 강화 1종(수동)
3. 그림자 게이지 + 역류 보스 웨이브
4. 두 세계 연결: 놓친 몬스터 → 음 강화 / 정화된 기억 → 양 머지 조각
5. 인생 이벤트 1개
6. 챕터 종료 시 결말 판정 (텍스트 출력)
7. 오프라인 진행 (음의 세계만), 로컬 저장
8. 디버그 패널, 플레이 metrics 기록

### 제외 (Out of scope) — 구현하지 않는다
- 도트 에셋, 애니메이션, 사운드, 이펙트, UI 꾸미기 (도형 + 텍스트로만)
- 회차 시스템, 챕터 2 이후, 음의 세계 층 선택(분기)
- 마음 날씨 팔레트 연출 (텍스트 표시만)
- 타이틀 연출, 엔딩 연출 (결말 텍스트만)
- BM, 광고, 서버, 계정, 튜토리얼, 현지화

---

## 3. 기술 스택

| 항목 | 선택 | 비고 |
|---|---|---|
| 엔진 | Phaser 3 (3.x 최신, 설치 시 버전 확인 후 package.json에 고정) | Phaser 4 아님 |
| 언어 | TypeScript | |
| 빌드 | Vite | `vite --host`로 같은 Wi-Fi의 폰에서 테스트 |
| 저장 | localStorage | 키: `hau_save_v1` |
| 데이터 | `src/data/*.json` | Vite JSON import. 수치 하드코딩 금지 |

### 화면
- 세로 고정, 논리 해상도 **360×640**, `Phaser.Scale.FIT` + `CENTER_BOTH`
- 레이아웃

```
y=0   ┌───────────────────────┐
      │ 상단 HUD: 기쁨 / 웨이브 / 마음 날씨(텍스트) │  0~40
      ├───────────────────────┤
      │ 몬스터 필드 (위→아래 이동) │  40~220
      ├───────────────────────┤
      │ 머지 그리드 3×3        │  220~340
      │ [조각 생성] 버튼       │
y=360 ├════════ 수면 ════════┤  ← 몬스터가 여기 닿으면 가라앉음
      │ 음의 세계 요약 뷰       │  360~560
      │  Unhappy / 현재 층 HP  │
      │  정화 대기 기억 [확정]  │
      │  그림자 게이지          │
      ├───────────────────────┤
      │ [강화] [음 패널 확장]   │  560~640
y=640 └───────────────────────┘
```

- 음 패널 확장: 탭하면 음의 세계가 화면 대부분을 차지하는 상세 뷰로 전환 (metrics용. 상세 뷰 내용은 요약 뷰와 같아도 됨)

---

## 4. 핵심 규칙

### 4.1 양의 세계 — 머지 디펜스 (Happy)

**조각 생성**
- [조각 생성] 탭 → 기쁨 `spawnCost` 소모 → 빈 칸 중 랜덤 위치에 1단계 조각
- `spawnCost = spawnCostBase + spawnCostStep × 생성횟수` (챕터 내 누적)
- 빈 칸이 없으면 버튼 비활성

**머지**
- 같은 단계 조각을 드래그해서 겹치면 → 단계 +1 (최대 3단계)
- 다른 단계 / 3단계끼리는 자리 교환만

**공격**
- 모든 조각은 자기 `attackInterval`마다 필드의 몬스터 중 **수면에 가장 가까운 몬스터**를 공격
- 투사체 없음 (즉시 데미지 + 선 1프레임 표시 정도)

**웨이브**
- 웨이브 시작 → `spawnInterval`마다 몬스터 등장, 총 `countBase + countStep × (웨이브-1)`마리
- 몬스터 HP = `hpBase × hpGrowth^(웨이브-1)`
- 몬스터가 수면(y=360)에 닿으면 → **가라앉음** (4.4 연결 규칙)
- 웨이브의 모든 몬스터가 처치 또는 가라앉으면 웨이브 종료 → `waveGap`초 후 다음 웨이브
- 처치 시 기쁨 `joyReward` 획득

### 4.2 음의 세계 — 방치형 (Unhappy)

**"방치"의 정의 (확정안)**
- 전투는 자동. 조작 없이도 Unhappy는 층을 공격하고 내려간다.
- **수동 조작 2가지**: 정화 확정, 강화
- 수동 조작을 미루면 그림자가 쌓이고, 결국 Unhappy가 멈춘다. = 외면

**자동 전투**
- 현재 층 HP = `floorHpBase × floorHpGrowth^(층-1) + 가라앉은 몬스터로 추가된 HP`
- Unhappy가 초당 `dps` 데미지
- 층 HP가 0 → 층 클리어
  - 정화 대기 기억 +1
  - 그림자 조각 +`shardReward`
  - 다음 층으로 자동 이동

**정화 대기 기억과 정화 확정**
- 정화 대기 기억은 최대 `pendingCap`개
- 대기 기억 1개당 그림자 +`pendingShadowPerSec`/초
- **대기 기억이 `pendingCap`개면 Unhappy가 멈춘다** (전투 중단, "지쳐서 멈춤" 텍스트) + 그림자 추가 +`stalledShadowPerSec`/초
- [확정] 탭 → 대기 기억 전부 정화
  - 기억 1개당 그림자 −`confirmShadowReduce`
  - 기억 1개당 양의 세계에 **정화된 기억 조각** 생성 (4.4)

**강화**
- [강화] 탭 → 그림자 조각 `upgradeCost × 현재레벨` 소모 → `dps += dpsPerLevel`

### 4.3 그림자와 역류

- 그림자 게이지 0 ~ `shadowMax` (기본 100)
- 증가: 가라앉은 몬스터, 정화 대기 기억, Unhappy 멈춤, 이벤트에서 Happy 선택
- 감소: 정화 확정, 역류 보스 처치
- **그림자 ≥ `shadowMax`** → 다음 웨이브를 **역류 보스 웨이브**로 교체 (일반 웨이브는 한 칸씩 밀림)
  - 보스 1마리 (HP `bossHp`, 속도 `bossSpeed`)
  - 처치: 그림자 = `shadowAfterBossWin`, 기쁨 +`bossJoyReward`
  - 가라앉음: 그림자 = `shadowAfterBossLose`, 기쁨 −`bossJoyPenalty` (0 미만 안 됨), 현재 층 HP +`bossSinkFloorHp`
- 역류는 챕터 중 여러 번 발생 가능. 역류 발생 횟수는 결말 판정에는 쓰지 않고 metrics에만 기록

**마음 날씨 (텍스트만)**
| 그림자 | 표시 |
|---|---|
| 0~24 | 맑음 |
| 25~49 | 흐림 |
| 50~74 | 비 |
| 75~ | 폭우 |

### 4.4 두 세계 연결

| 방향 | 규칙 |
|---|---|
| 양 → 음 | 몬스터가 수면에 닿으면: 그림자 +`sinkShadow`, 현재 층 HP +`sinkFloorHp` |
| 음 → 양 | 정화 확정한 기억 1개 → 빈 칸에 **`memoryPieceTier`단계 조각** 생성. 빈 칸이 없으면 "대기열"에 쌓였다가 칸이 비는 즉시 배치 |

- 정화된 기억 조각은 일반 조각과 성능이 같다. 구분 표시(테두리 색)만 한다. (metrics: 결말 판정·재미 평가에서 "음이 양을 도왔다"를 체감하는지 보기 위함)

### 4.5 인생 이벤트 (1개)

- 웨이브 `triggerAfterWave` 종료 직후 발생. 게임 일시정지 + 모달
- 텍스트: "친구와 싸운 날. 이 일은 누가 맡을까?"
- 선택지

| 선택 | 효과 |
|---|---|
| Happy가 맡는다 (웃어넘긴다) | 기쁨 +30, 그림자 +20, flag `avoid` |
| Unhappy가 맡는다 (마주한다) | 기쁨 −10, 정화 대기 기억 +1 (특수 기억), flag `face` |

- 특수 기억은 확정 시 그림자 −15 추가, 조각 단계 +1 (최대 3)
- 대기 기억이 이미 `pendingCap`이면 특수 기억은 cap을 무시하고 추가 (cap+1 허용)

### 4.6 챕터 종료와 결말 판정

- 웨이브 10 종료(역류 보스 웨이브는 웨이브 수에 포함하지 않음) → 게임 정지 → 결말 판정 → 결과 화면
- 점수

```
happyScore   = maxTierReached × wMaxTier
             + wavesCleared   × wWave
             + totalJoyEarned × wJoy

unhappyScore = memoriesConfirmed × wMemory
             + floorReached      × wFloor
             + shadowPurified    × wPurified
```

- 판정 (임계값은 `endings.json`)

| 조건 | 결말 |
|---|---|
| happy ≥ T 그리고 unhappy ≥ T 그리고 \|happy − unhappy\| ≤ balanceGap 그리고 flag `face` | (히든) Happy와 Unhappy의 화해 |
| happy ≥ T 그리고 unhappy ≥ T | 단단한 어른 |
| happy ≥ T 그리고 unhappy < T | 웃는 가면의 어른 |
| happy < T 그리고 unhappy ≥ T | 조용한 어른 |
| 둘 다 < T | 비 오는 어른 |

- 결과 화면: 결말 이름, 한 줄 설명, happyScore / unhappyScore, 엔딩 제목 텍스트(예: 웃는 가면 → "Happy"), [다시 시작] 버튼

### 4.7 오프라인 진행

- 저장 시 `lastSavedAt`(epoch ms) 기록
- 로드 시 경과 시간 = `now − lastSavedAt`, 최대 `offlineCapSec`(기본 8시간)으로 자름
- **음의 세계만** 1초 단위로 시뮬레이션 (전투, 층 클리어, 대기 기억, 그림자 증가, 멈춤)
- 양의 세계는 오프라인 진행 없음 (웨이브는 정지 상태로 복귀)
- 복귀 시 요약 모달: "자리를 비운 동안: 층 +N, 정화 대기 기억 N개, 그림자 +N"
- 의도: 대기 기억 cap 때문에 오래 비울수록 Unhappy가 멈춰 있고 그림자가 쌓인다 → 돌아와서 확정하고 싶게 만든다
- 오프라인 중 그림자가 `shadowMax`에 도달하면 복귀 후 첫 웨이브가 역류 보스 웨이브

**엣지 케이스**
- `now < lastSavedAt` (기기 시간을 되돌림) → 경과 0으로 처리
- 저장 데이터 파싱 실패 / `version` 불일치 → 저장 초기화 + 콘솔 경고 (프로토타입이므로 마이그레이션 안 함)
- 저장 시점: 웨이브 종료, 확정, 강화, 이벤트 선택, `visibilitychange`(hidden), 10초 주기

---

## 5. 데이터 파일 (JSON)

모든 수치는 아래 파일에서 읽는다. 아래 값은 **임시 값**이며 플레이하면서 조정한다.

### `src/data/balance.json`
```json
{
  "version": 1,
  "start": { "joy": 50, "shadow": 0 },
  "merge": {
    "gridCols": 3,
    "gridRows": 3,
    "spawnCostBase": 10,
    "spawnCostStep": 2,
    "maxTier": 3,
    "memoryPieceTier": 2
  },
  "wave": {
    "wavesPerChapter": 10,
    "countBase": 8,
    "countStep": 2,
    "spawnInterval": 1.2,
    "waveGap": 3
  },
  "abyss": {
    "floorHpBase": 100,
    "floorHpGrowth": 1.25,
    "dpsBase": 5,
    "dpsPerLevel": 2,
    "upgradeCost": 10,
    "shardReward": 5,
    "pendingCap": 3,
    "pendingShadowPerSec": 0.05,
    "stalledShadowPerSec": 0.1,
    "confirmShadowReduce": 8
  },
  "shadow": {
    "shadowMax": 100,
    "sinkShadow": 4,
    "sinkFloorHp": 15,
    "shadowAfterBossWin": 30,
    "shadowAfterBossLose": 60
  },
  "offline": { "offlineCapSec": 28800 }
}
```

### `src/data/pieces.json`
```json
[
  { "tier": 1, "damage": 5,  "attackInterval": 1.0 },
  { "tier": 2, "damage": 12, "attackInterval": 0.9 },
  { "tier": 3, "damage": 30, "attackInterval": 0.8 }
]
```

### `src/data/monsters.json`
```json
{
  "worry": { "name": "걱정", "hpBase": 20, "hpGrowth": 1.15, "speed": 40, "joyReward": 3 },
  "backflowBoss": {
    "name": "역류",
    "hp": 400,
    "speed": 25,
    "joyReward": 50,
    "joyPenalty": 30,
    "sinkFloorHp": 100
  }
}
```

### `src/data/events.json`
```json
[
  {
    "id": "friend_fight",
    "triggerAfterWave": 5,
    "text": "친구와 싸운 날. 이 일은 누가 맡을까?",
    "choices": [
      { "id": "happy",   "label": "Happy가 맡는다 (웃어넘긴다)", "flag": "avoid", "joy": 30,  "shadow": 20, "specialMemory": false },
      { "id": "unhappy", "label": "Unhappy가 맡는다 (마주한다)", "flag": "face",  "joy": -10, "shadow": 0,  "specialMemory": true }
    ],
    "specialMemory": { "extraShadowReduce": 15, "tierBonus": 1 }
  }
]
```

### `src/data/endings.json`
```json
{
  "weights": {
    "wMaxTier": 20, "wWave": 5, "wJoy": 0.05,
    "wMemory": 15, "wFloor": 5, "wPurified": 0.5
  },
  "threshold": 100,
  "balanceGap": 15,
  "endings": {
    "hidden":  { "name": "Happy와 Unhappy의 화해", "title": "(Un)Happy",          "desc": "불행 속에도 행복이 들어 있었어." },
    "solid":   { "name": "단단한 어른",            "title": "Happy And Unhappy",  "desc": "슬픔을 안고도 웃을 수 있는 어른." },
    "mask":    { "name": "웃는 가면의 어른",       "title": "Happy",              "desc": "늘 웃지만, 어딘가 비어 있다." },
    "quiet":   { "name": "조용한 어른",            "title": "Unhappy",            "desc": "아픔을 알지만 웃는 법을 잊었다." },
    "rainy":   { "name": "비 오는 어른",           "title": "Happy And Unhappy",  "desc": "쓸쓸하지만, 우산을 건네는 누군가가 있다." }
  }
}
```

- JSON 로드 직후 **필수 키·타입 검증** (누락 시 에러 화면에 어떤 키가 빠졌는지 표시). 수치 오타로 조용히 NaN이 퍼지는 것을 막기 위함.

---

## 6. 상태와 저장 데이터

```ts
interface SaveData {
  version: 1;
  lastSavedAt: number;           // epoch ms
  chapter: {
    wave: number;                // 1~10
    pendingBackflow: boolean;    // 다음 웨이브가 역류 보스인가
    spawnCount: number;
    eventDone: string[];         // 완료한 이벤트 id
    flags: string[];             // "avoid" | "face"
  };
  happy: {
    joy: number;
    grid: (number | null)[];     // 길이 9, 조각 단계 또는 null
    memoryFlags: boolean[];      // 길이 9, 정화된 기억 조각 여부
    memoryQueue: number[];       // 배치 대기 중인 기억 조각 단계
  };
  unhappy: {
    floor: number;
    floorHpLeft: number;
    dpsLevel: number;
    shards: number;
    pendingMemories: { special: boolean }[];
  };
  shadow: number;
  stats: {                       // 결말 판정 입력값
    maxTierReached: number;
    wavesCleared: number;
    totalJoyEarned: number;
    memoriesConfirmed: number;
    floorReached: number;
    shadowPurified: number;
  };
}
```

- 웨이브 진행 중인 몬스터는 저장하지 않는다. 로드 시 현재 웨이브를 처음부터 다시 시작.

---

## 7. 디버그 패널과 metrics

### 디버그 패널 (`?debug=1`일 때만 표시)
- 시간 배속 ×1 / ×5 / ×20
- 그림자 값 설정, 기쁨 +100, 그림자 조각 +100
- 웨이브 건너뛰기, 즉시 챕터 종료(결말 판정)
- 오프라인 N시간 시뮬레이션 (1h / 8h)
- 저장 초기화

### metrics (localStorage `hau_metrics_v1`, 디버그 패널에서 JSON 복사 가능)
- 세션 시작 시각 목록
- 음 패널 확장 횟수
- 정화 대기 기억 생성 → 확정까지 걸린 시간 (평균)
- Unhappy 멈춤 누적 시간
- 역류 발생 횟수, 보스 처치/실패 횟수
- 이벤트 선택 결과
- 챕터 결과 (결말, 점수, 소요 시간)

---

## 8. 폴더 구조 (권장)

```
happy-and-unhappy-proto/
├─ CLAUDE.md
├─ docs/
│  ├─ worldview.md
│  └─ prototype-spec.md
├─ src/
│  ├─ main.ts
│  ├─ data/            # JSON + 검증
│  ├─ core/            # 순수 로직 (Phaser 의존 없음)
│  │   ├─ merge.ts
│  │   ├─ wave.ts
│  │   ├─ abyss.ts     # 음의 세계 1초 tick → 오프라인 시뮬레이션 재사용
│  │   ├─ shadow.ts
│  │   ├─ ending.ts
│  │   └─ save.ts
│  ├─ scenes/          # Phaser Scene (표시·입력만)
│  └─ debug/
└─ package.json
```

- **로직(core)과 표시(scenes)를 분리**한다. 규칙을 Godot으로 옮길 때 참조하기 쉽고, 오프라인 시뮬레이션이 같은 tick 함수를 재사용한다.
- core는 단위 테스트 가능하게 (Vitest). 최소 테스트 대상: 머지, 결말 판정, 오프라인 시뮬레이션, 저장 로드 실패 처리.

---

## 9. 구현 순서 (마일스톤)

| 순서 | 내용 | 완료 조건 |
|---|---|---|
| M1 | 프로젝트 셋업, JSON 로드·검증, 화면 레이아웃 | 폰 브라우저에서 세로 화면 표시 |
| M2 | 머지 그리드 + 조각 생성 + 웨이브 + 몬스터 | 웨이브 10개 플레이 가능 |
| M3 | 음의 세계 자동 전투 + 정화 확정 + 강화 | 층 진행, 대기 기억 cap에서 멈춤 확인 |
| M4 | 연결 규칙 + 그림자 + 역류 보스 | 방치 시 역류 발생 확인 |
| M5 | 인생 이벤트 + 결말 판정 | 5개 결말 모두 디버그로 도달 확인 |
| M6 | 저장/로드 + 오프라인 진행 + metrics | 앱 종료 후 재접속 시 요약 모달 |
| — | 3일 이상 실제 플레이 → 판정 | 1장 판정 기준 평가 |

---

## 10. CLAUDE.md 초안 (repo 루트에 복사)

```markdown
# Happy And Unhappy — Prototype

## 이 repo의 성격
- 재미 검증용 프로토타입. 버리는 코드. 본 개발은 Godot에서 새로 한다.
- 스펙: docs/prototype-spec.md / 세계관: docs/worldview.md

## 규칙
- 스펙의 "제외" 항목은 구현하지 않는다. 범위 밖 기능이 필요해 보이면 구현 전에 물어본다.
- 수치는 src/data/*.json에서만 읽는다. 코드에 밸런스 수치 하드코딩 금지.
- 게임 규칙은 src/core에 Phaser 의존 없이 작성한다. scenes는 표시와 입력만 담당.
- 에셋은 도형 + 텍스트만 사용한다.
- 스택: Phaser 3 (package.json에 버전 고정) + TypeScript + Vite. Phaser 4 API를 섞지 않는다.
- core 변경 시 Vitest 테스트를 함께 수정한다.
```
