# Local Operations and Release Validation

이 문서는 fresh setup 이후의 data lifetime, 안전한 cleanup, troubleshooting과 opt-in smoke test를
정리합니다. 기본 설치 순서는 [README](../README.md)를 따릅니다.

## Runtime Contract

Local API는 `127.0.0.1:8765`만 사용하고 한 개의 정확한
`chrome-extension://<32-character-id>` origin만 허용합니다. Extension permission도 이 주소로
고정되므로 host나 port를 바꾸지 마세요. Environment file은 명시적으로 전달합니다.

Side Panel의 **네이버 접근 허용**은 `blog.naver.com`과 `m.blog.naver.com`에만 선택적으로 적용됩니다.
허용하면 navigation 뒤에도 현재 글 읽기와 댓글 입력 보조를 계속 사용할 수 있습니다. 거부해도
toolbar action으로 연 현재 탭에서는 `activeTab` 권한으로 사용할 수 있습니다.

Side Panel은 **오늘의 작업**, **댓글 작성**, **최근 작업**, **설정**으로 나뉩니다. 처음에는
로컬 서비스 상태와 대기열 수를 보여 주는 오늘의 작업만 열립니다. 대기열의
**이 글 처리하기** 또는 **새 탭에서 처리**를 누르면 댓글 작성으로 전환되고, 완료 뒤 다음 글이나
오늘의 작업으로 이동할 수 있습니다. 탐색·알림·접근 권한·자동 실행 동의는 설정에서 관리합니다.

```bash
uv run --frozen --env-file .env.local naver-blog-api
```

WSL DrvFs가 mode `0600`을 지원하지 않으면 `/mnt/e` repository 안에 credential file을 만들지
말고 `${XDG_CONFIG_HOME:-$HOME/.config}/naver-blog-assistant/env`를 사용합니다. Custom env file은
parent mode `0700`, file mode `0600`이어야 합니다.

## Data Retention and Cleanup

SQLite `data/naver_blog_assistant.db`에는 source URL, title, bounded excerpt, summary, topics,
candidate, edited comment, review state와 idempotency/failure metadata가 명시적 cleanup 전까지
남습니다. Full article body, OpenAI key, cookie와 provider body는 저장하지 않습니다.

글 탐색 대기열의 RSS·검색 후보, 일일 요약, SMTP 설정과 별도 보관 정책은
[글 탐색 대기열](discovery.md)을 참고하세요.

Side Panel의 **최근 작업**은 SQLite에서 최신 20개를 읽으며 browser storage에 history text를
복제하지 않습니다. 개별 **기록 삭제**는 선택한 recommendation, candidates와 연결된 completed
idempotency snapshot을 한 transaction에서 제거합니다. 전체 database cleanup은 아래 script를
사용합니다.

Extension의 trusted `chrome.storage.local`에는 retry용 digest, opaque id, state와 timestamp를
최대 20개 저장하고, 별도 versioned record에는 사용자가 기본값으로 저장한 관계, 말투, 댓글
길이와 분위기 enum, 최대 50자의 마무리 문구를 저장합니다. 신규 이웃 후보에 사용할
최대 500자의 기본 서로이웃 신청 메시지도 별도 versioned record로 저장합니다. 두 문구는
generation 요청이나 OpenAI에 전송되지 않고 local 검토·실행 단계에서만 사용됩니다. 본문, URL과 생성·편집된
댓글은 extension storage에 저장하지 않습니다. 사용자 승인형 자동 실행 동의도 별도 versioned
record에 활성 여부와 동의 시각만 저장합니다. 승인할 글, URL, 댓글, 이번 실행에서 수정한 신청
메시지와 one-time
승인 token은 Side Panel memory에만 있으며 navigation, 동의 철회 또는 panel 종료 시 폐기됩니다.
반면 SQLite에 보관된 완료 댓글은 개인화가 켜진
생성에서 최대 5개까지 OpenAI 스타일 예시로 전송될 수 있습니다. **최근 작업**에서 댓글별로
포함·제외할 수 있고, **스타일 예시 정리**는 모든 완료 댓글을 제외하지만 기록은 보존합니다.
Completed, released, dismissed entry는 60분 후 만료되고 다음 registry access에서 제거됩니다.
Active, reviewing, terminal-failure와 indeterminate entry는 duplicate provider call을 막기 위해
자동 만료되지 않습니다. Retained entry 20개가 남아 있거나 registry가 invalid이면 Side Panel이
확인 dialog와 함께 cleanup action을 제공합니다. Cleanup은 retry 복구 정보를 잃게 하므로
pending 결과를 확인한 뒤 실행하세요.

SQLite를 지우려면 API를 먼저 종료하고 dry run 결과를 확인한 뒤 같은 explicit env로 승인합니다.
명령은 configured repo-local database와 `-wal`, `-shm` file 외에는 삭제하지 않습니다.

```bash
uv run --frozen --env-file .env.local python -m scripts.clear_local_data
uv run --frozen --env-file .env.local python -m scripts.clear_local_data --confirm
```

Extension을 Chrome에서 제거하면 해당 extension의 local registry도 제거됩니다. 재설치 후 ID가
달라졌다면 env origin을 갱신하고 API를 재시작하세요.

## Troubleshooting

- **Setup check가 extension origin을 거부함:** `chrome://extensions`의 현재 unpacked ID를 공백이나
  trailing slash 없이 입력합니다. ID가 바뀌면 API를 재시작합니다.
- **API unavailable 또는 CORS error:** 다른 process가 port `8765`를 사용하지 않는지 확인하고
  `python -m scripts.check_local_setup --require-api`를 같은 `--env-file`로 실행합니다.
- **연결 표시는 정상이지만 최근 작업이 비어 있음:** 기록은 현재 configured `DATABASE_URL`에만
  저장됩니다. 다른 env file로 API를 시작했는지 확인하고 **최근 작업 > 새로고침**을 누릅니다.
- **DrvFs permission error:** XDG fallback path로 새 file을 만드세요. 기존 credential file을
  복사하거나 permission check를 우회하지 마세요.
- **본문을 읽지 못함:** 현재 URL이 `https://blog.naver.com` 또는 `https://m.blog.naver.com`인지
  확인하고 Side Panel의 **네이버 접근 허용**을 선택합니다. Image-only 또는 너무 짧은 글은 지원하지
  않습니다.
- **대기열 글을 연 뒤 preview가 갱신되지 않음:** **댓글 작성**을 열고 페이지가 완료될 때까지
  기다린 뒤 다시 시도합니다. **새 탭에서 처리**도 같은 흐름으로 동작하며, 네이버 접근 권한이
  없으면 **설정 > 네이버 페이지 접근 허용**에서 한 번 허용합니다.
- **자동 탐색 결과가 비어 있음:** 내 블로그 ID와 저장한 검색어를 확인한 뒤 **지금 동기화**를 누릅니다.
  신규 이웃 검색은 `NAVER_SEARCH_CLIENT_ID`와 `NAVER_SEARCH_CLIENT_SECRET`가 모두 필요합니다.
  공개 BuddyList·RSS·공식 검색 API 결과가 비어 있거나 접근할 수 없으면 기존 대기열은 삭제하지 않고
  마지막 동기화 상태에 이유를 표시합니다.
- **Extension 변경이 보이지 않음:** `npm --prefix extension run build` 후 extension card의 Reload를
  누릅니다. Reload 후 ID와 env origin이 여전히 일치하는지 확인합니다.
- **Generation timeout/indeterminate:** 동일 작업의 결과가 불명확할 수 있으므로 새 key를 자동으로
  만들지 않습니다. Side Panel의 복구 안내를 따르고 replacement 확인은 duplicate generation
  가능성을 이해한 경우에만 승인합니다.
- **자동 실행 동의가 없어 진행되지 않음:** **설정 > 사용자 승인형 자동 실행**으로 자동 이동합니다.
  범위와 약관을 확인해 동의하거나, 댓글 작성으로 돌아가 복사·수동 입력을 사용합니다.
- **댓글 입력 실패:** 입력 보조는 열린 입력란을 먼저 찾고, 없을 때만 표준 댓글쓰기 버튼 하나를
  누릅니다. 접힌 댓글 영역이면 댓글 목록을 먼저 펼친 뒤 최대 2초간 기다립니다. 실패 뒤 **다시 입력**은 같은 승인 댓글로만 탐색을 한 번 반복하며
  새 추천을 만들지 않습니다. 입력란이 여러 개이거나 기존 text가 있으면 안전을 위해 덮어쓰지
  않으므로 승인된 댓글을 복사해 직접 붙여넣습니다. 로그인·댓글 허용 상태도 확인하세요.
- **공감이 `not_found` 또는 `ambiguous`로 중단됨:** extension을 Reload한 뒤 글을 새로고침하고 다시
  실행합니다. 현재 게시글의 `#area_sympathy… > .my_reaction` 표준 하트 control만 선택하고, 숨은
  중복·다른 반응 control은 제외합니다. 하트가 반응 레이어를 여는 글에서는 기본 `like` 항목을 한 번
  더 선택한 뒤 상태 변화를 확인합니다. 그래도 실패하지만 공감·댓글을 직접 완료했다면 **직접 처리한
  단계 기록**에서 실제 완료한 단계만 기록해 오늘의 작업을 정리하세요. `결과 확인 필요(unconfirmed)`
  상태는 직접 완료로 바꾸지 않습니다.
- **서로이웃 신청이 중단됨:** 이웃추가 버튼을 눌렀다는 것만으로 신청 성공으로 기록하지 않습니다.
  네이버 popup의 **서로이웃** 선택, 두 번의 **다음**, 완료 문구와 **닫기**를 모두 확인합니다. popup이
  여러 개이거나 기본 이웃만 가능한 경우에는 추측해서 신청하지 않습니다.
- **저장한 신규 이웃 검색어를 지우고 싶음:** **설정 > 신규 이웃 검색어**의 삭제 버튼을 사용합니다.
  삭제해도 기존에 수집된 후보 글은 유지됩니다.
- **Clipboard 실패:** 편집 영역에 선택된 text를 OS copy command로 직접 복사합니다. 자동 게시로
  전환되지 않습니다.

Setup tool은 credential value를 출력하지 않습니다. 문제 보고에는 secret, 원문, source URL,
browser profile 대신 redacted status와 synthetic reproduction만 첨부하세요.

## Opt-in Manual Smoke Tests

Live OpenAI smoke는 실제 비용과 외부 전송이 발생합니다. Private env에 key를 넣고 다음 명령을
명시적으로 실행합니다. `--no-cov`는 세 가지 길이·분위기 조합의 opt-in test를 coverage gate와
분리합니다.

```bash
RUN_LIVE_OPENAI=1 uv run --frozen --env-file .env.local \
  pytest --no-cov -m live_openai tests/live
```

Manual Naver/OpenAI smoke는 본인이 공개 전송과 실제 교류를 허용한 테스트 글에서만 수행합니다.
Preview 확인, generation, 후보 선택, 편집, 입력 보조와 copy를 먼저 검증합니다. 실제 공감·댓글
등록·서로이웃 신청 검증이 필요하면 versioned 동의의 범위를 확인하고, 최종 확인 화면의 글·댓글·
신청 메시지를 다시 확인한 뒤 **이 한 건 실행**으로 승인한 한 건만 수행합니다. 동의하지 않은
환경에서는 외부 등록 전에 중단합니다.
Screenshot이나 terminal capture에는 글 본문, account identifier, source URL, API key를 남기지
않습니다.

## System E2E Scope and Limitation

CI의 `System E2E` job은 wheel을 temporary venv에 설치하고 그 absolute
`naver-blog-api` console script를 `SYSTEM_E2E_API_EXECUTABLE`로 전달합니다. Playwright bundled
Chromium, temporary browser profile, temporary SQLite, fake generator와 synthetic Naver fixture만
사용하며 worker 1개, retry 0회로 실행합니다. 실제 secret이나 E2E artifact는 업로드하지 않습니다.

Headless Chromium은 native Side Panel surface를 안정적으로 노출하지 않습니다. Test staging은
production manifest와 background를 그대로 load하고 CDP toolbar action으로 `activeTab` grant와
`sidePanel.open({tabId})` 호출을 실행합니다. 이후 원본 production `sidepanel.html/js`를 browser
page로 열어 `ChromeTabCaptureGateway`, DOM extraction, API client와 storage workflow를
검증합니다. 따라서 native Side Panel이 실제 browser chrome에 표시되는 모습, live Naver markup,
real OpenAI response는 이 automated test의 범위가 아니며 위 manual smoke로만 확인합니다.
