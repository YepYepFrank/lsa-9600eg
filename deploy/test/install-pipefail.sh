#!/bin/bash
# install.sh / 一键安装 setup.sh 在 set -euo pipefail 下的静默退出回归（0.13 验收查出，之后通扫）与转换程序串口（EG 0.5.1）：在一次性容器里跑
#   docker run --rm --pull never -v "$PWD/deploy:/d:ro" ubuntu:24.04 bash /d/test/install-pipefail.sh /d/eg/install.sh /d/bundle/setup.sh
# 从脚本里抽出函数 / 单行，在「全新装」「没网」这类条件下按 set -euo pipefail 跑，看能不能走到底。
# 串口一节要 root + mknod（容器缺省有 CAP_MKNOD）：造假的 /dev/ttyUSB0（有 by-id）与 /dev/ttyUSB1（没有 by-id）。
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
fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
# 抽函数定义
for fn in env_set conv_setup fw_status serial_list serial_byid conv_status; do awk "/^${fn}\\(\\) \\{/,/^\\}/" "$SRC" >> fn.sh; done
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

echo "-- 转换程序串口（EG 0.5.1）"
if [ "$(id -u)" = 0 ] && mknod /dev/ttyUSB0 c 188 0 2>/dev/null; then
  # 不管中途怎么退出，造的节点都删掉（直接在样机上跑时不留痕迹）
  trap 'rm -f /dev/serial/by-id/usb-FTDI_LSA_TEST_A1B2C3-if00-port0 /dev/ttyUSB0 /dev/ttyUSB1; rmdir /dev/serial/by-id /dev/serial 2>/dev/null || true' EXIT
  mknod /dev/ttyUSB1 c 188 1
  mkdir -p /dev/serial/by-id
  BYID=/dev/serial/by-id/usb-FTDI_LSA_TEST_A1B2C3-if00-port0
  ln -s ../../ttyUSB0 "$BYID"
  : > .env
  out="$(CONV_SERIAL=/dev/ttyUSB0 conv_setup 2>&1)"
  grep -q "^EG_CONV_SERIAL=$BYID$" .env && echo "$out" | grep -q '改记成稳定路径' && ok "--conv-serial /dev/ttyUSB0 → 记成 $BYID，打了说明" || bad "ttyUSB0 没换成 by-id：$(grep CONV_SERIAL .env)；$out"
  : > .env
  out="$(CONV_SERIAL=/dev/ttyUSB1 conv_setup 2>&1)"
  grep -q '^EG_CONV_SERIAL=/dev/ttyUSB1$' .env && echo "$out" | grep -q '芯片没有序列号，重启后设备号可能变，建议换带序列号的模块' && ok "--conv-serial /dev/ttyUSB1（没有 by-id）→ 原样记、提醒「芯片没有序列号…」" || bad "ttyUSB1：$(grep CONV_SERIAL .env)；$out"
  : > .env
  out="$(CONV_SERIAL="$BYID" conv_setup 2>&1)"
  grep -q "^EG_CONV_SERIAL=$BYID$" .env && ok "直接给 by-id 路径 → 原样记" || bad "by-id 原样：$(grep CONV_SERIAL .env)"
  lst="$(serial_list)"
  echo "$lst" | grep -q "$BYID → /dev/ttyUSB0" && echo "$lst" | grep -q '/dev/ttyUSB1（没有 by-id' && ! echo "$lst" | grep -q '/dev/ttyUSB0（没有' && ok "可选串口：列出 by-id → ttyUSB0、单列没有 by-id 的 ttyUSB1" || bad "可选串口：$lst"
  { echo "$lst" | grep -E '^  /dev/ttyS' || true; } | while read -r l; do t="/sys/class/tty/$(basename "${l%%（*}" | tr -d ' ')"; [ "$(cat "$t/type")" != 0 ] || echo "  ✗ 列了假串口 $l"; done
  ok "ttyS 只列真串口（type ≠ 0）：本容器宿主机上 $(echo "$lst" | grep -c '真串口' || true) 个"
  echo "$lst" | sed 's/^/      /'
else
  echo "  （不是 root 或不能 mknod，跳过）"
fi
echo "-- --conv-serial 带「:」「#」「空格」→ 安装时拒绝"
for bad_path in '/dev/serial/by-path/pci-0000:00:14.0-usb-0:1:1.0-port0' '/dev/x#1' '/dev/a b'; do
  rc=0; out="$(bash "$SRC" --conv-serial "$bad_path" --status 2>&1)" || rc=$?
  [ "$rc" = 2 ] && echo "$out" | grep -q '「:」「#」或空格' && ok "拒绝 $bad_path（rc 2）" || bad "$bad_path：rc $rc，$out"
done
[ "$fail" = 0 ] && echo "== 走到底了" || { echo "== 有失败项"; exit 1; }
