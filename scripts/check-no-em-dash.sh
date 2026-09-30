#!/usr/bin/env bash
# Fails if a tracked file contains an em dash (U+2014, matched by its UTF-8
# bytes so this file does not contain one): the project writes
# with regular punctuation (comma, colon, parentheses, new sentence), see #51.
# Internal build notes under docs/superpowers are not part of the project.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

hits=$(git grep -n -I $'\xe2\x80\x94' -- ':!docs/superpowers' || true)

if [[ -n "$hits" ]]; then
  echo "Em dashes found; use a comma, colon, parentheses or a new sentence:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "Em dash check OK."
