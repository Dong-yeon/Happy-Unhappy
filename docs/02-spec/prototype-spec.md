# Happy And Unhappy — 프로토타입 스펙 v0.2 (2026-09-30)

> Claude Code에서 프로토타입을 구현하기 위한 스펙이다.
> 기획 배경: `docs/01-planning/worldview.md` / 결정 근거: `docs/03-decisions/decision-log.md` (D-010 ~ D-016)
> **프로토타입은 버리는 코드다.** 목적은 재미 검증이며, 본 개발(Godot)로 넘기는 것은 코드가 아니라 이 규칙과 JSON 수치다.

### v0.1 → v0.2 변경 요약
| v0.1 | v0.2 |
|---|---|
| 포탑형 머지 디펜스 (조각이 그리드에서 공격) | 조각은 그리드에서 공격하지 않음. **위/아래 통로로 보내 소환** (D-010) |
| 음의 세계 = 방치형 자동 진행 + 정화 확정 | 음의 세계 = **심연 레인**. 아래로 보낸 유닛이 전진해 층을 뚫음 (D-013) |
| 조각 3단계 단일 종류 | **추억 체인 2개 × 3단계**, 3단계 = 영웅 (D-011) |
| 웨이브 10개 = 1챕터 | **하루 = 한 판** (아침·낮·저녁 3웨이브), 14일 (D-014) |
| 오프라인 진행 | **없음**. 대신 하루 진행 C안 (일일 제한 + 밀린 날 보관) (D-015) |
| 3×3 그리드 | 그리드 크기 파라미터 (4×4 / 5×4 / 6×4 비교) (D-012) |

---

## 1. 목적과 판정 기준

### 검증할 가설
| # | 가설 | 핵심 지표 |
|---|---|---|
| H1 | "위로 보낼까, 아래로 보낼까"가 매번 고민되는 선택이다 | 아래로 보낸 비율이 한쪽(0~10% 또는 90~100%)으로 쏠리지 않음 |
| H2 | "지금 보낼까, 더 합칠까"가 긴장을 만든다 | 소환 시 단계 분포가 한 단계에 몰리지 않음 |
| H3 | 정화 성공 → 단계 +1 귀환이 아래로 보낼 동기가 된다 | 아래 레인 성공 후 다음 아래 소환까지의 간격 |
| H4 | 하루 한 판(3~5분)이 완결감 있고, 다음 날이 기다려진다 | 판 평균 시간, 실제 날짜별 접속 |
| H5 | 추억 체인·영웅 소환이 수집 동기가 된다 | 체인별 3단계 도달 횟수, 영웅 최초 소환 시점 |
| H6 | 그리드 막힘이 짜증이 아니라 전략으로 느껴진다 | 그리드 가득 참 시간 비율, 놓아주기 횟수 + 주관 평가 |

### 재미 판정 기준 (타임박스 종료 시)
- 3일 이상 연속으로 스스로 켜게 되는가 (metrics: 실제 날짜별 세션)
- 아래로 보내는 것이 "손해"가 아니라 "투자"로 느껴지는가 (주관)
- 역류가 짜증이 아니라 긴장감인가 (주관)
- 그림일기를 읽게 되는가 (주관)

### 타임박스
2~4주. 기간 안에 판정이 안 나면 범위를 줄이지, 늘리지 않는다.

---

## 2. 범위

### 포함 (In scope)
1. 머지 그리드 (크기 파라미터), 추억 체인 2개 × 3단계, 영웅 2명, 와일드카드 1종, 놓아주기
2. 두 통로 소환 (위 = 방어 레인, 아래 = 심연 레인)
3. 레인 자동 전투 — **방어/공격 공용 코드, 방향 파라미터만 다름**
4. Happy 거점, Unhappy 정지 규칙
5. 그림자 게이지 + 역류 보스 웨이브
6. 하루 = 한 판 (3웨이브), 14일, 이벤트(이정표 1 / 계절 1 / 일상 4 / 평범한 하루)
7. 이정표 선택 (Happy가 맡을까 / Unhappy가 맡을까)
8. 그림일기 (템플릿 조합 텍스트), 일기장 목록 화면
9. 하루 진행 C안 (일일 제한 + 밀린 날 보관)
10. 14일 종료 시 결말 판정 (텍스트)
11. 로컬 저장, 디버그 패널, metrics

### 제외 (Out of scope) — 구현하지 않는다
- 도트 에셋, 애니메이션, 사운드, 이펙트, UI 꾸미기 (도형 + 텍스트만)
- 세계 2개 이상 (단, 데이터에 `world` 필드는 둔다)
- 오프라인 진행, 회차, 추억 도감 보상, 영웅 고유 스킬
- 타이틀·엔딩 연출, 마음 날씨 팔레트 연출 (텍스트 표시만)
- BM, 광고, 서버, 계정, 튜토리얼, 현지화, 실제 날짜 연동 이벤트(실제 크리스마스 등)

---

## 3. 기술 스택

| 항목 | 선택 | 비고 |
|---|---|---|
| 엔진 | Phaser 3 (3.x 최신, 설치 시 버전 확인 후 package.json에 고정) | Phaser 4 아님 |
| 언어 | TypeScript | |
| 빌드 | Vite | `vite --host`로 같은 Wi-Fi의 폰에서 테스트 |
| 테스트 | Vitest | core만 대상 |
| 저장 | localStorage | 키: `hau_save_v2`, metrics: `hau_metrics_v2` |
| 데이터 | `src/data/*.json` | Vite JSON import. 수치 하드코딩 금지. 로드 직후 스키마 검증 |

### 화면
- 세로 고정, 논리 해상도 **360×640**, `Phaser.Scale.FIT` + `CENTER_BOTH`
- 레이아웃 (그리드 6×4 기준. 4×4·5×4는 가운데 정렬)

```
y=0   ┌──────────────────────────────┐
      │ HUD: 8살 · 3일째 · 낮 │ 기쁨 │ 마음 날씨 │   0~36
      ├──────────────────────────────┤
      │ 방어 레인 (걱정이 위→아래로 내려옴)  │  36~206
      │ ── 방어선 (Happy 거점 + 방어 유닛) ── │  y=206
      ├──────── ▲ 위로 보내기 영역 ▲ ──────┤ 206~230
      │                                │
      │   머지 그리드 (수면)  칸 52×40    │ 230~400
      │                                │
      ├──────── ▼ 아래로 보내기 영역 ▼ ────┤ 400~424
      │ Unhappy + 심연 유닛 (위→아래 전진)  │ 424~584
      │ ── 그림자 벽 (현재 층 HP) ──        │  y=584
      ├──────────────────────────────┤
      │ [조각 생성 (비용)] [놓아주기] 그림자■■□ │ 584~640
y=640 └──────────────────────────────┘
```

- 칸 크기는 최소 40×40 논리 픽셀 (폰에서 터치 가능한 크기).
- 조각 표시: 체인별 색 + 단계 숫자, 영웅은 ★, 와일드카드는 흰색 "?".

---

## 4. 핵심 규칙

### 4.1 머지 그리드

**조각 생성**
- [조각 생성] 탭 → 기쁨 `spawnCost` 소모 → 빈 칸 랜덤 위치에 1단계 조각
- `spawnCost = spawnCostBase + spawnCostStep × 오늘 생성 횟수` (하루 시작 시 횟수 리셋)
- 체인 선택: `chains.json`의 `spawnWeight` × 오늘 이벤트의 체인 가중치 보정
- 빈 칸이 없으면 버튼 비활성

**머지**
- 같은 체인 + 같은 단계를 드래그로 겹치면 → 단계 +1 (최대 3)
- 와일드카드를 조각 위에 놓으면 → 그 조각 단계 +1 (3단계 위에는 불가)
- 와일드카드끼리는 합쳐지지 않음
- 그 외 조합은 자리 교환

**놓아주기**
- [놓아주기] 모드에서 조각 탭 → 조각 제거, 기쁨 `releaseRefund × 단계` 환급
- 와일드카드는 놓아주기 불가

**귀환 대기열**
- 심연에서 귀환하는 조각·보상 와일드카드는 빈 칸에 배치. 빈 칸이 없으면 대기열 → 칸이 비는 즉시 배치
- 대기열 최대 `returnQueueCap`. 초과분은 소실 (metrics 기록)

### 4.2 소환

- 조각을 **위로 보내기 영역** 또는 **아래로 보내기 영역**에 드롭 → 해당 레인에 유닛 소환, 조각은 그리드에서 제거
- 레인 유닛 수가 `laneCap`이면 드롭 거부 (조각은 원위치)
- 와일드카드는 소환 불가
- 유닛 능력치: 1~2단계 = 공용 "추억 정령" (`units.json` 단계별), 3단계 = 체인별 영웅 (`chains.json`)
- 유닛은 출신 체인과 단계를 기억한다 (귀환 시 사용)

### 4.3 레인 전투 (공용 코드)

두 레인은 **같은 전투 모듈**을 쓰고 방향과 적 종류만 다르다.

```ts
type LaneKind = 'defense' | 'abyss';
// defense: 적(걱정)이 위에서 내려오고, 유닛은 방어선에 정지
// abyss:   적(그림자 벽)은 고정, 유닛이 위에서 아래로 전진
```

**공통**
- 유닛: `hp`, `atk`, `atkInterval`, `range`(y축 거리)
- 1차원(y축) 전투. 레인 안에서 유닛은 가로로 겹치지 않게 표시만 분산
- 타깃: 사거리 안에서 가장 가까운 적

**방어 레인 (Happy 쪽)**
- 걱정은 레인 위쪽에서 등장, `speed`로 내려옴
- 방어선(y=206)에 도달한 걱정은 멈추고 방어선의 유닛 중 하나를 공격 (`atk`, `atkInterval`)
- 방어선에 유닛이 **하나도 없으면** 걱정은 방어선을 통과 → **가라앉음** (4.5)
- Happy: 방어선 중앙의 거점. **쓰러지지 않음.** 약한 공격(`happy.atk`)만 함. 걱정의 공격 대상이 되지 않음
- 걱정 처치 → 즉시 기쁨 `joyReward`
- 유닛 hp 0 → 소멸 (페널티 없음)

**심연 레인 (Unhappy 쪽)**
- 레인 아래 끝에 그림자 벽(현재 층). 층 HP = `layerHpBase × layerHpGrowth^(층-1) + 가라앉은 걱정으로 누적된 추가 HP`
- 유닛은 `advanceSpeed`로 아래로 전진, 벽이 사거리 안에 들어오면 멈추고 공격
- 그림자 벽은 `counterAtkInterval`마다 **가장 앞의 유닛**에게 `counterAtk` 피해
- 유닛 hp 0 → **조각 소실 + 그림자 +`abyssDeathShadow`**
- **층 돌파 (HP 0)**
  - 레인의 살아 있는 모든 유닛이 빛 조각이 되어 **단계 +1로 그리드에 귀환** (출신 체인 유지)
  - 3단계 영웅은 단계를 올릴 수 없으므로 **와일드카드 1개**로 귀환 + `heroFirstPurify` 기록 (도감 진척)
  - 그림자 −`layerClearShadowReduce`
  - 다음 층 생성
- **Unhappy**: 레인 맨 앞에 표시. 공격하지 않음. **심연 레인에 유닛이 0기이면 "멈춤" 상태** → 그림자 +`unhappyStallShadowPerSec`/초 (웨이브 진행 중에만)

### 4.4 그림자와 역류

- 그림자 0 ~ `shadowMax`
- 증가: 가라앉은 걱정, 심연 유닛 사망, Unhappy 멈춤, 이정표에서 Happy 선택
- 감소: 층 돌파, 역류 보스 처치
- **그림자 ≥ `shadowMax`** → 다음 웨이브를 **역류 보스 웨이브**로 교체 (그날의 남은 웨이브 중 다음 것. 저녁 웨이브 이후라면 다음 날 아침)
  - 보스 1마리 (`monsters.json`의 `backflowBoss`)
  - 처치: 그림자 = `shadowAfterBossWin`, 기쁨 +`bossJoyReward`
  - 통과(가라앉음): 그림자 = `shadowAfterBossLose`, 기쁨 −`bossJoyPenalty`(0 미만 불가), 현재 층 HP +`bossSinkLayerHp`
- 마음 날씨 (텍스트): 0~24 맑음 / 25~49 흐림 / 50~74 비 / 75~ 폭우

### 4.5 두 세계 연결

| 방향 | 규칙 |
|---|---|
| 양 → 음 | 걱정이 방어선을 통과(가라앉음): 그림자 +`sinkShadow`, 현재 층 HP +`sinkLayerHp` |
| 음 → 양 | 층 돌파: 살아 있는 심연 유닛이 단계 +1 조각으로 그리드에 귀환 (4.3) |

---

## 5. 하루 구조

### 5.1 하루의 흐름
```
하루 시작
 → 오늘의 이벤트 카드 표시 (탭하여 닫기)  ※ 이정표면 선택 모달
 → 이벤트 효과 적용 (조각 지급, 체인 가중치, 걱정 강도 등)
 → 아침 웨이브 → 간격 → 낮 웨이브 → 간격 → 저녁 웨이브
 → 하루 끝 처리 (5.3)
 → 그림일기 표시 → 저장 → "내일로" 또는 "오늘은 여기까지"
```
- 웨이브: 걱정 `countBase + countStep × (일차-1)`마리, `spawnInterval` 간격, HP = `hpBase × hpGrowthPerDay^(일차-1)`
- 이벤트의 `worryMultiplier`가 그날 걱정 수·HP에 곱해진다
- 판 길이 목표: 3~5분 (metrics로 측정)

### 5.2 이벤트
- 14일 캘린더는 `days.json`에서 정의
  - 고정: 이정표 1개 (7일째), 계절 1개 (10일째, 생일)
  - 나머지 날: `dailyEventChance` 확률로 일상 이벤트 풀에서 1개, 아니면 평범한 하루
  - 같은 일상 이벤트는 `dailyEventCooldownDays`일 안에 반복하지 않음
- 이정표 선택 (Happy / Unhappy 누가 맡을까)
  | 선택 | 효과 |
  |---|---|
  | Happy가 맡는다 (웃어넘긴다) | 기쁨 +, 그림자 +, flag `avoid` |
  | Unhappy가 맡는다 (마주한다) | 기쁨 −, 그날 심연 층 HP −(`faceLayerHpReduce`), 그날 심연 유닛 귀환 시 추가 조각 1개, flag `face` |

### 5.3 하루 끝 처리
- 방어 레인 유닛: **해산** (소멸, 페널티 없음)
- 심연 레인 유닛: **단계 그대로** 그리드로 귀환 (빈칸 없으면 대기열)
- 그리드·그림자·심연 층 진행도는 다음 날로 이어짐
- 오늘의 stats로 그림일기 생성

### 5.4 그림일기
- 문장 = `이벤트 문장` + `결과 문장` (`diary.json` 템플릿)
- 결과 문장 선택 규칙 (우선순위 순, 첫 번째 일치)
  1. 역류가 있었던 날 → "마음에 큰 비가 내렸다." 계열
  2. 층을 돌파한 날 → "오래된 기억 하나가 조금 가벼워졌다." 계열
  3. 가라앉은 걱정 ≥ `diarySinkThreshold` → "걱정 몇 개를 그냥 삼켜버렸다." 계열
  4. 기본 → "그래도 괜찮은 하루였다." 계열
- 같은 계열 안에서는 랜덤, 직전 날과 같은 문장 회피
- 일기장 화면: 지금까지의 일기 목록 (일차, 이벤트명, 문장)

### 5.5 하루 진행 C안 (일일 제한 + 밀린 날 보관)
- 실제 날짜(기기 로컬 날짜 `YYYY-MM-DD`)가 바뀔 때마다 열 수 있는 날 +`dailyLimit`, 최대 `storeCap`까지 보관
- 첫 실행 시 `dailyLimit`만큼 지급
- 열 수 있는 날이 0이면 "내일 또 만나요" 화면 (디버그로 우회 가능)
- 보관 한도를 넘어 버려진 날: 게임 안 날짜는 진행하지 않음. **"기억나지 않는 날"** 일기 항목만 추가 (벌칙 없음, 그림자 변화 없음). 단, 14일 일생 길이에는 포함하지 않음 (프로토타입에서는 카운트만 metrics에 기록)
- **엣지 케이스**
  - 기기 날짜를 되돌림 (`today < lastGrantDate`) → 지급 없음, `lastGrantDate` 유지
  - 며칠 만에 접속 → 지난 날 수 × `dailyLimit` 지급 후 `storeCap`으로 자름, 버려진 수 기록
  - 한 판 도중 날짜가 바뀜 → 진행 중인 판은 그대로 계속, 지급은 다음 판 시작 전에 처리

### 5.6 결말 판정 (14일째 종료 후)

```
happyScore   = sentUpTierSum      × wUpTier
             + worriesDefeated    × wDefeat
             + totalJoyEarned     × wJoy

unhappyScore = sentDownTierSum    × wDownTier
             + layersCleared      × wLayer
             + shadowPurified     × wPurified
```

| 조건 (위에서부터 첫 번째 일치) | 결말 |
|---|---|
| happy ≥ T, unhappy ≥ T, \|happy − unhappy\| ≤ balanceGap, flag `face` | (히든) Happy와 Unhappy의 화해 |
| happy ≥ T, unhappy ≥ T | 단단한 어른 |
| happy ≥ T, unhappy < T | 웃는 가면의 어른 |
| happy < T, unhappy ≥ T | 조용한 어른 |
| 둘 다 < T | 비 오는 어른 |

- 결과 화면: 결말 이름, 한 줄 설명, 엔딩 제목 텍스트, 두 점수, [일기장 보기], [처음부터]
- **임계값은 임시.** 디버그로 5개 결말 모두 도달 가능한지 확인 후 조정 (M6)

---

## 6. 데이터 파일 (JSON)

모든 콘텐츠 데이터에 `world` 필드(프로토타입은 `"modern"`만)를 둔다. 아래 값은 **임시 값**.

### `src/data/balance.json`
```json
{
  "version": 2,
  "start": { "joy": 60, "shadow": 0 },
  "grid": {
    "gridCols": 5,
    "gridRows": 4,
    "gridPresets": [[4, 4], [5, 4], [6, 4]],
    "spawnCostBase": 10,
    "spawnCostStep": 2,
    "maxTier": 3,
    "releaseRefund": 4,
    "returnQueueCap": 6
  },
  "lane": {
    "laneCap": 5,
    "defenseLineY": 206,
    "abyssAdvanceSpeed": 30
  },
  "happy": { "atk": 2, "atkInterval": 1.0, "range": 60 },
  "wave": {
    "wavesPerDay": 3,
    "countBase": 6,
    "countStep": 1,
    "spawnInterval": 1.5,
    "waveGap": 3,
    "hpGrowthPerDay": 1.08
  },
  "abyss": {
    "layerHpBase": 120,
    "layerHpGrowth": 1.2,
    "counterAtk": 4,
    "counterAtkInterval": 1.5,
    "abyssDeathShadow": 5,
    "layerClearShadowReduce": 15,
    "unhappyStallShadowPerSec": 0.3
  },
  "shadow": {
    "shadowMax": 100,
    "sinkShadow": 4,
    "sinkLayerHp": 15,
    "shadowAfterBossWin": 30,
    "shadowAfterBossLose": 60
  },
  "days": {
    "lifeLengthDays": 14,
    "dailyLimit": 2,
    "storeCap": 4
  },
  "diary": { "diarySinkThreshold": 3 }
}
```

### `src/data/units.json` (1~2단계 공용 "추억 정령")
```json
{
  "commonSpirit": [
    { "tier": 1, "hp": 20, "atk": 4,  "atkInterval": 1.0, "range": 40 },
    { "tier": 2, "hp": 45, "atk": 9,  "atkInterval": 0.9, "range": 40 }
  ]
}
```

### `src/data/chains.json`
```json
[
  {
    "archetypeId": "companion_animal",
    "world": "modern",
    "spawnWeight": 1,
    "color": "#E8A15A",
    "tierNames": ["강아지 발자국", "공놀이한 오후", "강아지"],
    "hero": { "hp": 110, "atk": 20, "atkInterval": 0.8, "range": 50 }
  },
  {
    "archetypeId": "comfort_object",
    "world": "modern",
    "spawnWeight": 1,
    "color": "#8FB8DE",
    "tierNames": ["담요 한 조각", "낮잠 자던 오후", "담요 인형"],
    "hero": { "hp": 150, "atk": 14, "atkInterval": 1.0, "range": 40 }
  }
]
```

### `src/data/monsters.json`
```json
{
  "worry": { "name": "걱정", "hpBase": 18, "speed": 35, "atk": 3, "atkInterval": 1.2, "joyReward": 3 },
  "backflowBoss": {
    "name": "역류",
    "hp": 350, "speed": 20, "atk": 8, "atkInterval": 1.0,
    "joyReward": 40, "joyPenalty": 30, "sinkLayerHp": 80
  }
}
```

### `src/data/events.json`
```json
{
  "milestones": [
    {
      "id": "first_tooth",
      "world": "modern",
      "archetypeId": "first_loss",
      "title": "처음 이가 빠진 날",
      "text": "흔들리던 이가 드디어 빠졌다. 이 일은 누가 맡을까?",
      "choices": [
        { "id": "happy",   "label": "Happy가 맡는다 (웃어넘긴다)", "flag": "avoid", "joy": 25,  "shadow": 20 },
        { "id": "unhappy", "label": "Unhappy가 맡는다 (마주한다)", "flag": "face",  "joy": -10, "shadow": 0, "faceLayerHpReduce": 0.3, "bonusReturnPiece": true }
      ],
      "diaryLine": "오늘은 이가 빠졌다."
    }
  ],
  "seasonal": [
    {
      "id": "birthday", "world": "modern", "archetypeId": "celebration",
      "title": "생일", "text": "오늘은 생일이다!",
      "effects": { "joy": 30, "freePieces": [{ "chain": "companion_animal", "tier": 2 }], "worryMultiplier": 0.8 },
      "diaryLine": "오늘은 내 생일이었다."
    }
  ],
  "daily": [
    { "id": "scraped_knee", "world": "modern", "title": "넘어져 다친 날", "effects": { "worryMultiplier": 1.4 }, "diaryLine": "운동장에서 넘어졌다." },
    { "id": "favorite_lunch", "world": "modern", "title": "좋아하는 반찬", "effects": { "joy": 15 }, "diaryLine": "급식에 좋아하는 반찬이 나왔다." },
    { "id": "rainy_day", "world": "modern", "title": "비 오는 날", "effects": { "chainWeight": { "comfort_object": 2 } }, "diaryLine": "하루 종일 비가 왔다." },
    { "id": "dog_walk", "world": "modern", "title": "강아지와 산책", "effects": { "chainWeight": { "companion_animal": 2 } }, "diaryLine": "강아지랑 동네를 한 바퀴 돌았다." }
  ],
  "plainDay": { "title": "평범한 하루", "diaryLines": ["평범한 하루였다.", "창밖에 무지개가 떴다.", "오늘은 별일 없었다."] }
}
```

### `src/data/days.json`
```json
{
  "world": "modern",
  "age": 8,
  "fixed": { "7": "first_tooth", "10": "birthday" },
  "dailyEventChance": 0.5,
  "dailyEventCooldownDays": 3
}
```

### `src/data/diary.json`
```json
{
  "result": {
    "backflow": ["마음에 큰 비가 내렸다.", "갑자기 모든 게 싫어졌다."],
    "layerCleared": ["오래된 기억 하나가 조금 가벼워졌다.", "마음 한구석이 따뜻해졌다."],
    "manySunk": ["걱정 몇 개를 그냥 삼켜버렸다.", "괜찮은 척했다."],
    "default": ["그래도 괜찮은 하루였다.", "내일도 이런 하루면 좋겠다."]
  },
  "forgottenDay": "기억나지 않는 날."
}
```

### `src/data/endings.json`
```json
{
  "weights": {
    "wUpTier": 3, "wDefeat": 0.5, "wJoy": 0.05,
    "wDownTier": 3, "wLayer": 10, "wPurified": 0.3
  },
  "threshold": 100,
  "balanceGap": 20,
  "endings": {
    "hidden": { "name": "Happy와 Unhappy의 화해", "title": "(Un)Happy",         "desc": "불행 속에도 행복이 들어 있었어." },
    "solid":  { "name": "단단한 어른",            "title": "Happy And Unhappy", "desc": "슬픔을 안고도 웃을 수 있는 어른." },
    "mask":   { "name": "웃는 가면의 어른",       "title": "Happy",             "desc": "늘 웃지만, 어딘가 비어 있다." },
    "quiet":  { "name": "조용한 어른",            "title": "Unhappy",           "desc": "아픔을 알지만 웃는 법을 잊었다." },
    "rainy":  { "name": "비 오는 어른",           "title": "Happy And Unhappy", "desc": "쓸쓸하지만, 우산을 건네는 누군가가 있다." }
  }
}
```

### 검증
- JSON 로드 직후 필수 키·타입·참조 무결성 검사 (예: `days.fixed`의 이벤트 id 존재, `freePieces.chain`이 `chains.json`에 존재). 실패 시 에러 화면에 경로와 원인 표시.

---

## 7. 저장 데이터

```ts
interface Piece { chain: string | 'wildcard'; tier: number; }

interface SaveData {
  version: 2;
  life: {
    day: number;                    // 1 ~ lifeLengthDays
    phase: 'dayStart' | 'wave' | 'dayEnd' | 'ended';
    flags: string[];                // "avoid" | "face"
    lastDailyEventIds: { id: string; day: number }[];
  };
  gating: {
    openableDays: number;
    lastGrantDate: string;          // YYYY-MM-DD (기기 로컬)
    forgottenDays: number;
  };
  grid: (Piece | null)[];           // 길이 = gridCols × gridRows
  returnQueue: Piece[];
  joy: number;
  shadow: number;
  abyss: { layer: number; layerHpLeft: number };
  diary: { day: number; eventTitle: string; line: string }[];
  heroFirstPurify: string[];        // chain id
  stats: {
    sentUpTierSum: number;
    sentDownTierSum: number;
    worriesDefeated: number;
    totalJoyEarned: number;
    layersCleared: number;
    shadowPurified: number;
  };
}
```
- **웨이브 진행 중 상태(레인 유닛·걱정)는 저장하지 않는다.** 판 도중 앱이 종료되면 그날을 하루 시작부터 다시 (그리드·기쁨은 하루 시작 시점 스냅샷으로 복원).
  - 구현: 하루 시작 시 `dayStartSnapshot`을 따로 저장.
- 저장 시점: 하루 시작, 하루 끝, 이정표 선택, `visibilitychange`(hidden)
- 파싱 실패 / version 불일치 → 저장 초기화 + 콘솔 경고 (마이그레이션 안 함)

---

## 8. 디버그 패널과 metrics

### 디버그 패널 (`?debug=1`)
- 시간 배속 ×1 / ×3 / ×10
- 그리드 프리셋 전환 (4×4 / 5×4 / 6×4) → 저장 초기화 후 적용
- 기쁨 +100, 그림자 설정, 조각 지급(체인·단계 선택), 와일드카드 지급
- 하루 건너뛰기, 특정 일차로 이동, 즉시 결말 판정
- 열 수 있는 날 +1, 날짜 경과 시뮬레이션(N일)
- 저장 초기화, metrics JSON 복사

### metrics (`hau_metrics_v2`)
| 분류 | 항목 |
|---|---|
| 선택 (H1, H2) | 위/아래 소환 횟수·비율, 소환 시 단계 분포, 조각 생성 → 소환까지 보유 시간 |
| 루프 (H3) | 층 돌파 횟수, 돌파 후 다음 아래 소환까지 시간, 심연 유닛 사망 수 |
| 세션 (H4) | 실제 날짜별 세션 수, 판 시간, 하루에 연 날 수, 보관 사용 수, 버려진 날 수 |
| 수집 (H5) | 체인별 3단계 도달 횟수, 영웅 최초 소환 일차 |
| 그리드 (H6, D-012) | 그리드 가득 참 시간 비율, 놓아주기 횟수, 귀환 대기열 소실 수 |
| 그림자 | Unhappy 멈춤 누적 시간, 역류 횟수, 보스 처치/실패 |
| 결과 | 이정표 선택, 결말, 두 점수, 사용한 그리드 프리셋 |

---

## 9. 폴더 구조

```
Happy-Unhappy/
├─ CLAUDE.md
├─ docs/
├─ src/
│  ├─ main.ts
│  ├─ data/            # JSON + 스키마 검증
│  ├─ core/            # 순수 로직 (Phaser 의존 없음)
│  │   ├─ grid.ts      # 생성·머지·와일드카드·놓아주기·귀환 대기열
│  │   ├─ lane.ts      # 공용 레인 전투 (LaneKind로 분기)
│  │   ├─ shadow.ts    # 그림자·역류·마음 날씨
│  │   ├─ day.ts       # 하루 흐름·이벤트 선택·하루 끝 처리
│  │   ├─ gating.ts    # C안 날짜 지급·보관
│  │   ├─ diary.ts     # 그림일기 생성
│  │   ├─ ending.ts    # 결말 판정
│  │   ├─ save.ts
│  │   └─ metrics.ts
│  ├─ scenes/          # 표시·입력만
│  └─ debug/
├─ tests/              # Vitest (core)
└─ package.json
```
- core는 `tick(dt)` 기반 순수 함수/클래스. 배속은 dt 배율로만 처리.
- **필수 테스트:** 머지 규칙(와일드카드 포함), 레인 전투의 방향 대칭성, 층 돌파 시 단계 +1 귀환과 3단계 → 와일드카드, 귀환 대기열 상한, gating 날짜 계산(되돌림·장기 미접속), 결말 판정 5종, 저장 파싱 실패 처리.

---

## 10. 마일스톤

| 순서 | 내용 | 완료 조건 |
|---|---|---|
| M1 | 셋업, JSON 로드·검증, 레이아웃, 그리드 프리셋 | 폰 브라우저에서 세로 화면 + 그리드 3종 전환 |
| M2 | 그리드: 생성·머지·와일드카드·놓아주기 | core 테스트 통과, 드래그 머지 동작 |
| M3 | 레인 공용 전투 + 방어 레인 + Happy 거점 | 걱정이 막히고, 비면 통과 |
| M4 | 심연 레인 + 층 돌파 귀환 + Unhappy 멈춤 + 그림자·역류 | 아래로 보내면 단계 +1로 돌아오고, 안 보내면 역류 |
| M5 | 하루 구조: 3웨이브·이벤트·이정표·하루 끝·그림일기 | 14일 연속 플레이 가능 |
| M6 | C안 gating + 결말 판정 + 저장/복원 | 5개 결말 디버그로 도달, 날짜 엣지 케이스 테스트 통과 |
| M7 | metrics + 디버그 패널 완성 | metrics JSON 복사 가능 |
| — | 실제 플레이 (그리드 3종 각각 1회 이상) → 판정 | 1장 기준 평가 |

---

## 11. 미해결 → 프로토타입에서 정할 것
- 그리드 크기 (D-012)
- `dailyLimit`, `storeCap` (D-015)
- 결말 임계값·가중치
- 레인 정원, 단계별 능력치, 심연 층 HP 곡선
