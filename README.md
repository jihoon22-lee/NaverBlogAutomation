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

### Windows 간편 설정

CPython 3.14, `uv`, Node.js 24와 npm 11을 설치한 뒤 repository folder에서
`scripts\setup-windows.cmd`를 실행합니다. 이 launcher는 locked dependency 설치와 extension
build를 마친 뒤, Chrome에 표시된 extension ID를 물어봅니다.

```bat
scripts\setup-windows.cmd
```

화면 안내대로 `chrome://extensions`의 Developer mode에서 `extension\dist`를 **Load unpacked**로
불러오고 32자 ID를 붙여넣습니다. 설정은 `%APPDATA%\NaverBlogAssistant\env`에 보관되며 기존
파일이 있으면 secret을 포함한 다른 항목은 유지하고 extension origin만 갱신합니다. 설정을 마친
뒤에는 아래 launcher로 API를 시작하고, 사용하는 동안 열린 terminal을 유지합니다.

```bat
scripts\start-windows.cmd
```

Extension을 다시 설치해 ID가 바뀌면 setup launcher를 다시 실행하면 됩니다. `.cmd` launcher는
현재 process에서만 repository의 PowerShell script 실행을 허용하며 system 실행 정책은 바꾸지
않습니다.

### macOS 간편 설정

CPython 3.14, `uv`, Node.js 24와 npm 11을 설치한 뒤 Finder에서
`scripts/setup-macos.command`를 double-click하거나 Terminal에서 실행합니다. Dependency와
extension build가 끝나면 화면 안내에 따라 `extension/dist`를 Chrome에 불러오고 ID를
붙여넣습니다.

```bash
scripts/setup-macos.command
```

Private 설정은 `~/.config/naver-blog-assistant/env`에 mode `0600`으로 보관됩니다. 기존 파일은
다른 값을 유지하고 extension origin만 갱신합니다. 이후에는 아래 launcher를 실행하고 사용하는
동안 열린 Terminal을 유지합니다.

```bash
scripts/start-macos.command
```

Extension ID가 바뀌면 setup launcher를 다시 실행합니다. macOS가 처음 실행을 확인하면 Finder에서
script를 control-click한 뒤 **열기**를 선택할 수 있습니다.

### Linux·WSL 간편 설정

CPython 3.14, `uv`, Node.js 24와 npm 11을 설치한 뒤 Linux terminal 또는 Ubuntu WSL에서
다음을 실행합니다.

```bash
scripts/setup-linux.sh
```

이 launcher는 dependency 설치와 extension build 뒤 Chrome extension ID를 물어보고,
`${XDG_CONFIG_HOME:-$HOME/.config}/naver-blog-assistant/env`에 mode `0600`의 private 설정을
만듭니다. WSL에서는 Windows Chrome의 **Load unpacked**에 사용할 `extension/dist` Windows 경로를
표시하고 가능한 경우 Explorer를 엽니다. `/mnt/e` 같은 DrvFs에 credential을 만들지 않습니다.

설정 뒤에는 다음 launcher로 API를 시작하고, 사용하는 동안 terminal을 유지합니다.

```bash
scripts/start-linux.sh
```

Extension ID가 바뀌면 setup launcher를 다시 실행합니다. 수동 설정이 필요하면
[`docs/local-operations.md`](docs/local-operations.md)의 XDG env 규칙과 setup 검사 명령을 따르세요.

## 사용 순서

1. Extension toolbar action을 눌러 Side Panel을 엽니다. 처음에는 **글 탐색 대기열**에서 이웃 새 글과
   신규 이웃 후보를 확인할 수 있습니다.
2. 이웃 목록을 현재 열린 네이버 목록에서 가져오거나 직접 등록하고, 검색어를 저장한 뒤 사용자가 연
   네이버 검색 결과에서 후보를 가져옵니다. 각 후보는 **이 글 열기**를 눌러 직접 확인합니다.
   저장 검색어의 제외어는 제목·표시된 작성자명에 적용되고, 검색 결과에 게시일이 표시된 후보는
   최신성 기간을 벗어나면 가져오지 않습니다. 게시일이 표시되지 않은 후보는 사용자가 직접 확인할 수
   있도록 대기열에 남습니다.
3. 지원되는 HTTPS Naver Blog 글을 연 뒤 Side Panel에서 추출된 title과 body preview를 확인합니다.
4. 저장된 빠른 설정을 확인하거나 상세 설정에서 관계, 말투, 분위기, 댓글 길이와 **스타일 개인화**를
   선택합니다. 개인화는 최근 완료 댓글 최대 5개를 OpenAI에 원문 그대로 보내 말투·문장 길이·문장부호
   같은 표면적 스타일만 참고하게 하며, 필요하면 생성 전에 끌 수 있습니다.
   반말은 **가까운 사이**에서만 사용할 수 있습니다. 길이 목표는 **짧게 40~80자**,
   **보통 100~160자**, **길게 200~320자**입니다. 원하는 조합은 명시적으로 기본값으로
   저장할 수 있습니다. 자주 쓰는 마무리 문구도 선택적으로 함께 저장할 수 있습니다.
5. **추천 댓글 만들기**를 눌러 세 후보를 생성하고 적용된 옵션을 확인합니다.
6. 후보의 **이 댓글 사용**을 누르거나 내용을 다듬은 뒤 **다듬은 댓글 사용**을 누릅니다.
7. 열려 있는 비어 있는 댓글 입력란이 정확히 하나이면 초안이 입력됩니다. 입력란이 닫혀 있으면
   표준 **댓글쓰기** 버튼을 한 번 열어 봅니다. 입력란을 찾지 못하거나 기존 내용이 있으면 **다시 입력**을
   한 번 시도하거나 복사 버튼으로 직접 붙여넣습니다. 등록은 항상 직접 수행합니다.
8. 실제 수동 절차를 마친 경우에만 **수동 등록 완료로 표시**를 누릅니다.

Side Panel 상단의 연결 표시에서 local API와 적용 중인 generator model을 확인할 수 있습니다.
**최근 작업**에는 최신 20개의 title, review 상태와 최종 댓글이 표시됩니다. 완료 댓글은 스타일 예시에
포함하거나 제외할 수 있으며, **스타일 예시 정리**는 기록을 지우지 않고 모든 완료 댓글을 예시에서만
제외합니다. 이전 댓글을 다시 복사하거나 원문을 열 수 있고, 더 이상 보관하지 않을 기록은 확인 후
해당 recommendation과 retry metadata를 함께 삭제할 수 있습니다.

**같은 설정으로 새 후보 만들기**는 현재 글을 다시 확인한 뒤 내용이 같으면 곧바로 새 OpenAI
API 요청을 시작합니다. 글이 달라졌으면 Preview에서 멈춥니다. **설정 바꾸기**는 API를 호출하지
않고 Preview로 돌아갑니다. 기본값으로 저장한 관계·말투·길이·분위기는 다음 글에도 적용됩니다.
생성 결과가 목표 길이나 역할 구분을 충분히 만족하지 못하면 후보를 숨기지 않고 review 화면에
품질 안내를 표시합니다.

입력 보조, 복사와 완료 표시는 댓글을 게시하지 않습니다. 입력 보조는 visible하고 비어 있는
댓글 입력란 하나만 채우며, 입력란이 없을 때 확인된 표준 댓글쓰기 버튼 하나만 누릅니다. 기존
text를 덮어쓰거나 등록 버튼을 누르지 않습니다. Tab 이동이나 navigation 뒤에는 toolbar action을
다시 눌러 `activeTab` 권한을 갱신하세요.

마무리 문구는 최대 50자로 정규화해 Chrome local storage에만 기본값으로 저장하며 생성 API나
OpenAI에는 전송하지 않습니다. 후보를 선택하면 편집 영역 끝에 문구가 붙으므로 승인 전에 제거하거나
고칠 수 있습니다. 승인한 최종 댓글은 기존 review workflow에 따라 local SQLite에 저장됩니다.

## OpenAI Opt-in

Fake workflow를 먼저 확인한 후에만 private env file을 다음처럼 변경하고 API를 재시작합니다.

```dotenv
APP_ENV=production
COMMENT_GENERATOR_MODE=openai
OPENAI_API_KEY=<private-key>
```

기본 adapter는 `gpt-5.6-terra`, low reasoning, `store=false`를 사용합니다. 생성 버튼을 누르면
현재 글의 title과 body, 그리고 개인화가 켜진 경우 최근 완료 댓글 최대 5개의 원문이 OpenAI API로
전송되며 source URL은 전송하지 않습니다. 개인화는 상세 설정에서 끄거나 최근 작업에서 댓글별·전체로
제외할 수 있습니다. Key를
extension file, shell history, screenshot, log 또는 commit에 남기지 마세요.

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

## Release

정식 릴리스는 `v0.4.0`처럼 stable SemVer tag를 사용합니다. 버전과 CHANGELOG를 갱신하고 main에
병합한 뒤 annotated tag를 push하면 GitHub Actions가 검증, wheel·extension ZIP build, checksum 생성,
GitHub Release 게시를 수행합니다. 절차와 asset 설명은 [Release Guide](docs/releasing.md)를
참고하세요.

## 범위와 Privacy

- 지원 범위는 현재 사용자가 연 Naver Blog 글의 추출, 추천, review, 안전한 입력 보조와 copy입니다.
- 공개 RSS의 하루 한 번 이웃 새 글 갱신은 opt-in으로 지원합니다. login, 쿠키 사용, 좋아요, 댓글
  자동 등록, 무인 페이지 순회는 제외합니다.
- Extension storage에는 body, title, URL, 후보나 편집 댓글을 저장하지 않습니다. 사용자가
  기본값으로 저장한 생성 옵션과 최대 50자의 마무리 문구는 예외입니다.
- SQLite에는 source URL, title, content hash, bounded excerpt, 추천과 review 상태가 남습니다. 완료
  댓글은 명시적으로 제외하기 전까지 개인화 스타일 예시로도 사용될 수 있습니다.
- 최근 작업 삭제는 선택한 SQLite recommendation, candidates와 연결된 idempotency snapshot만
  제거하며 다른 기록에는 영향을 주지 않습니다.
- Private/unpublished content, 실제 account identifier나 secret을 test fixture·artifact에 넣지 않습니다.

작업 branch와 Conventional Commit, review-ready PR 규칙은 [AGENTS.md](AGENTS.md)를 따릅니다.
