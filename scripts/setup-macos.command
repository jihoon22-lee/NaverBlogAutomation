#!/bin/bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skip_dependencies=0

finish() {
  status=$?
  trap - EXIT
  if ((status != 0)); then
    printf '\n설정에 실패했습니다. 위 안내를 확인한 뒤 다시 실행해 주세요.\n' >&2
  fi
  if [[ -t 0 ]]; then
    read -r -p "Return 키를 누르면 창을 닫습니다. " || true
  fi
  exit "$status"
}

fail() {
  printf '오류: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "'$1' 명령을 찾을 수 없습니다. README의 macOS 요구 사항을 확인해 주세요."
}

while (($# > 0)); do
  case "$1" in
    --skip-dependencies)
      skip_dependencies=1
      shift
      ;;
    *)
      fail "알 수 없는 option입니다: $1"
      ;;
  esac
done

trap finish EXIT

require_command uv
require_command npm

cd "$repository_root"
if ((skip_dependencies == 0)); then
  printf '[1/3] Python dependency를 설치합니다.\n'
  uv sync --frozen
  printf '[2/3] 웹앱 dependency와 bundle을 준비합니다.\n'
  npm ci --prefix client
  npm --prefix client run build
fi

[[ -n "${HOME:-}" ]] || fail "사용자 home directory를 찾을 수 없습니다."
environment_file="$HOME/.config/naver-blog-assistant/env"

if [[ ! -f "$environment_file" ]]; then
  printf '[3/3] Private 설정 파일을 만듭니다.\n'
  uv run --frozen python -m scripts.init_local_env --target "$environment_file"
else
  printf '[3/3] 기존 private 설정 파일을 재사용합니다.\n'
fi
uv run --frozen --env-file "$environment_file" \
  python -m scripts.check_local_setup --env-file "$environment_file"

printf '\n웹앱 설정이 완료되었습니다. 다음부터 scripts/start-macos.command 를 실행하세요.\n'
printf '실제 OpenAI 생성은 README의 안내에 따라 private 설정 파일에서 활성화할 수 있습니다.\n'
