# Local Recommendation API Contract

The machine-readable contract is [`api/openapi.yaml`](api/openapi.yaml). This document records
behavior that consumers and implementations must preserve.

## Transport

- Base URL: `http://127.0.0.1:8765`
- Media type: `application/json`
- Version prefix: `/api/v1`
- Authentication: none in the first local-only release
- Browser access: one configured `chrome-extension://<id>` origin only

The service must not bind to `0.0.0.0`. CORS allows only the declared origin, `GET` and `POST` or
`PATCH` as required, and the `Content-Type` and `Idempotency-Key` headers. Cookies and other browser
credentials are disabled.

## Create a Recommendation

`POST /api/v1/recommendations` accepts the active post after preview confirmation. A UUID-valued
`Idempotency-Key` header is required.

```json
{
  "source_url": "https://blog.naver.com/example/123456789",
  "title": "주말에 다녀온 전시 후기",
  "body": "전시에서 인상 깊었던 작품과 관람 동선을 정리한 본문입니다."
}
```

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
  "created_at": "2026-07-16T10:00:00Z"
}
```

The example abbreviates `candidates`; a successful response always contains exactly three.

## Read and Review

- `GET /api/v1/recommendations/{recommendation_id}` returns one persisted recommendation without
  its original body.
- `PATCH /api/v1/recommendations/{recommendation_id}` records the selected candidate, an optional
  edited comment, and a forward-only review status.

Allowed transitions are `drafted → approved → completed`. A user may edit while drafted or
approved. `completed` means the user reported finishing the manual workflow; it does not mean the
application posted a comment.

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

Provider failures are mapped to `generation_rate_limited`, `generation_timeout`,
`generation_refused`, or `generation_unavailable`. Responses never include API keys, source text,
provider request bodies, stack traces, or raw provider errors.

## Compatibility Rules

- Adding an optional response field is backward compatible.
- Removing or renaming a field, changing an enum, or tightening an accepted limit requires a new
  API version.
- Pydantic transport models and the checked-in OpenAPI file must be covered by a contract test.
- Extension fixtures use synthetic content; copied private or unpublished posts are prohibited.
