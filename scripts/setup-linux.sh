#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
extension_id=""
skip_dependencies=0

fail() {
  printf '오류: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "'$1' 명령을 찾을 수 없습니다. README의 Linux 요구 사항을 확인해 주세요."
}

normalize_extension_id() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

validate_extension_id() {
  [[ "$1" =~ ^[a-p]{32}$ ]] ||
    fail "Extension ID는 a부터 p까지의 영문 소문자 32자여야 합니다."
}

is_wsl() {
  grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease /proc/version 2>/dev/null
}

while (($# > 0)); do
  case "$1" in
    --extension-id)
      (($# >= 2)) || fail "--extension-id 뒤에 값을 입력해 주세요."
      extension_id="$(normalize_extension_id "$2")"
      shift 2
      ;;
    --skip-dependencies)
      skip_dependencies=1
      shift
      ;;
    *)
      fail "알 수 없는 option입니다: $1"
      ;;
  esac
done

if [[ -n "$extension_id" ]]; then
  validate_extension_id "$extension_id"
fi

require_command uv
require_command npm
[[ -n "${HOME:-}" ]] || fail "사용자 home directory를 찾을 수 없습니다."

cd "$repository_root"
if ((skip_dependencies == 0)); then
  printf '[1/4] Python dependency를 설치합니다.\n'
  uv sync --frozen
  printf '[2/4] Extension dependency를 설치합니다.\n'
  npm ci --prefix extension
  printf '[3/4] Chrome extension을 build합니다.\n'
  npm --prefix extension run build
fi

if [[ -z "$extension_id" ]]; then
  printf '\nChrome에서 chrome://extensions 를 열고 Developer mode를 켜세요.\n'
  if is_wsl && command -v wslpath >/dev/null 2>&1; then
    windows_extension_path="$(wslpath -w "$repository_root/extension/dist")"
    printf 'Windows Chrome의 Load unpacked에서 다음 folder를 선택하세요:\n  %s\n' \
      "$windows_extension_path"
    if command -v explorer.exe >/dev/null 2>&1; then
      explorer.exe "$windows_extension_path" >/dev/null 2>&1 ||
        printf 'Windows Explorer를 열지 못했습니다. 위 경로를 직접 사용해 주세요.\n' >&2
    fi
  else
    printf 'Load unpacked에서 다음 folder를 선택하세요:\n  %s\n' \
      "$repository_root/extension/dist"
  fi
  read -r -p "표시된 32자 extension ID: " extension_id
  extension_id="$(normalize_extension_id "$extension_id")"
fi
validate_extension_id "$extension_id"

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
environment_file="$config_home/naver-blog-assistant/env"
if [[ ! -f "$environment_file" ]]; then
  printf '[4/4] Private 설정 파일을 만듭니다.\n'
  uv run --frozen python -m scripts.init_local_env --target "$environment_file"
else
  printf '[4/4] 기존 private 설정 파일을 재사용합니다.\n'
fi

uv run --frozen python -m scripts.configure_local_env \
  --target "$environment_file" \
  --extension-id "$extension_id"
uv run --frozen --env-file "$environment_file" \
  python -m scripts.check_local_setup --env-file "$environment_file"

printf '\n설정이 완료되었습니다. 다음부터 scripts/start-linux.sh 를 실행하세요.\n'
printf '실제 OpenAI 생성은 README의 안내에 따라 private 설정 파일에서 활성화할 수 있습니다.\n'
