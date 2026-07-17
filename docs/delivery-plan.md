# Side Panel MVP Delivery Plan

Status: Approved plan on 2026-07-17

PR 1~3 delivered the domain/use cases, SQLite adapter, and local FastAPI contract. The following
PRs implement the accepted Side Panel architecture. Each PR targets `main`, is opened ready for
review, and merges only after all required CI checks pass. Later work depends on the preceding PR
being merged unless an explicitly isolated implementation can be rebased without contract drift.

## PR 5 — Side Panel and Naver Extraction

Scope:

- replace the popup with a Manifest V3 Side Panel opened from the toolbar action;
- add a typed browser adapter and extract the active supported Naver post across eligible frames;
- isolate Naver selectors, ranking, normalization, and generic fallback as testable modules; and
- render title, URL, character count, truncation notice, preview, and local extraction errors.

Acceptance criteria:

- only `activeTab`, `scripting`, `sidePanel`, and loopback host access are requested in this PR;
- navigation or active-tab changes invalidate stale content;
- unsupported, image-only, under-length, and over-limit cases are deterministic;
- no article body is written to extension storage or logs and no API call occurs before consent;
- synthetic fixtures cover selector fallback, frame ranking, and excluded navigation/comments; and
- Vitest coverage includes all new `extension/src/**/*.ts` behavior rather than a single scaffold
  module; and
- Biome, TypeScript, Vitest coverage, and production extension build pass.

Dependency: merged PR 4 architecture and unchanged v1 API request limits.

## PR 6 — OpenAI Responses Adapter

Scope:

- implement the generator port with the OpenAI Responses API and Pydantic Structured Outputs;
- default to `gpt-5.6-terra`, low reasoning effort, and `store=false`;
- delimit the untrusted article and require grounded summary, topics, and three tone variants; and
- map refusal, rate limit, timeout, unavailable, and invalid output cases to application errors;
- persist terminal failure snapshots for replay without a second provider call; and
- distinguish active generation from an indeterminate post-submission outcome with an Alembic
  migration and fenced persistence transitions.

Acceptance criteria:

- production `openai` mode constructs the real adapter while fake mode stays development/test-only;
- exactly three valid tones are enforced after provider parsing;
- timeout ordering prevents the API wrapper from routinely abandoning a still-running SDK call;
- SDK automatic retries are disabled; each generator invocation makes one provider HTTP attempt,
  known non-generation rejection may release the reservation for same-key retry, and a local key
  permits at most one ambiguous or potentially billable generation attempt;
- terminal failures replay the same safe error, while indeterminate failures require an explicitly
  confirmed replacement key;
- secrets, raw article text, and provider bodies do not appear in repr, logs, or public errors;
- mocked tests cover success and every error mapping, and synthetic quality cases are repeatable;
- migration from an existing database, restart replay, concurrency/fencing, transaction rollback,
  outer-versus-provider timeout, and redacted failure records are covered by integration tests;
- CORS exposes `Idempotency-Replayed` and `Retry-After` on success and errors;
- checked-in OpenAPI and runtime route metadata cover the new error semantics and replay header;
- an opt-in live smoke command is documented but never runs in CI; and
- Ruff, formatting, ty, pytest coverage, wheel build, and installed-wheel smoke pass.

Dependency: existing generator port and FastAPI error contract; it can be developed independently
of PR 5 but must rebase on the latest `main` before review.

## PR 7 — Integrated Side Panel Review Workflow

Scope:

- add the typed local API client and `application/problem+json` parser;
- connect health, generation, candidate selection, editing, approval, copy, and completion;
- persist a bounded digest-to-idempotency-key registry before the first request;
- implement retry, in-progress, rate-limit, indeterminate generation, and review-conflict UX; and
- remove the Streamlit placeholder, dependency, tests, and runtime documentation.

Acceptance criteria:

- repeated clicks are disabled and retry/reopen uses the original key for the same normalized body;
- `201` and `200` replay responses render identically without a second provider call;
- the panel never replaces an indeterminate provider attempt with a new key without confirmation;
- selected/edited/approved state survives a GET refresh, and review `409` refreshes before retry;
- copy is user initiated and does not automatically mark a recommendation completed;
- cancel, success, and navigation clear the full body from extension memory where practical;
- `chrome.storage.local` is added with trusted-context access, schema validation, and no
  body/title/URL/comment values; completed/released/dismissed records use a 60-minute TTL, while
  active/terminal-failure/indeterminate records are pinned and a full 20-entry registry blocks new
  work until explicit resolution, replacement, or cleanup;
- the API client reads exposed replay and retry headers in integration tests;
- the UI state machine covers unsupported, extracting, preview, generating, review, saving,
  approved, completed, and error states with stale-operation rejection;
- progress uses `aria-live`, errors use `role=alert`, result/error headings receive focus, and the
  candidate/edit/copy flow is keyboard operable; and
- body references are released on handoff, cancel, unload, navigation, and every local error path;
  server-side release still waits for the generation task to settle; and
- both language quality gates pass.

Dependencies: PR 5 Side Panel extraction and PR 6 OpenAI adapter.

## PR 8 — Integration and Release Hardening

Scope:

- provide a fresh-install workflow for environment configuration, API startup, and unpacked
  extension loading;
- exercise a built extension against a real loopback API using the deterministic fake generator;
- validate installed-wheel migrations and OpenAPI resources;
- document local data retention, clearing, troubleshooting, and opt-in manual smoke tests; and
- perform the requirement-by-requirement completion, security, and privacy audit.

Acceptance criteria:

- a new checkout can follow README commands without relying on an implicitly loaded `.env` file;
- CI covers health, extraction, create/replay/review, failure recovery, and packaged artifacts;
- no real blog body, account identifier, browser profile, or secret enters fixtures or artifacts;
- manual Naver/OpenAI smoke steps are opt-in, sanitized, and keep publishing fully manual;
- documentation and UI contain no active popup/Streamlit or automatic-engagement claims; and
- all required GitHub checks pass on a conflict-free, review-ready PR.

Dependencies: merged PR 5~7 and their stable public contracts.

## Explicit MVP Exclusions

- recommendation history browsing or search;
- ETag/`If-Match` multi-client concurrency;
- monitoring, likes, comment submission, login, or unattended browsing;
- hosted/multi-user deployment and remote authentication; and
- automatic recovery of an indeterminate provider call.
