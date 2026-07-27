# 네이버 블로그 댓글 작성 보조 도구

현재 열어 둔 네이버 블로그 글을 Chrome Side Panel에서 읽고, 검토 가능한 댓글 후보를 만드는
local-first 도구입니다. 사용자가 약관 안내에 동의하고 선택한 글 한 건의 최종 실행 내용을 확인한
경우에만 공감, 승인 댓글 등록과 선택적 서로이웃 신청을 순서대로 실행합니다. 여러 글을 무인·일괄
처리하지 않습니다.

## 핵심 기능

- **오늘의 작업**, **댓글 작성**, **최근 작업**, **설정**을 분리해 현재 필요한 정보만 표시합니다.
- 글 본문 preview를 확인한 뒤에만 댓글 후보를 생성하고, 선택·편집·복사·안전한 입력 보조를 제공합니다.
- 저장한 블로그 ID·검색어의 공개 목록, RSS를 매일 자동으로 **글 탐색 대기열**에 모아 한 글씩
  확인할 수 있습니다.
- 최종 확인한 글 한 건에서 미공감 상태면 공감하고 승인 댓글을 등록하며, 신규 후보는 현재 관계를
  확인한 뒤 서로이웃을 신청합니다. 성공한 단계는 반복하지 않고 불명확한 등록은 자동 재시도하지
  않습니다.
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

1. **설정 > 자동 탐색 설정**에서 내 블로그 ID와 시간을 저장하고, 필요하면 검색어·알림·서로이웃
   기본 메시지를 설정합니다.
2. **오늘의 작업**에서 **지금 동기화**를 누르고 이웃 새 글 또는 신규 이웃 후보를 고릅니다.
3. **이 글 처리하기** 또는 **새 탭에서 처리**를 누르면 **댓글 작성**으로 이동합니다.
4. 본문 preview와 옵션을 확인하고 댓글 후보를 생성한 뒤 하나를 선택하거나 다듬어 승인합니다.
5. 복사·수동 입력을 사용하거나, versioned 동의 후 표시되는 공감·댓글·서로이웃 실행 내용을 마지막으로
   확인해 이 글 한 건을 실행합니다.
6. 단계별 결과를 확인하고 **다음 대기 글 처리** 또는 **오늘의 작업으로**를 선택합니다.

입력란을 찾지 못하거나 기존 내용이 있으면 안전을 위해 덮어쓰지 않습니다. 복사한 뒤 직접
붙여넣으세요. Captcha·로그인 제한·불명확한 외부 결과는 우회하거나 자동으로 다시 누르지 않습니다.

## 선택 기능

| 기능 | 필요한 설정 | 안내 |
| --- | --- | --- |
| OpenAI 댓글 생성·스타일 개인화 | private env file의 `OPENAI_API_KEY` | [시작하기](docs/getting-started.md) |
| 자동 이웃 RSS 탐색 | 내 블로그 ID | [글 탐색 대기열](docs/discovery.md) |
| 신규 이웃 검색 후보 탐색 | 내 블로그 ID, private env file의 `NAVER_SEARCH_CLIENT_ID`·`NAVER_SEARCH_CLIENT_SECRET` | [글 탐색 대기열](docs/discovery.md#신규-이웃-검색) |
| 이메일 일일 요약 | private env file의 `DIGEST_SMTP_*` 값 | [글 탐색 대기열](docs/discovery.md#smtp-이메일-요약-선택) |
| 한 건 공감·댓글·서로이웃 실행 | **설정 > 사용자 승인형 자동 실행**의 약관 안내 확인과 동의, 실행 직전 최종 확인 | [Local Operations](docs/local-operations.md) |

자동 탐색은 opt-in이며 공개 metadata만 사용합니다. 로그인 정보·쿠키를 수집하거나 Captcha를
우회하지 않으며, 최종 확인 없는 무인 일괄 실행은 지원하지 않습니다.

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
저장하지 않습니다. 명시적으로 저장한 댓글 생성 옵션·마무리 문구·서로이웃 기본 메시지와 자동
실행 동의 상태만 versioned record로 보관합니다. SQLite에 남는 데이터와 삭제 방법은
[Local Operations](docs/local-operations.md)를 참고하세요.

작업 branch와 Conventional Commit, review-ready PR 규칙은 [AGENTS.md](AGENTS.md)를 따릅니다.
