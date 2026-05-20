#!/bin/bash
# 使い方:
#   ./push.sh "送信したいテキスト"
#   echo "テキスト" | ./push.sh
#   cat file.md | ./push.sh

if [ -n "$1" ]; then
  TEXT="$1"
elif [ ! -t 0 ]; then
  TEXT=$(cat)
else
  echo "使い方: $0 \"送信したいテキスト\" または echo \"テキスト\" | $0"
  exit 1
fi

RESULT=$(curl -s -X POST http://localhost:3000/push \
  -H "Content-Type: application/json" \
  -d "{\"text\": $(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}")

if echo "$RESULT" | grep -q '"ok"'; then
  echo "✅ 送信キューに追加しました"
else
  echo "❌ 失敗: $RESULT"
  exit 1
fi
