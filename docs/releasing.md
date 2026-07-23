# Release Guide

정식 릴리스는 사용자에게 보이는 변경 내역과 재현 가능한 build asset을 함께 제공합니다.

## 준비

1. `CHANGELOG.md`의 새 버전 섹션에 기능, 수정, bug fix를 한국어로 정리합니다.
2. `pyproject.toml`, `uv.lock`, `extension/package.json`, `extension/package-lock.json`,
   `extension/public/manifest.json`의 제품 버전을 같은 값으로 맞춥니다.
3. `uv run --frozen python -m scripts.check_release_version --tag vX.Y.Z`와 전체 품질 검사를
   통과시킨 뒤 main에 병합합니다.

FastAPI의 `/api/v1` 계약 버전은 제품 릴리스 버전과 별개이므로 호환성이 유지되면 변경하지 않습니다.

## 게시

main의 원하는 commit에서 annotated tag를 만들고 push합니다.

```bash
git tag -a v0.3.0 -m "v0.3.0"
git push origin v0.3.0
```

tag workflow는 version metadata와 CHANGELOG를 검증하고, Python wheel 및 unpacked Chrome extension
ZIP과 `SHA256SUMS.txt`를 GitHub Release asset으로 게시합니다. CHANGELOG 요약을 release note 앞에
넣고 GitHub가 생성한 PR·기여자 목록을 뒤에 추가합니다. 이미 게시된 release는 덮어쓰지 않습니다.
