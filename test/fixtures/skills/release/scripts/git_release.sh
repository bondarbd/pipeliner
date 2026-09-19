#!/usr/bin/env bash
# Mock of work-skills git_release.sh. State: file .branches in the repo dir lists created branches.
mode="$1"; repo="$2"; br="$3"
case "$mode" in
  exists) grep -qx "$br" "$repo/.branches" 2>/dev/null && { echo "commit=$(cat "$repo/.sha")"; exit 0; } || exit 1 ;;
  create) [ -f "$repo/.dirty" ] && { echo "ERROR: working tree is not clean" >&2; exit 2; }
          echo "$br" >> "$repo/.branches"; sha=$(printf '%s' "$repo$br" | shasum | cut -c1-40); echo "$sha" > "$repo/.sha"
          echo "OK repo=$repo branch=$br from=${4:-develop} commit=$sha"; echo "commit=$sha"; exit 0 ;;
  *) echo "unknown mode $mode" >&2; exit 1 ;;
esac
