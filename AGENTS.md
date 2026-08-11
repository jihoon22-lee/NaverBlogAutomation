# Repository Guidelines

## Project Structure & Module Organization

This Python 3.14 project is a human-in-the-loop Naver Blog comment assistant. Keep the root limited to project-wide configuration and documentation. Use this layout:

- `src/naver_blog_assistant/` for application code, grouped by responsibility.
- `tests/` for automated tests that mirror the `src/` hierarchy.
- `client/` for the TypeScript web app, injected page scripts, and their tests.
- `assets/` for non-code fixtures, templates, or sample media.
- `scripts/` for developer utilities and one-off maintenance commands.

Do not commit generated output, browser profiles, downloaded media, or local credentials.

## Build, Test, and Development Commands

Use `uv` for dependency management and run commands from the repository root:

- `uv sync` — create `.venv` and install locked dependencies.
- `uv run --env-file .env.local naver-blog-api` — start the loopback FastAPI service.
- `uv run pytest` — run tests with branch coverage and enforce the 87% minimum.
- `uv run ruff check .` and `uv run ruff format --check .` — lint and verify formatting.
- `uv run ty check` — run static type analysis.
- `npm ci --prefix client` — install the locked web-app toolchain.
- `npm --prefix client run check` — format-check, lint, type-check, test, and build the web app.

Commands should run from the repository root and behave consistently in local and CI environments.

## Coding Style & Naming Conventions

Python uses four-space indentation and Ruff formatting. Use `snake_case` for functions/modules,
`PascalCase` for classes, and explicit type annotations for public functions. TypeScript under
`client/` follows Biome formatting and linting. Keep modules focused and isolate network side
effects from content transformation logic. Run Ruff, `ty`, and the client checks before
submitting changes.

## Testing Guidelines

Add tests with every behavior change. Python requires at least 87% branch coverage and mirrors
source paths under `tests/`; name tests after observable behavior, for example,
`test_timeout_reuses_original_idempotency_key`. TypeScript requires 85% coverage and uses Vitest
with synthetic HTML for web-app and extraction behavior. Unit-test parsing and content
generation; use mocked boundaries for Naver, OpenAI, and browser interactions. Document opt-in
end-to-end tests and required environment variables without including secret values.

## Commit & Pull Request Guidelines

Use Conventional Commits with `type(scope): subject`, keeping the subject concise and the commit
focused. Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, and `revert`. Scope is optional; examples include `feat(api): add recommendation
endpoint` and `test(client): cover empty article extraction`. Mark breaking changes with `!`.
The committed `commit-msg` hook and PR quality gate enforce this format.

Create a task branch such as `feature/comment-review` or `fix/config-loading`; do not push feature
work directly to `main`. Pull requests should explain the motivation, summarize changes, list
verification commands, and link relevant issues. Merge only after the required `Commit convention`,
`Python quality`, and `TypeScript quality` checks pass. Include screenshots or sanitized logs when
UI behavior changes. Never include private account data, cookies, access tokens, or unpublished
blog content.

작업이 명시적으로 미완료인 경우가 아니라면 PR은 draft가 아닌 review 가능한 상태로
생성합니다. README, PR 설명, 커밋 메시지처럼 사용자가 직접 읽는 내용에는 한글을 우선
사용합니다. Library, API concept, technical term은 자연스러운 English를 함께 사용해 어색한
번역투를 피하고, 기술 식별자와 명령어는 원문 표기를 유지합니다.
