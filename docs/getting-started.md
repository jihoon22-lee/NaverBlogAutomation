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

## 3. Side Panel 작업 공간

Side Panel은 한 화면을 길게 스크롤하지 않도록 네 작업 공간으로 나뉩니다.

- **오늘의 작업:** 연결 상태, 이웃 새 글·신규 이웃 후보 수와 이어서 할 작업을 확인합니다. 댓글 등록이
  끝나고 서로이웃 신청만 남은 후보는 해당 상태를 명확히 표시합니다. **서로이웃 신청 계속하기**를
  누르면 원래 후보 글을 현재 탭에 다시 열고 댓글 작성 화면으로 이동합니다.
- **댓글 작성:** 현재 글을 읽고 댓글 후보를 만들며, 동의한 경우 이 한 건의 공감·댓글·서로이웃
  신청을 실행 버튼 한 번으로 처리합니다.
- **최근 작업:** 완료·실패 결과를 확인하고 필요한 기록을 정리합니다.
- **설정:** 글 탐색, 알림, 네이버 접근 권한, 사용자 승인형 자동 실행 동의와 기본 서로이웃
  신청 메시지를 관리합니다.

처음에는 **오늘의 작업**만 표시됩니다. 대기열에서 **이 글 처리하기**를 누르면 현재 탭으로
이동하고, **새 탭에서 처리**를 누르면 새 탭에서 글을 연 뒤 **댓글 작성**으로 전환합니다.

## 4. 첫 댓글 후보 만들기

1. 네이버 블로그 글에서 Side Panel을 열고 **네이버 접근 허용**을 선택합니다. 한 번 허용하면 탭을
   옮긴 뒤에도 다시 toolbar action을 누를 필요가 없습니다.
2. title·본문 preview가 맞는지 확인합니다.
3. 관계, 말투, 길이, 분위기를 고른 뒤 **추천 댓글 만들기**를 누릅니다.
4. 후보를 선택하고 필요하면 댓글을 다듬습니다.
5. 수동 처리라면 댓글을 복사해 네이버 입력란에 직접 붙여넣습니다. 사용자 승인형 자동 실행을
   켰다면 이웃 글의 **공감·댓글 등록 계속하기** 또는 신규 후보의
   **공감·댓글·서로이웃 신청 계속하기**를 누릅니다.

수동 댓글 등록은 브라우저의 일반 붙여넣기를 사용합니다. extension은 후보 댓글을 임의의 입력란에
넣지 않습니다.

### 사용자 승인형 자동 실행 동의

Side Panel의 **사용자 승인형 자동 실행**에서 범위와 네이버 이용약관 안내를 읽고 checkbox를
선택하면 동의를 켤 수 있습니다. 동의는 공감, 선택한 댓글 등록, 선택적 서로이웃 신청을 허용할
준비 단계이며, 동의만으로 외부 동작이 시작되지는 않습니다. 댓글 작성 화면에서 글별 실행 버튼을
누르면 선택·편집한 최종 댓글과 현재 설정의 신청 메시지로 한 번만 사용할 수 있는 승인이 만들어집니다.

동의하지 않거나 철회해도 댓글 복사는 계속 사용할 수 있습니다. 동의 문구
version이 바뀌면 다시 확인해야 하며, 여러 글 일괄 실행, Captcha·로그인 제한 우회는 지원하지
않습니다.

신규 이웃 후보를 실행하면 네이버 이웃추가 popup에서 기본 이웃이 아닌 **서로이웃**을 선택합니다.
이후 네이버가 요구하는 두 번의 **다음**과 완료 화면의 **닫기**까지 한 건의 승인 흐름으로 처리합니다.
공감 control이 반응 선택 레이어를 여는 글에서는 기본 **공감** 항목을 추가로 선택하며, 이미 공감한
글은 다시 누르지 않습니다.

## 5. 자동 글 탐색 설정

Side Panel의 **설정 > 글 탐색과 알림**에서 내 블로그 URL의 `blogId`를 한 번 입력한 뒤
**매일 자동 탐색**을 켜세요. 대기열은 **오늘의 작업**에서 이웃 새 글과 신규 이웃 후보로 나누어
확인할 수 있습니다.
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

동기화는 공개 제목·URL·게시 시각 metadata만 저장합니다. 네이버 로그인 비밀번호·쿠키·본문은
읽거나 저장하지 않습니다. 자동 실행 동의가 꺼져 있으면 복사만 제공하며, 동의가 켜져 있어도 사용자가
글별 실행 버튼을 누른 경우에만 공감·선택 댓글 등록·선택적 서로이웃 신청을 수행합니다.

## 6. OpenAI 선택 설정

기본 fake workflow를 확인한 뒤에만 private env file에 다음 값을 넣고 API를 재시작합니다.

```dotenv
APP_ENV=production
COMMENT_GENERATOR_MODE=openai
OPENAI_API_KEY=<private-key>
```

생성 요청을 시작할 때 현재 글의 title·body와, 개인화가 켜진 경우 최근 완료 댓글 최대 5개의 원문이
OpenAI API에 전송됩니다. source URL은 전송하지 않습니다. API key를 extension file, shell history,
screenshot, log 또는 commit에 남기지 마세요.

## 7. 업데이트

extension 코드를 바꾼 경우 다음 명령으로 build한 뒤 Chrome extension card의 **Reload**를 누릅니다.

```bash
npm --prefix extension run build
```

Reload 뒤 extension ID와 API env origin이 여전히 일치하는지 확인합니다.
