#!/bin/bash
# install.sh / 一键安装 setup.sh 在 set -euo pipefail 下的静默退出回归（0.13 验收查出，之后通扫）与转换程序串口（EG 0.5.1）：在一次性容器里跑
#   docker run --rm --pull never -v "$PWD:/r:ro" ubuntu:24.04 bash /r/deploy/test/install-pipefail.sh /r/deploy/eg/install.sh /r/deploy/bundle/setup.sh
# 从脚本里抽出函数 / 单行，在「全新装」「没网」这类条件下按 set -euo pipefail 跑，看能不能走到底。
# 串口一节要 root + mknod（容器缺省有 CAP_MKNOD）：造假的 /dev/ttyUSB0（有 by-id）与 /dev/ttyUSB1（没有 by-id）。
# 串口的选取、by-id、路径检查 0.6.2 起在 install-conv.sh（install.sh 的 --conv-serial 只是转过去）：第三个参数给它的路径，
# 不给就找 install.sh 旁边的（发布件里两个在一起），再找仓库里的 tools/conv-addon/install-conv.sh
# 完整的全新安装另有 deploy/test/fresh-install.sh（真跑一遍一键安装文件 --role eg）。
set -euo pipefail
SRC="$1"
SETUP="${2:-}"
CONV="${3:-$(dirname "$SRC")/install-conv.sh}"
[ -f "$CONV" ] || CONV="$(dirname "$SRC")/../../tools/conv-addon/install-conv.sh"
[ -f "$CONV" ] || { echo "找不到 install-conv.sh（第三个参数给它的路径；容器里要挂整个仓库，见上面的用法）" >&2; exit 2; }
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
for fn in env_set conv_wanted conv_check_devices conv_setup fw_status serial_list conv_status; do awk "/^${fn}\\(\\) \\{/,/^\\}/" "$SRC" >> fn.sh; done
awk '/^serial_byid\(\) \{/,/^\}/' "$CONV" >> fn.sh
grep -q '^serial_byid()' fn.sh || { echo "  ✗ $CONV 里没有 serial_byid"; exit 1; }
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
  echo "-- setup.sh：开头就查系统（只支持 Ubuntu Server 24.04，两个角色都查）"
  awk '/^os_check\(\) \{/,/^\}/' "$SETUP" > os.sh
  osrel() { printf 'ID=%s\nVERSION_ID="%s"\nPRETTY_NAME="%s"\n' "$1" "$2" "$3" > "os-$1-$2"; echo "$W/os-$1-$2"; }
  U2404="$(osrel ubuntu 24.04 'Ubuntu 24.04.5 LTS')"; U2204="$(osrel ubuntu 22.04 'Ubuntu 22.04.4 LTS')"; D12="$(osrel debian 12 'Debian GNU/Linux 12 (bookworm)')"
  for c in "sp|$U2404|0|" "eg|$U2404|0|" "eg|$U2204|1|§2a" "sp|$U2204|1|§2b" "sp|$D12|1|§2b" "eg|$D12|1|§2a" "|$U2204|1|§2b.*§2a"; do
    IFS='|' read -r role f want doc <<< "$c"
    rc=0; out="$( ( ROLE="$role"; . ./os.sh; os_check "$f" ) 2>&1 )" || rc=$?
    other=''; [ "$role" = sp ] && other='§2a'; [ "$role" = eg ] && other='§2b'
    if [ "$rc" = "$want" ] && { [ "$want" = 0 ] || { echo "$out" | tr -d '\n' | grep -q "只支持 Ubuntu Server 24.04.*$doc" && { [ -z "$other" ] || ! echo "$out" | grep -q "$other"; }; }; }; then
      ok "--role ${role:-（没给）} 在 $(sed -n 's/^PRETTY_NAME="\(.*\)"/\1/p' "$f")：rc $rc$([ "$want" = 1 ] && echo "，中文报错、指向 $doc")"
    else
      bad "--role ${role:-（没给）} $f：rc $rc（要 $want）；$out"
    fi
  done
fi

echo "-- 转换程序串口（EG 0.5.1）"
if [ "$(id -u)" = 0 ] && mknod /dev/ttyUSB0 c 188 0 2>/dev/null; then
  # 不管中途怎么退出，造的节点都删掉（直接在样机上跑时不留痕迹）
  trap 'rm -f /dev/serial/by-id/usb-FTDI_LSA_TEST_A1B2C3-if00-port0 /dev/ttyUSB0 /dev/ttyUSB1; rmdir /dev/serial/by-id /dev/serial 2>/dev/null || true' EXIT
  mknod /dev/ttyUSB1 c 188 1
  mkdir -p /dev/serial/by-id
  BYID=/dev/serial/by-id/usb-FTDI_LSA_TEST_A1B2C3-if00-port0
  ln -s ../../ttyUSB0 "$BYID"
  # install-conv.sh 记串口前先换成 by-id 的稳定名字
  [ "$(serial_byid /dev/ttyUSB0)" = "$BYID" ] && ok "install-conv.sh：/dev/ttyUSB0 → $BYID" || bad "ttyUSB0 没换成 by-id：$(serial_byid /dev/ttyUSB0)"
  [ "$(serial_byid /dev/ttyUSB1)" = /dev/ttyUSB1 ] && ok "install-conv.sh：/dev/ttyUSB1（没有 by-id）→ 原样" || bad "ttyUSB1：$(serial_byid /dev/ttyUSB1)"
  [ "$(serial_byid "$BYID")" = "$BYID" ] && ok "install-conv.sh：直接给 by-id 路径 → 原样" || bad "by-id 原样：$(serial_byid "$BYID")"
  # install.sh 重跑时：启用过、记的串口拔了 → 不起转换程序、说清楚，不能悄悄退出
  printf 'EG_CONV=on\nEG_CONV_SERIAL=/dev/ttyUSB9\n' > .env; printf 'lsa-eg-conv:x\n' > CONV_IMAGE.txt
  out="$(conv_setup 2>&1)" && echo "$out" | grep -q '串口 /dev/ttyUSB9 不存在' && ok "install.sh：启用过、串口拔了 → 不起、说「串口不存在」" || bad "串口拔了：$out"
  rm -f CONV_IMAGE.txt; : > .env
  lst="$(serial_list)"
  echo "$lst" | grep -q "$BYID → /dev/ttyUSB0" && echo "$lst" | grep -q '/dev/ttyUSB1（没有 by-id' && ! echo "$lst" | grep -q '/dev/ttyUSB0（没有' && ok "可选串口：列出 by-id → ttyUSB0、单列没有 by-id 的 ttyUSB1" || bad "可选串口：$lst"
  { echo "$lst" | grep -E '^  /dev/ttyS' || true; } | while read -r l; do t="/sys/class/tty/$(basename "${l%%（*}" | tr -d ' ')"; [ "$(cat "$t/type")" != 0 ] || echo "  ✗ 列了假串口 $l"; done
  ok "ttyS 只列真串口（type ≠ 0）：本容器宿主机上 $(echo "$lst" | grep -c '真串口' || true) 个"
  echo "$lst" | sed 's/^/      /'
else
  echo "  （不是 root 或不能 mknod，跳过）"
fi
echo "-- install-conv.sh --serial 带「:」「#」「空格」→ 拒绝（install.sh --conv-serial 转给它）"
# 一个最小的已装 EG：compose.yaml 有 conv 服务、有 eg.yaml；install-conv.sh 拷到旁边配上 CONV_IMAGE.txt（docker 是替身，镜像「在」）
mkdir -p eg/config kit
printf 'services:\n  conv:\n    image: x\n' > eg/compose.yaml
echo 'eg: {}' > eg/config/eg.yaml
cp "$CONV" kit/install-conv.sh; printf 'lsa-eg-conv:x\n' > kit/CONV_IMAGE.txt; cp "$SRC" kit/install.sh
if [ "$(id -u)" = 0 ]; then
  for bad_path in '/dev/serial/by-path/pci-0000:00:14.0-usb-0:1:1.0-port0' '/dev/x#1' '/dev/a b'; do
    rc=0; out="$(bash kit/install-conv.sh --dir "$W/eg" --serial "$bad_path" 2>&1)" || rc=$?
    [ "$rc" = 1 ] && echo "$out" | grep -q '「:」「#」或空格' && ok "拒绝 $bad_path（rc 1）" || bad "$bad_path：rc $rc，$out"
  done
  grep -q 'EG_CONV' eg/.env 2>/dev/null && bad "拒绝了还写了 .env：$(cat eg/.env)" || ok "拒绝时什么都没写（eg/.env 没有 EG_CONV）"
  # install.sh --conv-serial 转给旁边的 install-conv.sh（它按缺省目录 /opt/lsa-eg 找已装的 EG，这里没有 —— 说明转过去了）
  rc=0; out="$(bash kit/install.sh --conv-serial '/dev/x#1' 2>&1)" || rc=$?
  echo "$out" | grep -q '/opt/lsa-eg 下没有装好的 EG' && ok "install.sh --conv-serial 转给旁边的 install-conv.sh（rc $rc）" || bad "install.sh --conv-serial：rc $rc，$out"
else
  echo "  （不是 root，跳过：install-conv.sh 要 root）"
fi
[ "$fail" = 0 ] && echo "== 走到底了" || { echo "== 有失败项"; exit 1; }
