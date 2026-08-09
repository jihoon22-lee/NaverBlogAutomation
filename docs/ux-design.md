# 웹앱 UX·접근성 기준

Status: 현재 구현 기준, 갱신 2026-08-09 (PR #96~#105)

이 문서는 `client/` 웹앱의 화면 정보 구조(IA), 시각적 우선순위, 반응형 동작과 접근성 계약을
정리합니다. 구현자는 이 문서와 `client/src/app/views/`, `client/public/app.css`를 함께 확인하고,
회귀 검증은 `client/tests/app/` 및 packaged E2E를 사용합니다.

## 독자와 적용 범위

- 제품·디자인 담당자는 화면의 목적과 primary action을 확인합니다.
- frontend 개발자는 route, selector, state rerender와 focus 계약을 확인합니다.
- QA 담당자는 responsive/a11y acceptance 사례를 확인합니다.

이 문서는 실제 Naver 페이지의 DOM을 설명하지 않습니다. Naver editor staging은 별도의
capability probe와 fail-closed 계약을 따릅니다.

## 경험 원칙

1. **다음 행동 우선:** 한 화면에 모든 기능을 노출하지 않고 현재 사용자가 해야 할 다음 행동을
   하나의 primary action으로 제시합니다.
2. **본문 우선:** 글쓰기에서는 제목과 block canvas를 중심에 두고 AI·이미지·태그·변경 기록·임시저장
   도구는 필요할 때만 펼칩니다.
3. **상태를 숨기지 않기:** loading, saving, failed, unconfirmed를 status/notice로 표현하고,
   알 수 없는 외부 결과를 성공으로 표시하지 않습니다.
4. **사용자 입력 보존:** async 응답이나 rerender가 현재 입력·선택·panel open 상태를 조용히
   되돌리지 않습니다.
5. **좁은 화면에서도 핵심 흐름 유지:** 목록을 먼저 보여 주고 상세·도구는 선택 후 여는 방식으로
   가로 overflow와 불필요한 스크롤을 줄입니다.

## App shell과 navigation

HTML shell은 다음 구조를 고정합니다.

```text
skip link (#workspace)
└─ header.app-header
   ├─ brand / h1
   └─ nav#workspace-nav
      ├─ 홈       data-section="home"
      ├─ 작업함   data-section="workbench"
      ├─ 글쓰기   data-section="writing"
      └─ 관리     data-section="more"  (legacy key)
└─ main#workspace
```

네 개 버튼의 visible label은 `홈`, `작업함`, `글쓰기`, `관리`입니다. `more`는 내부 section key와
legacy hash의 호환 계약이므로 label을 바꾸는 것과 route key를 바꾸는 것을 같은 작업으로 취급하지
않습니다. 아이콘은 장식용 inline SVG이며 `aria-hidden="true"`와 `focusable="false"`를 유지합니다.
현재 탭은 `aria-current="page"`로만 표시하고, 버튼에 별도의 `aria-label`을 붙여 visible label을
가리지 않습니다.

화면 전환 시 `main` 또는 `#workspace-status`로 focus를 이동합니다. 같은 화면의 network 결과나
입력 rerender에서는 focus를 이동하지 않습니다. `#workspace` 전체에는 `aria-live`를 두지 않고,
각 view의 짧은 상태 문장만 `role="status"`/필요한 `aria-live`를 사용합니다.

## 화면 정보 구조

### 홈 dashboard

홈은 긴 queue를 다시 렌더하지 않고 다음 세 영역만 제공합니다.

- **다음 작업:** readiness blocker가 있으면 `초기 설정 계속` 하나를 `#setup`으로 연결합니다.
  readiness를 불러오는 중에는 disabled 상태 확인 문구를, 실패하면 다시 시도 action을 표시합니다.
- **오늘의 수집 요약:** 전체 항목, 이웃 새 글, 검색 후보, 보류됨을 metric card로 보여 줍니다.
- **빠른 시작:** 작업함 열기와 `새 글 시작`(`home-start-writing`)을 제공합니다.

blocker 상세에는 원인별 직접 설정 action이 남아 있지만, hero의 primary는 guided onboarding으로
일원화합니다. 준비가 끝난 상태에서 처리할 queue가 있으면 작업함으로, 없으면 새로 수집 action으로
의도를 연결합니다.

### 초기 설정 (`#setup`)

Onboarding은 앱 준비, AI 연결, 내 블로그, 자동화 브라우저, 네이버 로그인, 안전 설정의 선형
checklist입니다. 현재 단계 하나를 강조하고, 현재 단계에 필요한 설정 section deep-link 또는
browser launch/focus action 하나를 primary로 둡니다. 모든 단계가 완료되면 홈으로 돌아가기 action을
보여 줍니다. 홈 tab은 onboarding 중에도 current로 유지하여 navigation context를 잃지 않게 합니다.

### 작업함과 댓글 작업

작업함은 queue의 단일 소유자입니다.

- 기본 segment는 이웃 새 글이며 source/state/query/sort/cursor를 한 API 계약으로 보냅니다.
- compact header와 source/context/author/published-time badge로 row의 의미를 먼저 보여 줍니다.
- desktop은 list와 detail을 함께 보여 주고, 768px portrait 이하에서는 list-first 후 선택한 row만
  dismissible detail sheet로 엽니다. close/reopen 뒤 selection과 queue context를 보존합니다.
- 선택 순서를 유지한 batch preflight에서 action별 사용량·잔여량·최소 예상 시간을 보여 주고,
  승인 전 safety를 다시 확인합니다.
- 댓글 화면은 추출 preview, 후보 비교, 편집, 승인 후 실행을 분리하며 실행 progress는 run
  lifecycle controller가 소유합니다.

### 글쓰기 editor

글쓰기에는 `start`와 `editor` 두 모드가 있습니다.

```text
start
├─ seed: 제목 · 메모 · 카테고리 · 초안만 저장/AI로 초안 완성
└─ 최근 초안

editor
├─ main: 제목 · autosave status · BodyBlock canvas · outline/preview
└─ 보조 도구(details)
   ├─ 최근 초안
   ├─ AI 도구
   ├─ 이미지
   ├─ 태그
   ├─ 변경 기록
   └─ 임시저장
```

본문은 `BodyBlock[]`를 직접 편집합니다. structural action은 block을 추가·삭제·복제·이동하고,
이미지는 insertion point와 caption을 유지합니다. title/body는 debounce working copy로 저장하며,
revision checkpoint는 별도 명시 action입니다. active revision과 local canvas가 다르면 compose,
refine, tag, stage를 잠그고 `버전으로 남기기`를 먼저 요구합니다.

`새 글 시작`은 현재 draft를 삭제하지 않고 seed form으로 돌아갑니다. 예약·in-flight autosave,
실패한 autosave, 다른 draft 전환이 겹칠 때는 명확한 notice로 안전하게 막습니다. async render 뒤에는
title, block control, option, panel의 focus/selection을 안정적인 id·focus key로 복구합니다.

### 관리와 설정

관리 화면은 이력, 설정, PC 전용 태블릿 연결 entry를 제공합니다. 설정은 다음 세 section입니다.

| Section | 목적 | 상세 panel 예 |
| --- | --- | --- |
| 작업 기본값 | 댓글·글쓰기 AI 기본값 | 말투, 길이, 구조, 참고 글, 태그/이미지 |
| 탐색 및 자동화 | queue source와 안전한 실행 | blog ID, 이웃/검색어, consent, safety, schedule, AI budget |
| 연결 및 앱 | provider와 PC runtime | AI, Naver Search, SMTP, browser, LAN, data export/reset |

상단 summary는 현재 상태와 다음 행동을 먼저 보여 주고, 세부 form은 `details`로 progressive
disclosure합니다. `expandedPanels`는 저장·실패·section 전환·async reload 뒤 open 상태를 복원합니다.
Write-only secret은 성공 응답이나 rerender에서 다시 표시하지 않습니다. paired tablet에는 PC 전용
runtime secret, browser, network와 data management control을 렌더하지 않습니다.

## Route·상태 전환 원칙

공개 route는 [`architecture.md`](architecture.md)의 route 표가 source of truth입니다. route 전환은
`activeView → hash → nav current → view render → load` 순서로 수행합니다. hashchange와 initial mount
양쪽에서 같은 계약을 사용하며, `#today`, `#queue`, `#batch`, `#onboarding`, `#history`, `#config` 등
legacy alias는 새 화면으로 매핑합니다.

비동기 응답은 시작 당시의 route/session/draft/run identity와 현재 identity가 일치할 때만 state를
갱신합니다. terminal SSE는 source를 닫고, stale error도 현재 화면에 노출하지 않습니다. 이 규칙은
새 화면을 추가할 때 controller test에 “A 요청 후 B로 전환한 뒤 A 응답” 사례를 반드시 추가해야 한다는
뜻입니다.

## Responsive·접근성 acceptance

| 범위 | 확인할 계약 |
| --- | --- |
| desktop | primary nav, list/detail, editor canvas와 보조 panel, 설정 section이 한 화면에서 의미 순서를 유지 |
| 768px portrait | queue list-first/detail sheet, close/reopen selection, batch control과 댓글 resume |
| 1024px landscape | 넓은 queue/editor/settings layout, nav current와 keyboard focus |
| 320px 폭 | 본문·제목·primary action이 먼저 보이고 가로 scroll/잘린 focus target이 없음 |

모든 viewport에서 다음을 확인합니다.

- skip link가 `#workspace`로 이동하고 nav SVG가 접근성 tree에 노출되지 않습니다.
- visible button label이 accessible name으로 유지되고, current page·current onboarding step을
  `aria-current`로 읽을 수 있습니다.
- input/textarea/select에는 label 또는 명시적 accessible name이 있고, busy/disabled 상태가
  다음 행동을 설명하는 status와 함께 표시됩니다.
- async rerender 뒤 입력 focus, selection, details open 상태가 사라지지 않습니다.
- `#workspace` 전체에 broad `aria-live`가 없으며, status live region이 타이핑 내용을 반복하지
  않습니다.

검증은 synthetic DOM unit test와 packaged Playwright E2E를 함께 사용합니다. screenshot을 품질
근거로 삼지 않고 DOM, route, aria attribute, focus와 viewport metric을 검사합니다.

## 변경 시 체크리스트

1. 새 화면이나 hash를 추가하면 `main.ts`, route unit test, legacy alias test, nav `aria-current`를
   함께 갱신합니다.
2. controller의 async action을 바꾸면 duplicate/busy, stale identity, terminal/error recovery를
   같은 test file에 추가합니다.
3. editor/settings rerender를 바꾸면 focus/selection 또는 panel open state를 보존하는 test를
   추가합니다.
4. responsive UI를 바꾸면 desktop·768·1024·320px에서 overflow와 semantic order를 검사합니다.
5. 사용자 label을 바꾸더라도 내부 legacy key/route와 API 계약은 의도적으로 분리해 검토합니다.
