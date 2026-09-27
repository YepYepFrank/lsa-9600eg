#!/usr/bin/env bash
# LSA-9600SP 离线一键安装文件（自解压）。本文件 = 这段脚本 + 一个 tar 负载（scripts/bundle-all.mjs 生成）。
#
#   sudo bash LSA-9600SP-<版本>.run                    交互：选「子站主机」或「EG」，其余自动
#   sudo bash LSA-9600SP-<版本>.run --role sp --yes    子站主机，不问（本机 IP 自动取缺省路由的地址，或 --ip 指定）
#   sudo bash LSA-9600SP-<版本>.run --role eg --lan1 enp2s0 [--eg-config <目录>]
#   bash LSA-9600SP-<版本>.run --extract <目录>        只解包（不装）
#   bash LSA-9600SP-<版本>.run --help
#
# 解包需要约 5 GB 临时空间（缺省 /var/tmp，LSA_TMP 可改），装完自动删掉（--keep 保留）。
set -euo pipefail

SELF="$(readlink -f "$0")"
SKIP="$(awk '/^__LSA_PAYLOAD_BELOW__$/ { print NR + 1; exit 0 }' "$SELF")"
[ -n "$SKIP" ] || { echo '安装文件不完整（找不到负载）' >&2; exit 1; }

unpack() {
  mkdir -p "$1"
  echo "解包到 $1 ..."
  tail -n +"$SKIP" "$SELF" | tar -x -C "$1"
}

case "${1:-}" in
  --help | -h)
    sed -n '2,11p' "$SELF" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  --extract)
    unpack "${2:?--extract 后面给目录}"
    echo "已解包：$2/lsa9600sp-bundle（sudo bash $2/lsa9600sp-bundle/setup.sh --help）"
    exit 0
    ;;
esac

[ "$(id -u)" = 0 ] || { echo '要用 sudo 跑：sudo bash '"$0"' ...' >&2; exit 1; }
BASE="${LSA_TMP:-/var/tmp}"
mkdir -p "$BASE"
need_kb=$(( ( $(stat -c %s "$SELF") / 1024 ) + 512 * 1024 ))
free_kb="$(df -Pk "$BASE" | awk 'NR==2 { print $4 }')"
[ "$free_kb" -ge "$need_kb" ] || { echo "$BASE 剩余 $((free_kb / 1024)) MB，解包要约 $((need_kb / 1024)) MB（LSA_TMP 指到别的目录）" >&2; exit 1; }
WORK="$(mktemp -d "$BASE/lsa9600sp-bundle.XXXXXX")"
KEEP=0
for a in "$@"; do [ "$a" = --keep ] && KEEP=1; done
cleanup() { [ "$KEEP" = 1 ] && echo "解包目录保留在 $WORK" || rm -rf "$WORK"; }
trap cleanup EXIT
unpack "$WORK"
bash "$WORK/lsa9600sp-bundle/setup.sh" "$@"
exit $?
__LSA_PAYLOAD_BELOW__
