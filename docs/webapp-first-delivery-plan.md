# 웹앱 중심 제품 완성 Delivery Plan

Status: 활성 구현 계획, 2026-08-01 확정

이 문서는 완료된 [`archive/webapp-automation-delivery-plan.md`](archive/webapp-automation-delivery-plan.md)의
후속 Task를 덧붙이는 문서가 아닙니다. 기존 계획은 Task 0~21 완료 상태로 보존하고, 이 문서는
로컬 웹앱을 기본 제품으로 독립 배포하며 실제 사용자 여정을 완성하는 새로운 설계와 작업 범위를
정의합니다.

## 1. 제품 목표

사용자가 한 로컬 웹앱 안에서 다음 세 가지 일을 최소한의 개입으로 안전하게 끝낼 수 있어야 합니다.

1. 짧은 메모·제목·이미지를 입력해 AI로 블로그 본문을 만들고, 반복해서 다듬고, 태그를 고른 뒤
   네이버 에디터에 임시저장합니다.
2. 이웃의 신규 글을 한눈에 분류해 보고, 글을 선택하면 본문 기반 댓글 후보를 자동으로 받아 빠르게
   다듬은 뒤 한 번의 최종 동작으로 공감과 댓글 등록을 실행합니다.
3. 저장한 키워드로 신규 이웃 후보 글을 모아 같은 댓글 흐름으로 검토하고, 한 번의 최종 동작으로
   공감·댓글·서로이웃 신청을 실행합니다.
4. PC에서 local service와 automation browser를 실행한 상태라면 같은 신뢰 Wi-Fi의 Galaxy Tab·iPad
   browser에서도 동일한 작업 공간을 안전하게 사용할 수 있어야 합니다.

여기서 "최소한의 개입"은 외부 동작을 사용자 모르게 수행한다는 뜻이 아닙니다. 사용자는 대상 글과
최종 text를 확인하고, 실제 공감·댓글·서로이웃 신청 직전에 범위가 적힌 버튼을 한 번 누릅니다.
Captcha, 로그인 만료, 불명확한 결과는 자동으로 우회하거나 재시도하지 않습니다.

## 2. 현재 구현 감사 결과

### 이미 갖춘 기반

- FastAPI가 automation browser, SQLite, discovery scheduler, LLM provider, SSE 진행 상태를 소유합니다.
- 글쓰기에는 초안·이미지·revision·태그·본문 생성·다듬기·임시저장 endpoint가 있습니다.
- 이웃·검색 후보 수집, 단건 공감·댓글·서로이웃 실행, 세션 배치, 안전 정책, 무인 스케줄이 구현돼
  있습니다.
- OpenAI·Gemini·Claude provider와 댓글 fan-out endpoint가 존재합니다.
- extension v0.5.6은 동결돼 있고 새 DOM probe와 실행 로직은 `client/`와 Python automation으로
  이식됐습니다.

### 제품 사용을 막는 간극

| 영역 | 현재 상태 | 필요한 변화 |
| --- | --- | --- |
| 독립 실행 | `CHROME_EXTENSION_ORIGIN`과 extension build·ID가 항상 필요 | 웹앱 기본 설치에서는 extension을 완전히 선택 사항으로 전환 |
| 배포 | wheel에 page probe만 포함되고 SPA 전체는 포함되지 않음 | 설치된 wheel 자체가 `/app`을 제공하도록 client asset 포함 |
| 첫 실행 | 필요한 설정과 로그인 상태가 여러 화면·문서에 흩어짐 | redacted readiness와 단계별 onboarding 제공 |
| 오늘의 작업 | 제목 중심 목록이며 출처·시각·키워드 맥락, 정렬·필터가 약함 | source별 요약·필터·선택·상태 변경이 가능한 작업 inbox로 개편 |
| 댓글 | 생성, 후보 선택, 승인, 실행이 분절됨 | 글 선택 후 기본 후보 자동 생성, AI 빠른 다듬기, 한 번의 최종 실행 |
| 여러 글 | source와 최대 수만 승인해 실행 대상이 승인 뒤에도 암묵적 | 승인할 글 목록과 순서를 snapshot으로 고정 |
| 글쓰기 | 기능은 있지만 저장·revision 비교·삭제·재개 흐름이 거침 | AI 완성 단축 동작, 자동 저장, diff, 초안 삭제와 단계 복귀 |
| 설정 | 웹 화면에는 discovery 설정만 있고 여러 `app_settings`는 API에만 존재 | 사용 목적별 설정 화면과 활성화 조건을 제공 |
| 이력·복구 | 추천 이력·개인화 관리 UI가 없고 재시작 시 running session이 남음 | 최근 작업·복사·삭제·개인화 관리, 재시작 fail-closed 복구 |
| 태블릿 | API가 loopback 전용이고 인증·pairing·tablet layout이 없음 | opt-in LAN access, device session, touch·background 복구 UI 추가 |

## 3. 사용자 경험 원칙

1. **명시적 선택 이후 자동 연결.** 사용자가 글 카드를 열면 본문 추출과 기본 provider 댓글 후보
   생성까지 이어집니다. 별도 "추출" 버튼은 두지 않습니다.
2. **최종 외부 동작은 한 번.** 후보를 선택·편집한 뒤 이웃 글은 **공감하고 댓글 등록**, 검색 후보는
   **공감·댓글 등록·서로이웃 신청** 버튼 하나로 승인과 실행을 이어서 수행합니다.
3. **기본값은 저장하고 예외만 고침.** 말투·길이·분위기·provider·서로이웃 메시지·글쓰기 구성은
   설정에서 한 번 저장하고, 개별 작업에서 필요한 값만 바꿉니다.
4. **진행 상태를 잃지 않음.** URL hash route와 서버 저장 record로 새로고침 뒤에도 초안, 추천 댓글,
   진행 중 batch를 다시 엽니다.
5. **비용과 위험은 보이게.** LLM 호출 직전 provider 수를, 외부 동작 직전 수행 단계와 일일 잔여
   상한을 표시합니다.
6. **실패는 다음 행동으로 연결.** 로그인 필요, consent 누락, safety gate, SMTP·provider 미설정은
   설명만 표시하지 않고 해당 설정 또는 browser focus action으로 이동시킵니다.
7. **같은 작업, 다른 화면 크기.** desktop과 tablet은 별도 기능판이 아니라 같은 route·API·server
   state를 사용합니다. viewport에 따라 배치와 navigation만 달라집니다.

## 4. 목표 정보 구조와 실행 흐름

### 전역 shell

상단 navigation은 **오늘의 작업**, **여러 글 처리**, **글 작성**, **최근 작업**, **설정**으로
구성합니다. 오른쪽 status area에는 API 연결, automation browser·로그인, 진행 중 작업을 항상
표시합니다. 화면 전환은 hash route를 사용합니다.

```text
#today
#post/<discovery-post-id>
#comment/<recommendation-id>?post=<discovery-post-id>
#session/<session-id>
#writing/<draft-id>
#activity
#settings/<section>
```

처음 실행하거나 필수 조건이 빠진 경우 **시작 준비** panel을 오늘의 작업 상단에 표시합니다.
브라우저 시작·네이버 로그인, 내 블로그 ID, 사용 가능한 LLM provider, 자동 실행 동의, 안전 정책을
각각 완료·선택·차단 상태로 보여 줍니다. API key 값은 절대 반환하거나 표시하지 않습니다.

### 오늘의 작업과 discovery inbox

- 상단에 이웃 새 글, 신규 이웃 후보, 오늘 완료, 건너뜀 수를 요약합니다.
- 목록은 source, 상태, 게시 시각, 작성자, 저장 이웃명 또는 일치 검색어를 표시하고 source·상태로
  필터하며 최신순을 기본으로 합니다.
- 카드 하나를 열면 automation browser에서 본문을 추출하고 저장된 기본 provider로 댓글 후보를
  자동 생성합니다. 단일 provider에서는 `POST /automation/comments`, fan-out에서는 기존 fan-out
  endpoint 한 번으로 추출과 생성을 함께 수행해 같은 글을 중복 추출하지 않습니다. 실패하면 같은
  화면에서 재시도하거나 원문을 browser에 focus합니다.
- 카드를 건너뛰거나 다시 대기 상태로 돌릴 수 있습니다. 여러 카드를 선택해 세션 배치로 넘길 수
  있으며, 선택 순서와 대상은 승인 순간에 고정합니다.
- 대기열 밖의 글은 Naver URL을 직접 입력해 댓글 후보 생성·복사까지만 사용합니다. discovery record가
  없으므로 자동 공감·댓글 등록은 제공하지 않습니다.

### 댓글 후보와 한 번의 최종 실행

- 후보는 tone, comment, 참조 근거, provider를 나란히 표시합니다. fan-out은 선택 사항이고 기본은
  저장한 provider 하나만 호출합니다. 부분 실패 provider는 다른 성공 결과를 가리지 않습니다.
- 사용자는 후보를 선택해 직접 편집하거나 **더 짧게**, **더 자연스럽게**, **더 따뜻하게**,
  **글의 구체적 내용 강조**, 자유 지시 중 하나로 AI 다듬기를 요청할 수 있습니다.
- 다듬기 endpoint는 recommendation의 저장된 summary·topics·excerpt와 현재 댓글만 사용하며 source
  URL과 full article body를 다시 provider에 보내지 않습니다. 요청은 `Idempotency-Key`를 사용하고
  timeout·indeterminate 시 자동 교체 호출을 만들지 않습니다.
- 최종 버튼 한 번이 recommendation 승인과 engagement run 시작을 순차 실행합니다. 승인까지 성공하고
  run 시작이 거부되면 승인 댓글을 보존하고 **실행만 다시 시도**할 수 있게 합니다.
- 버튼 label은 실제 범위와 일치해야 합니다. 이웃 글은 공감·댓글, 신규 후보는 공감·댓글·서로이웃
  신청이며, 서로이웃 메시지를 최종 확인 영역에 함께 보여 줍니다.

### 여러 글 처리

- 오늘의 작업에서 선택한 글 또는 source별 최신 N건을 batch 대상으로 사용할 수 있습니다.
- 승인 화면은 대상 글, 순서, 실행 단계, 생성 provider, 일일 잔여 상한, 예상 최소 대기 시간을
  보여 줍니다.
- 승인 시 `automation_session_posts`에 대상과 순서를 snapshot으로 저장합니다. 실행 중 대기열이
  바뀌어도 다른 글이 끼어들지 않습니다.
- Captcha·로그인·safety gate는 전체 batch를 중단합니다. 일반적인 글 하나의 실패는 결과를 기록하고
  다음 글로 진행합니다. 취소는 현재 글 완료 뒤 반영합니다.

### 글쓰기

- 첫 화면에서 제목, 짧은 메모, 선택 이미지, 카테고리를 입력합니다.
- 기본 동작 **AI로 초안 완성**은 draft 생성과 본문 compose를 한 번의 사용자 동작으로 연결합니다.
  **초안만 저장**은 LLM 호출 없이 record만 만듭니다.
- draft 생성 뒤 제목·본문 편집은 debounce 자동 저장하며 저장 중·저장됨·실패 상태를 표시합니다.
- 빠른 다듬기 preset과 자유 지시를 제공하고, 각 revision의 변경점을 word-level diff로 보여 줍니다.
  이전 revision으로 돌아가도 기록은 삭제하지 않습니다.
- 태그 추천·직접 추가·선택, 이미지 순서·alt text, draft 삭제를 같은 흐름에서 처리합니다. 태블릿의
  사진 선택·카메라 upload도 일반 file input으로 같은 image validation을 통과합니다.
- 임시저장 실행 전 최종 제목·본문 길이·이미지·태그를 요약합니다. 성공하면 automation browser의
  에디터를 focus하고, 발행은 사용자가 직접 확인해 클릭합니다.

### 최근 작업과 설정

- 최근 작업은 recommendation, engagement run, batch, draft staging을 시간순으로 통합해 보여 줍니다.
  승인 댓글 복사, recommendation 삭제, 개인화 포함 여부 변경, 개인화 예시 초기화를 제공합니다.
- 설정은 **댓글·AI**, **자동 실행과 안전**, **탐색**, **글쓰기**, **선택 알림**으로 나눕니다.
- 화면에서 실제 반영되는 설정만 노출합니다. `browser_profile`처럼 현재 process environment가 실제
  source인 값은 browser 재시작 영향까지 구현하기 전에는 UI 설정으로 노출하지 않습니다.

## 5. 런타임·배포 설계 변경

### 웹앱과 extension 분리

- `CHROME_EXTENSION_ORIGIN`은 빈 값 또는 미설정을 허용합니다. 설정했다면 기존 32자 Chrome ID
  형식만 허용합니다.
- 요청의 `Origin`이 검증된 service `Host`와 일치하는 loopback·LAN same-origin 요청은 CORS header
  없이 허용하고, 설정된 extension origin에만 정확한 CORS·preflight header를 반환합니다. 그 밖의
  browser `Origin`은 403으로 거부합니다.
- 기본 `setup-<platform>`은 Python·client dependency와 app/page bundle만 설치·build합니다.
  `--with-extension`에서만 extension dependency·build·ID 입력을 수행합니다. 기존 env의 extension
  origin은 그대로 유효합니다.
- start launcher는 health 확인 뒤 기본 browser로 `/app`을 한 번 열고 API process가 종료될 때까지
  기다립니다. Ctrl+C와 비정상 종료 code를 child process에 전달합니다.

### Galaxy Tab·iPad 접속 경계

automation browser와 provider key는 계속 PC에만 둡니다. 태블릿은 PC에서 제공하는 SPA와 API에
접속하는 조작 화면이며, Playwright·Chrome profile·SQLite를 태블릿으로 옮기지 않습니다.

- 기본 `WEBAPP_ACCESS_MODE=local`은 기존처럼 `127.0.0.1`에만 bind합니다. 사용자가 desktop 웹앱에서
  LAN access를 명시적으로 켠 경우에만 `lan` mode에서 socket을 `0.0.0.0`에 bind하고, 실제 request의
  Host는 loopback과 setup 시 확인한 private IPv4 address만 허용합니다.
- LAN mode는 같은 private network 전용입니다. public IP client와 임의 Host·Origin을 거부하고,
  setup 화면에 확인된 private IPv4 URL만 표시합니다. 외부 인터넷 공개와 port forwarding은
  지원하지 않습니다.
- desktop loopback 사용자는 pairing 없이 접근할 수 있습니다. non-loopback client는 desktop 화면에
  표시된 5분 유효 일회용 code로 pairing해야 합니다. code는 성공 즉시 폐기하고 IP별 시도를
  제한합니다.
- 성공한 device에는 256-bit random session token을 `HttpOnly`, `SameSite=Strict` cookie로 발급하고
  SQLite에는 SHA-256 hash만 저장합니다. 별도의 `SameSite=Strict` CSRF cookie는 client가 읽어
  state-changing request의 `X-NBA-CSRF` header로 되돌려 보내며, server는 session에 묶인 hash와
  비교합니다. device는 이름·마지막 사용 시각과 함께 desktop 설정에서 개별 revoke할 수 있고 기본
  30일 후 만료됩니다.
- trusted LAN의 HTTP 접속은 pairing으로 무단 조작을 막지만 transport를 암호화하지는 않습니다.
  따라서 설정 화면에 이 한계를 명시하고 public·guest Wi-Fi를 거부합니다. TLS certificate를 사용한
  reverse proxy는 별도 advanced 운영 문서로만 다루며 이번 기본 launcher가 인증서를 자동 신뢰시키지
  않습니다.
- tablet에서 네이버 로그인이 필요해지면 **PC 자동화 브라우저에서 로그인 필요**로 표시합니다.
  tablet에 Naver credential 입력이나 remote desktop 기능을 추가하지 않습니다.

### Tablet UI와 browser lifecycle

- 48rem 이하에서는 desktop 2-column을 1-column card flow로 바꾸고 navigation을 sticky bottom bar로
  표시합니다. touch target은 최소 44×44 CSS px, form text는 16px 이상으로 유지해 iPadOS input zoom을
  피하고 hover에만 의존하는 action을 두지 않습니다.
- portrait·landscape, safe-area inset, software keyboard, 긴 댓글·본문 editor의 내부 scroll을
  검증합니다. destructive action은 label과 별도 confirm을 유지합니다.
- mobile Safari와 Android Chrome이 background tab의 SSE를 중지할 수 있으므로 `visibilitychange`와
  `pageshow`에서 active run·session·staging snapshot을 다시 읽고 terminal event를 중복 적용하지
  않습니다.
- HTTP LAN에서 Clipboard API가 막히면 선택 가능한 textarea와 수동 복사 안내를 제공하고, file upload는
  iOS Photos·Android file picker를 모두 지원합니다.
- `manifest.webmanifest`, app icon, theme color를 제공하지만 offline 실행이나 background automation은
  약속하지 않습니다. 모든 실제 작업은 PC service가 살아 있을 때만 수행됩니다.

### wheel과 release

- `client/dist`를 wheel의 `naver_blog_assistant/api/static_app` resource로 포함합니다. SPA router는
  설치 resource를 우선하고 editable source에서는 repository `client/dist`를 fallback으로 사용합니다.
- CI와 release는 client app과 page bundle을 모두 build한 뒤 wheel을 만듭니다. installed-wheel smoke가
  `/app/`, JavaScript, CSS, page probe, OpenAPI, migration head를 확인합니다.
- extension ZIP은 선택 설치 legacy asset으로 계속 만들고 독립된 회귀 job에서 검증합니다. 웹앱
  System E2E는 extension이 없는 wheel 환경을 기본으로 합니다.

## 6. API와 데이터 변경

기존 endpoint는 삭제하거나 의미를 바꾸지 않고 아래를 추가합니다.

| 변경 | 계약 |
| --- | --- |
| 준비 상태 | `GET /api/v1/app/readiness` — API, client asset, browser/login, blog ID, provider, consent, safety policy의 redacted 상태와 stable blocker code |
| discovery 표시 맥락 | `DiscoveryPostResponse.source_label` nullable 추가 — 이웃명 또는 저장 검색어를 repository join으로 계산 |
| 댓글 AI 다듬기 | `POST /api/v1/recommendations/{id}/refine` — 현재 댓글, preset 또는 자유 지시, provider 선택을 받고 refined text와 provider/model 반환 |
| 안전 현황 | `GET /api/v1/automation/safety-status` — 로컬 날짜, 현재 허용 시간 여부, 단계별 cap·사용·잔여 수 반환 |
| 선택 batch | `POST /api/v1/automation/sessions`에 optional `post_ids` 추가. 없으면 기존 source/max 동작, 있으면 순서가 있는 1~50개 고유 queued post만 허용 |
| 재시작 복구 | session abort reason에 `process_restarted` 추가. startup에서 남은 pending/running session을 aborted로 전환 |
| 이미지 편집 | `PATCH /api/v1/drafts/{draft_id}/images/{image_id}` — alt text와 새 ordinal을 함께 검증하고 한 transaction에서 순서 재정렬 |
| LAN pairing | loopback 전용 `POST /api/v1/remote/pairing-code`, pairing `POST /api/v1/remote/pair`, loopback 전용 `GET /api/v1/remote/devices`·`DELETE /api/v1/remote/devices/{id}` 추가 |

**migration 0019 `remote_device_sessions`**

| 컬럼 | 설명 |
| --- | --- |
| `id`, `device_name` | session 식별자와 사용자가 확인할 기기명 |
| `token_hash`, `csrf_hash` | 원문을 저장하지 않는 인증·CSRF token hash |
| `created_at`, `last_seen_at`, `expires_at`, `revoked_at` | 만료·감사·개별 revoke 상태 |

Pairing code는 짧은 수명이므로 database에 저장하지 않고 PC process memory에서 hash와 실패 횟수만
보유합니다. LAN mode를 끄면 모든 non-loopback session을 거부하며, 다시 켜도 기존 device session은
명시적으로 revoke되지 않은 경우 만료 전까지 재사용할 수 있습니다.

**migration 0020 `automation_session_posts`**

| 컬럼 | 설명 |
| --- | --- |
| `session_id`, `post_id` | 복합 unique, 기존 session과 discovery post FK |
| `position` | 승인 시점의 실행 순서, session 안에서 unique |
| `created_at` | snapshot 생성 시각 |

기존 source/max 승인을 포함한 모든 새 session은 승인 시점에 queue를 snapshot합니다. 기존 0017 session은
backfill하지 않으며, migration 이전 active session은 startup 복구에서 `process_restarted`로 중단합니다.


## 7. 작업 단위

PR 수는 줄이되 각 PR이 독립적으로 검증 가능한 큰 사용자 가치 단위가 되도록 세 개로 구성합니다.

### PR 1 — 웹앱 독립 실행과 배포 기반

상태: 완료·병합 (2026-08-01, PR #84)

- 새 plan 문서 확정, optional extension origin과 origin policy, 웹앱 기본 setup·start·readiness 검사.
- client app wheel packaging, installed `/app` smoke, webapp-first CI·release와 legacy extension 선택 build.
- opt-in LAN bind, pairing·device session·CSRF·Host/Origin 방어, tablet responsive shell과 app manifest.
- `docs/getting-started.md`를 웹앱 기준으로 다시 쓰고 `docs/extension-legacy.md`를 분리합니다.

완료 기준: extension을 설치하거나 ID를 입력하지 않은 fresh 환경에서 setup → start → browser `/app`
자동 열기까지 성공합니다. 같은 private Wi-Fi의 Galaxy Tab·iPad는 pairing 뒤 readiness까지만 접근할 수
있고 미pairing·foreign Origin·public client는 거부되며, 기존 extension env와 v0.5.6 회귀도 통과합니다.

### PR 2 — 핵심 일상 여정 통합

상태: 구현·검증 진행 중

- hash route·전역 상태·onboarding, 개선된 discovery inbox와 직접 URL 진입.
- 댓글 기본 자동 생성, provider 비교, AI 빠른 다듬기, 승인+실행 한 번의 최종 동작.
- 글쓰기 AI 완성 단축 동작, 자동 저장, revision diff, draft 삭제, 임시저장 최종 요약.
- 최근 작업과 실제 사용되는 app settings 전체 UI.
- tablet portrait·landscape·touch·file upload·clipboard fallback과 background 복귀 상태 재동기화.

완료 기준: 합성 fixture에서 이웃 글과 검색 후보 각각을 열어 댓글 후보 확인·편집 후 한 번의 최종
동작으로 올바른 단계가 실행되고, 짧은 seed에서 임시저장 완료까지 새로고침을 거쳐 완주합니다.

### PR 3 — 선택 batch와 운영 안전성

- session 대상 snapshot migration·선택 batch UI, safety status와 예상 실행 범위 표시.
- process restart 복구, global 진행 상태와 action 가능한 오류 복구.
- 웹앱 System E2E, 전체 사용자 가이드·Local Operations·Architecture·API 계약 최종 개정.

완료 기준: 선택한 글만 승인 순서로 처리되고, 중간 재시작 뒤 기존 batch가 자동 재개되지 않으며 새
session을 안전하게 시작할 수 있습니다. 전체 CI job과 installed-wheel journey가 통과합니다.

## 8. 테스트와 승인 기준

### 필수 여정

1. extension 없는 fresh setup과 기존 extension env upgrade를 각각 검증합니다.
2. 첫 실행 readiness가 빠진 설정별 action을 제공하고 secret 값을 노출하지 않습니다.
3. 이웃 글 선택 → 자동 추출·후보 생성 → AI 다듬기 → 공감·댓글 한 번 실행을 검증합니다.
4. 검색 후보 선택 → 일치 키워드 확인 → 메시지 확인 → 공감·댓글·서로이웃 한 번 실행을 검증합니다.
5. fan-out 부분 실패, LLM timeout, 승인 성공 후 run 시작 실패와 실행만 재시도를 검증합니다.
6. seed 작성 → AI 완성 → 자동 저장 → revision 전환·diff → 태그 → 임시저장과 발행 미실행을 검증합니다.
7. 선택 batch 순서, 대상 고정, 취소, blocking failure, process restart를 검증합니다.
8. foreign origin 403, optional extension preflight, same-origin POST를 실제 browser 또는 ASGI 통합
   테스트로 검증합니다.
9. Galaxy Tab 크기의 Android Chrome과 iPad portrait·landscape viewport에서 핵심 세 여정을 keyboard
   없이 완주하고, background→foreground 뒤 SSE snapshot이 정확히 복구되는지 검증합니다.
10. pairing code 만료·재사용·rate limit, cookie·CSRF 누락, device revoke, public client·DNS rebinding
    형태의 Host 요청을 모두 fail-closed로 검증합니다.

### 품질 gate

- Python: Ruff format/check, `ty`, 전체 pytest와 branch coverage 85% 이상.
- Client: Biome format/lint, TypeScript, Vitest branch coverage 85% 이상, production build.
- Extension: 동결 회귀 suite·build, client/Python에서 extension import가 없는 경계 검사.
- Package: installed wheel `/app` asset, page probe, migration 0019~0020, OpenAPI smoke.
- E2E: fake provider와 합성 Naver fixture를 사용해 Chromium·WebKit tablet viewport에서 핵심 여정을
  검증합니다. 실제 계정·live provider, 실물 Galaxy Tab·iPad 검증은 opt-in manual checklist로
  남깁니다.

## 9. 명시적 범위 경계

- 자동 발행은 추가하지 않습니다. 글쓰기는 임시저장에서 멈춥니다.
- 대기열 밖 직접 URL은 댓글 생성·복사까지만 지원합니다.
- Captcha·로그인 제한을 우회하지 않고, unconfirmed external action을 자동 재시도하지 않습니다.
- API key, SMTP password, cookie를 웹앱·SQLite·로그에 저장하거나 반환하지 않습니다.
- extension은 선택 설치 가능한 v0.5.6 legacy로 유지하되 새 기능을 추가하지 않습니다.
- tablet 기본 지원은 같은 private Wi-Fi까지입니다. public hosting, port forwarding, multi-user 권한,
  remote desktop, offline 실행은 이번 범위에 포함하지 않습니다.
- 지원 기준은 Android Chrome 120 이상과 iPadOS Safari 17 이상이며, 여러 paired device도 하나의
  로컬 사용자 권한을 공유합니다.
