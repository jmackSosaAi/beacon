#!/bin/sh
d="$(git rev-parse --git-common-dir)/hooks"
for h in pre-commit pre-push; do cp "$(dirname "$0")/$h" "$d/$h" && chmod +x "$d/$h"; done && echo "pre-commit and pre-push hooks installed"
