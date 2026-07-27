# 시작하기

이 문서는 Chrome extension을 설치하고 local API를 시작해 첫 댓글 후보를 만드는 과정을 설명합니다.
운영·데이터 정리와 문제 해결은 [Local Operations](local-operations.md), 이웃 RSS·검색 후보 탐색은
[글 탐색 대기열](discovery.md)을 참고하세요.

## 준비물

- CPython 3.14 standard GIL build와 `uv`
- Node.js 24 LTS와 npm 11
- Chrome 120 이상
- OpenAI 생성 기능을 쓸 때만 `OPENAI_API_KEY`

## 1. 환경별 설정

repository root에서 사용하는 환경에 맞는 launcher를 실행합니다. 모든 launcher는 locked dependency
설치와 extension build를 마친 뒤 Chrome extension ID를 요청합니다.

### Windows

```bat
scripts\setup-windows.cmd
```

`chrome://extensions`에서 Developer mode를 켠 뒤 `extension\dist`를 **Load unpacked**로 불러오고,
표시된 32자 ID를 launcher에 입력합니다. private env file은
`%APPDATA%\NaverBlogAssistant\env`에 보관됩니다. `.cmd` launcher는 현재 process에서만 필요한
PowerShell 실행을 허용하며 system 실행 정책을 변경하지 않습니다.

### macOS

Finder에서 `scripts/setup-macos.command`를 열거나 Terminal에서 실행합니다.

```bash
scripts/setup-macos.command
```

`extension/dist`를 **Load unpacked**로 불러온 뒤 ID를 입력합니다. private env file은
`~/.config/naver-blog-assistant/env`에 mode `0600`으로 보관됩니다. macOS가 처음 실행을 확인하면
Finder에서 script를 control-click한 뒤 **열기**를 선택할 수 있습니다.

### Linux·WSL

Linux terminal 또는 Ubuntu WSL에서 실행합니다.

```bash
scripts/setup-linux.sh
```

private env file은 `${XDG_CONFIG_HOME:-$HOME/.config}/naver-blog-assistant/env`에 mode `0600`으로
만들어집니다. WSL에서는 launcher가 Windows Chrome에 **Load unpacked**로 사용할 `extension/dist`
Windows 경로를 표시하고 가능한 경우 Explorer를 엽니다. `/mnt/e` 같은 DrvFs에는 credential file을
만들지 마세요.

## 2. API 시작

설정을 마친 뒤 사용하는 동안 terminal을 열어 둡니다.

```bat
scripts\start-windows.cmd
```

```bash
scripts/start-macos.command
# Linux·WSL에서는 scripts/start-linux.sh
```

수동으로 실행하거나 custom env file을 사용할 때는 다음과 같습니다.

```bash
uv run --frozen --env-file .env.local naver-blog-api
```

extension을 다시 설치해 ID가 바뀌면 해당 환경의 setup launcher를 다시 실행하고 API를 재시작하세요.

## 3. 첫 댓글 후보 만들기

1. 네이버 블로그 글에서 Side Panel을 열고 **네이버 접근 허용**을 선택합니다. 한 번 허용하면 탭을
   옮긴 뒤에도 다시 toolbar action을 누를 필요가 없습니다.
2. title·본문 preview가 맞는지 확인합니다.
3. 관계, 말투, 길이, 분위기를 고른 뒤 **추천 댓글 만들기**를 누릅니다.
4. 후보를 선택하거나 다듬어 **댓글 사용**을 누릅니다.
5. 네이버의 입력란에 들어간 초안을 확인한 뒤 직접 등록합니다.

입력 보조는 비어 있는 visible 입력란 하나만 채웁니다. 입력란이 없으면 표준 **댓글쓰기** 버튼을
한 번 열어 보며, 여러 입력란이나 기존 내용이 있으면 덮어쓰지 않습니다.

### 사용자 승인형 자동 실행 동의

Side Panel의 **사용자 승인형 자동 실행**에서 범위와 네이버 이용약관 안내를 읽고 checkbox를
선택하면 동의를 켤 수 있습니다. 동의는 공감, 선택한 댓글 등록, 선택적 서로이웃 신청을 허용할
준비 단계이며, 동의만으로 외부 동작이 시작되지는 않습니다. 실제 실행 전에는 글 제목, 네이버
host, 최종 댓글, 신청 메시지와 실행 단계를 다시 보여 주고 **이 한 건 실행**을 눌러야 메모리
안에서 한 번만 사용할 수 있는 승인이 만들어집니다.

동의하지 않거나 철회해도 기존 댓글 입력 보조와 복사는 계속 사용할 수 있습니다. 동의 문구
version이 바뀌면 다시 확인해야 하며, 여러 글 일괄 실행, Captcha·로그인 제한 우회는 지원하지
않습니다.

## 자동 글 탐색 설정

Side Panel의 **글 탐색 대기열**에서 **탐색 설정과 알림**을 열고 내 블로그 URL의 `blogId`를 한 번
입력한 뒤 **매일 자동 탐색**을 켜세요. 설정은 대기열을 우선 확인할 수 있도록 기본으로 접혀 있습니다.
기본 시각은 `Asia/Seoul` 오전 9시이며, **지금 동기화**를 누르면 바로 공개 이웃 목록·등록 이웃 RSS를
대기열에 모읍니다. 로컬 API가 실행 중일 때만 예약 동기화가 실행됩니다.

신규 이웃 검색도 사용하려면 [Naver Developers 검색 API](https://developers.naver.com/docs/serviceapi/search/blog/blog.md)에서
application을 만든 뒤 private env file에 아래 두 값을 함께 넣고 API를 재시작하세요. 하나만 넣으면
setup check와 API가 오류를 알려 주며, HTML 검색 결과를 대체로 읽지는 않습니다.

```dotenv
NAVER_SEARCH_CLIENT_ID=<private-client-id>
NAVER_SEARCH_CLIENT_SECRET=<private-client-secret>
```

검색어를 저장한 다음 **지금 동기화**를 누르면 공식 API의 최신 결과에서 후보를 가져옵니다.

동기화는 공개 제목·URL·게시 시각 metadata만 저장합니다. 네이버 로그인 비밀번호·쿠키·본문은 읽거나
저장하지 않으며, 댓글 등록은 계속 직접 수행합니다.

## OpenAI 선택 설정

기본 fake workflow를 확인한 뒤에만 private env file에 다음 값을 넣고 API를 재시작합니다.

```dotenv
APP_ENV=production
COMMENT_GENERATOR_MODE=openai
OPENAI_API_KEY=<private-key>
```

생성 요청을 시작할 때 현재 글의 title·body와, 개인화가 켜진 경우 최근 완료 댓글 최대 5개의 원문이
OpenAI API에 전송됩니다. source URL은 전송하지 않습니다. API key를 extension file, shell history,
screenshot, log 또는 commit에 남기지 마세요.

## 업데이트

extension 코드를 바꾼 경우 다음 명령으로 build한 뒤 Chrome extension card의 **Reload**를 누릅니다.

```bash
npm --prefix extension run build
```

Reload 뒤 extension ID와 API env origin이 여전히 일치하는지 확인합니다.
