# 웹앱 UX 전면 개편 — 실행·검증 기준서

> 상태: **활성 / 미완료** · 기준일: 2026-08-08 · 적용 범위: desktop web app, paired tablet web app,
> local API, browser automation adapter
>
> 이 문서는 이번 UX 전면 개편의 단일 실행 기준이다. 기능을 일부 구현했거나 단위 테스트가
> 하나 통과한 사실만으로 완료를 선언하지 않는다. 각 요구사항은 이 문서의 수용 기준과 증거를
> 모두 만족해야 완료다.
>
> 초기 웹앱 제공을 위한 과거 계획은
> [`archive/webapp-first-delivery-plan.md`](archive/webapp-first-delivery-plan.md)에 **역사 자료**로
> 보존한다. 해당 문서는 이번 UX 개편의 계획도, 완료 근거도 아니다. archive 이동은 구현 완료를
> 뜻하지 않는다.

## 1. 범위 잠금과 완료 선언 규칙

### 1.1 이번에 제공할 사용자 가치

사용자는 다음 흐름을 하나의 로컬 웹앱에서 끝낼 수 있어야 한다.

1. PC에서 AI·Naver Search·SMTP·브라우저·LAN 연결을 안전하게 저장하고, 명시적으로 재시작해
   적용한다.
2. 홈에서는 준비 상태와 오늘의 요약만 보고, 긴 발견 목록과 댓글 처리는 작업함에서 한다.
3. 이웃 새 글과 신규 이웃 후보를 같은 작업함에서 검색·선택·처리하고, 보류 글을 복구한다.
4. 복수 글은 선택 순서, 승인 단계, 일일 잔여 한도, 최소 소요 시간을 본 뒤 일괄 처리한다.
5. 글쓰기 studio에서 canonical block을 편집·자동저장·재개하고, 네이버가 지원하는 구조를
   검증한 뒤에만 임시저장한다.
6. Galaxy Tab/iPad에서는 작업함·댓글·글쓰기·이력을 재개하되 PC 비밀값, 브라우저 제어,
   LAN/기기 관리는 볼 수도 바꿀 수도 없다.

### 1.2 완료 판정

아래는 모두 충족되어야 한다.

| 완료 ID | 완료 조건 | 필요한 직접 증거 |
| --- | --- | --- |
| DONE-01 | 네 개 primary navigation과 legacy route 호환이 desktop/tablet에서 동작한다. | DOM/route test와 3 viewport E2E 결과 |
| DONE-02 | 작업함의 queue·댓글·보류 복구·일괄 승인 전 확인이 모든 source/state 조합에서 동작한다. | API integration, DOM journey, batch preview test |
| DONE-03 | canonical block/working copy/충돌 처리가 기존 초안을 훼손하지 않는다. | migration fixture, API conflict, editor DOM test |
| DONE-04 | 지원한다고 표시한 모든 Naver block을 요청 순서대로 trusted input으로 넣고 결과 구조를 읽어 검증한다. | adapter sequence test와 opt-in live smoke; 지원 불가 시 save 전에 fail-closed |
| DONE-05 | runtime secret은 write-only private env 외에 남지 않으며 restart guard가 실제로 적용을 제어한다. | redaction/permission/symlink/duplicate/pair/restart test 및 artifact audit |
| DONE-06 | client·extension·Python 품질 게이트와 secret/viewport 검증이 최종 종료 상태까지 통과한다. | 기록된 명령, exit 0, coverage, screenshot audit |
| DONE-07 | 두 review-ready 변경 단위가 서로의 범위와 검증 결과를 설명할 수 있다. | intentional commit 범위, PR 설명 초안, 검증 기록 |

`DONE-04`의 live smoke는 실제 네이버 계정 조작을 기본 test에 넣는다는 뜻이 아니다. mock
adapter 검증이 기본 gate이고, 별도 동의한 테스트 계정에서만 opt-in으로 실행한다. live smoke가
없는 block은 UI와 문서에서 지원 완료로 표시하지 않는다.

### 1.3 범위 밖

- 네이버 고유 표·지도·동영상·스티커·임의 글꼴/색상은 첫 block editor에서 지원하지 않는다.
- 자동 발행, Captcha 우회, 사용자 승인 없는 댓글·공감·서로이웃 신청·프로세스 재시작은 하지 않는다.
- DB URL, media directory, API host/port를 일반 웹 form으로 노출하지 않는다.
- API 응답 cache, credential을 포함한 screenshot/log/export, paired tablet의 PC 관리 기능은 허용하지 않는다.

## 2. 확정된 설계 결정과 불변 조건

| 결정 ID | 확정 사항 | 구현 경계 | 금지 사항 |
| --- | --- | --- | --- |
| DEC-01 | primary navigation은 `홈 · 작업함 · 글쓰기 · 더보기` 네 개다. | `client/public/index.html`, `navigation.ts`, `main.ts` | batch/activity/settings/device를 primary tab으로 추가 |
| DEC-02 | 작업함은 발견 목록의 단일 소유자다. | `TodayController`, `today.ts`, app discovery queue | 홈에 긴 목록/직접 URL/batch form 재도입 |
| DEC-03 | API/DB의 draft 본문 표준은 discriminated `BodyBlock[]`와 working copy다. | domain, draft API, migration `0021` | 입력 때마다 immutable revision 생성, textarea 재직렬화 |
| DEC-04 | 네이버 staging은 structure-first, fail-closed다. | page probe, browser port, `StagePost` | unsupported structure를 plain text로 조용히 save |
| DEC-05 | 비밀은 OS-private dotenv에 write-only로만 저장한다. | `RuntimeConfiguration`, supervisor, runtime router | SQLite/localStorage/GET/log/error/DOM echo |
| DEC-06 | runtime connection management는 desktop loopback 전용이다. | request local-client check, settings rendering | paired tablet에서 key/SMTP/browser/LAN/device 공개 |
| DEC-07 | PWA는 static shell만 cache하고 `/api/`는 항상 network다. | `service-worker.js`, manifest, SPA mount | API response/offline mutation cache |
| DEC-08 | low-level data location은 앱이 소유한다. | runtime data service, data-management UI | `DATABASE_URL`, `DRAFT_MEDIA_DIR`, `API_HOST`, `API_PORT` 일반 설정 노출 |

## 3. 현재 코드 감사 기준선

상태 표시는 2026-08-08 worktree를 직접 읽어 기록했다. `부분`은 코드가 있으나 수용 기준 또는
검증이 부족한 상태이며, 완료가 아니다.

| 요구 영역 | 현재 증거 | 상태 | 남은 결정적 작업 |
| --- | --- | --- | --- |
| 네 개 navigation·legacy hash redirect | `navigation.ts`, `main.ts`, `main.test.ts`, `navigation.test.ts` | 부분 | desktop/768/1024 E2E와 route 재개 검증 |
| home/workbench 분리·cursor queue·보류 복구 | app queue route, `TodayController`, `test_local_api.py`, `today-view.test.ts` | 부분 | batch preview의 한도/시간, journey와 viewport 확인 |
| `Recommendation.version` 제거 | OpenAPI/client parser/fixture 수정과 API client test | 부분 | schema-parity test를 gate로 연결하고 full Python/viewport 검증 |
| activity card·PWA shell | `activity.ts`, manifest, `service-worker.js`, SPA mount test | 부분 | API non-cache와 viewport/PWA install 확인 |
| canonical block·working copy·migration `0021` | domain/draft API/repository/migration/conflict test | 부분 | 실제 `0020 → 0021 → 0020 → 0021` fixture 검증은 통과; full migration gate 및 editor resume journey |
| structured staging | unique capability probe, fail-closed `StagePost`, semantic prefix evidence | 부분 | mock/local trusted input 검증은 통과; opt-in actual Naver signature smoke와 전체 gate |
| runtime protected configuration·supervisor | runtime service/router/settings UI/unit+integration tests, desktop data API/UI | 부분 | browser download E2E, full secret artifact audit |
| schedule/budget advanced settings | settings controller/view and app setting routes | 부분 | tablet restriction and end-to-end persistence proof |
| quality gates | targeted suites, client coverage completion, extension check | 부분 | Python full suite, viewport E2E, secret audit |

현재 branch의 각 기능 단위는 Conventional Commit으로 분리한다. PR 직전에는 `git diff` 기반으로
각 단위에 속하지 않는 변경을 분리하거나 명시하고, quality gate 증거를 PR 설명에 남긴다.

## 4. 사용자 여정과 화면별 수용 기준

### UJ-01. 첫 실행과 PC 연결 설정

| 단계 | 화면·동작 | 수용 기준 | 실패 시 행동 |
| --- | --- | --- | --- |
| 1 | 홈 준비 카드에서 부족한 AI 설정을 연다. | 해당 더보기 설정 section으로 이동하고 blocker 이유를 보여 준다. | 비밀값을 URL/DOM 상태에 넣지 않는다. |
| 2 | 브라우저 시작 후 네이버 로그인을 사용자가 한다. | login 상태 갱신과 focus/close action이 보인다. | 브라우저 제어 실패를 재시도 loop로 숨기지 않는다. |
| 3 | 내 블로그/탐색 기본값을 저장한다. | app settings와 runtime settings가 구분되어 저장된다. | validation error는 해당 card에 표시한다. |
| 4 | provider/key/SMTP/LAN을 저장하고 적용한다. | PATCH는 write-only, GET은 configured boolean만 반환한다. 재시작은 사용자가 별도로 승인한다. | launcher가 없거나 작업 중이면 409과 조치 안내를 반환한다. |

### UJ-02. 이웃 새 글과 댓글 처리

| 단계 | 수용 기준 |
| --- | --- |
| 작업함 진입 | `이웃 새 글`이 기본 segment이며 query/state/sort/cursor가 API 요청과 화면에 일치한다. |
| 상세 확인 | URL, source/search label, author, published time, 현재 상태, 실행 blocker를 표시한다. |
| 댓글 작업 | 원문 추출·후보 생성·근거·말투·글자 수·한도·실행 가능 상태를 즉시 갱신한다. |
| 복귀 | comment panel을 닫거나 뒤로 갈 때 selected row/filter/query/sort/cursor와 scroll context를 잃지 않는다. |
| 보류 | skipped 글은 `보류됨`에 실제로 남고 `다시 대기` 성공 후 counts/list/detail이 즉시 일치한다. |

### UJ-03. 신규 이웃 후보와 일괄 처리

| 단계 | 수용 기준 |
| --- | --- |
| 후보 탐색 | source가 search인 글에 검색어·작성자·발행 시각 badge가 있고 query가 server cursor 결과에 적용된다. |
| 복수 선택 | 선택 순서를 명확히 표시하며 최대 50건을 넘기지 않는다. |
| 작업함 preflight | 선택 제목/순서, 현재 일일 cap의 used·remaining, 선택 단계별 예상 action 수, `min_interval_seconds` 기반 최소 시간을 표시한다. |
| 승인 화면 | workbench context로 열린 batch 화면에서 like/comment/mutual-neighbor 범위와 대상이 재확인되고 start 직전 safety status를 다시 읽는다. |
| 실행/이력 | SSE의 post/step 결과, cancel, abort reason이 activity/session card와 일치한다. |

### UJ-04. 블록 글쓰기와 네이버 임시저장

| 단계 | 수용 기준 |
| --- | --- |
| 편집 | paragraph, heading, quote, ordered/unordered list, divider, image+caption을 삽입·삭제·복제·이동·drag reorder한다. |
| 재개 | title/blocks/summary/content version을 debounce save하고 다른 기기 충돌은 latest copy 재로드 안내로 처리한다. |
| AI | compose/refine/tagging은 canonical block input/output을 사용하며 checkpoint만 immutable revision을 만든다. |
| staging preflight | 지원 block matrix와 요청 block 수/순서를 보여 주고, unsupported block은 save 시작 전에 거부한다. |
| staging | title → body blocks in order → image at exact block position → tags → save 순서로 trusted input을 수행한다. 각 단계는 SSE에 `requested/observed/result_code`를 남긴다. |
| handoff | save 후 제목·block 순서·이미지·태그를 사용자가 네이버 UI에서 확인해야 한다는 checklist를 보여 준다. 발행 버튼은 제공하지 않는다. |

### UJ-05. 태블릿 재개

| viewport | 수용 기준 |
| --- | --- |
| 768px portrait | queue list와 detail/comment은 전환 가능한 dismissible sheet이며 back/close 후 목록 상태를 유지한다. |
| 1024px landscape | queue list/detail의 2열을 유지하며 최소 touch target 44px와 focus ring을 지킨다. |
| paired device | visibility/pageshow로 workbench/comment/writing/activity를 refresh한다. runtime connection, browser, pairing/device management card와 secret input은 렌더하지 않는다. |

## 5. 구현 단위 A — `feat(workbench): 현대적인 홈·작업함과 댓글 흐름`

### A0. 변경 경계와 의존성

- 선행: OpenAPI의 app queue response와 legacy extension queue contract가 독립되어 있어야 한다.
- 주 파일: `api/factory.py`, `discovery_repository.py`, `client/src/app/{main,navigation}.ts`,
  `controllers/today.ts`, `state/today.ts`, `views/today.ts`, `views/activity.ts`, `app.css`.
- 금지: extension `/api/v1/discovery/queue`에 SPA 전용 query/state 의미를 추가하거나, batch를
  fifth primary navigation으로 만드는 일.

### A1. navigation, home, more

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| A1-01 | primary navigation을 네 항목으로 고정하고 legacy hash를 새 route로 redirect한다. | 부분 구현 | route mapping unit test + initial/changed hash DOM test |
| A1-02 | 홈은 readiness/오늘 요약/quick start만 보이며 긴 queue는 작업함으로 보낸다. | 부분 구현 | home DOM snapshot과 direct URL/queue 부재 assertion |
| A1-03 | 더보기는 activity, 작업 기본값, 탐색·자동화, 연결·앱의 entry만 제공한다. | 부분 구현 | more IA DOM test와 route test |
| A1-04 | pairing/runtime card는 loopback desktop에서만 보인다. | 부분 구현 | local vs paired rendering test + API 403 test |

### A2. cursor queue, detail, comment context

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| A2-01 | `/api/v1/app/discovery/queue`에 source/state/query/cursor/limit과 items/counts/next_cursor를 유지한다. | 부분 구현 | cursor/query/count API integration; legacy endpoint regression |
| A2-02 | skipped search post는 saved search 삭제 후에도 SPA queue에서 조회·복구된다. | 부분 구현 | orphaned skipped API test와 UI restore journey |
| A2-03 | segment/filter/sort/search/cursor/badge와 list+detail/sheet를 구현한다. | 부분 구현 | Today state/controller/view test, 768/1024 E2E |
| A2-04 | comment panel은 workbench state를 보존하고 live character/limit/executable state를 보여 준다. | 부분 구현 | comment DOM journey, close/back state regression |
| A2-05 | `Recommendation.version`을 API response parser/fixture/request에서 제거한다. | 부분 구현 | schema-parity test that rejects extra/missing response fields |

### A3. batch preflight와 session handoff

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| A3-01 | `TodayState`에 읽기 전용 safety snapshot과 preflight load phase를 추가한다. | 부분 구현 | safety load/no-safety state test는 통과; dedicated preflight loading/error UI test가 남았다. |
| A3-02 | workbench 선택 card에 선택 순서·정확한 대상·단계별 cap used/remaining·예상 action count·최소 시간을 표시한다. | 부분 구현 | 1건/cap exhausted DOM test는 통과; N건·allowed-hours blocked viewport journey가 남았다. |
| A3-03 | `일괄 처리 계속`은 선택 ID/order를 SessionController에 전달하고, session은 start 직전에 safety를 재조회한다. | 부분 구현 | controller handoff/order와 session recheck가 있으나 changed-cap cross-controller integration test가 남았다. |
| A3-04 | session view는 workbench 하위 작업으로 back action을 제공하며 queue context를 보존한다. | 부분 구현 | explicit back control unit test는 통과; route/back/resume E2E가 남았다. |

예상 최소 시간은 `max(post_count - 1, 0) * min_interval_seconds`만을 **최소치**로 표기한다.
네트워크·AI·사용자 확인 시간은 포함하지 않으며, 이를 UI에도 명시한다.

### A4. activity, responsive PWA, 접근성

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| A4-01 | comment/batch/draft activity를 filter 가능한 summary card로 제공한다. | 부분 구현 | controller/view test for all filters and empty/error state |
| A4-02 | static shell service worker/manifest를 설치하고 `/api/` response를 cache하지 않는다. | 부분 구현 | service worker source test and browser network assertion |
| A4-03 | desktop/768/1024 navigation, queue detail, comment resume, keyboard focus를 확인한다. | 미구현 | playwright viewport E2E and sanitized screenshots |

### A 검증 완료 조건

`A1-01`~`A4-03`가 모두 완료되고, Python queue API + client workbench/comment/activity targeted tests,
client coverage, desktop/768/1024 E2E가 모두 exit 0이어야 한다. 이 조건 전에는 PR 1 commit을 만들지
않는다.

## 6. 구현 단위 B — `feat(studio): 블록 글쓰기와 웹 설정 센터`

### B0. 변경 경계와 의존성

- A의 navigation/workbench contract 위에 쌓되, API/DB migration은 UI 변경과 독립적으로 upgrade·rollback
  가능해야 한다.
- 주 파일: writing domain/repository/draft router, `StagePost`, page editor probes, browser port/adapters,
  runtime configuration/data service, settings controller/view, `scripts/start_webapp.py`.
- staging adapter는 live DOM을 추정해 성공시키지 않는다. capability가 없는 페이지는 명시 code로 중단한다.

### B1. canonical block과 working copy

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| B1-01 | BodyBlock discriminator와 legacy body parsing을 domain/API/OpenAPI/client parser에 일치시킨다. | 부분 구현 | schema parse matrix and OpenAPI parity test |
| B1-02 | canvas의 insert/delete/duplicate/reorder/image position/outline/preview/shortcut을 제공한다. | 부분 구현 | image position·keyboard retype 및 insert/duplicate/delete/drag reorder가 canonical block 배열을 유지하는 DOM test는 통과했다. outline focus/preview를 실제 viewport에서 확인하는 E2E가 남았다. |
| B1-03 | debounce working copy는 revision을 만들지 않고 title/blocks/summary/version을 저장한다. | 부분 구현 | fake-timer test가 burst edit 1회 저장, in-flight 뒤 최신 edit의 2차 저장 및 승인 version 승계를 확인했다. revision count/API two-device full journey가 남았다. |
| B1-04 | stale version은 409 latest copy를 반환하고 client는 overwrite 없이 재로드 안내한다. | 부분 구현 | API의 stale-device 409 test와 client의 conflict 뒤 latest working copy reload·queued autosave 폐기 test가 통과했다. 실제 two-device/DOM journey가 남았다. |
| B1-05 | migration `0021` backfill과 downgrade/restore 절차를 fixture DB에서 검증하고 문서화한다. | 부분 구현 | 실제 `0020 → 0021 → 0020 → 0021` fixture가 active revision 보존과 re-backfill을 검증했다. Local Operations에 운영 downgrade 비권장·export/backup 복구 범위를 기록했다. full migration gate가 남았다. |

### B2. structured Naver staging capability contract

이 항목은 단순 `readEditorBlocks()` snapshot이 존재한다고 완료가 아니다. 다음 capability contract를
모두 구현·검증해야 한다.

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| B2-01 | page probe가 editor root, title, save, image input과 block action capability를 각각 단 하나로 식별한다. 제목·저장·toolbar는 visible/enabled여야 하고, native image input은 브라우저 관례상 숨겨져도 되지만 중복이면 거부한다. | 부분 구현 | synthetic DOM ready/ambiguous/missing matrix와 duplicated toolbar/file input 거부 test는 통과했다. 실제 Naver signature smoke는 남았다. |
| B2-02 | browser port가 clear-and-type와 append/Enter/key action을 구분해 trusted input으로 제공한다. | 부분 구현 | Playwright adapter unit과 local trusted-input integration은 통과했다. 실제 Naver editor에서의 opt-in 확인은 B2-07에 남았다. |
| B2-03 | paragraph/heading/quote/ordered list/unordered list/divider를 빈 editor에서 한 block씩 입력하고 매 block 뒤 semantic snapshot prefix를 검증한다. | 부분 구현 | 여섯 kind action 순서와 prefix snapshot mock test는 통과했다. Naver DOM live smoke가 없으므로 완료가 아니다. |
| B2-04 | image는 request의 image block 위치에서 단일 attachment를 수행하고 caption/position snapshot을 검증한다. | 부분 구현 | image 앞/중간/뒤 action 순서, caption control 부재 fail-closed, prefix snapshot mock test는 통과했다. 실제 DOM signature 검증은 남았다. |
| B2-05 | unsupported block control, ambiguous selector, unexpected editor mutation, missing image/caption verification은 save 전에 stable result code로 중단한다. | 부분 구현 | negative matrix ensures no save click |
| B2-06 | SSE는 body `step_completed`에 requested index/range와 observed prefix를, client는 네이버 직접 확인 checklist를 노출한다. | 부분 구현 | API SSE detail, controller live update, checklist DOM test는 통과했다. 페이지를 닫은 뒤 transient detail을 재구성하는 정책은 아직 없다. |
| B2-07 | documented supported Naver DOM signature에서 opt-in smoke를 실행한다. signature가 바뀌면 support flag를 false로 바꾼다. | 미구현 | opt-in, no-secret live test record |

새 adapter가 하나의 block kind를 지원하지 못하면 그 kind는 staging preflight에서 unsupported로 반환한다.
평문 변환, 전체 body 한 번 입력 후 '우연히 snapshot이 맞음'을 성공으로 처리하는 방식은 금지한다.

### B3. settings IA, protected runtime configuration, data management

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| B3-01 | settings를 작업 기본값 / 탐색·자동화 / 연결·앱 card/side navigation으로 제공한다. | 부분 구현 | section navigation and save/reload DOM tests |
| B3-02 | schedule policy와 LLM budget advanced disclosure를 real GET/PATCH에 연결한다. | 부분 구현 | persistence and validation tests |
| B3-03 | stale SQLite `browser_profile`/`llm_providers`를 migration으로 제거하고 runtime env를 source of truth로 만든다. | 부분 구현 | upgrade/downgrade fixture and no-dead-setting test |
| B3-04 | runtime GET/PATCH/restart와 write-only secret replace/clear를 desktop loopback으로 제한한다. | 부분 구현 | local/paired 403, no-echo, atomic write, restart guard tests |
| B3-05 | private env owner/0600/symlink/duplicate/unknown-comment/atomic fsync-replace를 검증한다. | 부분 구현 | RuntimeConfiguration unit matrix |
| B3-06 | supervisor restart는 active browser/session/staging을 guard하고 readiness poll 뒤 SPA reload한다. | 부분 구현 | supervisor/router/client tests for success/unavailable/busy |
| B3-07 | app-owned data metadata(location, export/reset availability)를 desktop-only API로 제공한다. | 부분 구현 | local metadata와 paired 403 test는 통과했다. media root는 열린 SQLite database 인접 경로로 앱이 파생하고 runtime UI는 low-level path를 받지 않는다. desktop viewport E2E가 남았다. |
| B3-08 | export는 active work가 없을 때 browser download로 redacted archive를 만든다. | 부분 구현 | idle guard, database/media-only archive, private env/browser profile 제외, media symlink 거부 test는 통과했다. 실제 browser download E2E와 export-directory 운영 선택은 남았다. |
| B3-09 | reset은 DB/WAL/SHM·미디어별 count를 먼저 표시하고 explicit typed confirmation + idle guard 후 recoverable backup을 수행한다. | 부분 구현 | count breakdown, confirmation, browser-busy 409, backup move, symlink test는 통과했다. backup 보존 기간/복구 command 운영 문서가 남았다. |
| B3-10 | data management UI는 PC에만 위치·export·safe reset을 보여 주며 low-level path form은 없다. | 부분 구현 | desktop/paired DOM test와 client response parser test는 통과했다. viewport E2E가 남았다. |

`B3-08`과 `B3-09`는 destructive operation이다. 구현 전에는 export 대상, backup 보존 기간,
reset 대상(DB/WAL/SHM/media 중 무엇인지)을 API contract에 명시하고, 실제 대상이 확정된 뒤에만
사용자에게 confirmation UI를 노출한다. 이 결정이 없으면 reset control을 만들지 않는다.

### B4. 문서와 운영 handoff

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| B4-01 | README/Getting Started가 네 화면, desktop runtime 저장/재시작, tablet restriction을 정확히 설명한다. | 부분 구현 | documentation review against implemented capability matrix |
| B4-02 | block support/staging failure/user Naver confirmation을 실제 adapter capability만큼 설명한다. | 부분 구현 | no unsupported-success claim search/audit |
| B4-03 | migration upgrade/downgrade, data export/reset, test hang protocol을 운영 문서에 기록한다. | 부분 구현 | `local-operations.md`에 automatic migration, `0021` fixture rollback 범위, UI export/reset/backup 수동 복구, timeout/60초 무출력 중단 규칙을 기록했다. browser download E2E가 남았다. |

### B 검증 완료 조건

`B1-01`~`B4-03`가 모두 완료되고, migration/runtime/staging/data targeted Python tests, client writing/settings
DOM tests, structured staging smoke policy, desktop/768/1024 writing/settings E2E, secret artifact audit이
exit 0이어야 한다. 이 조건 전에는 PR 2를 review-ready로 열지 않는다.

## 7. API·데이터 계약 작업 목록

### 7.1 SPA queue와 legacy compatibility

| 계약 | 구현 규칙 | test |
| --- | --- | --- |
| `GET /api/v1/discovery/queue` | extension 계약을 보존하고 source는 required다. | legacy regression |
| `GET /api/v1/app/discovery/queue` | source optional, state/query/cursor/limit supported; response는 `items/counts/next_cursor`. | pagination/orphaned skipped/query/count matrix |
| discovery state PATCH | skipped→queued recovery가 item/count/UI selection을 일관되게 갱신한다. | API + controller journey |
| recommendation response | `version` 없음; client fixture/parser가 OpenAPI response schema 밖 field를 허용하지 않는다. | contract parity |

### 7.2 Draft blocks와 optimistic working copy

| 계약 | 구현 규칙 | test |
| --- | --- | --- |
| `BodyBlock` | discriminator별 required/forbidden field, list item/text/image UUID bounds를 server와 client가 동일하게 검증한다. | valid/legacy/invalid parse matrix |
| save body | `base_content_version`은 current working copy에 맞아야 하며 stale이면 409 `draft_content_conflict`. | two device test |
| checkpoint | mutable working copy를 immutable revision으로 명시적으로 승격한다. | revision count/content test |
| staging request | active revision보다 confirmed working copy를 우선하되 empty/missing copy를 명확히 거부한다. | request selection test |

### 7.3 Runtime configuration와 data management

| 계약 | 구현 규칙 | test |
| --- | --- | --- |
| `GET /api/v1/runtime/configuration` | non-secret values/configured booleans/restart flags만 반환한다. | response redaction and OpenAPI parity |
| `PATCH /api/v1/runtime/configuration` | known key와 secret replace/clear intent만 수용하고 value를 echo하지 않는다. | atomic merge/clear/invalid/pair rejection |
| `POST /api/v1/runtime/restart` | local + launcher + restart required + no active automation/session/staging 전부 필요하다. | 409 matrix and successful marker |
| data metadata/export/reset | desktop local only; metadata는 DB/WAL/SHM과 media file count를 분리하고, export/reset은 idle·path confinement·explicit confirmation을 요구한다. | traversal/symlink/active-work/secret exclusion |

OpenAPI, Pydantic model, TypeScript type/parser, fake fixture는 함께 바뀌어야 한다. 하나라도 response
field를 임의로 추가하면 contract parity test가 실패해야 한다.

## 8. 구현 순서와 두 PR 경계

### Phase 0 — 기준선 고정

1. 이 계획의 `현재 코드 감사 기준선`을 각 변경 전 다시 검토한다.
2. full-suite hang을 재현하면 test를 file/test ID까지 이분화하고, 원인 없이 timeout을 통과로 바꾸지 않는다.
3. API/OpenAPI/client parser fixture parity test를 먼저 보강한다.

### Phase 1 — PR 1: `feat(workbench): 현대적인 홈·작업함과 댓글 흐름`

순서: A1 → A2 → A3 → A4 → A 검증. 포함 후보는 다음으로 제한한다.

- SPA queue route/repository/model/OpenAPI와 queue integration tests
- primary navigation, home/more/workbench/comment/session handoff/activity/PWA UI와 client tests
- workbench batch preflight 및 viewport/accessibility E2E

제외: writing schema/migration/staging/runtime/data-management 변경. PR 1은 A의 모든 완료 조건과
quality gate가 통과한 commit 하나 이상으로만 review-ready 상태가 된다.

### Phase 2 — PR 2: `feat(studio): 블록 글쓰기와 웹 설정 센터`

순서: B1 → B2 capability contract → B3 runtime/data → B4 → B 검증. 포함 후보는 다음으로 제한한다.

- BodyBlock/working copy/migration/draft API/OpenAPI
- page editor probe, browser port/adapter, staging service/SSE and tests
- settings IA/runtime configuration/supervisor/data-management and tests
- writing/settings docs and secret audit

PR 1이 아직 merge되지 않았다면 PR 2는 stacked dependency와 검증 기준을 명시한다. 사용자에게 push/
PR 생성 권한을 받기 전에는 branch/commit scope와 PR description 초안만 준비한다.

## 9. 검증 매트릭스와 hang 방지 운영 규칙

### 9.1 실행 원칙

1. 모든 test command는 `timeout`을 가진다. 최종 test summary와 process exit code가 둘 다 있어야
   통과다.
2. 출력이 60초간 변하지 않으면 PID/process tree/CPU·I/O state를 확인한다. 무기한 대기하지 않는다.
3. 중단이 필요하면 process group을 종료하고 명령, PID, 마지막 출력 시각, 재현 단위를 기록한다.
   종료된 실행은 **중단됨/미완료**이며 절대 통과가 아니다.
4. 변경 영역 test → static/type/build → full suite/coverage → viewport E2E 순서로 실행한다.
5. live Naver/AI test는 `RUN_LIVE_*` opt-in으로만 실행하고, key/cookie/blog body가 output/screenshot에
   없음을 확인한다.

### 9.2 필수 gate

| ID | 범위 | 명령 또는 방법 | 통과 기준 |
| --- | --- | --- | --- |
| V-01 | Python static | `timeout 120 uv run ruff format --check .`, `ruff check .`, `ty check` | 각 exit 0 |
| V-02 | A Python targeted | `timeout 180 uv run pytest --no-cov -vv <queue/comment/session files>` | final summary, all passed |
| V-03 | B Python targeted | `timeout 180 uv run pytest --no-cov -vv <draft/staging/runtime/data files>` | final summary, all passed |
| V-04 | Python full | `timeout 1200 uv run pytest -vv` | final summary + configured 85% branch coverage |
| V-05 | Client static | `timeout 120 npm --prefix client run format:check`, `lint`, `typecheck`, `build` | each exit 0 |
| V-06 | Client coverage | `timeout -k 5 180 npm --prefix client run test:coverage -- --reporter=verbose` | final summary + statement/function/branch/line each configured 80% |
| V-07 | Extension | `timeout -k 5 300 npm --prefix extension run check` | final summary + configured coverage |
| V-08 | SPA/PWA E2E | desktop, 768px, 1024px browser harness | nav/resume/static-cache assertions and sanitized screenshots |
| V-09 | Security audit | diff, DB/export, API body, DOM, logs, screenshots search | no plaintext secret, no secret-derived error |
| V-10 | Live smoke policy | opt-in fixture account only | capability signature and user verification record; no publish |

### 9.3 수행할 test 사례

| 영역 | 최소 사례 |
| --- | --- |
| queue | neighbor/search/skipped, cursor, query, deleted-search skipped retention, restore, legacy endpoint |
| workbench/comment | segment/filter/sort, selection order, detail→comment→back, live character boundary, remote pairing error |
| batch | 1/N selection, cap remaining/exhausted, allowed-hours block, min interval formula, latest safety recheck |
| writing | every block kind, insertion/reorder/drag/keyboard, image point/caption, autosave debounce, 409 reload, checkpoint |
| staging | capability missing/ambiguous, each supported block action, prefix mismatch, every image position, no-save negative cases, SSE checklist |
| runtime/data | replace/clear/no echo, permissions/owner/symlink/duplicates, local vs paired, restart busy/unavailable, export/reset boundaries |
| responsive | four navigation items, 768 sheet, 1024 split view, focus, touch target, resume after visibility/pageshow |

## 10. 검증 기록

기록은 실제 최종 output만 적는다. `통과`는 해당 scope의 required gate를 모두 만족했다는 뜻이 아니라,
표에 적힌 명령 하나가 통과했다는 뜻이다.

| 날짜 | 범위 | 결과 | 직접 증거 / 제한 |
| --- | --- | --- | --- |
| 2026-08-08 | Python runtime configuration targeted | 통과 | ruff format/check, ty, `test_runtime_configuration.py` + `test_runtime_configuration_api.py`: 8 passed, 1 warning, 7.22s. |
| 2026-08-08 | Python SPA asset targeted | 통과 | `test_spa_mount.py`: 9 passed, 1 warning, 6.05s. static service-worker asset만 확인했다. |
| 2026-08-08 | Client targeted | 통과 | `main.test.ts` 23 (18.32s), `activity.test.ts` 4 (17.72s), `settings.test.ts` 37 (18.68s), `today-view.test.ts` 22 (17.50s); 해당 파일 범위만이다. |
| 2026-08-08 | Client workbench batch preflight targeted | 통과 | `format`, `typecheck`, `today-state/today-view/session/main` 4 files/103 tests가 13.08초에 final summary와 exit 0으로 종료했다. selection order, step scope, cap exhaustion, min-interval lower bound, session handoff/back을 확인했다. |
| 2026-08-08 | Structured staging Python targeted | 통과 | `ruff format/check` 및 `test_stage_post.py` + `test_staging_api.py`: 55 passed, 1 warning, 11.02s, exit 0. six text block action, image before/between/after, fail-closed, SSE non-content body range/prefix detail을 확인했다. 실제 Naver smoke는 포함하지 않았다. |
| 2026-08-08 | Staging/checklist client targeted | 통과 | `format`, `typecheck`, `writing-state/writing-api/settings` 3 files/99 tests가 17.21초에 exit 0으로 종료했다. SSE step 즉시 반영과 네이버 확인 checklist DOM을 확인했다. |
| 2026-08-08 | Structured staging consolidated | 통과 | `format`, `typecheck`, page bundle, selected Ruff/`ty`, `git diff --check`, client 5 files/126 tests(17.84s), Python 87 tests(24.33s)가 exit 0으로 종료했다. 바로 앞 시도는 `factory.py`의 `Path(str \| None)` narrowing 1건으로 exit 1이었고, 명시적 None 분기 후 재실행해 해소했다. 실제 Naver smoke와 전체 suite/coverage는 이 결과에 포함하지 않았다. |
| 2026-08-08 | Runtime data contract targeted | 통과 | `format`, `typecheck`, Ruff/`ty`, `git diff --check`, client `api-client/settings` 2 files/110 tests(8.72s), Python `runtime_data/runtime_configuration_api` 7 tests(8.36s)가 exit 0으로 종료했다. PC-only, busy export guard, DB/WAL/SHM-media count, secret-free archive, reset backup을 확인했다. |
| 2026-08-08 | Working-copy migration targeted | 통과 | `format`, Ruff/`ty`, `test_app_settings_repository.py`, `test_post_draft_repository.py`, `test_draft_revisions_api.py` 51 passed, 1 warning(31.19s)가 final summary와 exit 0으로 종료했다. 새 fixture는 `0020 → 0021 → 0020 → 0021`에서 active revision 보존, working copy backfill, re-upgrade를 확인했다. migration head assertion도 `0022`로 갱신했다. |
| 2026-08-08 | Client working-copy autosave targeted | 통과 | client `format`, `typecheck`, `writing-api/writing-state` 2 files/64 tests(8.26s)가 final summary와 exit 0으로 종료했다. in-flight save 뒤 queued 최신 block이 승인 version을 이어 저장하고, 409 conflict에서는 queued autosave를 버리고 최신 working copy를 표시함을 확인했다. |
| 2026-08-08 | Client block canvas DOM targeted | 통과 | client `format`, `typecheck`, `writing-state` 25 tests(17.73s)가 final summary와 exit 0으로 종료했다. image 위치, keyboard retype, append/duplicate/delete, drag reorder가 BodyBlock 배열을 유지함을 확인했다. |
| 2026-08-08 | Client test hang guard | 통과 | command-level timeout과 final summary/exit code 확인 규칙으로 중단 실행을 통과로 기록하지 않는다. targeted suites는 모두 final summary와 exit 0으로 종료했다. |
| 2026-08-08 | Python 106-test 묶음 | 중단됨 | PID 1719554가 41개 출력 뒤 `p9_client_rpc` I/O 대기와 60초 무출력을 보여 종료했다. final summary가 없어 통과가 아니다. |
| 2026-08-08 | Client non-coverage full suite | 중단됨 | PID 1713782(fork), 1714780(thread)가 `settings.test.ts` 35개 출력 뒤 60초 무출력으로 종료됐다. |
| 2026-08-08 | Client non-coverage full suite 재시도 | 통과 | 26 files/608 tests가 final summary와 exit 0으로 종료했다. 이 기록은 이전 중단을 지우지 않으며 coverage gate는 별도다. |
| 2026-08-08 | Client coverage full suite | 통과 | 625 tests가 종료했고 statements 90.00%, functions 81.41%, branches 80.19%, lines 92.03%로 모두 80% gate를 넘겼다. optional payload·remote device·block decoder·SSE/route resume tests로 실제 contract 경로를 보강했다. |
| 2026-08-08 | Extension quality gate | 통과 | 37 files/368 tests passed, statements 89.38%, functions 86.07%, branches 80.18%, exit 0. |

## 11. 문서 완료 checklist

- [ ] README: 새 primary navigation과 workbench-first journey가 실제 route와 일치한다.
- [ ] Getting Started: PC write-only runtime save → explicit restart → paired tablet restriction을 설명한다.
- [x] Local operations: automatic migration, export/reset·backup 수동 복구 범위, fixture rollback, hang protocol과 앱 소유 media root를 설명한다.
- [ ] API contract: runtime/data/staging response와 errors가 OpenAPI·Pydantic·client parser에 일치한다.
- [ ] 이 문서: 모든 ID에 완료/미완료와 실행한 검증의 최종 결과가 기록되어 있다.
- [ ] PR 1/PR 2: 각각 포함/제외 파일, acceptance evidence, known limitation, review command를 한국어로 설명한다.
