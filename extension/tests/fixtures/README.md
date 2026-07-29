# 실제 Naver DOM 기반 fixture

이 디렉터리의 `naver-*` fixture는 실제 Naver 화면에서 확인한 **구조와 selector만** 남긴
정규화본입니다. 계정 ID, 글 URL·제목·본문, 댓글 내용, cookie, token, 브라우저 profile은 절대
넣지 않습니다.

| 화면 단계 | fixture | 반드시 검증할 동작 |
| --- | --- | --- |
| 공감 | `naver-live-controls.html` | 대표 공감 하트의 미공감/공감 상태 판별과 한 번의 click |
| 댓글 입력·등록 | `naver-comment-publish-live.html` | `.u_cbox_write_wrap` 범위에서 입력란과 sibling 등록 버튼을 연결하고, 0×0 captcha placeholder를 실제 captcha로 오판하지 않음 |
| 이웃 추가 진입 | `naver-mutual-neighbor-entry.html` | `._buddy_popup_btn`을 통한 popup 열기 |
| 이웃/서로이웃 선택 | `naver-mutual-neighbor-wizard.html` | `#each_buddy_add` 선택 후 첫 `다음` |
| 그룹·신청 메시지 | `naver-mutual-neighbor-popup-application.html` | 선택된 `._selectGroup[groupid]`, `#message`, `._addBothBuddy` |
| 신청 완료·닫기 | `naver-mutual-neighbor-popup-complete.html` | 완료 문구 확인 후 `a.button_close[role="button"]`의 `window.close()` 실행 |

실제 완료 화면에서 공감은 대표 하트를 한 번 눌러 face layer를 연 다음, layer 안의
`a.u_likeit_list_button._button[data-type="like"]`를 눌러 확정됩니다. 따라서 fixture와 테스트는
두 click을 모두 보존합니다.

## 갱신 규칙

- 실제 화면을 CDP로 확인했을 때 selector나 단계가 달라지면, 먼저 이 표의 해당 fixture와 그 fixture를
  읽는 단위 테스트를 함께 갱신한다.
- 원본 HTML 전체를 저장하지 않는다. 동작에 필요한 element, attribute, 부모-자식 관계만 남긴다.
- 실제 외부 동작이 필요한 검증은 사용자의 명시적 승인과 별도 테스트 대상을 받은 경우에만 한다. 그 결과는
  PR 설명과 이 문서의 검증 항목에 요약하되, 대상 식별 정보는 기록하지 않는다.
