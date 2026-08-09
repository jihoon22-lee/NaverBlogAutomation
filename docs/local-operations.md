# Local Operations and Release Validation

이 문서는 fresh setup 이후의 data lifetime, 안전한 cleanup, troubleshooting과 opt-in smoke test를
정리합니다. 기본 설치 순서는 [README](../README.md)를 따릅니다.

## Runtime Contract

기본 local web app은 `127.0.0.1:8765`에서만 실행되며 `/app/`과 API는 같은 origin을 사용합니다.
따라서 extension ID나 별도 CORS 설정이 필요하지 않습니다. 태블릿을 쓸 때만 PC의 **관리 > 설정 >
연결 및 앱**에서 access mode를 LAN으로 저장하고, **저장한 설정 적용**으로 supervised restart를
승인합니다. service가 `WEBAPP_ACCESS_MODE=lan`과 일치하는 `API_HOST=0.0.0.0`을 private env file에
함께 기록하며, port는 `8765`으로 고정합니다. 이 경우에도 service는 발견한 private IPv4 address와
loopback Host만 받으며, 태블릿은 PC에서 만든 일회용 code로 pair해야 합니다.
공용 Wi-Fi, port forwarding, public hosting은 지원하지 않습니다.

웹앱의 **홈**, **작업함**, **글쓰기**, **관리**는 같은 PC-owned automation browser를 사용합니다.
네이버 로그인은 automation browser 창에서 직접 처리하며, 웹앱·태블릿에 계정 비밀번호나 cookie를
입력하지 않습니다. legacy extension의 별도 실행 조건은 [Extension Legacy](extension-legacy.md)를 따르세요.

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

Database에 포함된 주요 table 목록:

| table | 내용 |
| --- | --- |
| `recommendations` | 댓글 추천 기록 |
| `comment_candidates` | 댓글 후보 |
| `idempotency_records` | 생성 요청 멱등성 추적 |
| `neighbor_blogs` | 저장된 이웃 블로그 |
| `saved_searches` | 저장된 검색어 |
| `discovered_posts` | RSS·검색으로 수집한 대기열 글 |
| `engagement_runs` / `engagement_steps` | 글별 공감·댓글·서로이웃 실행 기록 |
| `app_settings` | 사용자 설정(동의, 안전 정책, LLM 예산, 스케줄, 글쓰기 프로필 등) |
| `llm_generation_attempts` | 다중 provider 호출 시도 기록 |
| `blog_categories` / `blog_reference_posts` | 내 블로그 카테고리·참조 글 캐시 |
| `post_drafts` / `post_draft_revisions` / `post_draft_images` / `post_draft_tags` | 글쓰기 초안·리비전·이미지·태그 |
| `publish_runs` / `publish_run_steps` | 임시저장 실행 기록 |
| `automation_sessions` | 세션 배치(승인·진행·완료·중단 내역) |
| `automation_session_posts` | 각 세션 승인 시 고정한 대상 글과 실행 순서 |
| `automation_activity_ledger` | 일별 외부 action 횟수(safety governor 일일 cap 산정) |
| `digest_settings` / `digest_runs` | 이메일 요약 설정·발송 기록 |
| `automatic_discovery_settings` / `automatic_discovery_runs` | 자동 탐색 설정·실행 기록 |
| `remote_device_sessions` | paired 태블릿의 token·CSRF hash, 만료·해제 상태 |

현재 migration head는 `20260808_0022_runtime_setting_cleanup`입니다.

### 초안 이미지 보관 (앱 소유 media directory)

글쓰기 워크플로에서 업로드한 이미지는 filesystem에 별도 보관됩니다.

- **경로:** 열려 있는 SQLite database 디렉터리 아래 `media/`를 앱이 결정합니다. 웹앱과 runtime API는
  media path 입력을 받지 않습니다.
- **구조:** `<media_root>/drafts/<draft_id>/<uuid>.<ext>` 형태로 초안별 디렉터리에 저장됩니다.
- **내용:** JPEG, PNG, WebP, GIF 이미지만 허용하며 파일당 10 MiB 이하입니다.
- **삭제:** 초안을 삭제하면 해당 draft의 모든 이미지 파일과 디렉터리가 제거됩니다. 전체 데이터
  초기화는 아래의 PC 웹앱 **데이터 관리** 절차를 사용합니다. 파일을 직접 삭제하면 database와
  media의 참조가 어긋날 수 있으므로 지원하지 않습니다.

글 탐색 대기열의 RSS·검색 후보, 일일 요약, SMTP 설정과 별도 보관 정책은
[글 탐색 대기열](discovery.md)을 참고하세요.

웹앱은 browser storage에 작업 이력이나 provider credential을 복제하지 않습니다. recommendation과
멱등성 상태는 SQLite에 보관하며, 완료 댓글은 개인화가 켜진 이후 생성에서 최대 5개까지 provider의
style example으로 전송될 수 있습니다. paired 기기의 session·CSRF 원문은 database에 저장하지 않고
hash만 보관합니다. PC의 **태블릿 연결**에서 기기를 해제하면 해당 세션은 즉시 쓸 수 없습니다.

개별 기록 삭제는 선택한 recommendation, candidates와 연결된 completed idempotency snapshot을 한
transaction에서 제거합니다. 전체 database cleanup은 아래 script를 사용합니다.

SQLite를 지우려면 API를 먼저 종료하고 dry run 결과를 확인한 뒤 같은 explicit env로 승인합니다.
명령은 configured repo-local database와 `-wal`, `-shm` file 외에는 삭제하지 않습니다.

```bash
uv run --frozen --env-file .env.local python -m scripts.clear_local_data
uv run --frozen --env-file .env.local python -m scripts.clear_local_data --confirm
```

## Webapp Migration, Export, and Reset

서비스는 시작할 때 `.env.local`에 지정된 SQLite database를 migration head까지 자동 upgrade합니다.
따라서 운영 database에 `uv run alembic ...`를 직접 실행하지 마세요. `alembic.ini`의 기본 URL은
실제 private runtime 경로와 다를 수 있습니다.

이번 working-copy migration은 `20260808_0021_draft_working_copy`입니다. 기존 활성 revision의
title·block·summary를 working copy로 한 번 backfill하고 `content_version=1`로 시작합니다. SQLite
table 재작성으로 revision을 잃지 않도록 additive column migration을 사용합니다. 이어지는
`20260808_0022_runtime_setting_cleanup`은 더 이상 쓰지 않는 `browser_profile`과 `llm_providers`
SQLite 설정만 제거합니다.

업데이트 전에는 PC의 **관리 > 설정 > 연결 및 앱 > 데이터 관리**에서 export를 내려받아 보관하세요.
export는 browser, batch, 네이버 임시저장 작업이 모두 idle일 때만 가능하며 다음만 ZIP에 넣습니다.

- SQLite DB와 존재하는 `-wal`/`-shm` 파일
- 초안 media 파일

private dotenv, API key, SMTP credential, browser profile은 export에 포함되지 않습니다. 다운로드한 ZIP은
별도 안전한 저장소에 보관합니다. 현재 구현에는 export를 자동으로 보관하는 server directory나
보존 기간 정책이 없습니다.

**안전한 초기화**는 같은 PC 화면에서 대상 DB/WAL/SHM 및 media file 수를 확인하고 `RESET LOCAL DATA`를
입력할 때만 사용할 수 있습니다. launcher(`scripts/start_webapp.py`)로 실행 중이고 작업이 idle이면
데이터를 삭제하지 않고 app data root 아래 `.nba-data-backups/<timestamp>-<id>/`로 이동한 뒤 restart를
요청합니다. 백업 위치는 응답 화면에 표시됩니다. 이 backup은 자동 삭제하지 않으므로, 복구가 필요한
기간에는 사용자가 보관하고 불필요해진 뒤에만 OS의 보안 정책에 따라 제거합니다.

복구는 자동 UI 기능이 아직 없습니다. service를 완전히 종료한 뒤, 초기화 응답의 backup 안에 있는
`database.sqlite3`(및 함께 존재하면 `database.sqlite3-wal`, `database.sqlite3-shm`)와 `media/`를
원래 data root로 되돌리는 수동 운영 절차입니다. 현재 새 data가 생겼다면 먼저 별도로 export하고,
대상 경로·권한·symlink 여부를 확인한 뒤에만 수행하세요. runtime dotenv와 browser login은 이 backup에
없으므로 별도로 다시 설정하거나 로그인해야 합니다.

코드 수준 downgrade는 운영 복구 수단이 아닙니다. `0020 → 0021 → 0020 → 0021` fixture test가 immutable
revision 보존과 backfill을 검증하지만, 운영 문제는 먼저 export/backup을 확보한 뒤 지원되는 build로
복원하는 방식으로 처리합니다.

## Test Timeout and Hang Protocol

테스트는 종료 summary와 exit code가 모두 있을 때만 통과로 기록합니다. 각 실행에는 timeout을 두고,
60초 동안 새 출력이 없으면 process 상태를 확인한 뒤 종료합니다. 이 경우에는 부분 출력이 모두
성공처럼 보여도 `중단됨`으로 기록하며, hang 원인과 PID·마지막 출력 지점을 남깁니다. 전체 test/coverage
gate는 이러한 중단 기록을 통과 증거로 대체할 수 없습니다.

## Troubleshooting

### 기본 연결·설정

- **API unavailable 또는 CORS error:** 다른 process가 port `8765`를 사용하지 않는지 확인하고
  `python -m scripts.check_local_setup --require-api`를 같은 `--env-file`로 실행합니다.
- **태블릿 연결 code를 만들 수 없음:** PC의 **관리 > 설정 > 연결 및 앱**에서 access mode를
  **신뢰 Wi-Fi**로 저장하고 **저장한 설정 적용**을 누르세요. 태블릿과 PC가 같은 private Wi-Fi인지도
  확인하세요. launcher 없이 수동 API로 실행 중이면 그 화면의 재시작 안내에 따라 직접 다시 시작합니다.
- **태블릿에서 계속 pairing 화면이 보임:** PC 웹앱에서 새 5분 code를 만든 뒤 다시 입력합니다. code는
  한 번 성공하면 즉시 폐기되며, 기기를 해제한 경우에도 새 code가 필요합니다.
- **연결 표시는 정상이지만 이력이 비어 있음:** 기록은 현재 실행 중인 앱 data root의 SQLite에만
  저장됩니다. 다른 private env file로 API를 시작했는지 확인하고 **관리 > 이력 > 새로고침**을 누릅니다.
- **DrvFs permission error:** XDG fallback path로 새 file을 만드세요. 기존 credential file을
  복사하거나 permission check를 우회하지 마세요.

### 본문·댓글 생성

- **본문을 읽지 못함:** automation browser가 실행 중이고 `https://blog.naver.com` 또는
  `https://m.blog.naver.com`에 로그인되어 있는지 확인하세요. Image-only 또는 너무 짧은 글은 지원하지
  않습니다.
- **대기열 글을 연 뒤 preview가 갱신되지 않음:** automation browser가 원문을 열고 페이지 로딩을
  마칠 때까지 기다린 뒤 웹앱에서 다시 시도하세요. 로그인 화면이 열리면 PC automation browser에서
  먼저 로그인합니다.
- **Generation timeout/indeterminate:** 동일 작업의 결과가 불명확할 수 있으므로 새 key를 자동으로
  만들지 않습니다. 웹앱의 복구 안내를 따르고 replacement 확인은 duplicate generation
  가능성을 이해한 경우에만 승인합니다.

### 탐색·이웃

- **자동 탐색 결과가 비어 있음:** 내 블로그 ID와 저장한 검색어를 확인한 뒤 **지금 동기화**를 누릅니다.
  신규 이웃 검색은 `NAVER_SEARCH_CLIENT_ID`와 `NAVER_SEARCH_CLIENT_SECRET`가 모두 필요합니다.
  공개 BuddyList·RSS·공식 검색 API 결과가 비어 있거나 접근할 수 없으면 기존 대기열은 삭제하지 않고
  마지막 동기화 상태에 이유를 표시합니다. 여러 저장 검색어의 신규 후보 수는 합계이므로 50개를 넘을 수
  있으며, 이는 정상 동기화 결과입니다.
- **저장한 신규 이웃 검색어를 지우고 싶음:** **관리 > 설정 > 탐색 및 자동화 > 신규 이웃 검색어**의
  삭제 버튼을 사용합니다.
  삭제해도 기존에 수집된 후보 글은 유지됩니다.

### 공감·댓글·서로이웃 실행

- **자동 실행 동의가 없어 진행되지 않음:** **관리 > 설정 > 탐색 및 자동화 > 자동 실행과 안전**으로 자동 이동합니다.
  자동 실행 범위를 확인해 동의하거나, 댓글 작성으로 돌아가 댓글을 복사해 직접 붙여넣습니다.
- **수동 댓글 등록:** 후보를 선택해 다듬은 뒤 승인된 댓글을 복사하고 네이버 입력란에 직접 붙여넣습니다.
  HTTP 태블릿 연결에서는 코드/댓글이 선택되면 길게 눌러 직접 복사할 수 있습니다.
- **댓글 등록이 `not_found`로 중단됨:** 입력란과 `등록` 버튼이 각각 보이더라도 네이버는 둘을 형제
  영역으로 배치할 수 있습니다. automation browser를 새로고침해도 반복되면, 공감·댓글을 다시 실행하지
  말고 최근 작업의 code와 DOM 정보를
  공유해 주세요.
- **댓글은 등록됐지만 `captcha_required`로 표시됨:** 이미 등록된 댓글은 다시 실행하지 말고 PC
  automation browser에서 Captcha 여부를 직접 확인하세요.
- **공감이 `not_found` 또는 `ambiguous`로 중단됨:** automation browser에서 글을 새로고침한 뒤 다시
  실행합니다. 현재 게시글의 `#area_sympathy… > .my_reaction` 표준 하트 control만 선택하고, 숨은
  중복·다른 반응 control은 제외합니다. 하트가 반응 레이어를 여는 글에서는 기본 `like` 항목을 한 번
  더 선택한 뒤 상태 변화를 확인합니다. 그래도 실패하지만 공감·댓글을 직접 완료했다면 **직접 처리한
  단계 기록**에서 실제 완료한 단계만 기록하세요. 신규 이웃 후보라면 댓글만 수동 완료로 기록한 뒤
  **실행만 다시 시도**를 누르면, 성공·수동 완료 단계는 건너뛰고 남은
  서로이웃 신청만 이어서 실행합니다. `결과 확인 필요(unconfirmed)` 상태는 직접 완료로 바꾸지 않습니다.
- **서로이웃 신청이 중단됨:** 이웃추가 버튼을 눌렀다는 것만으로 신청 성공으로 기록하지 않습니다.
  네이버 popup의 **서로이웃** 선택(숨김 radio와 연결된 label 포함), 필요 시 첫 이웃 그룹 선택,
  신청 메시지 입력, 두 번의 **다음**, 완료 문구와 **닫기**를 모두 확인합니다. popup이 여러 개이거나
  기본 이웃만 가능한 경우에는 추측해서 신청하지 않습니다. popup이 원문 탭의 앞에 뜨지 않아도
  해당 `BuddyAdd` 탭을 찾아 같은 탭에서 두 단계를 이어가며, 이미 선택된 이웃 그룹은 바꾸지 않습니다.
  신청 완료 뒤에는 **닫기** text뿐 아니라 Naver의 close class·title·aria-label control도 눌러 popup을
  닫습니다.

### 세션 배치 (여러 글 처리)

- **서비스 재시작 뒤 `process_restarted`로 중단됨:** 이전 process가 남긴 pending/running batch는
  재시작 시 자동 재개하지 않습니다. 이미 어떤 네이버 동작이 끝났는지 확정할 수 없기 때문입니다.
  **여러 글 처리**에서 결과와 처리 건수를 확인한 뒤, 아직 필요한 글만 새 batch로 다시 선택·승인하세요.
- **선택한 글이 기대와 다름:** batch 화면에서 체크한 순서가 실행 순서로 고정됩니다. 시작 뒤 새로
  수집된 글은 추가되지 않습니다. 선택하지 않았다면 당시 source 대기열의 최대 N건이 고정됩니다.
- **시작 버튼이 비활성화됨:** 현재 시간, 연속 실패 수, 선택한 공감·댓글·서로이웃 단계의 오늘 잔여
  한도를 확인하세요. 선택하지 않은 단계의 상한 소진은 batch를 막지 않습니다.

- **배치가 `daily_cap_reached`로 중단됨:** 이 batch에 포함한 공감·댓글·서로이웃 단계 중 하나가
  safety_policy의 일일 상한에 도달했습니다. 해당 단계의 사용량은 다음 날 자동으로 초기화됩니다.
  다른 단계만 선택한 새 batch는 가능할 수 있습니다. 상한을 높이려면 **관리 > 설정 > 탐색 및 자동화 > 자동 실행과 안전**에서
  값을 변경하고 저장합니다.
- **배치가 `outside_allowed_hours`로 시작도 안 되거나 중간에 멈춤:** 현재 시각(Asia/Seoul)이
  safety_policy의 `allowed_hours` 목록에 포함되지 않습니다. 허용 시간대를 확인하고, 필요하면
  현재 시간을 목록에 추가한 뒤 저장합니다.
- **배치가 `consecutive_failures`로 중단됨:** 연속 실패 횟수가 safety_policy의
  `max_consecutive_failures` 설정에 도달했습니다. 직전 실패 원인(네이버 로그인 만료, 네트워크
  문제 등)을 해결한 뒤 새 배치를 시작하면 실패 카운터가 초기화됩니다.
- **배치가 `captcha_required`로 중단됨:** 네이버가 Captcha를 요구했습니다. 자동으로 우회하지
  않으며 브라우저에서 직접 Captcha를 풀거나 잠시 대기한 뒤 새 배치를 시작합니다.
- **배치가 `login_required`로 중단됨:** 네이버 로그인 세션이 만료되었습니다.
  automation browser의 Chrome 프로필에서 네이버에 다시 로그인한 뒤 새 배치를 시작합니다.
- **배치가 `browser_unavailable`로 중단됨:** automation browser를 시작하지 못했거나 연결이
  끊어졌습니다. 기본 bundled Chromium을 사용하려면 `AUTOMATION_BROWSER_CHANNEL`을 비워 두세요. WSL에서는
  Windows Chrome이 아니라 Linux/WSL 안의 browser만 사용할 수 있습니다.
- **배치가 `internal_error`로 중단됨:** 예상하지 못한 내부 오류입니다. API 로그에서 traceback을
  확인하고 문제를 보고해 주세요.
- **취소를 눌렀는데 즉시 멈추지 않음:** 취소는 현재 처리 중인 글이 완전히 끝난 뒤에 반영됩니다.
  한 글의 공감·댓글·서로이웃 단계를 중간에 끊으면 불완전한 상태가 남으므로, 안전하게 현재 글을
  마무리한 뒤 session 상태가 `cancelled`로 전환됩니다. 급하게 모든 작업을 즉시 멈추려면 API를
  종료하세요.

### 무인 스케줄

무인 스케줄이 실행되지 않을 때 아래 `reason`을 API 로그에서 확인합니다.

| reason | 원인 | 해결 |
| --- | --- | --- |
| `not_scheduled` | 예약 실행의 실행 방식이 `매일 예약 실행`이 아닙니다. | **관리 > 설정 > 탐색 및 자동화 > 고급 · 예약 실행과 AI 예산**의 **실행 방식**에서 `매일 예약 실행`을 선택합니다. (기술 key: `schedule_policy.mode=schedule`) |
| `not_due` | 설정한 시각이 아직 아닙니다(5분 이내 window). | 정상 동작입니다. 설정 시각까지 대기하세요. |
| `consent_missing` | 자동 실행에 동의하지 않았습니다. | **관리 > 설정 > 탐색 및 자동화 > 자동 실행과 안전**에서 동의합니다. (기술 key: `automation_consent`) |
| `safety_policy_missing` | 안전 정책을 한 번도 저장하지 않았습니다. | **관리 > 설정 > 탐색 및 자동화 > 자동 실행과 안전**의 **세부 안전 한도와 허용 시간**을 설정하고 **안전 설정 저장**을 누릅니다. (기술 key: `safety_policy`) |
| `already_ran_today` | 오늘 이미 스케줄 세션을 실행했습니다. | 정상 동작입니다. 하루에 한 번만 실행됩니다. |
| `session_active` | 다른 세션(수동 배치 포함)이 아직 진행 중입니다. | 진행 중인 세션이 끝나면 다음 분 체크에서 시작합니다. |
| `browser_unavailable` | automation browser를 시작하지 못했습니다. | Chrome 설치, 프로필 디렉터리, headless 설정을 확인합니다. |

화면에서 자동 실행 동의, 안전 설정 저장, **매일 예약 실행** 선택을 모두 완료해야 무인 실행이
활성화됩니다. 기술 API 기준으로는 `automation_consent`, `safety_policy`, `schedule_policy.mode`
조건이 모두 필요하며 하나라도 빠지면 동작하지 않습니다.

### AI 호출 예산 초과 (`llm_budget`)

- **`provider_cap_exceeded` 오류:** 한 번의 요청에 포함된 AI 서비스(provider) 수가
  `per_request_provider_cap` 설정을 초과했습니다. 동시에 호출할 AI 서비스 수를 줄이거나
  **관리 > 설정 > 탐색 및 자동화 > 고급 · 예약 실행과 AI 예산**에서 요청당 호출 상한을 낮추거나
  높입니다. (기술 key: `llm_budget.per_request_provider_cap`)
- **`daily_cap_exceeded` 오류:** 오늘 AI 서비스 호출 총 횟수가 `daily_call_cap`에 도달했습니다.
  내일까지 대기하거나 **관리 > 설정 > 탐색 및 자동화 > 고급 · 예약 실행과 AI 예산**에서 일일
  호출 상한을 조절합니다. (기술 key: `llm_budget.daily_call_cap`)

### 글쓰기 워크플로

- **임시저장은 됐는데 발행이 안 됨:** 정상 동작입니다. 글쓰기 워크플로는 네이버 에디터에
  임시저장까지만 수행하며, 발행은 사용자가 에디터에서 직접 확인하고 클릭합니다.
  자동 발행은 의도적으로 지원하지 않습니다.
- **편집 내용이 AI 도구나 태그에서 잠김:** 제목을 비워 두지 말고 빈 문단·목록 항목을 먼저
  채운 뒤 자동 저장이 끝났는지 확인합니다. 편집 후에는 **버전으로 남기기**를 눌러야 AI 다듬기와
  태그 생성을 이어갈 수 있습니다. 자동 저장 실패가 표시되면 **지금 저장**으로 다시 저장한 뒤
  같은 확인을 반복합니다.
- **다른 기기에서 최신 초안이 저장됨:** 기존 화면의 편집 내용을 임의로 덮어쓰지 않도록 최신
  working copy를 다시 불러오라는 안내가 표시됩니다. 최신 내용을 확인한 뒤 필요한 편집을 다시
  하고, 원하는 시점에 **버전으로 남기기**를 사용합니다.
- **화면을 이동한 뒤 이전 화면의 늦은 응답이 도착함:** 웹앱은 현재 경로와 현재 초안에 해당하는
  최신 응답만 화면에 반영하고, 이전 화면·이전 초안의 늦은 응답은 무시합니다. 새 화면에서 최신
  상태를 확인하고 필요하면 해당 화면의 **새로고침**을 사용하세요.

### 웹앱·기타

- **Clipboard 실패:** 코드나 편집 영역의 text를 선택해 OS copy command 또는 길게 눌러 직접
  복사합니다. 자동 게시로 전환되지 않습니다.
- **legacy extension 문제:** 별도 설치·reload 문제는 [Extension Legacy](extension-legacy.md)를
  참고하세요.

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

네이버 editor의 실제 DOM signature는 별도 테스트 계정과 이미 로그인된 전용 browser profile이
있을 때만 확인합니다. 아래 smoke는 합성 제목·본문을 네이버 임시저장까지 입력하고 `draft_saved`
결과를 검증한 뒤 멈춥니다. 발행은 하지 않지만 테스트 계정에 초안이 생기므로 실행 전에 대상과
정리 방법을 확인하세요. 본문·cookie·screenshot은 출력하지 않습니다.

```bash
RUN_LIVE_NAVER=1 \
NAVER_LIVE_BLOG_ID='your-test-blog-id' \
AUTOMATION_PROFILE_DIR='/path/to/signed-in-test-profile' \
uv run pytest --no-cov -m live_naver tests/live/test_naver_staging_smoke.py
```

`AUTOMATION_DRIVER`(기본 `patchright`), `AUTOMATION_BROWSER_CHANNEL`, `LIVE_NAVER_HEADLESS=1`을
필요할 때만 추가합니다. probe가 `editor_ambiguous`, `*_unconfirmed` 또는 unsupported code를
반환하면 네이버 markup이 바뀐 것이므로 지원 완료로 표시하지 말고 sanitized fixture와 adapter
검증을 먼저 갱신합니다.

Manual Naver/OpenAI smoke는 본인이 공개 전송과 실제 교류를 허용한 테스트 글에서만 수행합니다.
Preview 확인, generation, 후보 선택, 편집과 copy를 먼저 검증합니다. 실제 공감·댓글
등록·서로이웃 신청 검증이 필요하면 versioned 동의의 범위를 확인하고, 댓글 작성 화면에서 최종 댓글과
신청 메시지를 확인한 뒤 글별 실행 버튼으로 승인한 한 건만 수행합니다. 동의하지 않은
환경에서는 외부 등록 전에 중단합니다.
Screenshot이나 terminal capture에는 글 본문, account identifier, source URL, API key를 남기지
않습니다.

### 승인된 실제 DOM 점검(CDP)

WSL에서 Windows Chrome의 remote debugging port(`127.0.0.1:9222`)에 연결한 경우에는
`scripts/cdp-evaluate.ps1`로 **정확히 한 개의 열린 page**에서 DOM을 점검할 수 있습니다.
이 도구는 secret·cookie를 읽거나 출력하지 않으며, 지정한 JavaScript expression만 실행합니다.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File 'E:\projects\NaverBlogAutomation\scripts\cdp-evaluate.ps1' \
  -TargetUrl 'https://blog.naver.com/example/123' \
  -Expression 'JSON.stringify({ title: document.title })'
```

읽기 전용 expression을 기본으로 사용합니다. click·submit처럼 외부 상태를 바꾸는 expression은
사용자가 해당 대상과 동작을 명시적으로 승인한 경우에만 실행합니다. 실제 구조를 확인했다면 원본 HTML을
저장하지 말고 sanitized fixture와 연결 테스트를 함께 갱신합니다.

## System E2E Scope and Limitation

CI의 `System E2E` job은 wheel을 temporary venv에 설치하고 그 absolute
`naver-blog-api` console script를 `SYSTEM_E2E_API_EXECUTABLE`로 전달합니다. Playwright bundled
Chromium, temporary browser profile, temporary SQLite, fake generator와 synthetic Naver fixture만
사용하며 worker 1개, retry 0회로 실행합니다. 실제 secret이나 E2E artifact는 업로드하지 않습니다.

System E2E는 installed wheel의 `/app/`과 API를 같은 origin으로 열어 synthetic Naver fixture,
DOM extraction, API client와 automation workflow를 검증합니다. 실제 Naver markup, real OpenAI
response, private Wi-Fi의 실물 태블릿 연결은 위 manual smoke로만 확인합니다.
