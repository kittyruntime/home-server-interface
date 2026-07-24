#!/usr/bin/env bash
# Fails if source files contain accented Latin characters — catches French
# strings before they ship (the UI is English-only; French labels leaked to
# production twice, see CHANGELOG 1.34.1).
#
# Matches U+00C0–U+00FF (é è à ç …, minus × ÷) and œ/Œ by their UTF-8 bytes,
# so it works regardless of locale.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

hits=$(LC_ALL=C grep -rnP '\xC3[\x80-\x96\x98-\xB6\xB8-\xBF]|\xC5[\x92\x93]' \
  --include='*.ts' --include='*.vue' --include='*.go' \
  apps/ packages/ 2>/dev/null || true)

if [[ -n "$hits" ]]; then
  echo "Accented characters found in source — UI strings must be English:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "i18n check OK — no accented characters in source."
