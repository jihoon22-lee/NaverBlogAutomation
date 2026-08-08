# 시작하기

이 문서는 독립 실행되는 local web app을 설치하고 첫 댓글 후보를 만드는 과정을 설명합니다.
운영·데이터 정리와 문제 해결은 [Local Operations](local-operations.md), 이웃 RSS·검색 후보 탐색은
[글 탐색 대기열](discovery.md)을 참고하세요.

## 준비물

- CPython 3.14 standard GIL build와 `uv`
- Node.js 24 LTS와 npm 11
- Chrome 120 이상
- OpenAI 생성 기능을 쓸 때만 `OPENAI_API_KEY`

## 1. 환경별 설정

repository root에서 사용하는 환경에 맞는 launcher를 실행합니다. 모든 launcher는 locked dependency
설치와 web app bundle build를 마친 뒤 private 환경 파일을 만듭니다. Chrome extension 설치와 ID 입력은
필요하지 않습니다.

### Windows

```bat
scripts\setup-windows.cmd
```

private env file은
`%APPDATA%\NaverBlogAssistant\env`에 보관됩니다. `.cmd` launcher는 현재 process에서만 필요한
PowerShell 실행을 허용하며 system 실행 정책을 변경하지 않습니다.

### macOS

Finder에서 `scripts/setup-macos.command`를 열거나 Terminal에서 실행합니다.

```bash
scripts/setup-macos.command
```

private env file은
`~/.config/naver-blog-assistant/env`에 mode `0600`으로 보관됩니다. macOS가 처음 실행을 확인하면
Finder에서 script를 control-click한 뒤 **열기**를 선택할 수 있습니다.

### Linux·WSL

Linux terminal 또는 Ubuntu WSL에서 실행합니다.

```bash
scripts/setup-linux.sh
```

private env file은 `${XDG_CONFIG_HOME:-$HOME/.config}/naver-blog-assistant/env`에 mode `0600`으로
만들어집니다. WSL에서도 browser extension을 설치할 필요가 없습니다. `/mnt/e` 같은 DrvFs에는 credential file을
만들지 마세요. repository가 `/mnt/c/...`·`/mnt/e/...` 같은 Windows 드라이브에 있어도 launcher는 Python
virtual environment를 Linux 파일 시스템의 `${XDG_DATA_HOME:-$HOME/.local/share}/naver-blog-assistant/python-venv`에
자동으로 둡니다. 처음 setup은 이 환경을 준비하므로 조금 걸릴 수 있지만, 이후 API 시작 시 느린 Windows
드라이브에서 대규모 Python dependency를 읽지 않습니다.

## 2. 환경 파일에 값 넣기

위의 setup launcher를 **한 번 실행하면** private 환경 파일이 자동으로 만들어집니다. 일반 사용자는
repository 안의 `.env.local`을 새로 만들 필요가 없습니다. 아래 명령으로 만들어진 파일을 열어 값을 넣으세요.

| 환경 | private 환경 파일 열기 |
| --- | --- |
| Windows (PowerShell) | `notepad "$env:APPDATA\NaverBlogAssistant\env"` |
| macOS (Terminal) | `nano ~/.config/naver-blog-assistant/env` |
| Linux·WSL (Terminal) | `nano "${XDG_CONFIG_HOME:-$HOME/.config}/naver-blog-assistant/env"` |

처음 만들어진 상태는 다음과 같습니다. 이 상태에서는 실제 AI를 호출하지 않고, 기능을 둘러보기 위한
fake 댓글·본문 후보만 만듭니다. API key나 네이버 계정 정보는 필요 없습니다.

```dotenv
APP_ENV=development
COMMENT_GENERATOR_MODE=fake
```

OpenAI로 실제 댓글·본문을 생성하려면 PC 웹앱의 **더보기 > 연결 및 앱**에서 provider를 선택하고
write-only API key field에 본인이 발급한 key를 붙여 넣은 뒤 **저장한 설정 적용**을 선택하세요. launcher가
API를 안전하게 다시 시작합니다. 파일을 직접 관리하는 경우에는 위 두 줄을 아래처럼 바꾸고, 세 번째 줄의
오른쪽에 key를 붙여 넣을 수도 있습니다.

```dotenv
APP_ENV=production
COMMENT_GENERATOR_MODE=openai
OPENAI_API_KEY=발급받은_OpenAI_API_key_전체
```

`발급받은_OpenAI_API_key_전체`는 예시 문구이므로 그대로 입력하면 안 됩니다. [OpenAI API
Quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)의 안내에 따라 OpenAI
Platform dashboard에서 API key를 새로 만든 뒤, 표시된 key 전체를 `=` 뒤에만 붙여 넣으세요. 이 key는
개인별 비밀값이라 문서나 예시 파일에 실제 값을 적을 수 없습니다. 저장한 뒤 실행 중인 start launcher를
완전히 종료하고 다시 시작해야 반영됩니다.

`OPENAI_MODEL`은 환경 파일에 이미 기본값이 있으므로 처음에는 바꾸지 않아도 됩니다. key 앞뒤에 따옴표,
공백, `<`·`>`를 넣지 마세요. 네이버 ID·비밀번호·cookie도 이 파일에 넣지 말고, automation browser가 열린
뒤 네이버에서 직접 로그인하세요.

private 환경 파일은 repository 밖에 있으므로 Git에 올라가지 않습니다. key를 `README.md`, `.env.example`,
extension 설정, screenshot, shell history에 복사하지 마세요. 개발자가 의도적으로 repository에서 API를
수동 실행할 때만 `.env.local`과 `uv run --env-file .env.local ...` 경로를 사용합니다.

자동화 browser는 별도 설치 없이 bundled Chromium을 기본으로 사용합니다. WSL에서는 Windows에 설치된
Chrome을 browser driver가 직접 쓸 수 없으므로 `AUTOMATION_BROWSER_CHANNEL`을 비워 두세요. Linux 안에
Google Chrome을 따로 설치한 경우에만 `AUTOMATION_BROWSER_CHANNEL=chrome`을 설정합니다.

## 3. API 시작

설정을 마친 뒤 사용하는 동안 terminal을 열어 둡니다.

```bat
scripts\start-windows.cmd
```

```bash
scripts/start-macos.command
# Linux·WSL에서는 scripts/start-linux.sh
```

시작 launcher는 health check 뒤 기본 browser에서 `http://127.0.0.1:8765/app/`을 자동으로 엽니다.
일반 사용은 위의 start launcher만 사용하세요. 개발자가 repository 안의 `.env.local`을 의도적으로 만들어
수동 실행하거나 custom env file을 사용할 때만 다음과 같습니다.

```bash
uv run --frozen --env-file .env.local naver-blog-api
```

동결된 legacy extension을 계속 사용하려면 setup launcher에 `--with-extension`을 추가하고
[Extension Legacy](extension-legacy.md)를 따르세요.

## 태블릿에서 열기 (선택)

기본값은 PC에서만 열리는 `local` mode입니다. Galaxy Tab이나 iPad를 같은 **신뢰할 수 있는 private
Wi-Fi**에서 사용하려면 PC 웹앱의 **더보기 > 설정 > 연결 및 앱**에서 `태블릿 연결`을 **신뢰 Wi-Fi**로
바꾸고 **연결 설정 저장** 뒤 **저장한 설정 적용**을 누르세요. `API_HOST`와 port는 앱이 access mode에
맞춰 고정하므로 private env file이나 일반 설정에서 직접 바꾸지 않습니다.

시작 창에는 태블릿에서 열 주소(`http://192.168.x.x:8765/app/` 등)가 표시됩니다. PC 웹앱의
**태블릿 연결**을 눌러 만든 5분짜리 일회용 코드를 태블릿의 연결 화면에 입력하면 됩니다. 연결된
기기는 30일 동안 유효하며 PC의 태블릿 연결 화면에서 개별 해제할 수 있습니다.

이 기능은 공용·guest Wi-Fi, 인터넷 공개, port forwarding을 지원하지 않습니다. LAN 기본 연결은 HTTP라
network transport를 암호화하지 않으므로 신뢰할 수 있는 개인 네트워크에서만 사용하세요. 네이버 로그인과
자동화 browser는 계속 PC에서만 실행됩니다.

## 4. 웹앱 작업 공간

브라우저에서 `http://127.0.0.1:8765/app/`을 열면 네 개의 primary 화면이 표시됩니다.

- **홈:** 연결 상태, 오늘의 수집 요약과 첫 실행 준비 단계를 확인합니다.
- **작업함:** 이웃 새 글·신규 이웃 후보·보류됨을 검색·필터링하고, 한 글 처리와 세션 배치를 이어갑니다.
- **글쓰기:** 넓은 block canvas에서 문단, 소제목, 인용, 순서/비순서 목록, 구분선, 이미지·캡션을
  편집하고 임시저장합니다.
- **더보기:** 이력과 일반 작업 설정을 열며, PC에서는 연결 및 앱 설정과 태블릿 연결도 관리합니다.

태블릿은 작업함, 댓글, 글쓰기, 이력을 PC와 이어서 사용할 수 있습니다. API key·SMTP password·browser·LAN
연결·기기 관리는 PC 로컬 웹앱에서만 변경할 수 있습니다.

처음에는 **홈**의 `시작 준비` card가 보입니다. blocker가 있으면 PC browser 시작·로그인이나
해당 설정 화면으로 바로 이동해 해결하세요. 대기열에서 글을 고른 뒤 **이 글 처리하기**를 누르면
본문 추출과 저장된 기본 provider의 댓글 후보 생성이 이어집니다.

## 5. 첫 댓글 후보 만들기

1. **더보기 > 설정 > 탐색 및 자동화**에서 내 블로그 ID를 저장하고 **지금 동기화**로 대기열을 채웁니다.
2. **작업함**에서 처리할 이웃 글 또는 신규 이웃 후보를 선택합니다.
3. automation browser에서 title·본문 preview가 맞는지 확인합니다. 생성 옵션을 바꾸려면 **다시 생성**을
   누릅니다. 둘 이상의 provider가 구성된 경우에는 호출 수가 표시된 **AI 후보 비교**를 명시적으로
   선택할 수 있습니다.
4. 후보를 선택하고 필요하면 직접 편집하거나 **AI 빠른 다듬기** preset·자유 지시를 사용합니다.
   다듬기에는 저장된 요약·토픽·excerpt와 현재 댓글만 전송되며 원문 URL과 전체 본문은 다시 전송하지
   않습니다.
5. 대기열 글은 사용자 승인형 자동 실행이 켜진 경우 이웃 글의 **공감하고 댓글 등록** 또는 신규 후보의
   **공감·댓글 등록·서로이웃 신청**을 한 번 눌러 승인과 실행을 시작합니다. run 시작만 거부된 경우에는
   승인한 댓글을 보존한 채 **실행만 다시 시도**할 수 있습니다. 직접 URL로 연 글은 후보 생성·복사만
   제공하며 외부 실행하지 않습니다.

수동 댓글 등록은 브라우저의 일반 붙여넣기를 사용합니다. 웹앱은 후보 댓글을 임의의 입력란에
넣지 않습니다.

### 사용자 승인형 자동 실행 동의

웹앱 **더보기 > 설정 > 탐색 및 자동화**에서 범위와 네이버 이용약관 안내를 읽고 checkbox를
선택하면 동의를 켤 수 있습니다. 동의는 공감, 선택한 댓글 등록, 선택적 서로이웃 신청을 허용할
준비 단계이며, 동의만으로 외부 동작이 시작되지는 않습니다. 댓글 작성 화면에서 글별 실행 버튼을
누르면 선택·편집한 최종 댓글과 현재 설정의 신청 메시지로 한 번만 사용할 수 있는 승인이 만들어집니다.

동의하지 않거나 철회해도 댓글 복사는 계속 사용할 수 있습니다. 동의 문구
version이 바뀌면 다시 확인해야 하며, Captcha·로그인 제한 우회는 지원하지 않습니다.

신규 이웃 후보를 실행하면 네이버 이웃추가 popup에서 기본 이웃이 아닌 **서로이웃**을 선택합니다.
이후 네이버가 요구하는 두 번의 **다음**과 완료 화면의 **닫기**까지 한 건의 승인 흐름으로 처리합니다.
공감 control이 반응 선택 레이어를 여는 글에서는 기본 **공감** 항목을 추가로 선택하며, 이미 공감한
글은 다시 누르지 않습니다.

## 6. 자동 글 탐색 설정

로컬 웹앱의 **더보기 > 설정 > 탐색 및 자동화**에서 내 블로그 ID(`blogId`)를 한 번 입력한 뒤
**매일 자동으로 모으기**를 켜세요. 대기열은 **작업함**에서 이웃 새 글과 신규 이웃 후보로 나누어
확인할 수 있습니다.
기본 시각은 `Asia/Seoul` 오전 9시이며, **지금 동기화**를 누르면 바로 공개 이웃 목록·등록 이웃 RSS를
대기열에 모읍니다. 로컬 API가 실행 중일 때만 예약 동기화가 실행됩니다.

**이웃 목록**에서는 공개 RSS를 확인할 이웃을 직접 추가하거나 수집만 일시 중지할 수 있습니다.
**이메일 요약**에서는 이웃 새 글을 새로 확인할 시각과 이메일 발송 선호를 저장합니다. SMTP가 아직
설정되지 않은 경우에도 선호는 저장되지만, SMTP 설정 전에는 이메일을 보내지 않습니다.

신규 이웃 검색도 사용하려면 [Naver Developers 검색 API](https://developers.naver.com/docs/serviceapi/search/blog/blog.md)에서
**애플리케이션 등록**을 하고, **내 애플리케이션**에서 발급된 Client ID와 Client Secret을 확인하세요.
등록할 때 검색 API의 Blog 사용 권한도 선택해야 합니다. PC의 **더보기 > 설정 > 연결 및 앱**에서
Client ID와 Client Secret을 write-only field에 함께 저장하고 **저장한 설정 적용**을 누르세요. 하나만
설정하면 setup check와 API가 오류를 알려 주며, HTML 검색 결과를 대체로 읽지는 않습니다.

검색어를 저장한 다음 **지금 동기화**를 누르면 공식 API의 최신 결과에서 후보를 가져옵니다.

동기화는 공개 제목·URL·게시 시각 metadata만 저장합니다. 네이버 로그인 비밀번호·쿠키·본문은
읽거나 저장하지 않습니다. 자동 실행 동의가 꺼져 있으면 복사만 제공하며, 동의가 켜져 있어도 사용자가
글별 실행 버튼을 누른 경우에만 공감·선택 댓글 등록·선택적 서로이웃 신청을 수행합니다.

## 7. LLM provider 설정

### OpenAI

기본 fake workflow를 확인한 뒤에만 PC의 **더보기 > 설정 > 연결 및 앱**에서 OpenAI provider와
write-only key를 저장하고 **저장한 설정 적용**을 누릅니다. API key는 [OpenAI API
Quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)에 따라 OpenAI Platform에서
발급한 개인 key 전체를 사용합니다. private env file을 직접 수정하는 방법은 수동 복구·개발 실행에만
사용합니다.

```dotenv
APP_ENV=production
COMMENT_GENERATOR_MODE=openai
OPENAI_API_KEY=발급받은_OpenAI_API_key_전체
```

model을 바꾸려면 `OPENAI_MODEL`을 추가합니다.

### Gemini

PC의 **더보기 > 설정 > 연결 및 앱**에서 Gemini key를 write-only로 저장하고 적용을 승인합니다.

```dotenv
GEMINI_API_KEY=<private-key>
```

model을 바꾸려면 `GEMINI_MODEL`을 추가합니다.

### Claude (Anthropic)

PC의 **더보기 > 설정 > 연결 및 앱**에서 Anthropic key를 write-only로 저장하고 적용을 승인합니다.

```dotenv
ANTHROPIC_API_KEY=<private-key>
```

model을 바꾸려면 `ANTHROPIC_MODEL`을 추가합니다.

### LLM 예산 설정

웹앱 **더보기 > 설정 > 탐색 및 자동화 > 고급 · 예약 실행과 AI 예산**에서 아래 두 값을 조절합니다.

| 필드 | 의미 | 기본값 |
| --- | --- | --- |
| `daily_call_cap` | 하루 전체 LLM 호출 상한 | 60 |
| `per_request_provider_cap` | 한 요청에서 동시에 호출할 provider 수 상한 | 3 |

API key는 PC의 password field에서 같은 origin의 write-only PATCH로 한 번 전달된 뒤 private env file과
재시작한 Python process에만 남습니다. `GET /api/v1/llm/providers`는 구성 여부만 반환하고 key 값은 웹앱에
전달하지 않습니다.

생성 요청을 시작할 때 현재 글의 title·body와, 개인화가 켜진 경우 최근 완료 댓글 최대 5개의 원문이
provider API에 전송됩니다. source URL은 전송하지 않습니다. API key를 웹앱 asset, shell history,
screenshot, log 또는 commit에 남기지 마세요.

## 8. 글쓰기 워크플로

**글 작성** 탭에서 내 글을 만드는 전체 흐름입니다. 자동 발행은 하지 않고 임시저장에서 멈추며,
발행은 사용자가 네이버 에디터에서 직접 확인하고 클릭합니다.

1. **초안 시작:** 제목과 짧은 메모를 입력합니다. LLM 호출 없이 record만 만들려면 **초안만 저장**,
   바로 첫 본문까지 만들려면 **AI로 초안 완성**을 누릅니다.
2. **카테고리 선택:** 카테고리를 고르면 같은 카테고리의 내 최근 참고 글(기본 5건)을 자동으로
   수집합니다. **카테고리 새로 읽기**로 목록을 갱신합니다.
3. **본문 생성:** 길이(`short`/`medium`/`long`), 분위기(`calm`/`warm`/`lively`),
   구성(`plain`/`sectioned`/`story`)과 provider를 고른 뒤 **본문 생성**을 누릅니다.
4. **다듬기와 자동 저장:** 결과를 확인하고 필요하면 요청 사항을 입력한 뒤 **다듬기 요청**을 반복합니다.
   제목과 block 편집은 잠시 멈추면 working copy에 자동 저장됩니다. AI 생성·다듬기와 사용자가 선택한
   checkpoint만 revision으로 남으므로 입력할 때마다 이력이 불필요하게 늘어나지 않습니다. 다른 기기에서
   먼저 저장한 경우 최신 working copy를 다시 불러와 확인합니다.
5. **태그 생성:** **태그 생성**으로 후보 태그를 만들고 사용할 태그를 선택합니다.
   직접 추가도 가능합니다.
6. **임시저장 실행:** **임시저장 실행**을 누르면 네이버 editor에서 제목·지원 block 순서·이미지·태그를
   확인한 뒤에만 임시저장합니다. 지원하지 않는 editor 구조는 평문으로 변환하지 않고 안전하게 중단하며
   단계별 진행 상황이 표시됩니다.
7. **발행:** 네이버 에디터에서 제목, block 순서, 이미지, 태그를 직접 확인한 뒤 발행합니다.

### 글쓰기 프로필 설정

웹앱 **더보기 > 설정 > 작업 기본값**에서 기본 생성 옵션을 저장합니다.

| 필드 | 의미 | 기본값 |
| --- | --- | --- |
| `target_length` | 본문 목표 길이 (`short`/`medium`/`long`) | `medium` |
| `tone` | 분위기 (`calm`/`warm`/`lively`) | `warm` |
| `structure` | 구성 (`plain`/`sectioned`/`story`) | `sectioned` |
| `reference_post_count` | 참고 글 최대 수 (0–10) | 5 |
| `body_tag_cap` | 본문에 삽입할 태그 상한 (1–50) | 20 |
| `use_image_vision` | 이미지를 provider에 전송해 분석 (vision 지원 provider만) | `false` |

## 9. 여러 글 처리 (세션 배치)

**여러 글 처리** 탭에서 한 번 승인으로 여러 글을 이어서 처리합니다.

1. 실행할 단계(공감·댓글·서로이웃)를 선택합니다.
2. 기본 대상(이웃 새 글/신규 이웃 후보/둘 다)과 최대 글 수(1–50)를 고릅니다. 필요하면 대기열
   글을 체크해 실행할 글과 순서를 직접 정합니다.
3. 화면의 오늘 잔여 한도와 예상 최소 대기 시간을 확인합니다. 선택한 단계에 필요한 한도가
   부족하거나 현재 시간이 허용 범위 밖이면 시작할 수 없습니다.
4. **N건 배치 승인 및 시작**을 누르면 선택 순서 또는 당시 기본 대기열 순서를 snapshot으로 고정해
   처리합니다. 이후 새로 수집된 글은 현재 batch에 들어오지 않습니다.
5. 진행 중 **배치 취소**를 누르면 지금 처리 중인 글이 끝난 뒤 멈춥니다.

배치는 안전 정책을 따릅니다. 일일 상한에 도달하거나, 허용 시간대를 벗어나거나, 연속 실패가
설정 횟수에 이르면 자동으로 중단합니다.

service를 다시 시작하면 이전의 pending/running batch는 `process_restarted`로 안전하게 중단됩니다.
이전 batch를 자동 재개하지 않으므로, 결과를 확인한 뒤 필요한 글만 새로 선택해 승인하세요.

## 10. 안전 정책과 무인 스케줄

### 안전 정책 저장

세션 배치와 무인 스케줄에 공통으로 적용되는 안전 정책을 **더보기 > 설정 > 탐색 및 자동화**에서 저장합니다.

| 필드 | 의미 | 기본값 |
| --- | --- | --- |
| `daily_like_cap` | 하루 공감 상한 | 20 |
| `daily_comment_cap` | 하루 댓글 상한 | 20 |
| `daily_neighbor_cap` | 하루 서로이웃 신청 상한 | 5 |
| `min_interval_seconds` | 글 사이 최소 대기 시간(초) | 90 |
| `jitter_ratio` | 대기 시간의 무작위 변동 비율 (0–1) | 0.4 |
| `allowed_hours` | 자동 실행을 허용하는 시간 목록 (0–23) | 9–22 |
| `max_consecutive_failures` | 연속 실패 시 중단 횟수 | 3 |

### 무인 스케줄 활성화

무인 스케줄은 opt-in이며, 아래 세 조건을 **모두** 충족해야 활성화됩니다.

1. **더보기 > 설정 > 탐색 및 자동화**에서 자동 실행에 동의 (`accepted: true`)
2. 같은 화면에서 안전 정책을 한 번 이상 저장
3. **고급 · 예약 실행과 AI 예산**의 `schedule_policy.mode`를 `schedule`로 변경

세 조건을 모두 충족하면 매일 지정 시각에 최대 `max_posts`건을 자동으로 처리합니다.

| 필드 | 의미 | 기본값 |
| --- | --- | --- |
| `mode` | 실행 모드 (`manual`/`session`/`schedule`) | `manual` |
| `hour` | 실행 시각 (0–23) | 10 |
| `minute` | 실행 분 (0–59) | 0 |
| `max_posts` | 한 번에 처리할 최대 글 수 (1–50) | 5 |

하루에 한 번만 실행됩니다. 이미 실행했거나 다른 세션이 진행 중이면 건너뜁니다.
조건이 하나라도 빠지면 무인 실행은 동작하지 않습니다.

## 11. 업데이트

웹앱은 설치 launcher가 client bundle을 다시 build하므로, source update 뒤 setup launcher를 다시
실행하고 service를 재시작하면 됩니다. 동결된 legacy extension을 함께 설치한 경우의 reload 절차는
[Extension Legacy](extension-legacy.md)를 참고하세요.
