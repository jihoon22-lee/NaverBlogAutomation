# 네이버 블로그 댓글 작성 보조 도구

현재 열어 둔 네이버 블로그 글을 Chrome Side Panel에서 읽고, 검토 가능한 댓글 후보를 만드는
local-first 도구입니다. 댓글 등록과 좋아요는 자동화하지 않으며, 사용자가 네이버에서 직접
수행합니다.

## 핵심 기능

- 글 본문 preview를 확인한 뒤에만 댓글 후보를 생성하고, 선택·편집·복사·안전한 입력 보조를 제공합니다.
- 저장한 블로그 ID·검색어의 공개 목록, RSS를 매일 자동으로 **글 탐색 대기열**에 모아 한 글씩
  확인할 수 있습니다.
- API key와 model 호출은 local FastAPI에만 남으며 extension에는 전달되지 않습니다.

## 빠른 시작

CPython 3.14, `uv`, Node.js 24 LTS/npm 11, Chrome 120 이상이 필요합니다. OpenAI를 사용하지 않는
기본 fake workflow에는 API key가 필요 없습니다.

| 환경 | 처음 설정 | API 시작 |
| --- | --- | --- |
| Windows | `scripts\setup-windows.cmd` | `scripts\start-windows.cmd` |
| macOS | `scripts/setup-macos.command` | `scripts/start-macos.command` |
| Linux·WSL | `scripts/setup-linux.sh` | `scripts/start-linux.sh` |

Setup launcher가 extension build와 ID 설정을 안내합니다. Chrome의 `chrome://extensions`에서
`extension/dist`를 **Load unpacked**로 불러온 뒤, 화면 안내에 따라 extension ID를 입력하세요.
플랫폼별 상세 설치와 첫 실행은 [시작하기](docs/getting-started.md)를 따르세요.

## 사용하는 흐름

1. Side Panel의 **글 탐색 대기열**에서 **탐색 설정과 알림**을 열고, 내 블로그 ID와 자동 탐색 시간을 저장합니다.
2. 필요하면 **지금 동기화**로 이웃 새 글과 검색 후보를 바로 확인합니다.
3. 글의 title과 body preview를 확인하고 댓글 설정을 고릅니다.
4. 후보를 생성한 뒤 선택하거나 다듬어 **댓글 사용**을 누릅니다.
5. 입력된 초안을 확인하고 네이버에서 직접 등록합니다.

입력란을 찾지 못하거나 기존 내용이 있으면 안전을 위해 덮어쓰지 않습니다. 복사한 뒤 직접
붙여넣으세요.

## 선택 기능

| 기능 | 필요한 설정 | 안내 |
| --- | --- | --- |
| OpenAI 댓글 생성·스타일 개인화 | private env file의 `OPENAI_API_KEY` | [시작하기](docs/getting-started.md) |
| 자동 이웃 RSS 탐색 | 내 블로그 ID | [글 탐색 대기열](docs/discovery.md) |
| 신규 이웃 검색 후보 탐색 | 내 블로그 ID, private env file의 `NAVER_SEARCH_CLIENT_ID`·`NAVER_SEARCH_CLIENT_SECRET` | [글 탐색 대기열](docs/discovery.md#신규-이웃-검색) |
| 이메일 일일 요약 | private env file의 `DIGEST_SMTP_*` 값 | [글 탐색 대기열](docs/discovery.md#smtp-이메일-요약-선택) |

자동 탐색은 opt-in이며 공개 metadata만 사용합니다. 로그인, 쿠키 사용, 댓글 자동 등록은 지원하지
않습니다.

## 문서

| 목적 | 문서 |
| --- | --- |
| 플랫폼별 설치, extension 로드, 첫 댓글 생성 | [시작하기](docs/getting-started.md) |
| 이웃 RSS, 검색 후보, badge·알림, SMTP 요약 | [글 탐색 대기열](docs/discovery.md) |
| runtime, 데이터 보관·정리, 문제 해결 | [Local Operations](docs/local-operations.md) |
| 설계와 보안 경계 | [Architecture](docs/architecture.md) |
| Local API 계약 | [API Contract](docs/api-contract.md) |
| 릴리스 절차와 배포 산출물 | [Release Guide](docs/releasing.md) |

## Privacy

FastAPI는 `127.0.0.1:8765`에만 bind합니다. extension storage에는 본문, URL, 후보와 편집 댓글을
저장하지 않습니다. SQLite에 남는 데이터와 삭제 방법은 [Local Operations](docs/local-operations.md)를
참고하세요.

작업 branch와 Conventional Commit, review-ready PR 규칙은 [AGENTS.md](AGENTS.md)를 따릅니다.
