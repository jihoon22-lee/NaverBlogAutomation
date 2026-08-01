#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
  printf '오류: %s\n' "$1" >&2
  exit 1
}

command -v uv >/dev/null 2>&1 ||
  fail "'uv' 명령을 찾을 수 없습니다. README의 Linux 요구 사항을 확인해 주세요."
[[ -n "${HOME:-}" ]] || fail "사용자 home directory를 찾을 수 없습니다."

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
environment_file="$config_home/naver-blog-assistant/env"
[[ -f "$environment_file" ]] ||
  fail "설정 파일이 없습니다. 먼저 scripts/setup-linux.sh 를 실행해 주세요."

cd "$repository_root"
uv run --frozen --env-file "$environment_file" \
  python -m scripts.check_local_setup --env-file "$environment_file"

printf 'Local API를 시작합니다. 이 창은 사용하는 동안 닫지 마세요.\n'
printf '종료하려면 Control+C를 누르세요.\n'
exec uv run --frozen --env-file "$environment_file" \
  python -m scripts.start_webapp --env-file "$environment_file"
