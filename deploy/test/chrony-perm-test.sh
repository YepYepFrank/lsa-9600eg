#!/bin/bash
# 0.9.1 对时文件权限回归（紫蓬山 2026-11-02：一键加柜经 lsa-eg-upgrade-job 跑 install.sh，umask 077 → lsa-eg.sources 600，
# chronyd 降成 _chrony 后读不了，sources 空、只剩 local stratum 12）：
#   1. umask 077 下 sp_ntp_apply / cam_ntp_apply 写出来是 644；老的 600 重跑后收回 644；
#   2. 真 chronyd（-u _chrony）：600 时 sources 空、--status 报「一个上级源都没有」+「读不了」；收回 644、reload 后有源、不再报读不了。
# 在一次性容器里跑（Ubuntu 24.04 + chrony 4.5，镜像 lsa-chrony-test:24.04；chronyd -x 不改容器的钟）：
#   bash deploy/test/chrony-perm-test.sh [镜像]
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
IMG="${1:-lsa-chrony-test:24.04}"
docker run --rm --pull never -i -v "$ROOT/deploy:/d:ro" --entrypoint bash "$IMG" -s <<'EOS'
set -uo pipefail
fail=0; n=0
ok() { n=$((n+1)); echo "  ✓ $*"; }
bad() { n=$((n+1)); echo "  ✗ $*"; fail=1; }
W=$(mktemp -d); cd "$W"; mkdir -p bin config
printf '#!/bin/sh\necho "3: eth1    inet 192.168.1.1/24 brd x scope global eth1"\n' > bin/ip
chmod +x bin/*; export PATH="$W/bin:$PATH"
: > .env
SRC=/d/eg/install.sh
grep -E '^(CAM_NTP_CONF|SP_NTP_SOURCES)=' "$SRC" > fn.sh
for fn in cam_ntp_on lan1_cidr cam_ntp_apply chrony_files_readable sp_ntp_apply sp_ntp_status; do awk "/^${fn}\\(\\) \\{/,/^\\}/" "$SRC" >> fn.sh; done
. ./fn.sh
mode() { stat -c %a "$1"; }
SP=192.0.2.10   # 文档用地址，永远对不上：只看 chronyd 认不认这个源

echo "== 1. umask 077（同 lsa-eg-upgrade-job）下写的文件"
( umask 077; sp_ntp_apply "$SP"; cam_ntp_apply eth1 )
[ "$(mode "$SP_NTP_SOURCES")" = 644 ] && ok "lsa-eg.sources 644" || bad "lsa-eg.sources $(mode "$SP_NTP_SOURCES")"
[ "$(mode "$CAM_NTP_CONF")" = 644 ] && ok "lsa-eg-cam.conf 644" || bad "lsa-eg-cam.conf $(mode "$CAM_NTP_CONF")"
grep -qx "server $SP iburst prefer" "$SP_NTP_SOURCES" && grep -qx 'makestep 1 -1' /etc/chrony/chrony.conf && ok "内容照旧：server 行、makestep 1 -1" || bad "内容：$(cat "$SP_NTP_SOURCES")"
chmod 600 "$SP_NTP_SOURCES" "$CAM_NTP_CONF"
( umask 077; sp_ntp_apply "$SP" )
[ "$(mode "$SP_NTP_SOURCES")" = 644 ] && [ "$(mode "$CAM_NTP_CONF")" = 644 ] && ok "老的 600（0.9.0 及以前加柜写的）重跑收回 644（两个都收）" || bad "收回：$(mode "$SP_NTP_SOURCES") / $(mode "$CAM_NTP_CONF")"

echo "== 2. 真 chronyd（-u _chrony）"
touch config/eg.yaml
sed -i 's/^pool /#pool /' /etc/chrony/chrony.conf   # 现场 EG 没有外网，公网 pool 解析不了、不进 sources；容器里有网，注释掉免得它们占位
chmod 600 "$SP_NTP_SOURCES" "$CAM_NTP_CONF"   # 复现现场
chronyd -x -u _chrony 2>/tmp/chronyd.err || { bad "chronyd 起不来：$(cat /tmp/chronyd.err)"; }
sleep 3
s="$(chronyc -n sources 2>&1)"
grep -q "$SP" <<<"$s" && bad "600 时 chronyd 也读到了源（推断不成立？）：$s" || ok "复现：600 时 chronyd 读不了 sources.d，一个源都没有"
st="$(sp_ntp_status)"
grep -q '一个上级源都没有' <<<"$st" && grep -q '读不了' <<<"$st" && ok "--status：报「一个上级源都没有」+「读不了」" || bad "--status：$st"
chrony_files_readable; chronyc reload sources >/dev/null 2>&1
sleep 2
s="$(chronyc -n sources 2>&1)"
grep -q "$SP" <<<"$s" && ok "收回 644 + reload sources：有源了（$(grep "$SP" <<<"$s" | awk '{print $1, $2}')）" || bad "reload 后还是没源：$s"
st="$(sp_ntp_status)"
grep -q "还没对上 $SP" <<<"$st" && ! grep -q '读不了' <<<"$st" && ok "--status：「还没对上」、不再报读不了" || bad "--status：$st"
echo "    （--status 原文：$(tr '\n' ' ' <<<"$st")）"

echo "== 结果：$n 项，$( [ $fail = 0 ] && echo 全过 || echo 有失败)"
exit $fail
EOS
