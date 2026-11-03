#!/bin/bash
# 0.9.1 公网 pool 回归（同子站 setup-ntp.sh #200）：有子站源时注释掉 Ubuntu 缺省的公网源、--ntp-pools-on 恢复、重跑幂等、--status 照旧。
# 在一次性容器里跑（Ubuntu 24.04 + chrony 4.5，镜像 lsa-chrony-test:24.04；chronyd -x 不改容器的钟）：
#   bash deploy/test/ntp-pools-test.sh [镜像]
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
IMG="${1:-lsa-chrony-test:24.04}"
docker run --rm --pull never -i -v "$ROOT/deploy:/d:ro" --entrypoint bash "$IMG" -s <<'EOS'
set -uo pipefail
fail=0; n=0
ok() { n=$((n+1)); echo "  ✓ $*"; }
bad() { n=$((n+1)); echo "  ✗ $*"; fail=1; }
W=$(mktemp -d); cd "$W"; mkdir -p config
: > .env
SRC=/d/eg/install.sh
grep -E '^(CAM_NTP_CONF|SP_NTP_SOURCES|NTP_POOL_OFF|NTP_POOL_RE)=' "$SRC" > fn.sh
for fn in chrony_files_readable ntp_pool_files ntp_pools_apply sp_ntp_apply sp_ntp_status; do awk "/^${fn}\\(\\) \\{/,/^\\}/" "$SRC" >> fn.sh; done
. ./fn.sh
env_set() { if grep -q "^$1=" .env 2>/dev/null; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
C=/etc/chrony/chrony.conf
pools() { grep -Ec "$NTP_POOL_RE" "$C" /etc/chrony/sources.d/*.sources 2>/dev/null | awk -F: '{s += $2} END {print s + 0}'; }
SP=192.0.2.10
# 站里另放的 sources：一行公网 server、一行站里自己的 server（不该动）
printf 'server 1.ubuntu.pool.ntp.org iburst\nserver 10.1.1.1 iburst\n' > /etc/chrony/sources.d/site.sources
cp "$C" /tmp/main.orig; cp /etc/chrony/sources.d/site.sources /tmp/site.orig
p0="$(pools)"
echo "== 0. 缺省配置：公网源 $p0 行（chrony.conf 的 pool + site.sources 一行）"
[ "$p0" -ge 2 ] || bad "测试前提：缺省配置里应有公网 pool"

echo "== 1. 待接入（没有 lsa-eg.sources）：不动"
ntp_pools_apply >/dev/null
cmp -s "$C" /tmp/main.orig && cmp -s /etc/chrony/sources.d/site.sources /tmp/site.orig && ok "没有子站源时公网源原样（那时它们是仅有的源）" || bad "待接入就改了"

echo "== 2. 接了子站：sp_ntp_apply 注释掉公网源"
out="$(sp_ntp_apply "$SP")"
[ "$(pools)" = 0 ] && ok "公网源全注释（$p0 行）" || bad "还剩 $(pools) 行：$(grep -En "$NTP_POOL_RE" "$C" /etc/chrony/sources.d/*.sources)"
grep -q "注释掉 $p0 行" <<<"$out" && ok "打印「注释掉 $p0 行」+ 恢复方法" || bad "输出：$out"
grep -qx 'server 10.1.1.1 iburst' /etc/chrony/sources.d/site.sources && ok "站里自己的 server 10.1.1.1 不动" || bad "site.sources：$(cat /etc/chrony/sources.d/site.sources)"
grep -qx "server $SP iburst prefer" "$SP_NTP_SOURCES" && ok "lsa-eg.sources 不动" || bad "lsa-eg.sources：$(cat "$SP_NTP_SOURCES")"
[ "$(grep -c "^$NTP_POOL_OFF" "$C" /etc/chrony/sources.d/site.sources | awk -F: '{s += $2} END {print s}')" = "$p0" ] && ok "行首记号「$NTP_POOL_OFF」$p0 行" || bad "记号行数不对"

echo "== 3. 重跑幂等"
cp "$C" /tmp/main.1; cp /etc/chrony/sources.d/site.sources /tmp/site.1
out="$(sp_ntp_apply "$SP")"
cmp -s "$C" /tmp/main.1 && cmp -s /etc/chrony/sources.d/site.sources /tmp/site.1 && [ -z "$(grep pool <<<"$out")" ] && ok "第二次：文件不变、不打印（记号不叠）" || bad "重跑改了文件 / 输出：$out"

echo "== 4. 真 chronyd：只剩子站源，--status 照旧"
chronyd -x -u _chrony 2>/tmp/chronyd.err || bad "chronyd 起不来：$(cat /tmp/chronyd.err)"
sleep 4
s="$(chronyc -n sources 2>&1 | awk '$1 ~ /^[\^=#][*+?x~-]$/ {print $2}' | sort | tr '\n' ' ')"
[ "$s" = "10.1.1.1 $SP " ] && ok "chronyc sources 只有 $SP 和站里的 10.1.1.1" || bad "sources：$s"
st="$(sp_ntp_status)"
grep -q "还没对上 $SP" <<<"$st" && ! grep -q '读不了' <<<"$st" && ok "--status「子站对时」照旧：$(head -1 <<<"$st")" || bad "--status：$st"

echo "== 5. --ntp-pools-on 恢复、--ntp-pools-off 回到缺省"
env_set EG_NTP_POOLS on
out="$(ntp_pools_apply)"
nomk() { grep -v 'makestep' "$1"; }   # makestep 是 sp_ntp_apply 本来就改的，跟 pool 无关
[ "$(nomk "$C")" = "$(nomk /tmp/main.orig)" ] && cmp -s /etc/chrony/sources.d/site.sources /tmp/site.orig && ok "恢复：pool 行跟原来一字不差（makestep 那行另算）" || bad "恢复后不一样：$(diff /tmp/main.orig "$C")"
grep -q "恢复 $p0 行" <<<"$out" && ok "打印「恢复 $p0 行」" || bad "输出：$out"
sp_ntp_apply "$SP" >/dev/null
[ "$(pools)" = "$p0" ] && ok "记住了：on 时重跑 install.sh 不再注释" || bad "on 时重跑又注释了：$(pools)"
env_set EG_NTP_POOLS off
ntp_pools_apply >/dev/null
[ "$(pools)" = 0 ] && ok "off：又注释掉" || bad "off 后还剩 $(pools)"

echo "== 结果：$n 项，$( [ $fail = 0 ] && echo 全过 || echo 有失败)"
exit $fail
EOS
