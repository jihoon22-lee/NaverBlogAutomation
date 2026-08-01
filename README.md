# 네이버 블로그 댓글 작성 보조 도구

네이버 블로그 이웃 글에 댓글을 남기고 내 글을 작성하는 과정을 로컬에서 도와주는
local-first 도구입니다. 사용자가 약관 안내에 동의하고 선택한 글의 실행 버튼을 누른
경우에만 공감, 승인 댓글 등록과 선택적 서로이웃 신청을 순서대로 실행합니다. 무인 일괄
실행은 명시적으로 켜지 않으면 동작하지 않으며, 기본은 여전히 사용자 승인입니다.

## 핵심 기능

- **오늘의 작업**, **여러 글 처리**, **글 작성** 탭을 분리해 현재 필요한 정보만 표시합니다.
- 글 본문 preview를 확인한 뒤에만 댓글 후보를 생성하고, 선택·편집·복사를 제공합니다.
- 저장한 블로그 ID·검색어의 공개 목록, RSS를 매일 자동으로 **글 탐색 대기열**에 모아 한 글씩
  확인할 수 있습니다.
- 실행 버튼을 누른 글 한 건에서 미공감 상태면 공감하고 승인 댓글을 등록하며, 신규 후보는 현재 관계를
  확인한 뒤 **서로이웃만** 신청합니다. 네이버 popup의 서로이웃 선택과 두 번의 **다음**, 완료 뒤
  **닫기**까지 확인하며, 성공한 단계는 반복하지 않고 불명확한 등록은 자동 재시도하지 않습니다.
- **여러 글 처리(세션 배치):** 한 번 승인으로 여러 글을 이어서 처리합니다. 취소는 처리 중인 글이
  끝난 뒤 반영됩니다.
- **글쓰기 워크플로:** 참고 글 수집 → 초안 등록 → 본문 생성 → 다듬기 → 태그 생성 → 임시저장
  순서로 내 글을 만듭니다. 자동 발행은 하지 않고 임시저장에서 멈추며, 발행은 사용자가 에디터에서
  직접 합니다.
- 댓글·본문 생성 시 **OpenAI·Gemini·Claude**를 선택하거나 동시에 호출해 결과를 비교할 수 있습니다.
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

로컬 웹앱(`http://127.0.0.1:8765/app`)에는 **오늘의 작업**, **여러 글 처리**, **글 작성**, **설정** 탭이
있습니다.

### 댓글·공감·서로이웃

1. **설정 > 자동 탐색 설정**에서 내 블로그 ID와 시간을 저장하고, 필요하면 검색어·알림·서로이웃
   기본 메시지를 설정합니다.
2. **설정 > 지금 동기화**에서 공개 이웃 목록·등록 이웃 RSS·검색 후보를 수집한 뒤, **오늘의 작업**에서
   이웃 새 글 또는 신규 이웃 후보를 고릅니다.
3. **이 글 처리하기** 또는 **새 탭에서 처리**를 누르면 댓글 작성 화면으로 이동합니다.
4. 본문 preview와 옵션을 확인하고 댓글 후보를 생성한 뒤 하나를 선택해 필요한 만큼 다듬습니다.
5. 동의한 경우 **공감·댓글 등록 계속하기** 또는 **공감·댓글·서로이웃 신청 계속하기**를 한 번 눌러
   그 글만 실행합니다. 수동으로 처리하려면 댓글을 복사해 직접 붙여넣습니다.
6. 단계별 결과를 확인하고 **다음 대기 글 처리** 또는 **오늘의 작업으로**를 선택합니다. 자동 실행이
   중단된 뒤 직접 처리했다면 **직접 처리한 단계 기록**에서 실제 완료한 단계만 선택해 대기열을
   정리합니다.

### 여러 글 처리 (세션 배치)

**여러 글 처리** 탭에서 실행할 단계(공감·댓글·서로이웃)와 최대 글 수를 고른 뒤 **배치 시작**을
누르면, 한 번의 승인으로 고른 글 수까지 이어서 처리합니다. 진행 중 **배치 취소**를 누르면 지금
처리 중인 글이 끝난 뒤 멈춥니다. 안전 정책의 일일 상한에 도달하거나 허용 시간대를 벗어나거나
연속 실패가 설정 횟수에 이르면 자동으로 중단합니다.

### 글쓰기

**글 작성** 탭에서 다음 순서로 내 글을 만듭니다.

1. 제목·초안 text와 이미지를 준비해 **초안 등록**을 누릅니다.
2. 카테고리를 선택하면 같은 카테고리의 내 최근 참고 글을 자동으로 수집합니다.
3. 길이·분위기·구성과 사용할 provider를 고른 뒤 **본문 생성**을 누릅니다.
4. 결과를 확인하고 필요하면 **다듬기 요청**을 반복합니다.
5. **태그 생성**으로 후보 태그를 만들고 선택합니다.
6. **임시저장 실행**을 누르면 네이버 에디터에 제목·본문·이미지·태그를 입력한 뒤 임시저장합니다.
7. 발행은 사용자가 에디터에서 직접 확인하고 클릭합니다.

수동 처리에는 복사한 댓글을 직접 붙여넣으세요. Captcha·로그인 제한·불명확한 외부 결과는 우회하거나
자동으로 다시 누르지 않습니다.
신규 이웃 후보는 활성 저장 검색어의 모든 단어가 제목에 포함될 때만 표시되며, 각 후보에는 해당
검색어를 표시합니다. 검색어를 삭제해도 metadata는 즉시 삭제하지 않지만 후보 목록에서는 숨깁니다.
공감은 실제 게시글의 표준 하트 control만 대상으로 하며, 반응 선택 레이어가 열리는 화면에서는
기본 **공감** 항목을 확인해 선택합니다.

## 다중 LLM provider 설정

댓글·본문 생성에 OpenAI, Gemini, Claude를 사용할 수 있습니다. 사용할 provider의 API key를 private
env file에 넣고 API를 재시작합니다. 하나만 설정해도 되고, 여러 개를 동시에 설정하면 fan-out으로
비교할 수 있습니다.

| Provider | 환경변수 | 기본 model (변경 가능) |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` |
| Claude | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |

웹앱 **설정 > LLM provider**에서 기본 provider와 model을 선택하고, `llm_budget` 설정으로
일일 호출 상한(`daily_call_cap`)과 요청당 provider 상한(`per_request_provider_cap`)을 조절합니다.
API key는 Python process 환경에만 존재하며, 웹앱과 extension에는 구성 여부만 표시됩니다.

## 안전 정책과 무인 스케줄

### 안전 정책

**설정 > safety_policy**에서 아래 항목을 저장합니다.

- **일일 상한:** 공감·댓글·서로이웃 각각의 하루 최대 횟수
- **허용 시간대:** 자동 실행을 허용하는 시간 목록 (0–23)
- **연속 실패 중단:** 연속 실패 횟수가 설정에 도달하면 배치를 중단
- **최소 간격과 jitter:** 글 사이 대기 시간과 무작위 변동 비율

### 무인 스케줄

무인 스케줄은 opt-in이며 아래 세 조건을 모두 충족해야 활성화됩니다.

1. **설정 > automation_consent**에서 자동 실행에 동의
2. **설정 > safety_policy**를 한 번 이상 저장
3. **설정 > schedule_policy**의 `mode`를 `schedule`로 변경

세 조건을 모두 충족하면 매일 지정 시각에 최대 `max_posts`건을 자동으로 처리합니다. 하루에 한 번만
실행되며, 이미 실행했거나 다른 세션이 진행 중이면 건너뜁니다. 조건이 하나라도 빠지면 무인 실행은
동작하지 않습니다.

## 선택 기능

| 기능 | 필요한 설정 | 안내 |
| --- | --- | --- |
| OpenAI 댓글 생성·스타일 개인화 | private env file의 `OPENAI_API_KEY` | [시작하기](docs/getting-started.md) |
| Gemini 댓글·본문 생성 | private env file의 `GEMINI_API_KEY` | [시작하기](docs/getting-started.md) |
| Claude 댓글·본문 생성 | private env file의 `ANTHROPIC_API_KEY` | [시작하기](docs/getting-started.md) |
| 자동 이웃 RSS 탐색 | 내 블로그 ID | [글 탐색 대기열](docs/discovery.md) |
| 신규 이웃 검색 후보 탐색 | 내 블로그 ID, private env file의 `NAVER_SEARCH_CLIENT_ID`·`NAVER_SEARCH_CLIENT_SECRET` | [글 탐색 대기열](docs/discovery.md#신규-이웃-검색) |
| 이메일 일일 요약 | private env file의 `DIGEST_SMTP_*` 값 | [글 탐색 대기열](docs/discovery.md#smtp-이메일-요약-선택) |
| 한 건 공감·댓글·서로이웃 실행 | **설정 > 사용자 승인형 자동 실행**의 약관 안내 확인과 동의, 글별 실행 버튼 클릭 | [Local Operations](docs/local-operations.md) |
| 여러 글 처리 (세션 배치) | 자동 실행 동의, 안전 정책 저장 | [시작하기](docs/getting-started.md) |
| 무인 스케줄 | 자동 실행 동의 + 안전 정책 저장 + schedule_policy `mode: schedule` | [시작하기](docs/getting-started.md) |
| 초안 이미지 보관 위치 지정 | private env file의 `DRAFT_MEDIA_DIR` | [Local Operations](docs/local-operations.md) |

자동 탐색은 opt-in이며 공개 metadata만 사용합니다. 로그인 정보·쿠키를 수집하거나 Captcha를
우회하지 않습니다.

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
