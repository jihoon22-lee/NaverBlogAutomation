# 네이버 블로그 댓글 작성 보조 도구

사람의 최종 검토를 전제로 현재 보고 있는 네이버 블로그 글을 분석하고 댓글 후보를 생성하는
local-first 애플리케이션입니다. 현재 Chrome Side Panel은 활성 글의 본문을 추출해 preview하며,
후속 integrated workflow에서는 추천, 편집, 복사까지 같은 화면에서 처리합니다. FastAPI는
OpenAI API key와 generation/persistence boundary를 담당합니다. 좋아요와 댓글 등록은 항상
사용자가 직접 수행합니다.

## 현재 상태와 Target Architecture

PR 1~7에서 framework-independent domain, SQLite persistence, local FastAPI v1 API,
Side Panel extraction, OpenAI Responses adapter와 안전한 failure replay persistence를
구현했습니다. Extension은 Side Panel에서 지원되는 Naver URL을 검증하고, 활성 글의 title,
URL, character count, truncation 상태와 bounded body preview를 표시합니다.
Side Panel은 유일한 end-user UI이며 FastAPI recommendation/review workflow를 제공합니다.
Packaged system E2E와 release hardening은 후속 작업입니다.

자세한 결정과 acceptance criteria는 다음 문서를 참고하세요.

- [Side Panel architecture](docs/architecture.md)
- [구현 계획](docs/delivery-plan.md)
- [Local API 계약](docs/api-contract.md)
- [OpenAPI 3.1 명세](docs/api/openapi.yaml)

## 요구 사항

- CPython 3.14 표준 GIL build
- `uv`
- Node.js 24 LTS와 npm 11
- OpenAI generator 사용 시 process environment의 `OPENAI_API_KEY`

## 설치

Repository root에서 dependency를 설치합니다.

```bash
uv sync
npm ci --prefix extension
```

`.env.example`을 `.env.local`로 복사하고 unpacked extension ID에 맞춰
`CHROME_EXTENSION_ORIGIN`을 수정합니다. 실제 credential은 commit하지 않습니다.

```bash
cp .env.example .env.local
```

## Local API 실행

외부 API 호출 없이 개발할 때는 explicit development mode의 deterministic fake generator로
현재 API contract와 persistence를 검증할 수 있습니다. Production mode는 OpenAI adapter를 사용합니다.

```bash
uv run --env-file .env.local naver-blog-api
```

`.env.local`에는 개발 단계에서 다음 값이 필요합니다.

```dotenv
APP_ENV=development
COMMENT_GENERATOR_MODE=fake
CHROME_EXTENSION_ORIGIN=chrome-extension://<unpacked-extension-id>
```

서버는 `http://127.0.0.1:8765`에만 bind하고 시작할 때 Alembic migration을 적용합니다.
`.env.local`은 application이 암묵적으로 읽는 파일이 아니므로 `uv run --env-file`을 생략하지
않습니다. OpenAI adapter는 server에서 `gpt-5.6-terra`, low reasoning,
`store=false`를 기본값으로 사용하며 API key를 extension으로 전달하지 않습니다.

## Extension 개발

Side Panel extension을 build하려면 다음 명령을 사용합니다.

```bash
npm --prefix extension run build
```

Chrome의 `chrome://extensions`에서 Developer mode를 켜고 `extension/dist`를 unpacked
extension으로 load합니다. Naver Blog 글을 연 뒤 toolbar action을 누르면 Side Panel이 열리고
현재 글의 extraction preview를 표시합니다. 추천 생성 button은 아직 비활성화되어 있으며,
현재 extension은 OpenAI 또는 local API에 요청을 보내지 않습니다. 후속 integrated workflow는
[`delivery-plan.md`](docs/delivery-plan.md)에 추적합니다.

## 품질 검사

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest
npm --prefix extension run check
```

실제 OpenAI 호출 smoke test는 기본 test/CI에서 skip됩니다. 비용과 외부 전송을 확인한 뒤에만
`RUN_LIVE_OPENAI=1 uv run pytest -m live_openai tests/live -s`로 명시적으로 실행하세요.

Pytest는 `naver_blog_assistant` branch coverage 85%를 강제합니다.
`uv run pytest --cov-report=html`로 `htmlcov/index.html` 상세 보고서를 만들 수 있습니다.
Extension CI도 format, lint, typecheck, Vitest coverage, production build를 독립적으로
검증합니다. 테스트 fixture에는 synthetic content만 사용합니다.

## Privacy와 운영 범위

- `OPENAI_API_KEY`, browser cookie, login credential, 별도 account profile, 원문 전체를 저장하거나
  log하지 않습니다.
- SQLite에는 URL, title, content hash, bounded excerpt, summary와 review 결과가 남습니다. 공개
  blog/account identifier가 source URL에 포함된 경우 그 URL의 일부로 함께 저장될 수 있습니다.
- 현재 Side Panel은 extension storage를 사용하지 않습니다. 후속 integrated retry workflow에서도
  digest와 opaque ID만 제한적으로 보관합니다.
- Monitoring, automatic likes, comment publishing, sign-in automation은 MVP 범위가 아닙니다.
- Live Naver/OpenAI smoke test는 opt-in이며 source text나 secret을 CI artifact에 남기지 않습니다.

## 기여 및 PR 작업 흐름

작업별 branch를 만들고 `main` 대상의 review-ready PR을 엽니다. `Commit convention`,
`Python quality`, `TypeScript quality`가 모두 성공한 뒤 merge합니다. Conventional Commit과
branch 규칙은 [`AGENTS.md`](AGENTS.md)를 따릅니다.

```bash
git config core.hooksPath .githooks
```

Local hook은 `main` 직접 push와 잘못된 commit message를 차단합니다. GitHub server-side
branch protection을 사용할 수 없는 환경에서도 PR 검토와 required checks를 유지합니다.
