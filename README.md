# 네이버 블로그 댓글 작성 보조 도구

사람의 최종 검토를 전제로 네이버 블로그 글을 분석하고 댓글 후보를 생성하는 Python
애플리케이션입니다. 네이버에서의 좋아요와 댓글 등록은 사용자가 직접 수행합니다.

## 요구 사항

- CPython 3.14(표준 GIL 빌드)
- `uv`
- Node.js 24 LTS와 npm 11
- 프로세스 환경변수에 설정된 `OPENAI_API_KEY`

## 설치 및 실행

```bash
uv sync
npm ci --prefix extension
uv run streamlit run src/naver_blog_assistant/app.py
```

애플리케이션은 환경변수에서 `OPENAI_API_KEY`를 읽으며 키 값을 저장하지 않습니다. 로컬
데이터베이스 파일은 `data/` 아래에 생성되고 Git 추적에서 제외됩니다.

## 설계 문서

- [브라우저 보조 방식 아키텍처](docs/architecture.md)
- [로컬 API 계약](docs/api-contract.md)
- [OpenAPI 3.1 명세](docs/api/openapi.yaml)

## 품질 검사

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest
npm --prefix extension run check
```

Pytest는 `naver_blog_assistant`의 브랜치 커버리지를 측정하며 85% 미만이면 실패합니다.
`uv run pytest --cov-report=html`로 로컬 HTML 보고서를 생성한 다음
`htmlcov/index.html`을 열어 상세 결과를 확인할 수 있습니다.

## 기여 및 PR 작업 흐름

작업별 브랜치를 생성하고 `main`을 대상으로 PR을 엽니다. GitHub Actions는
`Commit convention`, `Python quality`, `TypeScript quality`를 독립적인 Job으로 실행합니다.
각 언어의 포맷, 린트, 타입, 테스트, 커버리지와 빌드 결과를 별도 Job summary에서 확인할 수
있고, 상세 보고서는 `python-quality-reports`와 `typescript-quality-reports` artifact로
7일 동안 보관됩니다. 필수 검사가 모두 성공한 뒤에만 머지합니다.

이 저장소는 `.githooks/pre-push` 훅으로 `main` 브랜치 직접 push를 차단합니다. 새로 clone한
뒤에는 다음 명령으로 훅을 활성화합니다.

```bash
git config core.hooksPath .githooks
```

같은 훅 디렉터리에서 `feat(api): 댓글 추천 엔드포인트를 추가한다`와 같은 Conventional
Commit 제목도 검증합니다. 허용되는 타입과 예시는 [`AGENTS.md`](AGENTS.md)에 정리되어
있습니다.

개인 계정의 비공개 저장소에서 GitHub 서버 측 브랜치 보호를 사용하려면 해당 기능을 지원하는
요금제가 필요합니다. 그전까지는 로컬 훅과 PR 검토 절차를 보호 장치로 사용합니다. 다만 훅이
설정되지 않은 다른 clone이나 GitHub 웹사이트에서 발생하는 변경까지 차단할 수는 없습니다.
