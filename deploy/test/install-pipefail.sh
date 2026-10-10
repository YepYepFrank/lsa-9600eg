#!/bin/bash
# install.sh / 一键安装 setup.sh 在 set -euo pipefail 下的静默退出回归（0.13 验收查出，之后通扫）：在一次性容器里跑
#   docker run --rm -v "$PWD/deploy:/d:ro" ubuntu:24.04 bash /d/test/install-pipefail.sh /d/eg/install.sh /d/bundle/setup.sh
# 从脚本里抽出函数 / 单行，在「全新装」「没网」这类条件下按 set -euo pipefail 跑，看能不能走到底。
# 完整的全新安装另有 deploy/test/fresh-install.sh（真跑一遍一键安装文件 --role eg）。
set -euo pipefail
SRC="$1"
SETUP="${2:-}"
W=$(mktemp -d); cd "$W"
mkdir -p config bin
echo 'EG_PG_PASSWORD=x' > .env
echo 'eg: {}' > config/eg.yaml
printf '#!/bin/sh\nexit 0\n' > bin/docker
# nft：表在、但 input 链里没有计数行（grep 不匹配）
printf '#!/bin/sh\ncase "$2" in table) exit 0 ;; chain) echo "chain input {"; exit 0 ;; esac\nexit 0\n' > bin/nft
# ip：没有缺省路由（route get 返回 2）；addr 只有 lo
printf '#!/bin/sh\n[ "$1" = -4 ] && [ "$2" = route ] && { echo "RTNETLINK answers: Network is unreachable" >&2; exit 2; }\necho "lo UNKNOWN 127.0.0.1/8"\n' > bin/ip
chmod +x bin/*
export PATH="$W/bin:$PATH"
CONV_SERIAL=''
DC='docker compose'
# 抽函数定义
awk '/^env_set\(\) \{/,/^\}/' "$SRC" > fn.sh
awk '/^conv_setup\(\) \{/,/^\}/' "$SRC" >> fn.sh
awk '/^fw_status\(\) \{/,/^\}/' "$SRC" >> fn.sh
. ./fn.sh
echo "-- conv_setup（没有 CONV_IMAGE.txt、.env 里没有 EG_CONV_SERIAL）"
conv_setup
echo "-- 再来一次：有 CONV_IMAGE.txt（只有注释行）"
printf '# 只有注释\n' > CONV_IMAGE.txt; conv_setup; rm -f CONV_IMAGE.txt
echo "-- fw_status（.env 里没有 EG_LAN1；防火墙表在但没有计数行）"
fw_status
echo "-- 两行哈希（没有哈希文件、没有 sp-ca.pem）"
eval "$(grep -E '^cfg_sum=' "$SRC")"
eval "$(grep -E '^last_sum=' "$SRC")"
echo "cfg_sum=${cfg_sum:0:16} last_sum=[${last_sum}]"
if [ -n "$SETUP" ]; then
  echo "-- setup.sh：没有 MANIFEST.txt"
  eval "$(grep -E "^sed -n '2,20p' MANIFEST.txt" "$SETUP")"
  echo "-- setup.sh：没有缺省路由时猜本机 IP"
  eval "$(grep -E '^  guess="\$\(ip -4 route get' "$SETUP")"
  echo "guess=[${guess}]"
  echo "-- setup.sh：只有 lo 时列网口"
  eval "$(grep -E "^    ip -br -4 addr" "$SETUP")"
  echo "-- setup.sh：CA 证书不在时算哈希"
  ca=/nonexistent/sp-ca.pem
  ca_key_sum() { return 0; }
  eval "$(grep -E '^    ca1="\$\(sha256sum' "$SETUP")"
  echo "ca1=[${ca1}]"
fi
echo "== 走到底了"
