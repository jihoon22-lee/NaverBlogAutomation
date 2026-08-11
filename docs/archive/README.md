# 보관 문서 안내

`docs/archive/`는 완료된 계획, 당시의 검증 결과, 인계 기록을 보존하는 공간입니다.
보관 문서는 현재 제품 범위나 우선순위를 정하는 backlog가 아니며, 문서에 기록된 test count·
commit·run 정보는 작성 당시의 역사적 결과로 취급합니다.
2026-08-11에 제거된 `extension/` 경로와 관련 검증 기록도 당시 snapshot을 설명하는 표기로 남아
있으며, 원본 코드는 Git history에서 확인합니다.

현재 UX 현대화의 closure 기록은
[`webapp-experience-redesign-plan.md`](webapp-experience-redesign-plan.md)입니다. 이 문서는
PR #96–#105와 최신 검증 기준을 별도 snapshot으로 덧붙여 보존합니다.

수정이 필요할 때는 기존 절과 수치를 소급해서 고치지 말고, 이유·기준 commit·검증 명령을
명시한 새 closure 또는 handoff 절을 문서 끝에 추가합니다. 새 기능의 범위와 우선순위는
archive 문서가 아니라 현재 issue/PR 및 활성 설계 문서를 기준으로 결정합니다.

당시 표현과 수치는 원문을 보존합니다. 다만 파일 이동으로 깨진 문서 탐색 링크는 의미를 바꾸지 않는
범위에서 새 위치로 고쳐, 역사 기록도 계속 읽을 수 있게 유지합니다.
