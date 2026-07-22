#!/bin/bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

finish() {
  status=$?
  trap - EXIT
  if ((status != 0 && status != 130)); then
    printf '\n실행에 실패했습니다. 위 안내를 확인한 뒤 다시 실행해 주세요.\n' >&2
    if [[ -t 0 ]]; then
      read -r -p "Return 키를 누르면 창을 닫습니다. " || true
    fi
  fi
  exit "$status"
}

fail() {
  printf '오류: %s\n' "$1" >&2
  exit 1
}

trap finish EXIT

command -v uv >/dev/null 2>&1 ||
  fail "'uv' 명령을 찾을 수 없습니다. README의 macOS 요구 사항을 확인해 주세요."
[[ -n "${HOME:-}" ]] || fail "사용자 home directory를 찾을 수 없습니다."
environment_file="$HOME/.config/naver-blog-assistant/env"
[[ -f "$environment_file" ]] ||
  fail "설정 파일이 없습니다. 먼저 scripts/setup-macos.command 를 실행해 주세요."

cd "$repository_root"
uv run --frozen --env-file "$environment_file" \
  python -m scripts.check_local_setup --env-file "$environment_file"

printf 'Local API를 시작합니다. 이 창은 사용하는 동안 닫지 마세요.\n'
printf '종료하려면 Control+C를 누르세요.\n'
exec uv run --frozen --env-file "$environment_file" naver-blog-api
