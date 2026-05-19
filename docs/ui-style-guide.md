# Helm UI 스타일 가이드

> 출처(SoT): [`apps/desktop/src/styles.css`](../apps/desktop/src/styles.css)
> 사양 레퍼런스: [`docs/orchestrator-design.md`](orchestrator-design.md) (L1019 메뉴 4개, L1090 다크 캔버스 범위, L1092 라이트 테마 고정)
> 스택: Tailwind v4 + shadcn(slate base + emerald primary) + `lucide-react` 아이콘

이 문서는 Helm 데스크톱 앱의 디자인 시스템을 정리한다. 새 화면을 만들거나 기존 화면을 수정할 때 이 가이드의 토큰/패턴/레이아웃 컨벤션을 우선 따른다. 토큰 값(oklch / hex)은 문서에 박지 않고 이름만 적는다 — 값이 바뀌면 문서가 거짓말이 되기 때문이다. 정확한 값은 항상 `styles.css`에서 확인한다.

---

## 1. 디자인 원칙

1. **라이트 테마 고정**. 앱 전체는 ivory/slate 베이스의 라이트 테마다. 다크 톤은 터미널 캔버스에서만 허용한다(`docs/orchestrator-design.md` L1090).
2. **카드 남발 금지**. 정보 밀도가 낮은 5컬럼 카드 그리드보다 슬림한 메타바(`.statusbar`)나 라인 구분을 선호한다.
3. **단일 액센트**. 액션 강조는 `--brand`(emerald) 한 가지. 보라/파랑 그라데이션, 무지개 톤은 금지.
4. **상태색은 의미에만**. 녹색은 성공·완료, 앰버는 대기·주의, 빨강은 위험·실패. 장식 목적의 색 사용은 금지.
5. **mono는 의미 있는 단위에만**. 경로, 명령, 해시, 숫자 메트릭 등 "고정폭이 의미를 보조하는" 텍스트에만 `--font-mono`를 쓴다.
6. **토큰만 사용**. CSS 안에 `#ffffff`, `oklch(...)` 직접 박지 않는다. 새 의미가 필요하면 `:root`에 토큰을 먼저 추가한 뒤 사용한다.

---

## 2. 디자인 토큰

`apps/desktop/src/styles.css`의 `:root`에 정의되어 있다. shadcn 표준 변수와 레거시 alias가 공존하며, 새 코드는 가능한 shadcn 표준 이름을 쓴다.

### 2.1 색상 — 표면 위계

| 토큰 | 용도 |
|---|---|
| `--background` / `--surface` | 페이지 본문 배경(가장 밝음) |
| `--surface-2` (= `--sidebar`) | 사이드바, 섹션 카드 톤 |
| `--surface-3` (= `--secondary`) | 칩, 보조 버튼 hover, 세그먼티드 active |
| `--surface-sunken` | 코드/명령 미리보기, artifact viewer 등 "안쪽"으로 들어간 영역 |

### 2.2 색상 — 텍스트 위계

| 토큰 | 용도 |
|---|---|
| `--foreground` / `--text` | 본문 텍스트 |
| `--text-2` | 강조도 두 번째(코드 viewer, 파일 status 라벨 등) |
| `--soft` | 보조 텍스트, project-item inactive |
| `--text-muted` (= `--muted-foreground`) | 라벨, hint, status label |

### 2.3 색상 — 브랜드

| 토큰 | 용도 |
|---|---|
| `--brand` (= `--primary`) | 활성/액션 강조 |
| `--brand-weak` | brand 채워진 배경의 옅은 버전(active 배지, planning user message) |
| `--brand-strong` | brand 버튼의 hover 톤 |

### 2.4 색상 — 상태

| 토큰 | 의미 | weak 변형 |
|---|---|---|
| `--green` | 성공·통과·done | `--green-weak` |
| `--amber` | 주의·대기·blocked-warn | `--amber-weak` |
| `--red` (= `--destructive`) | 위험·실패·삭제 | `--red-weak` |
| `--slate` | 중립 정보 | `--slate-weak` |

### 2.5 색상 — 라인

| 토큰 | 용도 |
|---|---|
| `--line` (= `--border`) | 기본 구분선 |
| `--line-strong` | 강조 구분선, 점선 빈 상태 테두리, dot indicator 기본색 |
| `--line-soft` | 리스트 row 구분(plain-list / file-list) |

### 2.6 색상 — 터미널 전용

다른 화면에서 사용 금지. 터미널 캔버스(`.terminal-screen`) 안에서만.

| 토큰 | 용도 |
|---|---|
| `--term-bg` | 캔버스 배경(다크) |
| `--term-surface` | 헤더·컨트롤·output 카드 |
| `--term-line` | 다크 구분선 |
| `--term-text` | 본문 |
| `--term-muted` | 보조 |
| `--term-accent` | 액션, 출력 라벨 |
| `--term-stderr` | stderr 출력 텍스트 |

### 2.7 타이포

- `--font-sans`: Inter / Pretendard Variable / 시스템 sans. 본문 기본.
- `--font-mono`: Berkeley Mono / JetBrains Mono. 경로·명령·해시·숫자 메트릭에만.
- 본문 기본 13.5px / line-height 1.5
- `font-synthesis: none`, `text-rendering: optimizeLegibility`, antialiased 고정.

### 2.8 텍스트 위계(헤딩)

| 태그 | 크기 | weight | 비고 |
|---|---|---|---|
| `h1` / `h2` | 14px | 600 | letter-spacing `-0.005em`. 화면 타이틀/카드 타이틀 |
| `h3` | 10.5px | 600 | uppercase, letter-spacing `0.08em`. 섹션 헤더 라벨용 |

> 단, `.planning-empty h3`, `.settings-canvas-header h2` 같이 시각적 큰 타이틀이 필요한 영역에서는 별도 override한다(소문자 / 14px). 무조건 따르지 말고 **컨텍스트에 맞는 위계**가 우선.

### 2.9 Radius / Shadow

- `--radius: 0.5rem` (기본)
- `--radius-sm: 4px` (작은 배지, 미리보기 박스)
- `--radius-lg: 10px`
- `--shadow-1`: 떠 있는 카드(active project-item, settings-nav-item active 등)
- `--shadow-2`: 강한 떠 있음(잘 안 씀)

### 2.10 색의 의미 매핑 치트시트

```
성공/완료 ─── green (배지: check-pass, settings-status-success, task-column Merged/Done)
주의/대기 ─── amber (배지: check-fail, task-column Ready/MergeWaiting, next-action waiting)
실패/위험 ─── red  (배지: error-banner, secondary-button.danger, settings-status-error)
정보/중립 ─── slate (배지: provider-pill, settings-status-info)
액션/현재 ─── brand (active 상태, primary 버튼, focus ring)
```

---

## 3. 공통 컴포넌트 패턴

### 3.1 버튼

| 클래스 | 용도 |
|---|---|
| `.primary-button` | 페이지/모달의 1순위 액션(저장, 새 항목 등). brand 채움 |
| `.secondary-button` | 2순위 액션, 인라인 액션. 테두리 + surface 배경 |
| `.secondary-button.danger` | 삭제·연결 해제 등 위험 액션. 평소는 red 텍스트만, hover 시 red-weak 배경 |
| `.sidebar-add-button` | 사이드바 푸터의 "+ 새 X" CTA. 점선 테두리 |

**기본 규격**: height 28px, font 12.5px, gap 6px, padding `0 10px`(secondary) / `0 12px`(primary).

```tsx
<button className="primary-button" onClick={save}>저장</button>
<button className="secondary-button" onClick={cancel}>취소</button>
<button className="secondary-button danger" onClick={remove}>삭제</button>
```

> 한 영역 안에 primary 버튼은 1개만. 같은 행에 primary가 2개 이상이면 무엇이 진짜 1순위인지 흐려진다.

### 3.2 세그먼티드 토글

`.segmented` — 2~3개 옵션 간 즉시 전환되는 라디오 패턴.

```tsx
<div className="segmented">
  <button className="active">옵션 A</button>
  <button>옵션 B</button>
</div>
```

### 3.3 인풋 / 텍스트에어리어 / 셀렉트

전역 `input, select, textarea` 룰이 적용된다. height 자동, border 1px, focus 시 brand-weak ring 3px.

```tsx
<label className="settings-field">
  <span>이름</span>
  <input value={name} onChange={...} />
  <small className="muted">힌트 텍스트 — 토큰명을 코드로 보이려면 <code>--brand</code></small>
</label>
```

> textarea는 글로벌 `resize: vertical`. 코드/JSON은 `font-family: var(--mono)` 명시.

### 3.4 토글 스위치 (`.toggle-switch`)

활성/비활성 의미가 **명확한** 곳에서만 사용한다. 폼 안의 "여러 항목 중 선택"은 토글이 아니라 체크박스(`.inline-check`)다.

```tsx
<label className="toggle-switch">
  <input type="checkbox" checked={enabled} onChange={...} />
  <span className="toggle-switch-track" aria-hidden />
  <span className="toggle-switch-label">{label}</span>
</label>
```

`<input>`은 시각적으로 숨기지만 키보드/스크린리더 동작은 유지된다(`clip: rect(0 0 0 0)`).

### 3.5 인라인 체크/라디오 (`.inline-check`)

다중 선택, 단일 선택(라디오) 모두 사용.

```tsx
<label className="inline-check">
  <input type="checkbox" checked={...} onChange={...} />
  <span>{label}</span>
</label>
```

### 3.6 배지 / 칩

| 클래스 | 용도 | 색 |
|---|---|---|
| `.status-pill` | 상태 표시(detail header) | brand-weak |
| `.provider-pill` | AI 연결 provider 표시 | surface-2 |
| `.role-mode-pill` | 단일/다중 선택 표시 | surface |
| `.check-pass` / `.check-fail` | 검사 결과 | green / amber |
| `.settings-status-{success,error,info}` | 저장 액션 피드백 | green / red / slate |
| `.file-list li > span.code-{added,modified,deleted}` | 파일 상태 코드 | green / amber / red |

### 3.7 카드

- **일반 카드**: `border: 1px solid var(--line)` + `background: var(--surface)` + `var(--radius)`
- **떠 있는 강조**: `box-shadow: var(--shadow-1)` 추가 (active 상태)
- **카드 안의 카드**: 외부가 `--surface-2`이면 내부는 `--surface`로 톤 차이 만들기

대표 예: `.task-card`, `.template-card`, `.connection-card`, `.role-assignment-row`, `.planning-message`, `.planning-session-item`, `.run-list li`.

### 3.8 빈 상태

| 클래스 | 용도 |
|---|---|
| `.empty-state` | 화면 전체 빈 상태(스냅샷 없을 때 등) |
| `.empty-inline` | 컨테이너 내 인라인 안내 |
| `.settings-empty` | settings 섹션 내부 안내(다음 단계 명시용) |
| `.planning-empty` | planning 캔버스 본문 빈 상태 |
| `.planning-aside-empty`, `.planning-context-empty`, `.sidebar-empty` | 사이드/aside 내 한 줄 안내 |

빈 상태에서는 **"왜 비었고 다음 무엇을 해야 하는지"**를 명시한다. 단순 "데이터가 없습니다"는 약하다.

### 3.9 펼침/접힘 (`<details class="settings-disclosure">`)

고급 옵션이나 사용 빈도 낮은 영역은 details로 기본 접힘. summary는 12.5px/600, `::before ▸` 마커가 펼침 시 90° 회전.

### 3.10 메시지

- `.error-banner` — 화면 상단의 빨간 배너(앱 레벨 에러)
- `.muted` — 보조 안내, 비활성·완료된 정보
- `.settings-status-*` — 폼 저장 액션의 즉시 피드백

---

## 4. 레이아웃 패턴

각 화면은 아래 5개 레이아웃 패턴 중 하나를 미러한다. 새 화면을 만들 때 "처음부터 짜지 말고 가장 가까운 패턴을 골라 grid 구조를 복사"한다.

### 4.1 App Shell

```
.app-shell (grid: auto + 1fr)
├── .domain-tabs (상단 탭바, 좌측에 brand)
└── .app-body (grid: 232px + 1fr)
    ├── .sidebar
    └── .main (현재 화면)
```

- 도메인 탭 4개: Tasks / Git / Terminal / Settings (+ 계획 Planning은 별도 라우트)
- 사이드바 너비 **232px** 고정, 16px padding 14px.
- 활성 탭은 `.domain-tab.active` — 하단 brand 라인 + icon brand 색.

### 4.2 Tasks Board (`.tasks-layout`)

```
.tasks-layout (grid: 1fr + 360px)
├── .task-workspace
│   ├── .section-header
│   ├── .create-panel (segmented + form-grid)
│   ├── .task-board (가로 스크롤, 컬럼 240px 고정)
│   └── .approval-inbox
└── .detail-panel (선택된 task 상세)
```

- `.task-column[data-status="..."]`의 헤더 점은 status별로 자동 색 매핑(Coding/Review/Testing → brand, Ready/MergeWaiting → amber, Merged/Done → green, Blocked → red).
- 카드 active: `.task-card.selected` — brand border + 2px brand-weak ring.

### 4.3 Git Layout (`.git-layout`)

```
.git-layout (grid: 1.1fr + 1fr, 1px gap = line 색)
├── .content-panel (저장소 상태)  ← full-width
├── .content-panel (변경 파일)
├── .content-panel (로컬 브랜치)
└── .content-panel (최근 커밋)    ← full-width
```

- 패널 헤더 h2는 uppercase 10.5px/600 라벨로 override.
- `.metric-grid`는 5컬럼 슬림 메트릭. 카드가 아니라 라벨+숫자(mono, tabular-nums)만.

### 4.4 Planning Workspace (`.planning-layout`)

```
.planning-layout (grid: 1fr + auto)
└── .planning-body (grid: 220px + 1fr + 280px)
    ├── .planning-aside (세션 리스트)
    ├── .planning-canvas (헤더 + 메시지 스트림 + goal form)
    └── .planning-context (우측 컨텍스트 메타)
```

- 우측 `.planning-context`는 1100px 이하에서 자동 숨김.
- 메시지는 `.planning-message`. 사용자 발화는 `.planning-message.user`(brand-weak 배경).

### 4.5 Settings (`.settings-layout`)

```
.settings-layout
└── .settings-body (grid: 240px + 1fr)
    ├── .settings-nav (좌측 카테고리)
    │   ├── .settings-nav-meta (h3 + 프로젝트명)
    │   └── .settings-nav-list (li > .settings-nav-item)
    └── .settings-canvas (grid: auto + 1fr)
        ├── .settings-canvas-header (h2 + 액션/메시지)
        └── .settings-canvas-body (max-width 880px)
```

- 활성 nav 아이템은 `.settings-nav-item.active` — surface 채움 + shadow-1로 떠 있는 느낌.
- 본문 max-width 880px — 가독성을 위한 measure 제약. 좌측 정렬.

### 4.6 Terminal (`.terminal-screen`) — 다크 캔버스 유일 허용 영역

```
.terminal-screen (grid: auto + auto + 1fr, --term-* 토큰 사용)
├── .terminal-header
├── .terminal-controls (input/select/button)
└── .terminal-output-list (.terminal-output 카드들)
```

- `--term-*` 토큰만 사용. `--surface`, `--text` 등 라이트 토큰을 섞지 않는다.
- stderr 출력은 `.terminal-output pre.stderr-output` — `--term-stderr` 색.

---

## 5. 사이드바 / 캔버스 너비 규약

| 패턴 | 좌측 nav/aside | 우측 context |
|---|---|---|
| App shell sidebar | 232px | — |
| Planning aside | 220px | 280px |
| Settings nav | 240px | — |

너비가 화면마다 다른 건 의도된 것 — App shell은 좁고 빈도 높은 네비, Planning aside는 세션 리스트로 메타가 적고, Settings nav는 카테고리 + 한 줄 hint가 있어 약간 더 넓다. 새 화면에서 좌측 패널을 만들 때는 콘텐츠 밀도에 맞춰 220–240px 사이로 잡는다.

---

## 6. 반응형 분기점

`styles.css` 하단의 두 미디어쿼리만 사용한다. 새 화면을 만들 때 같은 분기에 자기 케이스를 추가한다.

### 6.1 `@media (max-width: 1100px)`

- 다중 컬럼 그리드를 1-컬럼으로 (`.tasks-layout`, `.git-layout`)
- 우측 보조 컬럼 숨김 (`.planning-context`)
- 좌측 nav 너비 축소(200px)
- 폼 그리드 2-컬럼화 (`.form-grid`, `.terminal-controls`)

### 6.2 `@media (max-width: 880px)`

- 앱 사이드바를 상단 띠로 (`.app-body { grid-template-columns: 1fr }`)
- 모든 좌측 nav/aside를 위쪽 분리선으로
- 헤더 액션 영역은 wrap 허용

---

## 7. 금지 / 주의 사항

- ❌ **다크 테마 적용 금지** (터미널 캔버스 제외). 다크 배경이 필요해도 `.terminal-screen` 안에서만.
- ❌ **카드 남발 금지**. 5컬럼 메트릭 카드 그리드 같은 패턴 대신 슬림 메타바(`.statusbar`) 또는 라인 구분.
- ❌ **보라/파랑 그라데이션 금지**. 단일 액센트는 `--brand`(emerald) 뿐.
- ❌ **직접 hex / rgb / oklch 값 박지 않기**. 토큰만 사용. 새 의미가 필요하면 토큰을 먼저 만든다.
- ❌ **인라인 스타일 회피**. 동적 값(예: progress %)이 아니면 클래스로.
- ❌ **임의 폰트 크기 사용 금지**. 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 외 사이즈는 만들지 않는다.
- ⚠️ **shadcn 변수 우선**. 새 코드에서는 `--background` / `--foreground` / `--primary`를 쓰고, 레거시 alias(`--bg` 등)는 유지보수 시 점진적으로 교체.
- ⚠️ **h3은 섹션 라벨**이지 본문 타이틀이 아니다. 14px이 필요하면 h2 또는 override.

---

## 8. 새 화면 추가 체크리스트

1. **레이아웃 패턴 선택**: Tasks / Git / Planning / Settings / Terminal 중 가장 가까운 것을 골라 grid 구조 미러.
2. **상단 헤더**: `h2`(14px/600) + 필요 시 한 줄 hint(`p` 12px muted). uppercase 라벨이 필요하면 `h3`.
3. **본문 정렬**: 폼이면 max-width 880px(`.settings-canvas-body` 패턴), 보드이면 가로 스크롤(`.task-board` 패턴).
4. **빈 상태**: 화면 전체 비면 `.empty-state`, 섹션 단위면 `.settings-empty`/`.planning-empty`. **다음 단계**를 명시.
5. **액션 버튼**: 1순위는 `.primary-button` 하나만. 위험 액션은 `.secondary-button.danger`.
6. **메시지 피드백**: 저장 직후 즉시 피드백이면 `.settings-status-*`. 화면 레벨 에러면 `.error-banner`.
7. **반응형**: 1100px / 880px 미디어쿼리에 자기 케이스 추가.
8. **터미널이 아니면 다크 토큰 금지** — 잠깐 어둡게 하고 싶어도 라이트 톤 안에서 위계를 조절한다.

---

## 9. 자주 쓰는 코드 스니펫

### 빈 상태(스냅샷 없음)

```tsx
<section className="empty-state">
  <h2>{화면명}</h2>
  <p>프로젝트를 열면 {기능} 이 표시됩니다.</p>
  <button className="primary-button" onClick={onOpenProject} type="button">
    프로젝트 열기
  </button>
</section>
```

### 좌측 nav + 우측 캔버스 골격

```tsx
<div className="settings-layout">
  <div className="settings-body">
    <aside className="settings-nav">
      <div className="settings-nav-meta">
        <h3>설정</h3>
        <p className="settings-nav-project">{프로젝트명}</p>
      </div>
      <ul className="settings-nav-list">{/* settings-nav-item */}</ul>
    </aside>
    <section className="settings-canvas">
      <header className="settings-canvas-header">
        <div><h2>{카테고리}</h2><p>{hint}</p></div>
        <div className="settings-canvas-actions">{/* status + primary action */}</div>
      </header>
      <div className="settings-canvas-body">{/* 콘텐츠 */}</div>
    </section>
  </div>
</div>
```

### 상태 피드백 pill

```tsx
{message ? (
  <span className={`settings-status settings-status-${message.tone}`} role="status">
    {message.tone === "success" ? <CheckCircle2 size={14} aria-hidden /> : null}
    {message.tone === "error" ? <XCircle size={14} aria-hidden /> : null}
    {message.text}
  </span>
) : null}
```

### 카드 안의 카드(연결 카드)

```tsx
<article className="connection-card">
  <div className="connection-card-header">
    <label className="toggle-switch">{/* ... */}</label>
    <div className="connection-card-meta">
      <span className="provider-pill">{provider}</span>
      <span className={check.available ? "check-pass" : "check-fail"}>{...}</span>
    </div>
  </div>
  <div className="connection-fields">{/* 2-컬럼 grid */}</div>
  <code className="command-preview">{/* mono, sunken */}</code>
  <div className="connection-card-actions">{/* secondary buttons */}</div>
</article>
```

---

## 10. 변경 이력

- 2026-05-19 최초 작성. styles.css 기준은 commit `891134f` 시점.
