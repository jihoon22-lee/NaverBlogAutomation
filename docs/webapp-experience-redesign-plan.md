# 웹앱 UX 전면 개편 — 실행·검증 기준서

> 상태: **구현 완료 / local·mock 검증 완료 / 최신 PR CI 재실행 중 / 외부 live smoke 대기** · 기준일: 2026-08-08 · 적용 범위:
> desktop web app, paired tablet web app, local API, browser automation adapter
>
> 이 문서는 이번 UX 전면 개편의 단일 실행 기준이다. 현재 구현은 두 개의 기능 단위 커밋 묶음으로
> 정리되어 있으며, 아래 검증 기록은 실제 명령의 최종 output과 exit code를 기준으로 작성했다.
> 실제 Naver 계정이 필요한 live smoke만 외부 prerequisite로 남아 있고, 그 밖의 local/mock/DOM/API
> 수용 기준은 완료로 판정한다.
>
> 초기 웹앱 제공을 위한 과거 계획은
> [`archive/webapp-first-delivery-plan.md`](archive/webapp-first-delivery-plan.md)에 **역사 자료**로
> 보존한다. 해당 문서는 이번 UX 개편의 계획도, 완료 근거도 아니다. archive 이동은 구현 완료를
> 뜻하지 않는다.

### 현재 상태 한눈에 보기

| 구분 | 상태 | 근거 | 남은 일 |
| --- | --- | --- | --- |
| 사용자 기능 구현 | 완료 | 홈·작업함·댓글·batch·block studio·설정 센터·data management가 코드와 계약에 반영됨 | 없음 |
| 로컬 자동 검증 | 완료 | Python `1462 passed`, client `628 passed`, extension `368 passed`, E2E `5 passed` | 없음 |
| 보안/호환성 검증 | 완료 | runtime redaction/권한/symlink/pair 제한, OpenAPI parser parity, legacy route/endpoint 회귀 검증 | 실제 배포 환경의 운영자 확인만 남음 |
| 실제 Naver editor 확인 | 외부 opt-in 대기 | 지원 block별 trusted input smoke harness와 fail-closed 경로 준비 | 전용 로그인 profile에서 `RUN_LIVE_NAVER=1` 실행 |
| PR 전달 | review-ready | [PR 1 #90](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/90)과 [PR 2 #91](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/91)이 review-ready이며 PR 1은 최신 CI green, PR 2는 보안 보강 커밋 후 CI 재실행 중 | CI 완료 확인 후 merge/review |

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
| DONE-01 | ✅ 완료 — 네 개 primary navigation과 legacy route 호환이 desktop/tablet에서 동작한다. | DOM/route test, 3 viewport E2E의 nav/legacy `#today` assertion |
| DONE-02 | ✅ 완료 — 작업함의 queue·댓글·보류 복구·일괄 승인 전 확인이 source/state 조합에서 동작한다. | queue API integration, comment/workbench DOM, skipped restore, batch preflight/session handoff test |
| DONE-03 | ✅ 완료 — canonical block/working copy/충돌 처리가 기존 초안을 훼손하지 않는다. | `0020 → 0021 → 0020 → 0021` migration fixture, API 409 conflict, editor autosave DOM |
| DONE-04 | 🟡 외부 opt-in 대기 — 지원 block을 요청 순서대로 trusted input으로 넣고 결과 구조를 읽는 adapter contract와 fail-closed 경로는 완료했다. | mock/local sequence·negative matrix 통과; 실제 로그인된 Naver editor smoke만 계정 prerequisite로 남음 |
| DONE-05 | ✅ 완료 — runtime secret의 영속 저장은 write-only private env로 제한되고 restart guard가 적용을 제어한다. 프로세스 실행 중 환경 변수 사용은 API/DB/브라우저 저장과 구분한다. | redaction/permission/parent-mode/symlink/duplicate/pair/restart/data export test 및 생성 artifact audit |
| DONE-06 | ✅ 완료 — client·extension·Python 품질 게이트와 secret/viewport 검증이 최종 종료 상태까지 통과했다. | Python 90.06%, client 80% 이상, extension 80% 이상, E2E 5 passed, 최종 exit 0 |
| DONE-07 | ✅ 완료 — 두 review-ready 변경 단위의 커밋 경계와 설명을 이 문서에 기록했다. | [PR 1 #90](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/90), [PR 2 #91](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/91), 각 PR의 검증/제한/커밋 경계 |

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

상태 표시는 2026-08-08 worktree와 최종 gate output을 직접 읽어 기록했다. `외부 대기`는
local/mock 검증은 완료했지만 실제 Naver 계정 또는 운영 launcher가 필요한 항목을 뜻한다.

| 요구 영역 | 현재 증거 | 상태 | 남은 결정적 작업 |
| --- | --- | --- | --- |
| 네 개 navigation·legacy hash redirect | `navigation.ts`, `main.ts`, `main.test.ts`, `navigation.test.ts`, 3 viewport E2E | 완료 | `#today`가 home을 소유하고 네 항목만 렌더되는 route/DOM assertion 통과 |
| home/workbench 분리·cursor queue·보류 복구 | app queue route, `TodayController`, `test_local_api.py`, `today-view.test.ts`, E2E | 완료 | neighbor/search/skipped, cursor/count, back, restore, batch preflight까지 최종 suite 통과 |
| `Recommendation.version` 제거 | OpenAPI/client parser/fixture 수정과 unknown-key contract test | 완료 | `version` extra 응답을 명시적으로 거부하고 실제 schema 필드를 파싱; targeted 83 tests 통과 |
| activity card·PWA shell | `activity.ts`, manifest, `service-worker.js`, SPA mount test, E2E | 완료 | static shell만 cache하고 `/api/`는 cache하지 않는 browser assertion 및 3 viewport 통과 |
| canonical block·working copy·migration `0021` | domain/draft API/repository/migration/conflict test, writing DOM/E2E | 완료 | `0020 → 0021 → 0020 → 0021` fixture, autosave/version conflict, resume/preview 통과 |
| structured staging | unique capability probe, fail-closed `StagePost`, semantic prefix evidence, opt-in harness | 외부 대기 | mock/local trusted input과 negative matrix 통과; 실제 Naver signature smoke는 계정 필요 |
| runtime protected configuration·supervisor | runtime service/router/settings UI/unit+integration tests, desktop data API/UI, supervisor | 완료 | write-only/atomic/private file·0700 parent/symlink/owner/pair/restart/export/reset 검증 및 settings/data E2E 통과; parent 경로 보강은 `2a8db50` |
| schedule/budget advanced settings | settings controller/view and app setting routes | 완료 | advanced disclosure, persistence/validation, paired restriction 테스트 통과 |
| quality gates | targeted suites, full Python/client/extension, viewport E2E, artifact checks | 완료 | Python 1462/8 skip, client 628, extension 368, E2E 5, all required exits 0 |

현재 branch의 각 기능 단위는 Conventional Commit으로 분리되어 있다. PR 직전에는 `git diff`
기반으로 각 단위에 속하지 않는 변경이 없는지 다시 확인하고, 이 문서의 quality gate 증거를 PR
설명에 복사한다. 이 계획 문서 자체의 최종 상태는 PR 2에 포함한다.

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
| A1-01 | primary navigation을 네 항목으로 고정하고 legacy hash를 새 route로 redirect한다. | 완료 | `navigation.test.ts`/`main.test.ts` 및 desktop·768·1024 E2E에서 네 label과 `#today → home` 확인 |
| A1-02 | 홈은 readiness/오늘 요약/quick start만 보이며 긴 queue는 작업함으로 보낸다. | 완료 | home DOM test와 E2E의 queue 화면 분리 assertion |
| A1-03 | 더보기는 activity, 작업 기본값, 탐색·자동화, 연결·앱의 entry만 제공한다. | 완료 | more IA/route test와 settings/data E2E |
| A1-04 | pairing/runtime card는 loopback desktop에서만 보인다. | 완료 | local/paired DOM 및 API 403 테스트, E2E password field redaction |

### A2. cursor queue, detail, comment context

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| A2-01 | `/api/v1/app/discovery/queue`에 source/state/query/cursor/limit과 items/counts/next_cursor를 유지한다. | 완료 | `test_local_api.py` cursor/query/count/legacy regression과 client parser test |
| A2-02 | skipped search post는 saved search 삭제 후에도 SPA queue에서 조회·복구된다. | 완료 | orphaned skipped API test와 E2E `보류됨 → 다시 대기` journey |
| A2-03 | segment/filter/sort/search/cursor/badge와 list+detail/sheet를 구현한다. | 완료 | Today state/controller/view test와 세 viewport overflow/grid assertion |
| A2-04 | comment panel은 workbench state를 보존하고 live character/limit/executable state를 보여 준다. | 완료 | comment DOM journey, close/back state, live count/limit test |
| A2-05 | `Recommendation.version`을 API response parser/fixture/request에서 제거한다. | 완료 | OpenAPI parity parser가 `version` extra를 거부하고 personalization/timestamp fields를 검증 |

### A3. batch preflight와 session handoff

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| A3-01 | `TodayState`에 읽기 전용 safety snapshot과 preflight load phase를 추가한다. | 완료 | safety load/no-safety/error state와 preflight controller/view tests |
| A3-02 | workbench 선택 card에 선택 순서·정확한 대상·단계별 cap used/remaining·예상 action count·최소 시간을 표시한다. | 완료 | 1/N selection, cap exhausted, allowed-hours/min-interval unit/API tests와 batch E2E |
| A3-03 | `일괄 처리 계속`은 선택 ID/order를 SessionController에 전달하고, session은 start 직전에 safety를 재조회한다. | 완료 | controller handoff/order, latest safety recheck, preflight approval payload tests |
| A3-04 | session view는 workbench 하위 작업으로 back action을 제공하며 queue context를 보존한다. | 완료 | explicit back control, session handoff, E2E back-to-workbench assertion |

예상 최소 시간은 `max(post_count - 1, 0) * min_interval_seconds`만을 **최소치**로 표기한다.
네트워크·AI·사용자 확인 시간은 포함하지 않으며, 이를 UI에도 명시한다.

### A4. activity, responsive PWA, 접근성

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| A4-01 | comment/batch/draft activity를 filter 가능한 summary card로 제공한다. | 완료 | controller/view tests for all filters, empty/error state, activity E2E |
| A4-02 | static shell service worker/manifest를 설치하고 `/api/` response를 cache하지 않는다. | 완료 | service worker source test와 browser cache assertion |
| A4-03 | desktop/768/1024 navigation, queue detail, comment resume, keyboard focus를 확인한다. | 완료 | Playwright Chromium E2E 3 viewport의 nav/detail/back/focus/overflow metrics; secret screenshot artifact 없음 |

### A 검증 완료 조건

`A1-01`~`A4-03`는 완료했다. Python queue API + client workbench/comment/activity targeted tests,
client coverage, desktop/768/1024 E2E가 모두 final summary와 exit 0으로 종료했으며, 기능 경계별
commit을 PR 1에 그대로 보존한다.

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
| B1-01 | BodyBlock discriminator와 legacy body parsing을 domain/API/OpenAPI/client parser에 일치시킨다. | 완료 | schema parse matrix, OpenAPI parity, legacy `heading/paragraph/quote/image` read test |
| B1-02 | canvas의 insert/delete/duplicate/reorder/image position/outline/preview/shortcut을 제공한다. | 완료 | block DOM tests와 writing E2E가 canonical 배열, outline/preview, image position을 확인 |
| B1-03 | debounce working copy는 revision을 만들지 않고 title/blocks/summary/version을 저장한다. | 완료 | fake-timer autosave burst/in-flight queue, draft API/revision count, writing E2E |
| B1-04 | stale version은 409 latest copy를 반환하고 client는 overwrite 없이 재로드 안내한다. | 완료 | API stale-device 409와 client latest copy reload/queued autosave 폐기 test |
| B1-05 | migration `0021` backfill과 downgrade/restore 절차를 fixture DB에서 검증하고 문서화한다. | 완료 | `0020 → 0021 → 0020 → 0021` fixture와 full Python suite, Local Operations rollback/backup 절차 |

### B2. structured Naver staging capability contract

이 항목은 단순 `readEditorBlocks()` snapshot이 존재한다고 완료가 아니다. 다음 capability contract를
모두 구현·검증해야 한다.

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| B2-01 | page probe가 editor root, title, save, image input과 block action capability를 각각 단 하나로 식별한다. 제목·저장·toolbar는 visible/enabled여야 하고, native image input은 브라우저 관례상 숨겨져도 되지만 중복이면 거부한다. | 완료 | synthetic DOM ready/ambiguous/missing matrix, duplicated toolbar/file input 거부 test; unsupported는 preflight에서 중단 |
| B2-02 | browser port가 clear-and-type와 append/Enter/key action을 구분해 trusted input으로 제공한다. | 완료 | Playwright adapter unit과 local trusted-input integration test |
| B2-03 | paragraph/heading/quote/ordered list/unordered list/divider를 빈 editor에서 한 block씩 입력하고 매 block 뒤 semantic snapshot prefix를 검증한다. | 완료 | 여섯 kind action 순서와 prefix snapshot mock/adapter tests |
| B2-04 | image는 request의 image block 위치에서 단일 attachment를 수행하고 caption/position snapshot을 검증한다. | 완료 | image 앞/중간/뒤 action 순서, caption 부재 fail-closed, prefix snapshot tests |
| B2-05 | unsupported block control, ambiguous selector, unexpected editor mutation, missing image/caption verification은 save 전에 stable result code로 중단한다. | 완료 | negative matrix에서 save click이 발생하지 않고 stable result code를 반환 |
| B2-06 | SSE는 body `step_completed`에 requested index/range와 observed prefix를, client는 네이버 직접 확인 checklist를 노출한다. | 완료 | API SSE detail, controller live update, checklist DOM test |
| B2-07 | documented supported Naver DOM signature에서 opt-in smoke를 실행한다. signature가 바뀌면 support flag를 false로 바꾼다. | 외부 opt-in 대기 | `tests/live/test_naver_staging_smoke.py` harness는 추가했고 기본 실행은 1 skipped; 전용 로그인 profile에서만 실행 |

새 adapter가 하나의 block kind를 지원하지 못하면 그 kind는 staging preflight에서 unsupported로 반환한다.
평문 변환, 전체 body 한 번 입력 후 '우연히 snapshot이 맞음'을 성공으로 처리하는 방식은 금지한다.

### B3. settings IA, protected runtime configuration, data management

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| B3-01 | settings를 작업 기본값 / 탐색·자동화 / 연결·앱 card/side navigation으로 제공한다. | 완료 | section navigation, save/reload, password write-only DOM E2E |
| B3-02 | schedule policy와 LLM budget advanced disclosure를 real GET/PATCH에 연결한다. | 완료 | persistence, validation, advanced disclosure client/API tests |
| B3-03 | stale SQLite `browser_profile`/`llm_providers`를 migration으로 제거하고 runtime env를 source of truth로 만든다. | 완료 | `0022` upgrade/downgrade fixture와 no-dead-setting tests |
| B3-04 | runtime GET/PATCH/restart와 write-only secret replace/clear를 desktop loopback으로 제한한다. | 완료 | local/paired 403, no-echo, atomic write, restart guard tests |
| B3-05 | private env owner/0600/symlink/duplicate/unknown-comment/atomic fsync-replace를 검증한다. | 완료 | RuntimeConfiguration unit matrix와 full Python coverage |
| B3-06 | supervisor restart는 active browser/session/staging을 guard하고 readiness poll 뒤 SPA reload한다. | 완료 | supervisor/router/client success/unavailable/busy tests; E2E readiness shell path |
| B3-07 | app-owned data metadata(location, export/reset availability)를 desktop-only API로 제공한다. | 완료 | local metadata/paired 403, app-owned media derivation, desktop data panel E2E |
| B3-08 | export는 active work가 없을 때 browser download로 redacted archive를 만든다. | 완료 | idle guard, database/media-only archive, private env/browser profile 제외, symlink 거부, download E2E |
| B3-09 | reset은 DB/WAL/SHM·미디어별 count를 먼저 표시하고 explicit typed confirmation + idle guard 후 recoverable backup을 수행한다. | 완료 | count breakdown, typed confirmation, busy 409, backup move, symlink tests와 reset UI E2E |
| B3-10 | data management UI는 PC에만 위치·export·safe reset을 보여 주며 low-level path form은 없다. | 완료 | desktop/paired DOM, response parser, viewport E2E; paired에는 card/input 미렌더 |

`B3-08`과 `B3-09`는 destructive operation이다. 구현 전에는 export 대상, backup 보존 기간,
reset 대상(DB/WAL/SHM/media 중 무엇인지)을 API contract에 명시하고, 실제 대상이 확정된 뒤에만
사용자에게 confirmation UI를 노출한다. 이 결정이 없으면 reset control을 만들지 않는다.

### B4. 문서와 운영 handoff

| ID | 작업 | 상태 | 완료 증거 |
| --- | --- | --- | --- |
| B4-01 | README/Getting Started가 네 화면, desktop runtime 저장/재시작, tablet restriction을 정확히 설명한다. | 완료 | README/docs review와 구현 route/settings capability 대조 |
| B4-02 | block support/staging failure/user Naver confirmation을 실제 adapter capability만큼 설명한다. | 완료 | supported matrix/fail-closed/no unsupported-success 문구 audit; live smoke는 opt-in으로 명시 |
| B4-03 | migration upgrade/downgrade, data export/reset, test hang protocol을 운영 문서에 기록한다. | 완료 | `local-operations.md`의 migration, backup/manual recovery, timeout/60초 무출력 규칙과 live smoke 절차 |

### B 검증 완료 조건

`B1-01`~`B4-03` 중 local/mock 기준은 완료했다. migration/runtime/staging/data targeted Python tests,
client writing/settings DOM tests, structured staging smoke policy, desktop/768/1024 writing/settings E2E,
secret artifact audit이 final summary와 exit 0으로 종료했다. B2-07의 실제 계정 smoke만 외부 opt-in으로
남기고, PR 2에는 이 제한과 정확한 실행 명령을 명시한다.

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

제외: writing schema/migration/staging/runtime/data-management 변경. `feature/workbench`에는 A의
기능별 Conventional Commit을 유지하고, PR 1은 이 branch를 `main`에 비교해 review-ready로 연다.
현재 최종 webapp E2E 파일은 B의 draft/settings API도 함께 검증하므로 PR 2의 stacked 검증에 두고,
PR 1 자체는 queue/session 기존 packaged journey와 A targeted tests를 독립적으로 통과시킨다.

### Phase 2 — PR 2: `feat(studio): 블록 글쓰기와 웹 설정 센터`

순서: B1 → B2 capability contract → B3 runtime/data → B4 → B 검증. 포함 후보는 다음으로 제한한다.

- BodyBlock/working copy/migration/draft API/OpenAPI
- page editor probe, browser port/adapter, staging service/SSE and tests
- settings IA/runtime configuration/supervisor/data-management and tests
- writing/settings docs and secret audit

PR 2는 `feature/webapp-experience-redesign`에서 PR 1을 base로 삼는 stacked PR이다. 다음 커밋
경계를 그대로 보존한다.

| PR | branch | 포함 범위 | 제외/제한 | 핵심 검증 |
| --- | --- | --- | --- | --- |
| PR 1 | `feature/webapp-workbench` · [#90](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/90) · head `5f3a2b1` | `8fc7377` 이후 A0~A4의 queue/navigation/activity/PWA/UI 및 A 테스트, `173c03d` 태블릿 overflow, `cdb4a60` recommendation contract, `5f3a2b1` legacy hash 별칭 | writing/migration/staging/runtime/data 설정 | client targeted/coverage, Python queue/API, Chromium workbench + 기존 workflow E2E |
| PR 2 | `feature/webapp-experience-redesign` · [#91](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/91) · base `5f3a2b1`, latest head `2a8db50` | PR 1 위에 B1~B4의 working copy/block canvas/staging/runtime/settings/data/docs, full 3 viewport E2E, opt-in live harness, `2a8db50` 보호 경로 보강 | 실제 Naver 계정 호출은 기본 skip | Python full, client/extension check, E2E 5 passed, live smoke 1 skipped; 최신 CI는 재실행 중 |

PR 1과 PR 2 모두 review-ready 상태로 생성한다. PR 설명에는 이 표와 commit 목록, 실제 실행한
명령의 최종 summary, 외부 opt-in 제한을 그대로 복사한다. Plan 문서는 PR 2에서 최종 실행 기록과
PR URL을 갱신한다.

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
| V-08 | SPA/PWA E2E | `npm --prefix extension run test:e2e` (Chromium, desktop/768 portrait/1024 landscape) | nav/detail/back, block autosave/preview, settings/data, static-cache and no-horizontal-overflow assertions; DOM/metrics만 사용하며 screenshot artifact는 저장하지 않음 |
| V-09 | Security audit | diff, DB/export, API body, DOM, logs, screenshots search | no plaintext secret, no secret-derived error |
| V-10 | Live smoke policy | `RUN_LIVE_NAVER=1` + dedicated logged-in profile only | capability signature와 user verification record; no publish; 기본 suite에서는 skip |

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
| 2026-08-08 | Client targeted | 통과 | `main.test.ts` 26 (legacy hash 별칭 포함), `activity.test.ts` 4, `settings.test.ts` 37, `today-view.test.ts` 22; 해당 파일 범위만이다. |
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
| 2026-08-08 | Client coverage full suite (PR 1 merge 전) | 통과 | 625 tests가 종료했고 statements 90.00%, functions 81.41%, branches 80.19%, lines 92.03%로 모두 80% gate를 넘겼다. optional payload·remote device·block decoder·SSE/route resume tests로 실제 contract 경로를 보강했다. |
| 2026-08-08 | Extension quality gate | 통과 | 37 files/368 tests passed; interim check output recorded statements 86.07%, branches 80.18%, functions 93.18%, lines 89.38%, exit 0. |
| 2026-08-08 | Client final quality gate (PR 1 merge 후) | 통과 | `npm --prefix client run check`: 628 tests, statements 90.57%, branches 80.69%, functions 81.50%, lines 92.67%; build 포함, exit 0. Biome의 기존 `document.cookie` 2 warning만 남음. |
| 2026-08-08 | Extension final quality gate | 통과 | `npm --prefix extension run check`: 37 files/368 tests, statements 86.07%, branches 80.18%, functions 93.18%, lines 89.38%; build 포함, exit 0. |
| 2026-08-08 | Python static final gate | 통과 | `uv run ruff format --check .`, `uv run ruff check .`, `uv run ty check` 각 exit 0; 235 files checked. |
| 2026-08-08 | Python full final gate | 통과 | `timeout 1200 uv run pytest -vv`: `1462 passed, 8 skipped, 8 warnings in 420.56s`; total coverage 90.06% (branch requirement 85%). skips는 Playwright binary 4, Naver live 1, OpenAI live 3. |
| 2026-08-08 | Recommendation contract parity | 통과 | client comment API/run/state/view targeted 83 tests; OpenAPI에 없는 `version` field를 fixture가 보내면 parser가 안정적으로 거부. |
| 2026-08-08 | Naver staging smoke harness | 기본 skip | `uv run pytest --no-cov -q tests/live/test_naver_staging_smoke.py`: 1 skipped. 실제 계정/profile 없이는 실행하지 않으며, 실행 명령과 no-publish 정책을 local operations에 기록. |
| 2026-08-08 | Web app journey E2E | 통과 | `npm --prefix extension run test:e2e`: 5 passed (desktop 1440, tablet portrait 768, landscape 1024 각각 Chromium + legacy workflow); writing autosave/preview, skipped restore, settings redaction, export/reset, PWA no-API-cache assertion 포함. |
| 2026-08-08 | Secret/artifact audit | 통과 | runtime API/DOM/log/export tests가 plaintext secret을 거부하고, E2E는 synthetic credentials만 사용하며 screenshot artifact를 생성하지 않는다. generated `client/dist`/`extension/dist`와 Playwright temp output에 secret pattern 없음. |
| 2026-08-08 | Runtime path hardening | 통과 | `test_runtime_configuration.py` + `test_runtime_data.py`: 15 passed. private env parent `0700`, owner check, database/media symlink parent rejection을 추가한 `2a8db50`을 검증했다. |

## 11. 문서 완료 checklist

- [x] README: 새 primary navigation과 workbench-first journey가 실제 route와 일치한다.
- [x] Getting Started: PC write-only runtime save → explicit restart → paired tablet restriction을 설명한다.
- [x] Local operations: automatic migration, export/reset·backup 수동 복구 범위, fixture rollback, hang protocol과 앱 소유 media root를 설명한다.
- [x] API contract: runtime/data/staging response와 errors가 OpenAPI·Pydantic·client parser에 일치한다.
- [x] 이 문서: 모든 ID에 완료/외부 대기와 실행한 검증의 최종 결과가 기록되어 있다.
- [x] PR 1/PR 2: 각각 포함/제외 파일, acceptance evidence, known limitation, review command를 한국어로 설명한다. [PR 1 #90](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/90)과 [PR 2 #91](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/91)이 review-ready 상태다.

## 12. 문서 통제와 현재 상태 snapshot

이 절은 “무엇을 했는가”와 “무엇이 아직 외부 조건인가”를 섞지 않기 위한 운영 기록이다. `완료`는
코드·계약·local/mock test가 끝났다는 뜻이고, `외부 대기`는 구현이 없다는 뜻이 아니라 실제 계정,
운영 launcher 또는 사용자의 최종 확인이 필요한 뜻이다.

| 항목 | 현재 값 | 판정 기준 |
| --- | --- | --- |
| implementation head | `2a8db50` (`fix(runtime): 보호 경로의 부모 권한과 symlink를 검증한다`) | runtime file parent `0700`/owner와 database·media symlink parent 거부까지 포함 |
| PR 1 | [#90](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/90), `feature/webapp-workbench` → `main`, head `5f3a2b1`, review-ready | PR 1 범위의 required checks가 green이면 A 단위 수용 |
| PR 2 | [#91](https://github.com/jihoon22-lee/NaverBlogAutomation/pull/91), `feature/webapp-experience-redesign` → `feature/webapp-workbench`, head `2a8db50`, review-ready | PR 2 head의 CI가 다시 green인지 확인한 뒤 review/merge |
| local Python | `1462 passed, 8 skipped`, coverage 90.06% | skip은 Playwright binary 4, Naver live 1, OpenAI live 3이며 숨겨진 pass로 취급하지 않음 |
| local client/extension | client 628, extension 368 | 각 package의 format/type/lint/build/coverage 명령이 final summary와 exit 0 |
| 외부 live | Naver staging smoke 1 skipped | `RUN_LIVE_NAVER=1`과 dedicated logged-in profile 없이는 실행하지 않음 |
| merge 전 남은 일 | 최신 CI 확인, reviewer 승인, 실제 Naver smoke opt-in | 이 문서의 구현 수용 기준을 뒤집는 미완료 항목은 아님 |

문서 변경 이후의 커밋은 이 표의 implementation head를 갱신해야 한다. CI가 재실행 중일 때는
`완료`로 미리 기록하지 않고 `재실행 중`으로 둔다. `gh pr checks 90`, `gh pr checks 91`의
모든 required job이 `pass`가 된 뒤에만 최종 상태를 `CI green`으로 바꾼다.

## 13. 요구사항-코드-검증 traceability matrix

아래 표는 각 사용자 가치 단위가 어느 파일과 테스트로 닫히는지 보여 준다. 한 행의 production
파일만 바뀌고 transport model, parser, fixture 또는 test가 빠지면 그 행은 완료로 표시할 수 없다.

| 요구 ID | production boundary | 계약·상태 저장 | 직접 검증 | 잔여 조건 |
| --- | --- | --- | --- | --- |
| A1 navigation/home/more | `client/src/app/main.ts`, `navigation.ts`, `views/today.ts`, `views/settings.ts` | `routeFromHash`, `NavSection`, `AppReadiness` | `client/tests/app/main.test.ts`, `navigation.test.ts`, `extension/tests/e2e/webapp.e2e.ts` | legacy route의 실제 외부 bookmark 확인은 운영 smoke |
| A2 queue/detail/comment | `api/factory.py` queue routes, `discovery_repository.py`, `controllers/today.ts`, `state/today.ts`, `views/today.ts` | `WebAppDiscoveryQueueResponse`, `DiscoveryState`, `source_label` | `tests/integration/api/test_local_api.py`, `client/tests/app/api-client.test.ts`, `today-state.test.ts`, `today-view.test.ts` | queue item body는 API에 포함하지 않음 |
| A2-05 recommendation contract | `api/models.py`, `client/src/app/api/client.ts` `readRecommendation` | OpenAPI `RecommendationResponse`의 `additionalProperties: false` | `client/tests/app/comment-api.test.ts` version-extra rejection, comment/run/state/view 83 targeted tests | server가 `version`을 추가하지 않는지 release diff에서 재확인 |
| A3 batch preflight | `controllers/today.ts`, `state/today.ts`, `controllers/session.ts`, `views/session.ts` | `SafetyStatus`, `AutomationSession`, ordered `postIds` | `today-state.test.ts`, `today-view.test.ts`, `session.test.ts`, session API integration, E2E batch journey | 실제 실행은 명시적 승인 없이는 시작하지 않음 |
| A4 activity/PWA/responsive | `controllers/activity.ts`, `views/activity.ts`, `service-worker.js`, `app.css`, `main.ts` | activity filter state, shell-only cache list | activity tests, `test_spa_mount.py`, 3 viewport E2E/cache assertion | offline mutation은 지원하지 않음 |
| B1 working copy | `domain/writing.py`, `api/draft_models.py`, `routers/drafts.py`, `post_draft_repository.py` | `BodyBlock[]`, `DraftWorkingCopy`, `base_content_version`, migration `0021` | `test_writing.py`, `test_post_draft_repository.py`, `test_draft_revisions_api.py`, writing state/API tests | 기존 legacy JSON은 read-only 호환 입력으로만 허용 |
| B2 structured staging | `application/automation/stage_post.py`, `client/src/page/editor.ts`, page bundle, browser port | probe capability, `PublishStep`, SSE `detail` prefix evidence | `test_stage_post.py`, `test_staging_api.py`, editor tests, staging client tests, live harness | 실제 Naver DOM signature만 외부 대기 |
| B3 runtime connection | `application/runtime_configuration.py`, `api/routers/runtime_configuration.py`, `client/views/settings.ts`, `scripts/start_webapp.py` | private dotenv known-key merge, replace/clear intent, restart marker | runtime unit/API tests, settings tests, supervisor tests, settings E2E | launcher 없는 수동 API는 409 안내 |
| B3 data management | `application/runtime_data.py`, `api/routers/runtime_data.py`, settings UI | derived SQLite/WAL/SHM + media only, backup move | runtime data tests/API, export/reset E2E | backup 보존/삭제는 별도 운영 정책이며 자동 삭제하지 않음 |
| B4 documentation | `README.md`, `docs/getting-started.md`, `docs/local-operations.md`, `docs/api-contract.md`, this file | route/settings/operation text must match source | documentation review + release diff audit | Naver live 결과가 생기면 supported signature 기록 갱신 |

### 13.1 변경 시 함께 갱신해야 하는 파일

1. Python response model을 바꾸면 `docs/api/openapi.yaml`과 `client/src/app/api/types.ts`를 먼저
   같이 바꾼다.
2. parser가 읽는 필드를 바꾸면 `client/tests/app/api-client.test.ts` 또는 해당 domain fixture에서
   정상·누락·extra·enum 경계를 모두 만든다.
3. DB 필드를 바꾸면 migration upgrade/downgrade fixture와 repository/API test를 같은 커밋 단위에
   둔다. migration head만 바꾸고 fixture를 남겨두지 않는다.
4. 화면 route를 바꾸면 `main.test.ts`, direct hash route, legacy alias, 768/1024 E2E를 함께 확인한다.
5. secret 또는 filesystem 경계를 바꾸면 response body·DOM·log·archive·symlink·permission test를
   동시에 실행한다.

## 14. API와 상태 전이의 실행 계약

### 14.1 SPA discovery queue

`/api/v1/discovery/queue`는 extension이 이미 사용하는 legacy contract라서 `source` required와
기존 item shape를 보존한다. 웹앱은 `/api/v1/app/discovery/queue`만 사용한다.

| 입력 | 허용값 | 의미 | 화면 동작 |
| --- | --- | --- | --- |
| `source` | 생략/`neighbor`/`search` | 생략이면 두 출처를 합산 | segment 또는 source filter |
| `state` | 생략/`queued`/`opened`/`skipped`/공통 state enum | 생략이면 작업 가능한 pending과 hold를 조회 | status filter |
| `query` | trim 후 최대 120자 | title, publisher, publisher blog id, source label을 case-fold 검색 | 검색 input |
| `cursor` | URL-safe opaque offset | 현재 정렬 snapshot의 다음 page 시작 위치 | “더 불러오기” |
| `limit` | 1–100, 기본 30 | 한 요청의 item 상한 | page append |

응답 `counts`는 현재 작업함에서 사용하는 `neighbor`, `search`, `skipped`, `total` 수이며 현재
filter로 줄어든 page의 count가 아니다. `source_label`은 neighbor 이름 또는 saved-search query다.
삭제된 saved search의 candidate는 `skipped`일 때만 보류 화면에 남긴다. 저장 검색어를 지웠다고
기존 보류 후보가 조용히 사라지지 않는다.

상태 action은 다음과 같이 제한한다.

| 현재 상태 | 작업함 action | 결과 |
| --- | --- | --- |
| `queued`/`opened` | 이 글 건너뛰기 | `skipped`, 보류 segment와 count에 반영 |
| `skipped` | 다시 대기 | `queued`, neighbor/search segment와 count에 반영 |
| 어떤 item | 처리하기 | 기존 선택 row/filter/query/cursor를 유지한 comment context로 이동 |
| item 없음/삭제 | 처리하기 | API 404 또는 extraction 오류를 inline status로 표시, 재시도 loop 없음 |

`cursor`는 DB id를 노출하지 않기 위한 base64 offset이며, 새 sync가 page 사이에 삽입되면 다음
요청 전에 refresh하여 snapshot을 다시 읽는다. 따라서 cursor는 장기 bookmark가 아니며, 서버는
오래된 cursor를 성공으로 가장하지 않고 malformed cursor에 `422 invalid_cursor`를 반환한다.

### 14.2 Block working copy

| discriminator | 필수 필드 | 제한 | staging action |
| --- | --- | --- | --- |
| `paragraph`/`heading`/`quote` | `text` | 1–4,000자 | editor clear/type 또는 block-specific toolbar |
| `ordered_list`/`unordered_list` | `items` | 1–100개, item 1–4,000자 | list toolbar + line-by-line Enter |
| `divider` | 없음 | content field 금지 | divider capability |
| `image` | UUID `image_id` | media에 실제 존재, caption 최대 4,000자, 동일 image UUID 중복 금지 | exact position attachment + caption verification |

전체 `BodyBlock[]`는 1–200개다. 서버는 unknown field, 잘못된 discriminator, 빈 block, 존재하지
않는 image UUID, 중복 image reference를 저장·staging 전에 거부한다. client parser는 canonical
배열을 그대로 보존하고 화면에서만 `bodyText` 요약을 계산한다. `blocksFromText`는 구버전 호출자를
위한 deprecated shim이며 block canvas나 autosave의 production 경로에서는 호출하지 않는다.

working copy 저장은 다음 순서를 따른다.

1. client debounce가 마지막 title/blocks/summary를 하나로 모은다.
2. 요청은 `base_content_version`을 포함한다. 서버 version과 다르면 `409 draft_content_conflict`
   와 최신 working copy를 반환한다.
3. client는 in-flight 뒤의 queued edit를 자동 재생하지 않고 최신 copy를 보여 준다. 사용자가
   다시 편집한 뒤에만 새 base version으로 저장한다.
4. “revision으로 남기기” 같은 명시적 checkpoint만 immutable revision을 생성한다.

### 14.3 Runtime secret lifecycle

| 단계 | 허용 데이터 | 금지 데이터 | 검증 |
| --- | --- | --- | --- |
| PATCH request | 알려진 key의 replace/clear intent | raw secret을 query/path에 넣기, unknown key | Pydantic strict model, single-line/length |
| process memory | child가 provider 호출에 필요한 env | SQLite/localStorage에 복사 | factory/provider registry audit |
| private file | known key, 기존 주석/unknown key 보존 | duplicate known key, symlink path, group/world readable | owner, file `0600`, parent `0700`, atomic fsync/replace |
| GET response | configured boolean, model, SMTP address/host/port, browser non-secret | key/password/credential value | response model + client parser redaction test |
| UI state | 빈 write-only input과 clear checkbox | saved secret repopulation, URL/history/DOM text | paired/local settings DOM test |
| log/archive/screenshot | result code와 redacted metadata | secret-derived error/body, env file, browser profile | artifact audit와 export archive test |

`clear`는 의도적으로 해당 known key line을 제거한다. 빈 replace는 허용하지 않으며, active
provider를 바꿀 때 선택된 provider가 구성되지 않았으면 저장 자체를 거부한다. 이 guard는 사용자가
기존 credential을 지우는 보안 작업까지 막지는 않는다.

### 14.4 Restart supervisor sequence

```text
PATCH runtime config
  └─ private env atomic write + restart_required=true
POST runtime/restart (desktop loopback only)
  ├─ launcher unavailable → 409 launcher_restart_unavailable
  ├─ no pending config → 409 restart_not_required
  ├─ browser/session/staging active → 409 restart_busy
  └─ marker write + restart_required=false → 200
supervisor sees marker
  ├─ child SIGINT → bounded terminate fallback
  ├─ same private env file로 child 재실행
  └─ /health 200까지 최대 60초 polling
SPA
  └─ 짧은 지연 후 status polling, 준비되면 reload; timeout이면 수동 새로고침 안내
```

수동 `uv run ... naver-blog-api` 실행은 marker를 전달하지 않으므로 설정 저장은 가능하지만
restart는 `launcher_restart_unavailable`로 명시적으로 중단한다. reset/export도 브라우저가
stopped이고 session/publish/staging이 idle인 경우에만 수행한다.

## 15. Block staging의 capability와 fail-closed 규칙

### 15.1 Probe 결과

page probe는 editor root, title control, save control, image input, 각 block action을 식별한다.
visible/enabled control이 0개이거나 2개 이상이면 `capability_missing` 또는 `capability_ambiguous`
결과로 중단한다. native file input만 hidden인 것은 허용하지만 중복 input은 허용하지 않는다.

| 단계 | 요청 | 관찰 증거 | 실패 code 예 |
| --- | --- | --- | --- |
| title | draft title | title value/semantic snapshot | `title_control_missing`, `title_not_observed` |
| body | block index와 kind 하나 | 요청 prefix가 관찰 snapshot에 포함 | `block_action_missing`, `body_prefix_mismatch` |
| image | image UUID와 block index | attachment count/position/caption | `unknown_image_reference`, `image_position_mismatch`, `caption_unresolved` |
| tags | selected tags | tag chip/text snapshot | `tags_control_missing`, `tags_not_observed` |
| save | 임시저장 click | 네이버 저장 완료/상태 변화 | `save_control_missing`, `save_unconfirmed` |

지원하지 않는 block이 한 개라도 있으면 title/body 입력 전에 preflight에서 중단한다. body 전체를
한 번에 plain text로 넣거나, snapshot이 우연히 같다는 이유로 성공 처리하지 않는다. SSE body
`step_completed.detail`에는 content body 대신 `requested_range_start/end`와
`observed_prefix_count`만 남긴다. 최종 UI는 “네이버에서 제목·block 순서·이미지·태그를 직접 확인”
checklist를 보여 주며 발행 control을 제공하지 않는다.

### 15.2 Live smoke 운영 절차

1. 외부 동의된 test account와 dedicated browser profile을 준비한다. 기존 개인 profile/cookie를
   사용하지 않는다.
2. `RUN_LIVE_NAVER=1`, `NAVER_LIVE_BLOG_ID`, `AUTOMATION_PROFILE_DIR`를 설정하고
   `uv run pytest --no-cov -q tests/live/test_naver_staging_smoke.py`만 실행한다.
3. 지원 signature, 단계별 observed result, user-confirmed draft URL을 기록하되 publish하지 않는다.
4. selector/signature가 바뀌거나 결과 구조가 불명확하면 support flag를 false로 기록하고 adapter를
   수정하기 전까지 기본 suite에 성공을 추가하지 않는다.

## 16. 데이터 관리·PWA·responsive 수용 기준

### 16.1 Data export/reset 대상

| 작업 | 포함 | 제외 | 안전장치 |
| --- | --- | --- | --- |
| metadata | DB, WAL, SHM, media file count/size와 앱 소유 위치 | env, browser profile, arbitrary user path | local desktop only, resolved path, symlink rejection |
| export | `database.sqlite3*`, `media/**` regular files | private env, profile, unrelated files | idle guard, `Cache-Control: no-store`, ZIP name fixed |
| reset | DB/WAL/SHM와 media를 timestamp+UUID backup으로 move | delete, env/profile, unrelated sibling | typed `RESET LOCAL DATA`, idle guard, recoverable backup, restart marker |

reset은 데이터를 영구 삭제하지 않는다. backup retention/삭제는 아직 자동 정책으로 만들지 않았고,
운영자가 backup 위치를 확인한 뒤 별도 절차로 관리한다. DB와 media가 서로 다른 filesystem root에
있거나 root 자체가 symlink이면 reset을 지원하지 않는다.

### 16.2 PWA/cache

`client/public/service-worker.js`는 `./`, HTML/CSS/JS, manifest, icon만 `nba-app-shell-v1`에
cache한다. method가 GET이 아니거나 origin이 다르거나 pathname이 `/api/`이면 fetch handler를
가로채지 않는다. API response와 mutation은 항상 network이며, offline 상태에서는 stale 작업
목록을 성공처럼 보여 주지 않는다.

### 16.3 viewport와 접근성

| viewport | layout | 필수 확인 |
| --- | --- | --- |
| desktop | left navigation + workbench list/detail 2열 + wide writing canvas | keyboard focus, selected row, no secret field leakage |
| 768px portrait | list와 detail/comment가 전환되는 sheet | back/close가 query/filter/scroll context 보존, horizontal overflow 0 |
| 1024px landscape | list/detail 2열 | 44px 이상 touch target, focus ring, detail action 접근 |
| paired tablet | 일반 workbench/comment/writing/activity만 | runtime connection/browser/LAN/device management와 secret input 미렌더 |

## 17. 커밋·PR ledger와 review 순서

커밋은 하나의 거대 변경으로 합치지 않고 사용자 가치와 검증 경계로 나뉜다. 아래 순서는 실제
history의 review 순서이며, 후속 base sync 커밋은 PR 1의 기능 내용을 중복 구현하지 않는다.

### PR 1 — workbench

| 순서 | commit | 단위 |
| --- | --- | --- |
| 1 | `8fc7377` | 이 UX 개편 기준서의 초기 실행 경계 |
| 2 | `d521c45` | discovery cursor queue와 web-only response |
| 3 | `8cdc30f` | version 없는 recommendation response 호환 |
| 4 | `133adc5` | 홈/작업함 navigation과 detail 흐름 |
| 5 | `2fee83e` | activity summary card |
| 6 | `d10daf1` | responsive design token/PWA UI |
| 7 | `173c03d` | tablet overflow regression |
| 8 | `cdb4a60` | OpenAPI/client recommendation contract |
| 9 | `d62bc20` | stream route coverage |
| 10 | `11e946f` | readiness path tests |
| 11 | `41277d1` | workbench batch journey E2E |
| 12 | `f4bf4b3` | E2E formatting gate |
| 13 | `5f3a2b1` | legacy hash aliases (`#queue/#batch/#more/#history/#config/#devices`) |

### PR 2 — studio/settings

| 순서 | commit | 단위 |
| --- | --- | --- |
| 1 | `ef02c94` | working copy/content version |
| 2 | `9810509` | block canvas/autosave |
| 3 | `777d755` | structured staging/fail-closed |
| 4 | `5fe3c11` | protected runtime/data service |
| 5 | `3708b63` | stale SQLite setting cleanup/migration `0022` |
| 6 | `ec25472` | SMTP non-secret addresses |
| 7 | `6918c3c` | settings center/restart UI |
| 8 | `2fd1d1f` | supervisor tests |
| 9 | `0e1d03b` | duplicate image reference validation |
| 10 | `07c9e8a` | client contract tests |
| 11 | `ba2376d` | user-facing docs |
| 12 | `ab3aa80` | 3 viewport webapp E2E |
| 13 | `fc99f20` | opt-in Naver staging harness |
| 14 | `b7bfdb4` | settings/restore E2E |
| 15 | `04092b5` | live smoke platform typing |
| 16 | `2dd4428` | E2E formatting |
| 17 | `2c9bedb` → `1af12bf` | staged plan/verification records |
| 18 | `0445a29` | PR 1 stream fixture merge cleanup |
| 19 | `833b615` | wheel smoke migration head |
| 20 | `5c72b2c` | PR 1 format base sync |
| 21 | `3e18dbc` | PR 1 legacy hash base sync |
| 22 | `2a8db50` | protected parent mode and symlink hardening |

Review는 PR 1에서 A 범위가 독립적으로 이해되는지 먼저 확인하고, PR 2에서 B 범위와 base sync를
확인한다. PR 2의 `3e18dbc`와 같은 base sync는 PR 1이 merge되면 자동으로 사라질 수 있지만,
stacked PR을 review하는 동안에는 PR 1의 최신 contract가 PR 2에 반영됐다는 증거다.

## 18. 완료/잔여 판정 checklist

### 구현 완료로 판정한 것

- [x] 네 개 primary navigation, legacy route alias, home/workbench 분리
- [x] neighbor/search/skipped queue, source label, query/state/sort, cursor append, restore
- [x] comment context 보존, live character/limit/executable state, batch selection/preflight
- [x] activity cards, PWA shell-only cache, desktop/768/1024 layout 및 focus/overflow 검증
- [x] canonical blocks, image position/caption, working copy debounce, checkpoint, 409 conflict
- [x] capability probe, trusted block-by-block staging, image/prefix verification, SSE checklist
- [x] runtime write-only private env, `0600` file/`0700` parent/owner/symlink/duplicate/atomic write
- [x] desktop loopback restriction, paired tablet redaction, restart busy/unavailable guard, supervisor
- [x] app-owned data metadata/export/reset/backup, stale setting migration `0022`
- [x] OpenAPI/Pydantic/client parser/fixture parity, README/Getting Started/Local Operations update

### 아직 완료로 표시하지 않는 것

- [ ] 실제 Naver editor에서 documented signature로 block별 trusted input을 실행한 live smoke
- [ ] reviewer가 PR 1/PR 2를 승인하고 merge한 상태
- [ ] merge 후 main 기준으로 release/launcher 운영자가 private env 위치와 backup 정책을 확인한 상태

위 세 항목은 local 구현을 다시 작성하는 작업이 아니다. 첫 항목은 외부 계정과 사용자의 확인이
필요하고, 뒤의 두 항목은 GitHub review/운영 handoff 상태다. 그 외에 “구현이 덜 됐다”는 이유로
남겨 둔 기능 ID는 없다. 새로운 요구가 생기면 이 문서에 ID와 직접 검증을 먼저 추가한 뒤 별도
커밋/PR 단위로 범위를 확장한다.
