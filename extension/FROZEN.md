# FROZEN — Chrome extension v0.5.6

이 디렉터리는 **동결(FROZEN)** 상태입니다. v0.5.6에서 기능 개발을 멈췄고, 이후 모든 작업은
로컬 웹앱(`client/`)과 FastAPI 서비스(`src/naver_blog_assistant/`)에서 이어집니다.

## 무엇이 동결됐는가

- 새 기능을 추가하지 않습니다.
- DOM 추출·공감·댓글·서로이웃 로직은 `client/src/page/`로 **복사해 이식**했습니다. 공유하지
  않았습니다. 웹앱을 고쳐도 extension이 회귀하지 않는 편이, 두 곳에 같은 논리가 있는 비용보다
  낫다고 판단했습니다.
- `scripts/check_extension_boundary.py`가 `client/`·`src/`·`tests/`·`scripts/`에서 이 디렉터리를
  import하지 않는지 CI에서 검사합니다. 이 경계가 유지되는 동안 웹앱은 `git subtree split`으로
  분리할 수 있습니다.

## 여전히 유효한 것

- 이미 설치한 v0.5.6은 그대로 동작합니다. `npm --prefix extension run check`도 계속 통과합니다.
- 보안 결함이나 Chrome의 파괴적 변경에는 대응합니다. 그 외 변경은 받지 않습니다.

## 웹앱으로 옮겨간 기능

| extension에서 하던 일 | 지금 위치 |
| --- | --- |
| 글 본문 추출 | `client/src/page/article.ts` |
| 공감 대상 판별 | `client/src/page/like.ts` |
| 댓글 입력 | `client/src/page/comment.ts` |
| 서로이웃 신청 | `client/src/page/mutual-neighbor.ts` |
| 댓글 후보 검토 UI | `client/src/app/views/comment.ts` |
| 설정 보관 | SQLite `app_settings` table |

새 기능은 [webapp automation delivery plan](../docs/webapp-automation-delivery-plan.md)을
따릅니다.
