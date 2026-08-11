# 네이버 블로그 댓글 작성 보조 도구

네이버 블로그 이웃 글에 댓글을 남기고 내 글을 작성하는 과정을 로컬에서 도와주는
local-first 도구입니다. 사용자가 자동 실행 범위를 확인하고 동의한 뒤 선택한 글의 실행 버튼을 누른
경우에만 공감, 승인 댓글 등록과 선택적 서로이웃 신청을 순서대로 실행합니다. 무인 일괄
실행은 명시적으로 켜지 않으면 동작하지 않으며, 기본은 여전히 사용자 승인입니다.

## 핵심 기능

- 네 개의 primary 화면인 **홈**, **작업함**, **글쓰기**, **관리**로 필요한 일을 빠르게 엽니다.
- **작업함**에서 이웃 새 글·새 이웃 후보·보류된 글을 검색·필터링하고, 목록 위치를 유지한 채
  댓글 작성과 일괄 처리를 이어갑니다.
- 글 본문 preview를 확인한 뒤에만 댓글 후보를 생성하고, 선택·편집·복사를 제공합니다.
- 저장한 블로그 ID·검색어의 공개 목록, RSS를 매일 자동으로 **글 탐색 대기열**에 모아 한 글씩
  확인할 수 있습니다.
- 실행 버튼을 누른 글 한 건에서 미공감 상태면 공감하고 승인 댓글을 등록하며, 신규 후보는 현재 관계를
  확인한 뒤 **서로이웃만** 신청합니다. 네이버 popup의 서로이웃 선택과 두 번의 **다음**, 완료 뒤
  **닫기**까지 확인하며, 성공한 단계는 반복하지 않고 불명확한 등록은 자동 재시도하지 않습니다.
- **여러 글 처리(세션 배치):** 한 번 승인으로 여러 글을 이어서 처리합니다. 취소는 처리 중인 글이
  끝난 뒤 반영됩니다.
- **글쓰기 워크플로:** 넓은 block canvas에서 문단·소제목·인용·목록·구분선·이미지/캡션을
  working copy로 자동 저장하며, 참고 글 수집 → 본문 생성 → 다듬기 → 태그 생성 → 임시저장 순서로
  내 글을 만듭니다. 편집 내용을 `버전으로 남기기`로 확정해야 AI 도구와 태그를 이어서 사용할 수
  있고, 제목과 빈 문단·목록 항목을 먼저 확인합니다. 네이버 editor의 지원 구조와 순서를 확인하지
  못하면 임시저장하지 않고 멈춥니다. 자동 발행은 하지 않으며, 발행은 사용자가 에디터에서 직접 합니다.
- 댓글·본문 생성 시 **OpenAI·Gemini·Claude**를 선택하거나 동시에 호출해 결과를 비교할 수 있습니다.
- API key와 model 호출은 local FastAPI에만 남으며 웹앱에는 전달되지 않습니다.

## 빠른 시작

CPython 3.14, `uv`, Node.js 24 LTS/npm 11, Chrome 120 이상이 필요합니다. OpenAI를 사용하지 않는
기본 fake workflow에는 API key가 필요 없습니다.

| 환경 | 처음 설정 | API 시작 |
| --- | --- | --- |
| Windows | `scripts\setup-windows.cmd` | `scripts\start-windows.cmd` |
| macOS | `scripts/setup-macos.command` | `scripts/start-macos.command` |
| Linux·WSL | `scripts/setup-linux.sh` | `scripts/start-linux.sh` |

Setup launcher는 웹앱 bundle을 준비하고 private 환경 파일을 만듭니다. 시작 launcher는 준비가
끝나면 기본 브라우저에서 `/app/`을 엽니다.
플랫폼별 상세 설치와 첫 실행은 [시작하기](docs/getting-started.md)를 따르세요.

기존 Chrome extension을 설치한 사용자는 `chrome://extensions`에서 **네이버 블로그 댓글 작성 보조
도구**를 제거하고 local web app으로 전환하세요. Extension의 browser-local 설정은 자동 이전되지
않으므로 웹앱의 **관리 > 설정**에서 댓글 기본값·자동화 동의·안전 한도를 다시 확인해야 합니다.
Local service의 SQLite 데이터는 extension 제거만으로 삭제되지 않습니다.

실제 AI를 사용하려면 setup 뒤 자동 생성된 private 환경 파일에 다음 세 값을 넣습니다. 앞의 두 값은
그대로 입력하고, 마지막 값에는 OpenAI Platform에서 직접 발급한 개인 API key 전체를 넣어야 합니다.
key 발급 위치·운영체제별 파일 여는 명령·재시작 방법은 [환경 파일에 값
넣기](docs/getting-started.md#2-환경-파일에-값-넣기)에 복사 가능한 예시로 안내합니다. 기본 `fake` mode는
API key 없이 화면과 흐름만 확인하는 용도입니다.

```dotenv
APP_ENV=production
COMMENT_GENERATOR_MODE=openai
OPENAI_API_KEY=발급받은_OpenAI_API_key_전체
```

Galaxy Tab·iPad는 기본 설치 후에도 PC와 같은 신뢰 Wi-Fi에서 선택적으로 연결할 수 있습니다. private
env file에서 LAN mode를 명시적으로 켠 뒤 PC 화면의 일회용 코드로 pair합니다. 자세한 보안 경계와 설정은
[시작하기](docs/getting-started.md#태블릿에서-열기-선택)를 참고하세요.

## 사용하는 흐름

로컬 웹앱(`http://127.0.0.1:8765/app`)의 primary navigation은 **홈 · 작업함 · 글쓰기 · 관리**입니다.
배치와 이력은 작업 흐름 및 관리에서 열며, PC 전용 연결·browser·비밀 설정은 paired tablet에 노출되지
않습니다. **관리 > 설정 > 연결 및 앱**에서는 API key·Naver Search·SMTP password를 보이지 않는
write-only field로 갱신할 수 있습니다. 저장 뒤에는 **저장한 설정 적용**을 눌러 launcher가 안전하게
재시작하도록 승인하세요. launcher가 아닌 수동 API 실행에서는 안내에 따라 직접 재시작합니다.

### 댓글·공감·서로이웃

1. **관리 > 설정 > 탐색 및 자동화**에서 내 블로그 ID와 시간을 저장하고, 필요하면 검색어·알림·서로이웃
   기본 메시지를 설정합니다.
2. **관리 > 설정 > 탐색 및 자동화 > 지금 동기화**에서 공개 이웃 목록·등록 이웃 RSS·검색 후보를 수집한 뒤, **작업함**에서
   이웃 새 글 또는 신규 이웃 후보를 고릅니다.
3. **이 글 처리하기** 또는 **새 탭에서 처리**를 누르면 댓글 작성 화면으로 이동합니다.
4. 본문 preview와 옵션을 확인하고 댓글 후보를 생성한 뒤 하나를 선택해 필요한 만큼 다듬습니다.
5. 동의한 경우 **공감·댓글 등록 계속하기** 또는 **공감·댓글·서로이웃 신청 계속하기**를 한 번 눌러
   그 글만 실행합니다. 수동으로 처리하려면 댓글을 복사해 직접 붙여넣습니다.
6. 단계별 결과를 확인하고 **다음 대기 글 처리** 또는 **작업함으로**를 선택합니다. 자동 실행이
   중단된 뒤 직접 처리했다면 **직접 처리한 단계 기록**에서 실제 완료한 단계만 선택해 대기열을
   정리합니다.

### 여러 글 처리 (세션 배치)

**작업함**에서 글을 여러 개 선택한 뒤 **일괄 처리 계속**을 누르면 실행할 단계(공감·댓글·서로이웃),
기본 대상과 최대 글 수를 고릅니다.
필요하면 대기열 글을 체크해 실행 대상과 순서를 직접 정할 수 있습니다. 시작 전 오늘의 단계별
잔여 한도와 예상 최소 대기 시간을 확인한 뒤 승인하면, 대상은 snapshot으로 고정되어 새 글이
중간에 들어오지 않습니다. 진행 중 **배치 취소**를 누르면 지금 처리 중인 글이 끝난 뒤 멈춥니다.
안전 정책의 일일 상한에 도달하거나 허용 시간대를 벗어나거나 연속 실패가 설정 횟수에 이르면
자동으로 중단합니다. service 재시작 뒤 진행 중이던 batch는 자동 재개하지 않습니다.

### 글쓰기

**글쓰기** 탭에서 다음 순서로 내 글을 만듭니다.

1. 제목·짧은 메모와 카테고리를 입력합니다. record만 만들려면 **초안만 저장**, 첫 본문까지
   만들려면 **AI로 초안 완성**을 누릅니다. 이미지는 초안이 만들어진 뒤 글쓰기 화면에서 추가합니다.
2. 카테고리를 선택하면 같은 카테고리의 내 최근 참고 글을 자동으로 수집합니다.
3. 길이·분위기·구성과 사용할 AI 서비스(provider)를 고른 뒤 **본문 생성**을 누릅니다.
4. 결과를 확인하고 제목·block을 편집합니다. 잠시 멈추면 working copy로 자동 저장되며, 편집 후에는
   **버전으로 남기기**를 눌러야 AI 다듬기와 태그 생성을 이어갈 수 있습니다.
5. **다듬기 요청**을 반복하고 **태그 생성**으로 후보 태그를 만들어 선택합니다. 빈 제목이나 빈
   문단·목록 항목은 저장할 수 없습니다.
6. **임시저장 실행**을 누르면 네이버 editor의 지원 block 구조와 제목·순서·이미지·태그를 확인한 뒤에만
   임시저장합니다. 구조를 확인하지 못하면 평문으로 바꾸지 않고 중단합니다.
7. 네이버 editor에서 제목, block 순서, 이미지, 태그를 확인한 뒤 사용자가 직접 발행합니다.

수동 처리에는 복사한 댓글을 직접 붙여넣으세요. Captcha·로그인 제한·불명확한 외부 결과는 우회하거나
자동으로 다시 누르지 않습니다.
신규 이웃 후보는 활성 저장 검색어의 모든 단어가 제목에 포함될 때만 표시되며, 각 후보에는 해당
검색어를 표시합니다. 검색어를 삭제해도 metadata는 즉시 삭제하지 않지만 후보 목록에서는 숨깁니다.
공감은 실제 게시글의 표준 하트 control만 대상으로 하며, 반응 선택 레이어가 열리는 화면에서는
기본 **공감** 항목을 확인해 선택합니다.

## 다중 LLM 서비스(provider) 설정

댓글·본문 생성에 OpenAI, Gemini, Claude를 사용할 수 있습니다. 사용할 AI 서비스(provider)의 API key를 private
env file에 넣고 API를 재시작합니다. 하나만 설정해도 되고, 여러 개를 동시에 설정하면 fan-out으로
비교할 수 있습니다.

| AI 서비스(provider) | 환경변수 | 기본 model (변경 가능) |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` |
| Claude | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |

웹앱 **관리 > 설정 > 연결 및 앱**에서 기본 AI 서비스와 model을 선택합니다. 호출 예산은
**관리 > 설정 > 탐색 및 자동화 > 고급 · 예약 실행과 AI 예산**에서 조절합니다
(기술 설정 key: `llm_budget`, `daily_call_cap`, `per_request_provider_cap`).
API key는 PC의 password field에서 같은 origin의 write-only PATCH로 한 번 전달된 뒤 private env file과
재시작한 Python process에만 남습니다. 웹앱에는 구성 여부만 표시됩니다.
실제 key를 어디서 발급하고 어느 파일에 넣는지는 [환경 파일에 값
넣기](docs/getting-started.md#2-환경-파일에-값-넣기)를 따르세요.

## 안전 정책과 무인 스케줄

### 안전 정책

**관리 > 설정 > 탐색 및 자동화 > 자동 실행과 안전**에서 아래 항목을 저장합니다.

- **일일 상한:** 공감·댓글·서로이웃 각각의 하루 최대 횟수
- **허용 시간대:** 자동 실행을 허용하는 시간 목록 (0–23)
- **연속 실패 중단:** 연속 실패 횟수가 설정에 도달하면 배치를 중단
- **최소 간격과 jitter:** 글 사이 대기 시간과 무작위 변동 비율

### 무인 스케줄

무인 스케줄은 opt-in이며 아래 세 조건을 모두 충족해야 활성화됩니다.

1. **관리 > 설정 > 탐색 및 자동화 > 자동 실행과 안전**에서 자동 실행에 동의
2. 같은 화면의 **안전 설정 저장**을 한 번 이상 실행
3. **관리 > 설정 > 탐색 및 자동화 > 고급 · 예약 실행과 AI 예산**의 **실행 방식**에서
   **매일 예약 실행**을 선택 (기술 설정 key: `schedule_policy.mode=schedule`)

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
| 한 건 공감·댓글·서로이웃 실행 | **관리 > 설정 > 탐색 및 자동화 > 자동 실행과 안전**에서 자동 실행 동의, 글별 실행 버튼 클릭 | [Local Operations](docs/local-operations.md) |
| 여러 글 처리 (세션 배치) | 자동 실행 동의, 안전 정책 저장 | [시작하기](docs/getting-started.md) |
| 무인 스케줄 | 자동 실행 동의 + 안전 정책 저장 + 고급 설정에서 **매일 예약 실행** 선택 (기술 key: `schedule_policy.mode`) | [시작하기](docs/getting-started.md) |
| 초안 이미지 보관 | 앱이 관리하는 database 인접 `media/` directory | [Local Operations](docs/local-operations.md) |

자동 탐색은 opt-in이며 공개 metadata만 사용합니다. 로그인 정보·쿠키를 수집하거나 Captcha를
우회하지 않습니다.

## 문서

| 목적 | 문서 |
| --- | --- |
| 플랫폼별 웹앱 설치와 첫 작업 | [시작하기](docs/getting-started.md) |
| 이웃 RSS, 검색 후보, badge·알림, SMTP 요약 | [글 탐색 대기열](docs/discovery.md) |
| runtime, 데이터 보관·정리, 문제 해결 | [Local Operations](docs/local-operations.md) |
| 현재 화면 구조와 UX·접근성 기준 | [UX Design](docs/ux-design.md) |
| 설계와 보안 경계 | [Architecture](docs/architecture.md) |
| 테스트 범위와 품질 gate | [Testing](docs/testing.md) |
| Local API 계약 | [API Contract](docs/api-contract.md) |
| 릴리스 절차와 배포 산출물 | [Release Guide](docs/releasing.md) |
| 전체 문서와 역사 기록 찾기 | [문서 허브](docs/README.md) |

## Privacy

기본 FastAPI는 `127.0.0.1:8765`에만 bind합니다. 웹앱은 같은 origin에서 API를 호출하며, API key는
Python process 밖으로 나가지 않습니다. 명시적으로 저장한 댓글 생성 옵션·마무리 문구·서로이웃 기본
메시지와 자동 실행 동의 상태만 versioned record로 보관합니다. SQLite에 남는 데이터와 삭제 방법은
[Local Operations](docs/local-operations.md)를 참고하세요.

작업 branch와 Conventional Commit, review-ready PR 규칙은 [AGENTS.md](AGENTS.md)를 따릅니다.
