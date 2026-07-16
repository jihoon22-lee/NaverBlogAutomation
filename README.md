# Naver Blog Assistant

사람의 최종 검토를 전제로 네이버 블로그 글을 분석하고 댓글 후보를 생성하는 Python
애플리케이션입니다. 네이버에서의 좋아요와 댓글 등록은 사용자가 직접 수행합니다.

## Requirements

- CPython 3.14 (standard GIL build)
- `uv`
- `OPENAI_API_KEY` available in the process environment

## Setup

```bash
uv sync
uv run streamlit run src/naver_blog_assistant/app.py
```

The application reads `OPENAI_API_KEY` from the environment and never stores its value. Local
database files are written below `data/` and ignored by Git.

## Quality checks

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest
```

Pytest measures branch coverage for `naver_blog_assistant` and fails below 85%. Generate a local
HTML report with `uv run pytest --cov-report=html`; then open `htmlcov/index.html`.

## Contribution workflow

Create a task branch and open a pull request into `main`. The `Quality gate` GitHub Actions job
runs Ruff, ty, and pytest for every pull request. Its job summary includes the test and coverage
output, while detailed JUnit and HTML coverage reports are retained as a `quality-reports`
artifact for seven days. Merging is allowed only after this required check succeeds.

This checkout uses the committed `.githooks/pre-push` hook to reject direct pushes to `main`.
Enable it after a fresh clone with:

```bash
git config core.hooksPath .githooks
```

GitHub server-side branch protection for a private personal repository requires an account plan
that supports the feature. Until then, the local hook and PR review workflow provide a lightweight
guardrail but cannot prevent changes made from another unconfigured clone or the GitHub website.
