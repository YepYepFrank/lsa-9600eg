#!/bin/bash
# 在一次性容器里跑：从 install-conv.sh 摘出 env_get / serial_byid / serial_list / pick_serial，造假串口验缺省 COM2
#   用法（开发机，Docker 起着）：docker run --rm --pull never --privileged -v "$PWD/deploy/test/pick-serial-test.sh:/w/t.sh:ro" -v "$PWD/tools/conv-addon/install-conv.sh:/w/install-conv.sh:ro" ubuntu:24.04 bash /w/t.sh
set -u
F=/w/install-conv.sh
fn() { sed -n "/^$1() {/,/^}/p" "$F"; }
eval "$(grep -E '^env_get\(\)' "$F")"
eval "$(fn serial_byid)"; eval "$(fn serial_list)"; eval "$(fn pick_serial)"
P=0; X=0
ok() { echo "  ✓ $*"; P=$((P+1)); }
bad() { echo "  ✗ $*"; X=$((X+1)); }
mknod /dev/ttyS1 c 4 65 2>/dev/null || true
mknod /dev/ttyUSB0 c 188 0; mkdir -p /dev/serial/by-id
BYID=/dev/serial/by-id/usb-FTDI_LSA_TEST_A1B2C3-if00-port0
cd "$(mktemp -d)"
run() { SERIAL="$1"; pick_serial > /tmp/ps.out 2>&1; rc=$?; out="$(cat /tmp/ps.out)"; }   # 不能 $(…)：子 shell 里设的 SERIAL 带不出来

echo "== 1. 没插 USB、没记过 → COM2"
: > .env; run ''
[ $rc = 0 ] && [ "$SERIAL" = /dev/ttyS1 ] && grep -q 'COM2' <<<"$out" && ! grep -q 'USB' <<<"$out" && ok "$SERIAL" || bad "rc $rc $SERIAL：$out"

echo "== 2. 插着一个 USB、没记过 → 仍是 COM2，只提示"
ln -s ../../ttyUSB0 "$BYID"; : > .env; run ''
[ $rc = 0 ] && [ "$SERIAL" = /dev/ttyS1 ] && grep -q '没有自动用' <<<"$out" && grep -q "$BYID" <<<"$out" && ok "$SERIAL，提示：$(sed -n 2p <<<"$out")" || bad "rc $rc $SERIAL：$out"

echo "== 3. 以前记过 USB（样机）→ 沿用"
echo "EG_CONV_SERIAL=$BYID" > .env; run ''
[ $rc = 0 ] && [ "$SERIAL" = "$BYID" ] && grep -q '沿用上次' <<<"$out" && ok "$SERIAL" || bad "rc $rc $SERIAL：$out"

echo "== 4. 记过 /dev/null（--sim）→ COM2"
echo 'EG_CONV_SERIAL=/dev/null' > .env; run ''
[ $rc = 0 ] && [ "$SERIAL" = /dev/ttyS1 ] && ok "$SERIAL" || bad "rc $rc $SERIAL：$out"

echo "== 5. --serial /dev/ttyUSB0 → by-id"
: > .env; run /dev/ttyUSB0
[ $rc = 0 ] && [ "$SERIAL" = "$BYID" ] && ok "$SERIAL" || bad "rc $rc $SERIAL：$out"

echo "== 6. 记过的 USB 拔了 → 报不存在、退出"
echo 'EG_CONV_SERIAL=/dev/ttyUSB9' > .env; out="$( (SERIAL=''; pick_serial) 2>&1)"; rc=$?
[ $rc != 0 ] && grep -q '串口 /dev/ttyUSB9 不存在' <<<"$out" && ok "rc $rc：不存在" || bad "rc $rc：$out"

echo "== 7. 不交互（stdin 不是终端）、插着两个 USB → 不卡、用 COM2"
mknod /dev/ttyUSB1 c 188 1; ln -s ../../ttyUSB1 /dev/serial/by-id/usb-FTDI_LSA_TEST_D4E5F6-if00-port0
: > .env; run '' </dev/null
[ $rc = 0 ] && [ "$SERIAL" = /dev/ttyS1 ] && [ "$(grep -c ' → /dev/ttyUSB' <<<"$out")" = 2 ] && ok "$SERIAL，列出两个" || bad "rc $rc $SERIAL：$out"
echo "== $P 过 / $X 失败"; [ $X = 0 ]
