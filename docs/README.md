# 문서 허브

이 저장소의 문서는 독자와 변경 기준이 다릅니다. 사용자 가이드는 실행 방법을, 운영 문서는
데이터·복구·릴리스 절차를, 설계 문서는 현재 코드 계약을 설명합니다. 과거 계획은 `archive/`에
보관하며 현재 기능의 source of truth로 사용하지 않습니다.

## 사용자 가이드

| 문서 | 목적 | 주요 독자 |
| --- | --- | --- |
| [시작하기](getting-started.md) | local web app 설치, 환경 파일, 첫 댓글·글쓰기·태블릿 연결 흐름 | 사용자, 처음 설치하는 운영자 |
| [글 탐색 대기열](discovery.md) | RSS·검색 후보 수집 조건, 보관 기간, SMTP 요약 | queue를 설정하는 사용자 |

현재 웹앱의 visible primary navigation은 **홈 · 작업함 · 글쓰기 · 관리**입니다. 문서와 UI에서
`관리`라고 부르는 네 번째 탭은 내부 호환 key `more`와 `#more` route를 유지합니다.

## 현재 설계·개발 기준

| 문서 | 목적 | 주요 독자 |
| --- | --- | --- |
| [UX·접근성 기준](ux-design.md) | 앱 셸, 화면 IA, editor/settings progressive disclosure, responsive/a11y acceptance | 제품·디자인·frontend·QA |
| [Architecture](architecture.md) | runtime 구성, route/state 소유권, persistence, async lifecycle/stale-response 불변 조건 | 개발자, reviewer, 운영자 |
| [Testing](testing.md) | 위험 기반 테스트 범위, coverage gate, packaged E2E와 live test 경계 | 개발자, reviewer, QA |
| [API contract](api-contract.md) | endpoint semantics, error/status contract, client와 service 경계 | API·backend·frontend 개발자 |
| [OpenAPI](api/openapi.yaml) | 기계 판독 API schema | API tooling, contract test |

`architecture.md`와 `ux-design.md`는 현재 코드 계약을 설명하는 기준 문서입니다. 실행·검증
숫자나 PR ledger를 갱신할 때에는 실제 `origin/main`의 commit과 명령 output을 확인한 뒤 해당
snapshot 문서의 역사 기록인지 현재 기준인지 명시하세요.

## 운영·릴리스

| 문서 | 목적 | 주요 독자 |
| --- | --- | --- |
| [Local Operations](local-operations.md) | migration, data lifetime, export/reset, backup, troubleshooting, opt-in smoke | 운영자, 장애 대응 담당자 |
| [Persistence](persistence.md) | SQLite retention, transaction, idempotency, migration safety | backend 개발자, 운영자 |
| [Release Guide](releasing.md) | version alignment, quality gate, tag와 release asset 게시 | release 담당자 |

## 역사 기록

[`archive/`](archive/)에는 완료된 delivery plan과 시점별 handoff를 보관합니다.

- [보관 문서 안내](archive/README.md)
- [Side Panel MVP delivery plan](archive/delivery-plan.md)
- [Web app first delivery plan](archive/webapp-first-delivery-plan.md)
- [Web app automation delivery plan](archive/webapp-automation-delivery-plan.md)
- [UX 개편 실행·검증 snapshot](archive/webapp-experience-redesign-plan.md)
- [2026-08-01 handoff](archive/handoff-2026-08-01.md)
- [v0.5.1 engagement delivery plan](archive/v0.5.1-engagement-delivery-plan.md)

archive 문서의 오래된 route, label, coverage 수치는 당시의 snapshot입니다. 새 기능의 우선순위,
현재 route 또는 품질 gate를 판단할 때는 현재 설계·개발 기준 문서를 먼저 확인합니다.

## 개발자 시작점

프로젝트 구조와 기본 명령은 루트 [AGENTS.md](../AGENTS.md), 위험별 검증 범위와 품질 gate는
[Testing](testing.md)을 읽습니다. 실제 수용 기준은 `pyproject.toml`, 각 package의 Vitest 설정과
`.github/workflows/`이며, 문서에 적힌 일회성 test count보다 이 설정을 우선합니다.
