#!/usr/bin/env bash
# Merges the minimal setup from copilot-min/ into your existing Copilot home (~/.copilot or $COPILOT_HOME).
# Shows every change and asks before replacing anything. Your login, sessions and skills stay as they are.
set -euo pipefail

if ! command -v jq >/dev/null; then
  echo "install.sh needs jq. Install it (for example 'sudo apt install jq' or 'brew install jq') and run again." >&2
  exit 1
fi

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/copilot-min" && pwd)
dest=${COPILOT_HOME:-$HOME/.copilot}

ask() {
  local answer=''
  printf '%s [y/N] ' "$1"
  read -r answer || true
  [ "$answer" = y ]
}

# diff exits 1 when the files differ; only 2 is an error.
show_diff() {
  diff -u --label "$1" --label "$2" "$3" "$4" || [ $? -eq 1 ]
}

mkdir -p "$dest"

# settings.json: deep merge, ours wins, except two lists. disabledSubagents keeps your entries, adds ours and drops
# "gp" (our subagent). userPromptSubmitted puts our guard hook first, then yours.
settings=$dest/settings.json
if [ ! -e "$settings" ]; then
  cp "$src/settings.json" "$settings"
  echo "Wrote $settings."
else
  merged=$(jq -S -s '.[0] as $u | .[1] as $o | ($u * $o)
    | .subagents.disabledSubagents = ((($u.subagents.disabledSubagents // []) + $o.subagents.disabledSubagents) | unique - ["gp"])
    | .hooks.userPromptSubmitted = ($o.hooks.userPromptSubmitted + (($u.hooks.userPromptSubmitted // []) - $o.hooks.userPromptSubmitted))' \
    "$settings" "$src/settings.json")
  if [ "$merged" = "$(jq -S . "$settings")" ]; then
    echo "$settings already has the minimal setup."
  else
    show_diff "$settings" "$settings (merged)" <(jq -S . "$settings") <(printf '%s\n' "$merged")
    changed=$(jq -r -s '.[0] as $u | .[1] as $m
      | $u | paths(type != "object") | select(all(.[]; type == "string")) as $p
      | select(($u | getpath($p)) != ($m | getpath($p)))
      | "  \($p | join(".")): \($u | getpath($p) | tojson) -> \($m | getpath($p) | tojson)"' \
      "$settings" <(printf '%s\n' "$merged"))
    if [ -n "$changed" ]; then
      echo "Existing values that change:"
      echo "$changed"
    fi
    if ask "Apply?"; then
      printf '%s\n' "$merged" > "$settings"
      echo "Updated $settings."
    else
      echo "Left $settings unchanged."
    fi
  fi
fi

ext=$dest/extensions/minprompt/extension.mjs
if [ ! -e "$ext" ]; then
  mkdir -p "$(dirname "$ext")"
  cp "$src/extensions/minprompt/extension.mjs" "$ext"
  echo "Wrote $ext."
elif ! cmp -s "$src/extensions/minprompt/extension.mjs" "$ext"; then
  show_diff "$ext" "$ext (new)" "$ext" "$src/extensions/minprompt/extension.mjs"
  if ask "Apply?"; then
    cp "$src/extensions/minprompt/extension.mjs" "$ext"
    echo "Updated $ext."
  else
    echo "Left $ext unchanged."
  fi
fi
