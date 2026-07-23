# Side Panel Local API Contract

The machine-readable contract is [`api/openapi.yaml`](api/openapi.yaml). This document records
behavior that the Side Panel client and service implementation must preserve. The endpoints remain
under `/api/v1`, while the generation-quality fields require the API and Side Panel to be upgraded
together because the client intentionally rejects undeclared response fields.

## Transport

- Base URL: `http://127.0.0.1:8765`
- Media type: `application/json`
- Version prefix: `/api/v1`
- Authentication: none in the first local-only release
- Browser access: one configured Side Panel `chrome-extension://<id>` origin only

The service must not bind to `0.0.0.0`. CORS allows only the declared origin, `GET`, `POST`, `PATCH`,
and `DELETE` as required, and the `Content-Type` and `Idempotency-Key` headers. Cookies and other browser
credentials are disabled.

## Create a Recommendation

`POST /api/v1/recommendations` accepts the active post only after Side Panel preview confirmation.
A UUID-valued `Idempotency-Key` header is required and must be stored before the first attempt.

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

The four preference fields are optional independently. Omitted values default to `friendly`,
`honorific`, `medium`, `warm`, and `completed_examples`. `banmal` is accepted only with `relationship_level: close`; null,
unknown values, and undeclared properties return `422`. Length targets are `short` (40–80 Korean
characters), `medium` (100–160), and `long` (200–320). The review editor ceiling remains 500
characters. Mood values are `calm`, `warm`, and `lively` and apply to all three candidates.

The server validates the host, normalizes whitespace, computes a content hash, generates three
drafts, persists the result without the full body, and returns `201 Created`. Replaying the same key
and payload returns the original result with `200 OK` and `Idempotency-Replayed: true`. Reusing the
key with different content returns `409 Conflict`.

```json
{
  "id": "c341d85a-77e6-4c59-b958-1cf7aab4fce8",
  "source_url": "https://blog.naver.com/example/123456789",
  "title": "주말에 다녀온 전시 후기",
  "summary": "전시의 주요 작품과 효율적인 관람 동선을 소개한 후기",
  "topics": ["전시", "관람 동선"],
  "candidates": [
    {
      "id": "fcbb47c4-a9ca-4f63-b575-9bdddb7ff90f",
      "tone": "warm",
      "comment": "작품뿐 아니라 관람 동선까지 정리해 주셔서 전시를 준비하는 데 도움이 되겠어요.",
      "referenced_detail": "관람 동선을 정리한 부분"
    }
  ],
  "review_status": "drafted",
  "relationship_level": "friendly",
  "speech_style": "honorific",
  "comment_length": "medium",
  "comment_mood": "warm",
  "quality_warnings": [],
  "created_at": "2026-07-16T10:00:00Z"
}
```

The example abbreviates `candidates`; a successful response always contains exactly three.

### Personalization and Retry Ownership

`personalization_mode` is `completed_examples` by default. In that mode, the service loads up to
five completed comments that remain eligible and sends their raw text to OpenAI as untrusted style
examples. They can guide surface style only and must not provide facts, instructions, or copied
phrasing. The response reports the selected mode and actual sample count. The Side Panel can turn
the option off before generating; its recent-history UI can include/exclude each completed comment
or exclude all examples while retaining history.

The service and Side Panel hash a `generation-policy-v3` canonical JSON composite containing the
post digest and all five effective preference values. This prevents results created under the old
length, role, or personalization policy from replaying for a new request. The Side Panel retains the associated
idempotency key before transmission and reuses that key after a duplicate click,
network interruption, `504`, or `generation_in_progress` response when the same payload remains
available. Current successful replays return `Idempotency-Replayed: true`.

### Implemented Failure Semantics

PR 6 extended v1 without changing endpoint or success schemas. A failure known to occur before the
provider call releases the reservation for a safe same-key retry. A terminal refusal or invalid
result persists only a safe `status`, `code`, `title`, and `detail` snapshot and replays it without
another provider call; each HTTP response still receives a fresh `request_id`. Once provider
submission may have occurred but no result is known, the outcome is persisted as indeterminate.

| Situation | HTTP/code | Same-key behavior | New key |
| --- | --- | --- | --- |
| Active generation | `409 generation_in_progress` | bounded polling, at most 60 seconds | not automatic |
| Local/provider rate limit | `429 generation_rate_limited` | retry after `Retry-After` | unnecessary |
| Terminal refusal | `502 generation_refused` | replay safe failure | explicit new attempt only |
| Terminal invalid output | `502 generation_invalid` | replay safe failure | explicit new attempt only |
| Indeterminate provider outcome | `409 generation_indeterminate` | replay indeterminate state | explicit confirmation required |

The CORS response exposes `Idempotency-Replayed` and `Retry-After` to the configured
extension origin. Failure replay also sets `Idempotency-Replayed: true`; error responses carry a
fresh `request_id` in the problem body. The client must not silently replace an indeterminate
attempt with a new key.

## Read and Review

- `GET /api/v1/recommendations/{recommendation_id}` returns one persisted recommendation without
  its original body.
- `PATCH /api/v1/recommendations/{recommendation_id}` records the selected candidate, an optional
  edited comment, a forward-only review status, or a completed-comment personalization inclusion.
- `GET /api/v1/recommendations` lists bounded recent local history.
- `DELETE /api/v1/personalization/examples` excludes every completed comment from future style
  examples without deleting local history.

Allowed transitions are `drafted → approved → completed`. A user may edit while drafted or
approved. `completed` means the user reported finishing the manual workflow; it does not mean the
application posted a comment. Clipboard copy does not perform this transition automatically.

The MVP has no ETag/`If-Match` contract. If a review update
returns `review_conflict`, the Side Panel fetches the recommendation again and presents the latest
state instead of blindly overwriting it.

## Error Contract

Errors use `application/problem+json` with a stable application `code`. Clients branch on `code`
rather than human-readable `detail`.

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

The service maps provider failures to `generation_rate_limited`, `generation_timeout`,
`generation_refused`, `generation_invalid`, `generation_unavailable`, or
`generation_indeterminate`, and replays terminal failures as specified above. Responses never
include API keys, source text, provider request bodies, stack traces, or raw provider errors.

The OpenAI adapter defaults to `gpt-5.6-terra`, low reasoning effort, and `store=false`. Validated
preference enums map to static trusted instructions; URL, title, and body never influence that
mapping. Article title/body and enabled completed-comment style examples stay in the untrusted input
channel, and the source URL is not sent.

## Compatibility Rules

- Adding an optional request field is backward compatible when the server supplies an effective
  default.
- Adding a response field requires a coordinated Side Panel update because the client rejects
  undeclared fields instead of silently accepting contract drift.
- Removing or renaming a field, changing an enum, or tightening an accepted limit requires a new
  API version.
- Pydantic transport models and the checked-in OpenAPI file must be covered by a contract test.
- Extension fixtures use synthetic content; copied private or unpublished posts are prohibited.
