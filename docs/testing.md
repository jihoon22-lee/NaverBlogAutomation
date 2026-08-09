# 테스트와 품질 기준

Status: 현재 저장소 기준, 갱신 2026-08-09

이 문서는 변경 위험에 맞는 테스트 범위와 release gate를 설명합니다. 복사된 test count는 빠르게
낡으므로 수용 기준으로 사용하지 않습니다. 정확한 threshold와 CI job은 `pyproject.toml`,
`client/vitest.config.ts`, `extension/vitest.config.ts`, `.github/workflows/`가 source of truth입니다.

## 기본 품질 gate

| 영역 | 명령 | 최소 기준 |
| --- | --- | --- |
| Python | `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check`, `uv run pytest` | 전체 성공, branch coverage 87% 이상 |
| 웹앱 | `npm --prefix client run check` | format·lint·type·unit test·build 성공, statements/branches/functions/lines 각각 80% 이상 |
| 동결 extension | `npm --prefix extension run check` | format·lint·type·unit test·build 성공, statements/branches/functions/lines 각각 80% 이상 |
| Packaged E2E | `npm --prefix extension run test:e2e` | 설치 가능한 앱과 legacy workflow의 Playwright journey 성공 |

PR에서는 변경 영역의 targeted test를 먼저 실행하고, 제출 전 해당 package의 전체 check를 실행합니다.
Python package나 설치 산출물에 영향이 있으면 전체 `uv run pytest`와 wheel smoke까지 확인합니다.

## 위험에 따른 테스트 선택

| 변경 | 반드시 포함할 회귀 사례 |
| --- | --- |
| route·controller·SSE | A 화면 요청 후 B로 이동했을 때 A 응답 무시, 중복 action 방지, terminal stream 종료, 실패 후 재시도 |
| 글쓰기 editor | autosave debounce·충돌·실패, draft 전환 중 입력 보존, checkpoint 전 AI/stage 잠금, block·focus·selection 보존 |
| 설정 | progressive panel open 상태, 저장 중 입력 보존, write-only secret 미노출, paired tablet의 PC 전용 control 미렌더 |
| 작업함·세션 | filter와 selection 보존, 직접 선택 순서, safety preflight, 취소·재시작·늦은 session 응답 |
| API·persistence | OpenAPI/Pydantic/client parser parity, migration upgrade, transaction·idempotency, export/reset 경계 |
| Naver DOM probe | synthetic HTML 단위 테스트, selector 중복·숨김 요소·불명확 결과 fail-closed |
| 반응형·접근성 | keyboard focus, accessible name, `aria-current`, details 조작, 44px target, 320/768/1024/desktop overflow |

Coverage는 빠진 분기를 찾는 경보이며 테스트의 목적 자체가 아닙니다. threshold를 올릴 때에는 단순
getter나 방어 불가능한 줄을 채우기보다, 위 표의 사용자 데이터 유실·중복 외부 동작·오래된 응답 같은
고위험 분기를 우선합니다.

## Packaged E2E와 live test 경계

Packaged E2E는 wheel에서 제공되는 `/app/`과 synthetic Naver fixture를 사용합니다. desktop,
tablet portrait/landscape와 phone 폭에서 navigation, queue/detail, writing, settings, focus, touch target,
horizontal overflow를 검증합니다. 실제 계정·cookie·API key를 artifact에 넣지 않습니다.

실제 외부 서비스 검증은 기본 gate와 분리된 opt-in test입니다.

- OpenAI: `uv run pytest --no-cov -m live_openai tests/live`
- Naver 임시저장: `uv run pytest --no-cov -m live_naver tests/live/test_naver_staging_smoke.py`

live test는 사용자 credential과 명시적 동의가 있을 때만 실행합니다. Captcha를 우회하거나 불명확한
등록 결과를 자동으로 성공 처리하지 않으며, 실행 절차와 데이터 정리는
[Local Operations](local-operations.md)의 smoke test 절을 따릅니다.

## 문서와 릴리스 검증

- 사용자 label·route·설정 경로가 바뀌면 README, 시작하기, 관련 기능 가이드, UX·Architecture를 함께
  검색합니다.
- Markdown 상대 링크가 실제 파일을 가리키는지 확인하고 `git diff --check`를 통과시킵니다.
- release 전에는 [Release Guide](releasing.md)의 version metadata 검사와 전체 CI를 통과시킵니다.
- 완료 계획의 과거 test count는 `archive/`에 그대로 보존하고, 현재 수용 기준으로 재사용하지 않습니다.
