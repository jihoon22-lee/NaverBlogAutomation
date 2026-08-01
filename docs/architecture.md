# 네이버 블로그 댓글·글쓰기 보조 도구 아키텍처

Status: 현재 구현을 반영한 개정본, 갱신 2026-08-01

이 문서는 v0.6 이후의 실제 런타임 구조를 기술합니다. 현재 제품 범위와 다음 구현 순서는
[`webapp-first-delivery-plan.md`](webapp-first-delivery-plan.md)에, PR 1–8이 만든 원래 Side Panel
아키텍처와 delivery boundary는 [`archive/delivery-plan.md`](archive/delivery-plan.md)에 남아 있습니다.

## 목적과 경계

이 도구는 한 명의 로컬 사용자가 네이버 블로그 이웃 글을 발견하고, 관련 댓글을 생성·편집하며,
공감·댓글 등록·서로이웃 신청을 수행하고, 별도 워크플로로 자기 블로그 글을 작성하는 과정을
돕습니다.

탐색 대기열은 저장된 블로그 ID 하나와 선택적 검색어, 수동 추가 이웃을 사용합니다. 활성화되면
공개 BuddyList, 네이버 검색 API, RSS metadata endpoint만 읽습니다. 쿠키·로그인 정보를
수집하거나 Captcha를 우회하지 않으며, 무인 배치는 명시적 opt-in 없이 동작하지 않습니다.

## 시스템 구조

```mermaid
flowchart LR
    U[User] -->|브라우저에서 접속| W["Local Web App\n(client/)"]
    W -->|REST / SSE| A["Local FastAPI\n127.0.0.1:8765"]
    A -->|page script inject| B["Automation Browser\n(Playwright)"]
    B -->|DOM probe / CDP action| N["Naver Blog"]
    A -->|public BuddyList, search, RSS| N
    A -->|structured request| LLM["LLM Providers\n(OpenAI · Gemini · Claude)"]
    LLM -->|summary, candidates, body| A
    A --> D[(SQLite)]
    A --> FS["Local Filesystem\n(초안 이미지)"]
```

FastAPI는 `127.0.0.1:8765`에만 bind합니다. **`client/` 로컬 웹앱**이 유일한 end-user
UI입니다. 과거 Chrome Side Panel extension은 v0.5.6에서 동결(FROZEN)되었으며 더 이상
개발·사용되지 않습니다. Python 패키지는 loopback 서비스와 SPA를 함께 제공하며
별도 프레젠테이션 프로세스는 필요하지 않습니다.

## 구성 요소 책임

### 로컬 웹앱 (`client/`)

TypeScript SPA로 빌드되며 같은 loopback 서비스에서 static으로 제공됩니다. CORS 추가
설정 없이 같은 origin에서 API를 호출합니다.

워크스페이스에는 **오늘의 작업(Today)**, **여러 글 처리(Session)**, **글 작성(Writing)**,
**최근 작업(Activity)**, **설정(Settings)** 다섯 탭이 있으며, 한 번에 하나만 표시합니다.

- **Today** — 탐색 대기열 상태, 큐 동기화, 개별 글 처리 시작.
- **Comment** — 추출 뒤 기본 후보를 생성하고, 선택·AI 빠른 다듬기·복사·한 번의 실행 승인을 제공합니다.
- **Session** — 세션 배치 승인, SSE 기반 진행 추적, 취소.
- **Writing** — 초안 생성과 AI 완성, title·body 자동 저장, revision 비교, 태그 생성, 임시저장 실행.
- **Activity** — 저장된 recommendation·배치·초안을 다시 열고 개인화 예시와 로컬 기록을 정리합니다.

SPA는 secret이나 API key를 보유하지 않으며, LLM provider 설정 여부만 표시합니다.

### Page Script Injection (`client/src/page/`)

자동화 브라우저(Playwright)의 isolated context에 `window.__nbaPage`로 주입되는 read-only
probe 번들입니다. 기사 추출, 댓글·공감·서로이웃 popup probe, 에디터 probe, 내 블로그 카테고리
읽기 등 DOM 관측만 담당합니다. CDP를 통한 클릭·입력은 Python 레이어가 probe 결과를 확인한 뒤
trusted input으로 실행합니다.

### Local API, Domain, Persistence

FastAPI는 체크인된 [`api/openapi.yaml`](api/openapi.yaml) 계약, 입력 검증, request-size
제한, exact-origin CORS, local rate limiting, timeout 처리, redacted 로그를 소유합니다.
application과 domain 레이어는 FastAPI, Chrome, SQLAlchemy, 어떤 LLM SDK에도 의존하지
않습니다.

SQLite는 추천(recommendations), 교류 실행(engagement runs), 탐색 큐(discovery posts),
세션 배치(automation sessions), 초안(post drafts)과 그 revision·tag·이미지 metadata,
설정(app settings), LLM 호출 기록(call attempts)의 정식 소유자입니다. 완전한 기사
본문은 절대 저장하지 않습니다.

### 다중 LLM Provider 구조

```
infrastructure/llm/
├── registry.py        — ProviderRegistry
├── openai_client.py   — OpenAIStructuredClient
├── gemini_client.py   — GeminiStructuredClient
├── anthropic_client.py — AnthropicStructuredClient
└── fake_client.py     — FakeStructuredClient (테스트·기본)
```

**`ProviderRegistry`**는 프로세스 환경에서 API key를 읽고, 어떤 provider가 호출 가능한지
보고하며, 요청 시 client를 캐싱해 반환합니다. Key 값은 response나 로그에 절대 노출하지
않으며, SPA에는 `configured: bool` 여부만 반환합니다.

각 adapter는 공통 `StructuredCompletion` port를 구현하며, Pydantic Structured Outputs를
사용해 결과를 검증합니다.

| Provider | 환경변수 | 기본 model |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.6-terra` |
| Gemini | `GEMINI_API_KEY` | `gemini-3.6-flash` |
| Claude | `ANTHROPIC_API_KEY` | `claude-sonnet-5-20260514` |

**Fan-out (`application/llm/fanout.py`)**는 하나의 요청을 여러 provider에 병렬 호출해
결과를 비교합니다. 각 provider에 독립적인 idempotency key가 파생되므로 재시도 시 이미
저장된 결과를 재생합니다. 부분 실패는 정상이며, 한 provider의 거부가 다른 provider의
성공 결과를 무효화하지 않습니다.

**`CallBudget` (`application/llm/budget.py`)**는 fan-out이 시작되기 전에 두 가지 한도를
확인합니다:

1. **`per_request_provider_cap`** — 한 요청이 동시에 호출할 수 있는 provider 수.
2. **`daily_call_cap`** — 이 설치가 하루에 사용할 수 있는 총 provider 호출 수.

한도를 초과하면 `BudgetExceededError`를 반환하며 어떤 provider도 호출하지 않습니다.
두 값은 `settings/{kind=llm_budget}`에서 구성합니다.

### 글쓰기 Domain

글쓰기 워크플로는 다음 domain 개체를 사용합니다:

- **`PostDraft`** — 초안의 lifecycle을 소유합니다. 상태는 `collecting → composed →
  refining → tagged → staging → staged`로 전진하며, `abandoned`로의 명시 전환만
  예외입니다.
- **`DraftRevision`** — 한 번의 생성·다듬기·사용자 편집 결과. `seed`, `composed`,
  `refined`, `user_edited` 네 kind가 있으며 draft에 여러 revision이 쌓입니다.
- **`BodyBlock`** — 본문은 HTML이 아니라 block 배열입니다. 에디터 입력은 block 단위로
  실행하며, 같은 콘텐츠를 다른 에디터로 옮길 수 있습니다.
- **`DraftTag`** — 정규화된 태그. `generated`와 `user` 소스를 구분하며 선택 상태를
  관리합니다.
- **`PublishRun`** — 에디터 임시저장 step machine. `title → body → images → tags →
  save` 5단계로 진행하며, engagement run과 같은 forward-only 전이를 따릅니다.

`ComposePost` use case는 참고 글 본문(최대 4,000자 × `reference_post_count`건)과
초안 seed text를 LLM provider에 보내 본문을 생성합니다. 다듬기는 기존 body를 입력으로
같은 port를 호출합니다. 태그 생성도 동일한 경로를 사용합니다.

### 세션 배치 (`RunSession`, `SessionPostRunner`)

**`RunSession`**은 하나의 승인으로 여러 글을 순서대로 처리하는 batch orchestrator입니다.
승인 시점에 `automation_session_posts`에 대상 UUID와 순서를 snapshot으로 저장하고, 실행 중
대기열이 바뀌어도 이 snapshot만 사용합니다. 각 글 사이에 `SafetyGovernor`가 판정을 수행합니다.

- 사용자가 승인한 `max_posts`건까지 처리하며 하나도 초과하지 않습니다.
- 취소 요청은 현재 글이 끝난 뒤 반영됩니다.
- 진행 상태는 SSE event stream으로 client에 전달됩니다.
- 종료된 세션은 새 승인 없이 재개되지 않습니다.
- process가 다시 시작되면 이전 pending/running session은 `process_restarted` abort 상태가 됩니다.
  브라우저의 실제 마지막 동작을 재추측하거나 자동 재개하지 않습니다.

**`SessionPostRunner`**는 한 글에서 추출 → 댓글 생성 → 첫 후보 승인 → 교류 실행을
순서대로 수행합니다. 각 실패는 result code로 기록되며 batch가 계속할지 중단할지를
`RunSession`이 판단합니다.

### SafetyGovernor

`SafetyGovernor`는 모든 외부 행동 전에 다음 조건을 확인합니다:

| 판정 사유 | 조건 |
| --- | --- |
| `daily_cap_reached` | 공감·댓글·서로이웃 각각의 일일 상한 초과 |
| `outside_allowed_hours` | 현재 시각이 허용 시간대(`allowed_hours`) 밖 |
| `consecutive_failures` | 연속 실패 횟수가 `max_consecutive_failures`에 도달 |

추가로 글 사이 **최소 간격**(`min_interval_seconds`)과 **jitter**(`jitter_ratio`)를
적용하며, 기사 길이에 비례하는 **dwell time**을 계산합니다.

거부 시 `GovernorRefusedError`가 발생하며 session은 abort 상태로 전이합니다.
`GET /api/v1/automation/safety-status`는 action별 cap·사용·잔여량과 현재 시간/실패 gate를
반환합니다. 웹앱은 사용자가 선택한 단계와 대상 수만 이 상태에 대입해 시작 전 범위를 표시하며,
서버는 각 글을 실행하기 직전에 같은 governor를 다시 확인합니다.

### 무인 스케줄 (`ScheduleSessions`)

무인 실행은 opt-in이며 다음 세 조건을 모두 충족해야 활성화됩니다:

1. `settings/automation_consent`에서 `accepted: true`.
2. `settings/safety_policy`가 한 번 이상 명시적으로 저장됨(`updated_at ≠ null`).
3. `settings/schedule_policy`의 `mode`가 `"schedule"`.

세 조건을 충족하면 `ScheduleSessions.run_if_due()`가 매일 지정 시각(±5분)에 호출됩니다.
자동으로 browser session을 시작하고 `SessionTrigger.SCHEDULE`로 세션을 승인합니다.

안전 장치:
- 하루에 한 번만 실행됨(같은 날 `SessionTrigger.SCHEDULE`로 생성된 세션이 이미 있으면
  건너뜀).
- 다른 세션이 활성 상태이면 건너뜀.
- 브라우저를 시작하지 못하면 건너뜀.
- 하나라도 누락된 조건이 있으면 `ScheduleDecision(started=False, reason=...)`을
  반환하며 아무 작업도 하지 않음.

## 상태 소유와 데이터 수명

| 상태 | 소유자 | 수명 |
| --- | --- | --- |
| Blog DOM | Automation Browser tab | 페이지 수명 |
| 추출된 전체 본문 | FastAPI 메모리 | 해당 작업이 완료되거나 프로세스 종료 시 해제 |
| 참고 글 본문 (글쓰기용) | FastAPI 메모리 → LLM provider 전송 | generation 완료 시 해제 |
| SPA UI 상태 | 브라우저 메모리 | 탭 수명 |
| 추천·교류 실행·세션·초안·설정 | SQLite | 명시 삭제까지 |
| 초안 이미지 bytes | 로컬 filesystem (`DRAFT_MEDIA_DIR`) | 초안 삭제까지 |
| LLM API Key | Python process 환경변수 | 프로세스 수명 |
| `NAVER_SEARCH_CLIENT_ID`/`SECRET` | Python process 환경변수 | 프로세스 수명 |
| LLM 호출 기록 (attempts) | SQLite | 예산 계산용, 일별 |
| 세션 배치 진행·SSE event | 메모리 + SQLite | 세션 종료까지 |

## 보안과 개인정보 경계

- **LLM API key는 Python 프로세스 환경에만 존재합니다.** 어떤 경우에도 client(SPA),
  response body, 로그, 브라우저 storage에 전달되지 않습니다. SPA에는 `configured: bool`
  여부만 반환합니다.
- **참고 글 본문은 LLM provider로 전송됩니다.** 글쓰기의 `ComposePost`와 `RefinePost`는
  내 블로그 참고 글 본문(최대 4,000자 × 설정된 건수)을 provider에 전달합니다. 댓글
  생성 시에도 대상 글 본문이 provider에 전달됩니다. 전송된 본문은 SQLite나 로그에
  저장되지 않습니다.
- **초안 이미지는 로컬 filesystem에만 존재합니다.** `DraftImageStore`가 관리하는 runtime
  directory(`DRAFT_MEDIA_DIR` 또는 기본 경로)에 generated UUID 이름으로 저장됩니다.
  원본 파일명은 sanitize되며, response에 bytes가 포함되지 않습니다. `use_image_vision:
  true`를 설정한 경우에만 이미지가 provider에 전달됩니다.
- FastAPI는 loopback에만 bind하며, CORS는 선언된 origin만 허용합니다. 브라우저
  credentials는 비활성입니다.
- `blog.naver.com`과 `m.blog.naver.com` HTTPS URL만 초기 허용 대상입니다.
- 자동화 브라우저는 전용 profile을 사용하며 기존 브라우저와 분리됩니다. 쿠키·계정
  정보를 읽지 않고, 공개 페이지의 sign-in affordance만 관찰합니다.
- Request body, authorization header, 기사 본문, provider payload는 로그·브라우저
  storage·테스트 artifact·스크린샷에서 제외됩니다.
- Client abort나 탭 닫기 시 브라우저 reference는 해제되나, 이미 실행 중인 FastAPI/
  provider 작업의 취소는 보장하지 않습니다.

### Extension 동결 상태

Chrome Manifest V3 extension은 v0.5.6에서 동결(FROZEN)되었습니다. `extension/`
디렉토리는 코드베이스에 남아 있지만 새 기능이 추가되지 않으며, 사용자 워크플로에서
사용되지 않습니다. 기존 `chrome.storage.local`에 저장된 데이터는 웹앱 이전을 위해
참조만 가능합니다.

## 런타임과 품질 전략

Python 3.14, `uv`, FastAPI, SQLAlchemy, Alembic, SQLite가 서비스를 구성합니다.
`client/`는 Node.js 24 LTS, TypeScript, esbuild, Biome, Vitest로 빌드합니다.
자동화 브라우저는 Playwright입니다.

PR CI는 Ruff, ty, pytest(85% branch coverage 이상), TypeScript 검사, Biome, Vitest
coverage, extension production build, 설치된 wheel smoke test, 별도 System E2E
workflow를 실행합니다. Fixture는 합성 HTML만 포함하며, 실제 Naver 페이지나 live LLM
호출은 opt-in입니다.

## 결과

- API key가 SPA에 노출되지 않으면서도 같은 loopback에서 모든 기능을 제공합니다.
- 여러 LLM provider를 동시 비교할 수 있으면서도 예산 제한으로 비용을 통제합니다.
- 세션 배치와 무인 스케줄은 항상 SafetyGovernor를 거치며 일일 상한과 시간대를
  준수합니다.
- 글쓰기 워크플로는 임시저장까지만 자동화하며 발행은 사용자가 직접 수행합니다.
- OpenAPI가 SPA-to-service의 단일 진실 소스이며, 비호환 변경은 새 API version을
  요구합니다.
