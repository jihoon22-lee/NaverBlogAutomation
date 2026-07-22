# Local Operations and Release Validation

이 문서는 fresh setup 이후의 data lifetime, 안전한 cleanup, troubleshooting과 opt-in smoke test를
정리합니다. 기본 설치 순서는 [README](../README.md)를 따릅니다.

## Runtime Contract

Local API는 `127.0.0.1:8765`만 사용하고 한 개의 정확한
`chrome-extension://<32-character-id>` origin만 허용합니다. Extension permission도 이 주소로
고정되므로 host나 port를 바꾸지 마세요. Environment file은 명시적으로 전달합니다.

Toolbar action은 활성화된 tab의 `activeTab` 권한을 얻고 Side Panel을 엽니다. Chrome 120에서는
두 번째 click으로 panel을 닫는 toggle을 제공하지 않으며, 닫기는 Chrome Side Panel UI에서
직접 수행합니다.

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

Extension의 trusted `chrome.storage.local`에는 retry용 digest, opaque id, state와 timestamp를
최대 20개 저장하고, 별도 versioned record에는 댓글 길이(`short`, `medium`, `long`)와 분위기
(`calm`, `warm`, `lively`)만 저장합니다. 본문, URL, 관계와 말투는 저장하지 않습니다.
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
- **DrvFs permission error:** XDG fallback path로 새 file을 만드세요. 기존 credential file을
  복사하거나 permission check를 우회하지 마세요.
- **본문을 읽지 못함:** 현재 URL이 `https://blog.naver.com` 또는 `https://m.blog.naver.com`인지
  확인합니다. Navigation 후에는 toolbar action을 다시 누릅니다. Image-only 또는 너무 짧은 글은
  지원하지 않습니다.
- **Extension 변경이 보이지 않음:** `npm --prefix extension run build` 후 extension card의 Reload를
  누릅니다. Reload 후 ID와 env origin이 여전히 일치하는지 확인합니다.
- **Generation timeout/indeterminate:** 동일 작업의 결과가 불명확할 수 있으므로 새 key를 자동으로
  만들지 않습니다. Side Panel의 복구 안내를 따르고 replacement 확인은 duplicate generation
  가능성을 이해한 경우에만 승인합니다.
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

Manual Naver/OpenAI smoke는 본인이 공개 전송을 허용한 글에서만 수행합니다. Preview 확인,
generation, 후보 선택, 편집, 승인, copy까지 검증하되 댓글 입력과 등록은 직접 수행합니다.
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
