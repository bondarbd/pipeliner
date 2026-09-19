#!/usr/bin/env bash
# alpha: ok; beta: fails on the first attempt (marker file in $OUT/..), ok after; gamma: always fails.
name="$1"; out="$2"
marker="$(dirname "$out")/.beta-failed-once"
case "$name" in
  alpha) echo "build=ok"; exit 0 ;;
  beta)  if [ -f "$marker" ]; then echo "build=ok-after-retry"; exit 0; else touch "$marker"; echo "transient error" >&2; exit 1; fi ;;
  gamma) echo "permanent error: pom.xml broken" >&2; exit 2 ;;
  *)     echo "unknown item $name" >&2; exit 3 ;;
esac
