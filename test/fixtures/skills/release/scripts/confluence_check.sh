#!/usr/bin/env bash
# Mock: succeeds when the report exists and env MOCK_CONFLUENCE_OK=1
[ -f "$2" ] && [ "${MOCK_CONFLUENCE_OK:-0}" = "1" ] && { echo "RESULT=OK page=https://confluence/x"; exit 0; }
echo "RESULT=MISSING"; exit 1
