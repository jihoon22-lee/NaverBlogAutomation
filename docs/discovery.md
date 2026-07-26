# 글 탐색 대기열

글 탐색 대기열은 사용자가 직접 확인할 이웃 새 글과 신규 이웃 후보를 Side Panel에 모아 주는
local-only 기능입니다. 댓글 등록과 좋아요를 자동화하거나 네이버에 로그인·쿠키 사용·무인 페이지
순회를 하지 않습니다.

## 시작 조건

- v0.4.0 이상의 extension과 local API를 실행합니다.
- Side Panel을 열 때마다 현재 tab의 `activeTab` 권한이 필요하므로, navigation 뒤에는 toolbar action을
  다시 누릅니다.
- 이웃 RSS 갱신과 일일 요약은 local API process가 실행 중일 때만 동작합니다.

## 이웃 새 글

1. Side Panel에서 **열린 이웃 목록 가져오기**를 누르거나 블로그 ID·URL을 직접 등록합니다.
2. **이웃 새 글 갱신**을 누르면 등록·활성화된 이웃의 공개 RSS를 읽어 최대 50개 metadata를 대기열에
   넣습니다.
3. **이 글 열기**로 원문을 직접 확인하거나 **건너뛰기**로 대기열에서 제외합니다.

RSS가 비공개이거나 요청에 실패하면 해당 이웃의 RSS 상태가 `unavailable`로 표시됩니다. 새 글을
즉시 확인하려면 **이웃 새 글 갱신**을 사용하세요.

## 신규 이웃 검색

1. 검색어, 제외어, 최신성 기간을 저장합니다.
2. 네이버 검색 결과를 사용자가 직접 연 뒤, 저장된 검색어의 **현재 검색 결과 가져오기**를 누릅니다.
3. 후보를 검토하고 **이 글 열기** 또는 **건너뛰기**를 선택합니다.

제외어는 후보의 제목과 페이지에 표시된 작성자명에 적용됩니다. 검색 결과에서 Gregorian 게시일을
읽을 수 있는 후보는 최신성 기간을 벗어나면 가져오지 않습니다. 게시일이 표시되지 않은 후보는
자동으로 오래된 글이라고 단정하지 않고 사용자가 직접 검토할 수 있도록 대기열에 남습니다.

## Badge·Chrome 알림·하루 요약

extension은 한 시간마다 이웃 새 글 대기열 수를 확인해 toolbar badge를 갱신하고, 수가 늘면 Chrome
알림을 표시합니다. Side Panel의 **하루 요약 알림**에서 시간대와 시각을 정하며 기본값은
`Asia/Seoul` 오전 9시입니다.

이메일은 선택 기능입니다. 이메일을 켜지 않아도 대기열, badge와 Chrome 알림은 사용할 수 있습니다.

## SMTP 이메일 요약 (선택)

private env file에 아래 값을 설정하고 API를 재시작한 뒤, Side Panel에서 **SMTP 이메일 요약도 받기**를
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
