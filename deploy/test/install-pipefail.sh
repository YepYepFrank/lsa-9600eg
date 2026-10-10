#!/bin/bash
# install.sh 的「全新安装」回归（0.13 验收查出的 set -euo pipefail 静默退出）：在一次性容器里跑
#   docker run --rm -v "$PWD/deploy:/d:ro" ubuntu:24.04 bash /d/test/install-pipefail.sh /d/eg/install.sh
# 在一次性容器里跑：从 install.sh 抽出 env_set / conv_setup 与两行哈希，在「全新装」的条件下（.env 没有任何 EG_CONV* / EG_LAN1、没有哈希文件、没有 sp-ca.pem）
# 按 set -euo pipefail 跑，看能不能走到底。用法：snip-test.sh <install.sh>
set -euo pipefail
SRC="$1"
W=$(mktemp -d); cd "$W"
mkdir -p config bin
echo 'EG_PG_PASSWORD=x' > .env
echo 'eg: {}' > config/eg.yaml
printf '#!/bin/sh\nexit 0\n' > bin/docker; chmod +x bin/docker
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
echo "-- fw_status（.env 里没有 EG_LAN1；非 root 时直接返回，这里按 root 跑）"
fw_status || true
echo "-- 两行哈希（没有哈希文件、没有 sp-ca.pem）"
eval "$(grep -E '^cfg_sum=' "$SRC")"
eval "$(grep -E '^last_sum=' "$SRC")"
echo "cfg_sum=${cfg_sum:0:16} last_sum=[${last_sum}]"
echo "== 走到底了"
