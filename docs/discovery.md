# 글 탐색 대기열

글 탐색 대기열은 사용자가 직접 확인할 이웃 새 글과 신규 이웃 후보를 local web app에 모아 주는
local-only 기능입니다. 저장한 블로그 ID·검색어의 공개 metadata와 등록 이웃의 RSS를 매일 한 번
읽습니다. 대기열 수집 자체는 댓글·공감을 실행하지 않습니다. 사용자가 글 한 건의 댓글과 실행
내용을 검토한 뒤 글별 실행 버튼을 누른 경우에만 별도의 사용자 승인형 교류 흐름이 동작합니다.

## 시작 조건

- local web app과 PC-owned automation browser를 실행합니다.
- automation browser에서 네이버 로그인 상태를 직접 유지합니다. 웹앱과 태블릿은 로그인 credential을
  읽거나 저장하지 않습니다.
- 자동 탐색·이웃 RSS 갱신·일일 요약은 local API process가 실행 중일 때만 동작합니다.

## 이웃 새 글

1. 웹앱의 **설정 > 자동 탐색 설정**에서 내 블로그 ID를 저장하고 **매일 자동 탐색**을 켭니다.
2. **지금 동기화** 또는 예약 시각에 공개 이웃 목록을 확인하고, 등록·활성화된 이웃의 공개 RSS에서
   최대 50개 metadata를 대기열에 넣습니다.
3. **오늘의 작업**에서 이웃 새 글·신규 이웃 후보 개수와 현재 처리 중인 글을 확인합니다.
4. **이 글 처리하기**로 PC automation browser에서 원문을 확인합니다. 페이지 로딩이 완료되면
   웹앱의 댓글 작업 화면에서 본문 preview를 표시합니다.
5. **건너뛰기**로 대기열에서 제외합니다.

글을 연 뒤 댓글 후보를 선택·승인하면 **공감하고 승인 댓글 등록**을 사용할 수 있습니다. 마지막
확인 화면에서 글과 댓글, 두 단계를 다시 확인해야 실행되며 이미 공감한 글은 다시 누르지 않습니다.
완료 화면에서는 같은 출처의 **다음 대기 글 처리** 또는 **오늘의 작업으로**를 선택할 수 있습니다.

RSS가 비공개이거나 요청에 실패하면 해당 이웃의 RSS 상태가 `unavailable`로 표시됩니다. 새 글을
즉시 확인하려면 **지금 동기화**를 사용하세요.

## 신규 이웃 검색

1. private env file에 `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`를 함께 설정하고 API를
   재시작합니다. 값은 [Naver Developers의 검색 API](https://developers.naver.com/docs/serviceapi/search/blog/blog.md)에서 발급합니다.
2. **설정 > 신규 이웃 검색어**에서 검색어, 제외어, 최신성 기간을 저장합니다. 후보는 저장 검색어의
   공백 단위 모든 단어가 **제목**에 포함될 때만 표시합니다. 예를 들어 `코스트코 고기`는 두 단어가
   모두 제목에 있어야 합니다.
3. 다음 자동 탐색 또는 **지금 동기화**에서 공식 네이버 블로그 검색 API 결과를 읽고, 제목 일치·제외어·최신성 규칙을 차례로 적용합니다. 후보 목록에는 `검색어: ...` 출처가 함께 표시됩니다.
4. 검색어를 삭제해도 metadata를 즉시 삭제하지는 않지만, 연결이 사라진 기존 후보는 목록에서 숨깁니다.
5. **오늘의 작업 > 신규 이웃 찾기**에서 후보를 검토하고 **이 글 처리하기**,
   **새 탭에서 처리** 또는 **건너뛰기**를 선택합니다.

검색 후보에서는 **설정 > 서로이웃 신청 메시지**에 저장한 기본 문구를 이번 글에 맞게 확인한 뒤
**공감·댓글 등록 후 서로이웃 신청**을 실행할 수 있습니다. 공감, 댓글, 서로이웃 순서로 한 단계씩
진행하며 성공한 단계는 재시도에서 반복하지 않습니다. 완료 여부가 불명확한 댓글 또는 신청은
자동으로 다시 누르지 않으므로 최근 작업 결과를 확인한 뒤 수동으로 판단해야 합니다.

제외어와 최신성 기간은 API metadata를 기준으로 적용합니다. 같은 블로그는 가장 최신 후보 하나만
남기며, 내 블로그·저장 이웃·최근 30일 안에 완료한 후보는 제외합니다. API credential이 없거나 API
요청에 실패하면 검색을 우회하지 않고 필요한 설정 또는 오류를 보여 줍니다.

## SMTP 이메일 요약 (선택)

private env file에 아래 값을 설정하고 API를 재시작한 뒤, 웹앱에서 **SMTP 이메일 요약도 받기**를
켜세요. host, account, sender, recipient 값은 모두 함께 제공해야 하며 password는 app password 사용을
권장합니다.

```dotenv
DIGEST_SMTP_HOST=smtp.example.com
DIGEST_SMTP_PORT=587
DIGEST_SMTP_SECURITY=starttls
DIGEST_SMTP_USERNAME=your-account
DIGEST_SMTP_PASSWORD=your-app-password
DIGEST_EMAIL_FROM=from@example.com
DIGEST_EMAIL_TO=to@example.com
```

`DIGEST_SMTP_SECURITY`은 `starttls`(기본값) 또는 `ssl`입니다. `DIGEST_SMTP_PORT`를 생략하면
`587`을 사용합니다. 이메일에는 제목·게시 시각·원문 링크만 담기며 본문과 댓글은 포함하지 않습니다.

## 저장 정보와 보관 기간

대기열에는 이웃 블로그 URL·ID, 저장 검색어, 제목·URL·게시 시각·출처·상태만 SQLite에 저장됩니다.
본문, 쿠키, 로그인 정보는 수집하거나 저장하지 않습니다. 대기 항목은 30일 뒤 자동 정리됩니다.

전체 데이터 보관과 삭제 절차는 [Local Operations](local-operations.md#data-retention-and-cleanup)를
참고하세요.
