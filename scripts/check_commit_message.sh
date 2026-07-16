#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--file" ]]; then
    if [[ -z "${2:-}" ]]; then
        echo "Usage: $0 --file <commit-message-file> | <commit-subject>" >&2
        exit 2
    fi
    IFS= read -r subject < "$2"
else
    subject="$*"
fi

pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?(!)?:[[:space:]][^[:space:]].*$'

if [[ ! "$subject" =~ $pattern ]]; then
    echo "Invalid commit subject: $subject" >&2
    echo "Expected Conventional Commits format: type(scope): subject" >&2
    echo "Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert" >&2
    exit 1
fi

if (( ${#subject} > 100 )); then
    echo "Commit subject must not exceed 100 characters (${#subject} given)." >&2
    exit 1
fi
