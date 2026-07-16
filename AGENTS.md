# Repository Guidelines

## Project Structure & Module Organization

This Python 3.14 project is a human-in-the-loop Naver Blog comment assistant. Keep the root limited to project-wide configuration and documentation. Use this layout:

- `src/naver_blog_assistant/` for application code, grouped by responsibility.
- `tests/` for automated tests that mirror the `src/` hierarchy.
- `assets/` for non-code fixtures, templates, or sample media.
- `scripts/` for developer utilities and one-off maintenance commands.

Do not commit generated output, browser profiles, downloaded media, or local credentials.

## Build, Test, and Development Commands

Use `uv` for dependency management and run commands from the repository root:

- `uv sync` — create `.venv` and install locked dependencies.
- `uv run streamlit run src/naver_blog_assistant/app.py` — start the local UI.
- `uv run pytest` — run tests with branch coverage and enforce the 85% minimum.
- `uv run ruff check .` and `uv run ruff format --check .` — lint and verify formatting.
- `uv run ty check` — run static type analysis.

Commands should run from the repository root and behave consistently in local and CI environments.

## Coding Style & Naming Conventions

Use four-space indentation and Ruff formatting. Use `snake_case` for functions/modules, `PascalCase` for classes, and explicit type annotations for public functions. Keep modules focused and isolate network side effects from content transformation logic. Run Ruff and `ty` before submitting changes.

## Testing Guidelines

Add tests with every behavior change and maintain at least 85% branch coverage. Mirror source paths under `tests/` and name tests after observable behavior (for example, `test_publish_retries_after_timeout`). Use Streamlit `AppTest` for UI behavior. Unit-test parsing and content generation; use mocked boundaries for Naver, OpenAI, and browser interactions. Document opt-in end-to-end tests and required environment variables without including secret values.

## Commit & Pull Request Guidelines

Use concise, imperative subjects (for example, `Add draft validation`) and keep each commit focused. Create a task branch such as `feature/comment-review` or `fix/config-loading`; do not push feature work directly to `main`. Pull requests should explain the motivation, summarize changes, list verification commands, and link relevant issues. Merge only after the required `Quality gate` check passes. Include screenshots or sanitized logs when UI behavior changes. Never include account identifiers, cookies, access tokens, or unpublished blog content.
