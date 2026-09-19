#!/usr/bin/env bash
# Fake headless agent for tests. Usage: fake-agent.sh -p "<prompt>" [--mode X]
# Behaviour is driven by env FAKE_AGENT_MODE:
#   keys      -> prints result=ok and writes notes
#   badformat -> prints prose (no key=value); on a repair prompt prints key=value
#   needinput -> prints NEED_INPUT=which version?
#   dirty     -> creates an untracked file in cwd, then sleeps 30 (for timeout tests)
prompt="$2"
echo "[fake-agent] prompt bytes: ${#prompt}"
case "${FAKE_AGENT_MODE:-keys}" in
  keys)      echo "result=ok"; echo "note from agent" >> "$CTX_ITEM/notes.md" ;;
  badformat) if [[ "$prompt" == *"Верни только строки key=value"* ]]; then echo "fixed=1"; else echo "Sure! Here is what I did."; fi ;;
  needinput) echo "NEED_INPUT=which version?" ;;
  dirty)     echo junk > "$PWD/junk.txt"; sleep 30 ;;
esac
echo "$prompt" > "$OUT/seen-prompt.txt"
