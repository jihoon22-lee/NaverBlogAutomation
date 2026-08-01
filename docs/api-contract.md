# Local API Contract

기계 판독 계약은 [`api/openapi.yaml`](api/openapi.yaml)입니다. 이 문서는 client와
service 구현이 반드시 보존해야 하는 행동을 기록합니다. endpoint는 `/api/v1` 아래에
있으며, generation-quality 필드는 API와 SPA를 함께 업그레이드해야 합니다(client가
선언되지 않은 response field를 거부하기 때문).

## Transport

- Base URL: `http://127.0.0.1:8765`
- Media type: `application/json`
- Version prefix: `/api/v1`
- Authentication: loopback desktop은 없음, paired private-LAN device는 session cookie와 CSRF header
- Browser access: 같은 origin의 SPA

기본 service는 `127.0.0.1`에 bind합니다. `WEBAPP_ACCESS_MODE=lan`을 명시한 경우에만 private
Wi-Fi의 `0.0.0.0:8765`를 열고, PC가 발견한 private IPv4 Host와 loopback Host만 허용합니다.
non-loopback device는 PC에서 만든 일회용 code로 pair해야 하며 이후 `HttpOnly`, `SameSite=Strict`
session cookie와 `X-NBA-CSRF` header를 사용합니다. public hosting과 port forwarding은 지원하지
않습니다. 설정된 legacy extension origin 외의 foreign Origin은 거부합니다.

## Create a Recommendation

`POST /api/v1/recommendations`는 웹앱 preview 확인 이후의 active post만 받습니다.
UUID-valued `Idempotency-Key` header가 필수이며 첫 시도 전에 저장되어야 합니다.

```json
{
  "source_url": "https://blog.naver.com/example/123456789",
  "title": "주말에 다녀온 전시 후기",
  "body": "전시에서 인상 깊었던 작품과 관람 동선을 정리한 본문입니다.",
  "relationship_level": "friendly",
  "speech_style": "honorific",
  "comment_length": "medium",
  "comment_mood": "warm"
}
```

네 preference 필드는 각각 독립적으로 optional입니다. 생략 시 기본값은 `friendly`,
`honorific`, `medium`, `warm`, `completed_examples`입니다. `banmal`은
`relationship_level: close`에서만 허용됩니다. 길이 목표는 `short`(40–80), `medium`
(100–160), `long`(200–320 한글 문자)입니다. Mood 값은 `calm`, `warm`, `lively`입니다.

서버는 host를 검증하고, 공백을 정규화하고, content hash를 계산하고, 세 후보를 생성하고,
전체 body 없이 결과를 저장한 뒤 `201 Created`를 반환합니다. 같은 key와 payload를 재생하면
`200 OK`와 `Idempotency-Replayed: true`를 반환합니다. 같은 key에 다른 내용을 보내면
`409 Conflict`입니다.

### Personalization과 Retry 소유

`personalization_mode`는 기본 `completed_examples`입니다. 해당 모드에서 서비스는 최대 5개의
적격 완료 댓글을 OpenAI에 untrusted style example로 보냅니다.

서비스와 SPA는 post digest + 5개 preference 값의 `generation-policy-v3` canonical JSON
composite를 hash합니다. SPA는 전송 전에 idempotency key를 보유하고, 중복 클릭·네트워크
중단·`504`·`generation_in_progress` 응답에 같은 key를 재사용합니다.

### 실패 처리

| 상황 | HTTP/code | 같은 key 행동 | 새 key |
| --- | --- | --- | --- |
| Active generation | `409 generation_in_progress` | bounded polling, 최대 60초 | 자동 아님 |
| Local/provider rate limit | `429 generation_rate_limited` | `Retry-After` 이후 재시도 | 불필요 |
| Terminal refusal | `502 generation_refused` | safe failure replay | 명시적 새 시도만 |
| Terminal invalid output | `502 generation_invalid` | safe failure replay | 명시적 새 시도만 |
| Indeterminate outcome | `409 generation_indeterminate` | indeterminate 상태 replay | 명시적 확인 필요 |

## Read and Review

- `GET /api/v1/recommendations/{recommendation_id}` — 원본 body 없이 하나의 추천 반환.
- `PATCH /api/v1/recommendations/{recommendation_id}` — 선택한 후보, 편집된 댓글,
  forward-only review status, personalization inclusion 기록.
- `GET /api/v1/recommendations` — bounded recent history 목록.
- `DELETE /api/v1/personalization/examples` — 모든 완료 댓글을 future style example에서 제외.

허용 전이는 `drafted → approved → completed`입니다. `completed`는 사용자가 수동 완료를
보고했거나 연결된 engagement run의 comment step이 `succeeded`인 경우입니다.

## Automated Discovery

`GET`/`PUT /api/v1/discovery/automation-settings`로 로컬 opt-in 스케줄을 읽고 저장합니다.
`POST /api/v1/discovery/sync`는 즉시 동기화를 실행합니다. 공개 BuddyList, RSS, 네이버
검색 API만 사용하며 쿠키·로그인 정보는 받지 않습니다.

`DELETE /api/v1/discovery/searches/{search_id}`는 저장된 검색만 삭제합니다. 이미 수집된
후보는 남아 있으나 활성 검색 큐에서는 숨겨집니다.

## 사용자 승인형 교류 실행

`POST /api/v1/engagement-runs`는 글별 실행 버튼에서 발급한 `approval_id`, 기존
`discovery_post_id`, 승인된 `recommendation_id`만 받습니다. 댓글 text와 서로이웃
message는 API 또는 SQLite에 보내지 않습니다. 같은 승인이나 같은 탐색 글을 다시
시작하면 `200 OK`, `Engagement-Replayed: true`와 기존 작업을 반환합니다.

이웃 글의 고정 단계는 `like → comment`, 검색 후보는
`like → comment → mutual_neighbor`입니다. 각 단계는 `pending`, `running`, `succeeded`,
`skipped`, `failed`, `unconfirmed` 중 하나이며 다음 API로 조회·전이합니다.

- `GET /api/v1/engagement-runs?limit=20`
- `GET /api/v1/engagement-runs/{run_id}`
- `GET /api/v1/engagement-runs/by-post/{post_id}`
- `PATCH /api/v1/engagement-runs/{run_id}/steps/{step_name}`
- `POST /api/v1/engagement-runs/{run_id}/manual-completion`

`pending`/`failed` 단계만 `running`으로 전이할 수 있고, 앞 단계가
`succeeded`/`skipped`가 아니면 다음을 시작할 수 없습니다. `unconfirmed`는 다시
`running`으로 바꿀 수 없습니다. 댓글 단계 성공 시 추천을 `completed`로 바꾸고, 모든
필수 단계 성공 시 탐색 글도 완료합니다.

`manual-completion`에 `completed_steps`를 보내 해당 run을 한 번만 정리할 수 있습니다.
댓글 단계는 반드시 포함해야 하며 `unconfirmed` run은 이 endpoint로도 완료할 수 없습니다.

## 자동화 댓글 생성

### 단일 Provider (`POST /api/v1/automation/comments`)

SPA가 URL을 보내면 서비스가 직접 추출, 저장된 generation profile 적용, idempotency key
도출을 수행합니다. 중복·중단·timeout은 같은 key를 재사용하며, 교체 시도는
`replace: true`를 요구합니다.

| 상태 | HTTP | code |
| --- | --- | --- |
| 성공(새 생성) | `200` | — |
| 성공(replay) | `200` + `Idempotency-Replayed: true` | — |
| 생성 중 | `409` | `generation_in_progress` |
| Indeterminate | `409` | `generation_indeterminate` |
| Provider rate limit | `429` | `generation_rate_limited` |
| Browser 미실행 | `409` | `browser_session_not_running` |
| Provider 거부 | `502` | `generation_refused` |
| Provider timeout | `504` | `generation_timeout` |

### Fan-out (`POST /api/v1/automation/comments/fanout`)

여러 provider를 한 번에 호출해 결과를 비교합니다. 부분 실패는 정상입니다.

```json
{
  "url": "https://blog.naver.com/example/123456789",
  "providers": [
    {"provider": "openai"},
    {"provider": "gemini"},
    {"provider": "anthropic", "model": "claude-sonnet-5-20260514"}
  ]
}
```

| 상태 | HTTP | code |
| --- | --- | --- |
| 하나 이상 성공 | `200` | — |
| 예산 초과 | `402` | `provider_cap_exceeded` 또는 `daily_cap_exceeded` |
| 모든 provider 실패 | `502` | `fanout_all_failed` |
| 설정된 provider 없음 | `503` | `fanout_unavailable` |

Response는 `CommentFanoutResponse`로, `attempt`, `extraction`, `items[]`를 포함합니다.
각 item은 `provider`, `model`, `status`(`succeeded`/`failed`/`indeterminate`),
`result_code`, `replayed`, `retry_after`, `recommendation`(성공 시)을 갖습니다.

## LLM Provider 조회

### `GET /api/v1/llm/providers`

설정된 모든 provider와 호출 가능 여부를 반환합니다. API key는 절대 포함되지 않습니다.

```json
{
  "items": [
    {"provider": "openai", "configured": true, "model": "gpt-5.6-terra"},
    {"provider": "gemini", "configured": false, "model": "gemini-3.6-flash"},
    {"provider": "anthropic", "configured": true, "model": "claude-sonnet-5-20260514"}
  ]
}
```

## 세션 배치

### `POST /api/v1/automation/sessions` (승인)

한 번의 승인으로 여러 글을 이어서 처리합니다. Response는 `202 Accepted`와 생성된 세션입니다.

```json
{
  "approved_steps": ["like", "comment", "mutual_neighbor"],
  "sources": ["neighbor"],
  "max_posts": 10
}
```

| 상태 | HTTP | code |
| --- | --- | --- |
| 승인 성공 | `202` | — |
| 이미 진행 중 | `409` | `session_already_running` |
| 유효하지 않은 승인 | `422` | `invalid_session_approval` |

### `GET /api/v1/automation/sessions`

최근 세션 목록을 반환합니다. `?limit=20`(1–50).

### `GET /api/v1/automation/sessions/{session_id}`

하나의 세션 상태를 반환합니다. `404`(`session_not_found`).

### `POST /api/v1/automation/sessions/{session_id}/cancel`

실행 중인 세션의 취소를 요청합니다. 현재 글이 끝난 뒤 멈춥니다.

### `GET /api/v1/automation/sessions/{session_id}/events`

SSE stream으로 세션 진행을 실시간으로 전달합니다. `text/event-stream`.

## 무인 스케줄

### `GET /api/v1/automation/schedule`

스케줄 정책과 활성화 여부를 반환합니다. 비활성 시 `blocking_reason`을 포함합니다.

```json
{
  "mode": "schedule",
  "hour": 10,
  "minute": 0,
  "max_posts": 5,
  "enabled": true,
  "blocking_reason": null
}
```

`blocking_reason` 가능한 값: `not_scheduled`, `not_due`, `already_ran_today`,
`consent_missing`, `safety_policy_missing`, `session_active`, `browser_unavailable`.

## 글쓰기 (Drafts)

### `POST /api/v1/drafts` — 초안 등록

```json
{
  "title": "제주도 여름 여행",
  "seed_text": "제주도에서 3박 4일 동안...",
  "category_no": 12,
  "use_image_vision": false
}
```

`201 Created`와 생성된 `DraftResponse`를 반환합니다.

### `GET /api/v1/drafts` — 초안 목록

`?limit=20`(1–50). 최신순 정렬.

### `GET /api/v1/drafts/{draft_id}` — 초안 조회

`404`(`draft_not_found`).

### `PATCH /api/v1/drafts/{draft_id}` — 초안 메타 수정

`title`, `category_no`, `use_image_vision`, `active_revision_id`를 개별 수정합니다.

### `DELETE /api/v1/drafts/{draft_id}` — 초안 삭제

초안과 연결된 이미지 파일을 함께 삭제합니다. `204`.

### `POST /api/v1/drafts/{draft_id}/images` — 이미지 업로드

`multipart/form-data`로 파일 하나를 업로드합니다. 최대 20장(`409 image_limit_reached`).
허용 MIME: `image/jpeg`, `image/png`, `image/webp`, `image/gif`. 최대 10 MB.

### `DELETE /api/v1/drafts/{draft_id}/images/{image_id}` — 이미지 삭제

### `PUT /api/v1/drafts/{draft_id}/body` — 사용자 편집 body 저장

사용자가 직접 편집한 block body를 새 revision으로 저장합니다.

### `POST /api/v1/drafts/{draft_id}/compose` — 본문 생성

```json
{
  "provider": "openai",
  "model": null,
  "length": "medium",
  "tone": "warm",
  "structure": "sectioned",
  "reference_limit": 5,
  "request": ""
}
```

| 상태 | HTTP | code |
| --- | --- | --- |
| 성공 | `200` | — |
| 초안 없음 | `404` | `draft_not_found` |
| seed text 없음 | `422` | `seed_text_missing` |
| Provider 설정 안됨 | `503` | `fanout_unavailable` |
| Provider 모두 실패 | `502` | `fanout_all_failed` |
| Provider 선택 유효하지 않음 | `422` | `invalid_provider_selection` |

### `POST /api/v1/drafts/{draft_id}/refine` — 본문 다듬기

같은 request body. 활성 revision이 없으면 `422`(`no_active_revision`).

### `POST /api/v1/drafts/{draft_id}/tags` — 태그 생성

같은 `DraftGenerationRequest`. 생성 결과가 모두 무효하면 `422`(`no_usable_tags`).

### `PATCH /api/v1/drafts/{draft_id}/tags` — 태그 선택·추가

```json
{
  "selected": ["제주여행", "맛집"],
  "added": ["자유여행"]
}
```

### `POST /api/v1/drafts/{draft_id}/stage` — 임시저장 실행

에디터에 제목·본문·이미지·태그를 입력한 뒤 임시저장합니다. 발행은 하지 않습니다.
`202 Accepted`와 `PublishRunResponse`를 반환합니다.

| 상태 | HTTP | code |
| --- | --- | --- |
| 실행 시작 | `202` | — |
| 초안 없음 | `404` | `draft_not_found` |
| 활성 body 없음 | `422` | `no_active_revision` |
| Blog ID 미설정 | `422` | `blog_id_missing` |
| 에디터 열기 실패 | `422` | `navigation_failed` |

### `GET /api/v1/drafts/{draft_id}/stage/events` — 임시저장 진행 SSE

`PublishRun`의 5단계(`title`, `body`, `images`, `tags`, `save`) 진행을 event stream으로
전달합니다.

## 블로그 카탈로그

### `GET /api/v1/blog/categories`

캐싱된 내 블로그 카테고리 목록을 반환합니다.

### `POST /api/v1/blog/categories/sync`

자동화 브라우저로 내 블로그 카테고리를 다시 읽습니다.

| 상태 | HTTP | code |
| --- | --- | --- |
| 성공 | `200` | — |
| 다른 블로그 | `403` | `not_blog_owner` |
| Browser 미실행 | `409` | `browser_session_not_running` |
| 카테고리 없음 | `422` | `no_categories` |
| 탐색 실패 | `422` | `navigation_failed` / `probe_failed` |
| Page bundle 없음 | `503` | `browser_unavailable` |

### `GET /api/v1/blog/reference-posts`

한 카테고리의 참고 글을 반환합니다. `?category_no=12&limit=5`(1–10).

## Settings

`GET`/`PUT /api/v1/settings/{kind}`로 하나의 설정 record를 읽고 저장합니다.

### Settings Kind 목록

| kind | 용도 |
| --- | --- |
| `generation_profile` | 댓글 생성 기본 선호(relationship, speech, length, mood, personalization) |
| `closing_phrase` | 마무리 문구 (최대 50 code point) |
| `neighbor_message` | 서로이웃 기본 메시지 (최대 500 code point) |
| `automation_consent` | 자동 실행 동의 (version + accepted) |
| `safety_policy` | 일일 상한, 허용 시간대, 연속 실패 중단, 최소 간격·jitter |
| `schedule_policy` | 무인 스케줄 모드·시각·최대 글 수 |
| `browser_profile` | headless 여부, channel |
| `llm_providers` | 기본 provider, provider별 model 선택 |
| `llm_budget` | 일일 호출 상한(`daily_call_cap`), 요청당 provider 상한(`per_request_provider_cap`) |
| `writing_profile` | 글쓰기 기본 길이·분위기·구성·참고글 수·태그 상한·이미지 vision |

저장 시 서비스가 kind별 schema를 검증하며, 유효하지 않은 값은 `422`로 거부합니다.
존재하지 않는 kind는 `404`(`setting_not_found`)입니다.

## Error Contract

오류는 `application/problem+json`으로, 안정적인 application `code`를 포함합니다.
Client는 `detail`이 아닌 `code`로 분기합니다.

```json
{
  "type": "about:blank",
  "title": "Unsupported blog URL",
  "status": 422,
  "detail": "Only supported Naver Blog HTTPS URLs can be processed.",
  "code": "unsupported_source_url",
  "request_id": "410e0c55-09f4-40d8-bec8-67ca33f96601"
}
```

### 주요 오류 코드

| code | HTTP | 설명 |
| --- | --- | --- |
| `unsupported_source_url` | 422 | 허용되지 않는 blog URL |
| `generation_rate_limited` | 429 | local 또는 provider rate limit |
| `generation_timeout` | 504 | provider timeout |
| `generation_refused` | 502 | provider가 거부 |
| `generation_invalid` | 502 | structured output 검증 실패 |
| `generation_unavailable` | 503 | 필요한 provider 미설정 |
| `generation_indeterminate` | 409 | provider 결과 불명확 |
| `generation_in_progress` | 409 | 이미 생성 중 |
| `idempotency_conflict` | 409 | 같은 key에 다른 payload |
| `review_conflict` | 409 | 저장된 상태와 충돌 |
| `browser_session_not_running` | 409 | 자동화 브라우저 미실행 |
| `browser_operation_failed` | 502 | 브라우저 조작 실패 |
| `browser_unavailable` | 503 | 브라우저 시작 불가 |
| `consent_required` | 403 | 자동 실행 동의 미완료 |
| `session_already_running` | 409 | 다른 세션 진행 중 |
| `session_not_found` | 404 | 세션 없음 |
| `invalid_session_approval` | 422 | 승인 요청 유효하지 않음 |
| `draft_not_found` | 404 | 초안 없음 |
| `seed_text_missing` | 422 | 초안에 seed text 없음 |
| `no_active_revision` | 422 | 활성 revision 없음 |
| `unknown_image_reference` | 422 | 생성 결과가 없는 이미지 참조 |
| `duplicate_image_reference` | 422 | 같은 이미지 중복 참조 |
| `no_usable_tags` | 422 | 태그 생성 결과 전부 무효 |
| `invalid_provider_selection` | 422 | provider/model 선택 유효하지 않음 |
| `provider_cap_exceeded` | 402 | 요청당 provider 수 초과 |
| `daily_cap_exceeded` | 402 | 일일 LLM 호출 상한 초과 |
| `fanout_all_failed` | 502 | fan-out에서 모든 provider 실패 |
| `fanout_unavailable` | 503 | 설정된 provider 없음 |
| `image_limit_reached` | 409 | 초안 이미지 최대 수 초과 |
| `not_blog_owner` | 403 | 설정된 내 블로그가 아님 |
| `no_categories` | 422 | 카테고리를 찾지 못함 |
| `navigation_failed` | 422 | 블로그/에디터 페이지 열기 실패 |
| `setting_not_found` | 404 | 존재하지 않는 settings kind |
| `not_allowed` | 422 | engagement 시작 조건 미충족 |
| `engagement_conflict` | 409 | 기존 engagement와 충돌 |
| `daily_cap_reached` | — | SafetyGovernor가 세션 중 거부 (SSE event) |
| `outside_allowed_hours` | — | SafetyGovernor가 세션 중 거부 (SSE event) |
| `consecutive_failures` | — | SafetyGovernor가 세션 중 거부 (SSE event) |

Response에는 API key, source text, provider request body, stack trace, raw provider error가
절대 포함되지 않습니다.

## Compatibility Rules

- Optional request field 추가는 서버가 effective default를 제공할 때 호환됩니다.
- Response field 추가는 SPA 업데이트를 요구합니다(client가 undeclared field를 거부).
- Field 제거·이름 변경, enum 변경, 허용 limit 강화는 새 API version을 요구합니다.
- Pydantic transport model과 체크인된 OpenAPI 파일은 contract test로 보호합니다.
- Extension fixture는 합성 콘텐츠만 사용하며 비공개·미발행 글은 금지합니다.
