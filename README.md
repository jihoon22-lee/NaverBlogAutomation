# 네이버 블로그 댓글 작성 보조 도구

현재 보고 있는 네이버 블로그 글을 Chrome Side Panel에서 읽고 댓글 후보를 생성하는
local-first 도구입니다. 사용자가 본문 preview를 확인한 뒤에만 local FastAPI로 전송하며,
후보 선택·편집·승인·복사까지 Side Panel에서 처리합니다. 댓글 등록과 좋아요는 자동화하지
않으며 항상 사용자가 네이버 페이지에서 직접 수행합니다.

## 구성

- `extension/`: Manifest V3 TypeScript Side Panel, 본문 추출과 review UI
- `src/naver_blog_assistant/`: FastAPI, domain/application layer, OpenAI adapter, SQLite persistence
- `tests/`: Python unit/integration/live opt-in tests
- `docs/`: architecture, API contract, 운영·보존 정책

FastAPI는 `127.0.0.1:8765`에만 bind합니다. API key와 model 호출은 Python process에 남고
extension에는 전달되지 않습니다. 자세한 설계는 [architecture](docs/architecture.md)를
참고하세요.

## 요구 사항

- CPython 3.14 standard GIL build와 `uv`
- Node.js 24 LTS와 npm 11
- Chrome 120 이상
- OpenAI mode를 선택할 때만 `OPENAI_API_KEY`

## Fresh Setup

Repository root에서 locked dependency를 설치하고 extension을 먼저 build합니다.

```bash
uv sync --frozen
npm ci --prefix extension
npm --prefix extension run build
```

Chrome `chrome://extensions`에서 Developer mode를 켜고 **Load unpacked**로
`extension/dist`를 선택합니다. 표시된 32자 extension ID를 복사한 뒤 private environment
file을 만듭니다. Script는 기존 파일을 덮어쓰지 않으며 POSIX에서는 mode `0600`을 강제합니다.

```bash
uv run --frozen python -m scripts.init_local_env
```

Repository가 WSL의 `/mnt/e` 같은 DrvFs에 있어 `0600`을 보장하지 못하면 Linux filesystem의
XDG config directory를 사용합니다.

```bash
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/naver-blog-assistant/env"
uv run --frozen python -m scripts.init_local_env --target "$ENV_FILE"
```

생성한 file에서 `CHROME_EXTENSION_ORIGIN`을
`chrome-extension://<복사한-extension-id>`로 바꿉니다. 첫 실행은 다음 설정을 유지하세요.

```dotenv
APP_ENV=development
COMMENT_GENERATOR_MODE=fake
API_HOST=127.0.0.1
API_PORT=8765
```

Default `.env.local`을 사용한다면 setup을 검증하고 API를 시작합니다. Application은 `.env`를
암묵적으로 읽지 않으므로 `--env-file`을 생략하지 않습니다.

```bash
uv run --frozen --env-file .env.local python -m scripts.check_local_setup
uv run --frozen --env-file .env.local naver-blog-api
```

XDG fallback을 사용했다면 다음처럼 setup tool에도 선택한 path를 알려 줍니다.

```bash
uv run --frozen --env-file "$ENV_FILE" \
  python -m scripts.check_local_setup --env-file "$ENV_FILE"
uv run --frozen --env-file "$ENV_FILE" naver-blog-api
```

API 시작 후 별도 terminal에서 CORS까지 확인할 수 있습니다.

```bash
uv run --frozen --env-file .env.local \
  python -m scripts.check_local_setup --require-api
```

## 사용 순서

1. 지원되는 HTTPS Naver Blog 글을 현재 tab에 엽니다.
2. Extension toolbar action을 눌러 Side Panel을 엽니다.
3. 추출된 title과 bounded body preview가 맞는지 확인합니다.
4. 관계, 말투, 댓글 길이를 선택합니다. 반말은 **가까운 사이**에서만 사용할 수 있습니다.
5. **추천 댓글 만들기**를 눌러 세 후보를 생성하고 적용된 옵션을 확인합니다.
6. 후보를 선택하거나 내용을 편집한 뒤 승인합니다.
7. 승인한 댓글을 복사해 네이버 댓글 입력란에 직접 붙여넣고 등록합니다.
8. 실제 수동 절차를 마친 경우에만 **수동 등록 완료로 표시**를 누릅니다.

**옵션을 바꿔 다시 생성**은 먼저 현재 글을 다시 읽어 Preview로 돌아갑니다. 이 단계에서는
API를 호출하지 않으며, Preview에서 다시 생성 버튼을 눌렀을 때 새 OpenAI API 사용이 발생할 수
있습니다. 댓글 길이만 browser에 저장되고 관계와 말투는 새 글마다 기본값으로 돌아갑니다.

복사와 완료 표시는 댓글을 게시하지 않습니다. Tab 이동이나 navigation 뒤에는 toolbar action을
다시 눌러 `activeTab` 권한을 갱신하세요.

## OpenAI Opt-in

Fake workflow를 먼저 확인한 후에만 private env file을 다음처럼 변경하고 API를 재시작합니다.

```dotenv
APP_ENV=production
COMMENT_GENERATOR_MODE=openai
OPENAI_API_KEY=<private-key>
```

기본 adapter는 `gpt-5.6-terra`, low reasoning, `store=false`를 사용합니다. 생성 버튼을 누르면
현재 글의 title, URL, body가 OpenAI API로 전송될 수 있습니다. Key를 extension file, shell
history, screenshot, log 또는 commit에 남기지 마세요.

## 품질 검사

```bash
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen ty check
uv run --frozen pytest
npm --prefix extension run check
npm --prefix extension exec -- playwright install chromium
npm --prefix extension run test:e2e
```

Pytest는 85% branch coverage를 강제합니다. System E2E는 synthetic fixture와 fake generator만
사용하며 build된 production Side Panel을 실제 loopback API에 연결합니다. 자세한 운영,
troubleshooting, data cleanup과 opt-in smoke 절차는
[Local Operations](docs/local-operations.md)에 있습니다.

## 범위와 Privacy

- 지원 범위는 현재 사용자가 연 Naver Blog 글의 추출, 추천, review와 copy입니다.
- Monitoring, 새 글 탐색, login, 좋아요, 댓글 자동 입력·등록, unattended browsing은 제외합니다.
- Extension storage에는 body, title, URL, 후보나 편집 댓글을 저장하지 않습니다.
- SQLite에는 source URL, title, content hash, bounded excerpt, 추천과 review 상태가 남습니다.
- Private/unpublished content, 실제 account identifier나 secret을 test fixture·artifact에 넣지 않습니다.

작업 branch와 Conventional Commit, review-ready PR 규칙은 [AGENTS.md](AGENTS.md)를 따릅니다.
