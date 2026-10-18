#!/bin/bash
# 假 pack-eg：--only <单元号> → dist/eg/<单元号>/eg.yaml（舱室单元 schema 2 带 unit 段）
while [ $# -gt 0 ]; do [ "$1" = --only ] && ONLY="$2"; shift; done
echo "pack-eg.sh --only $ONLY" >> /fake/calls
d="/opt/lsa9600sp/lsa9600sp-backend/dist/eg/$ONLY"; mkdir -p "$d"
if [[ "$ONLY" =~ ^(.+)-([A-Z])$ ]]; then printf 'schema: 2\ncabinet:\n  code: %s\nunit:\n  id: %s\n  code: %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$ONLY" > "$d/eg.yaml"
else printf 'schema: 1\ncabinet:\n  code: %s\n' "$ONLY" > "$d/eg.yaml"; fi
echo x > "$d/sp-ca.pem"
