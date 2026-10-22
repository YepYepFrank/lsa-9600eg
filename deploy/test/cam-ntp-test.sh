#!/bin/bash
# 摄像机对时（0.7.x，S19）回归：install.sh 的 lan1_cidr / cam_hosts / cam_ntp_apply / fw_apply / cam_ntp_status，
# 0.7.3：cam_ntp_drift 与安全提醒（改了摄像机地址、放行没跟上）；0.19.0：cam_ntp_watch（盯 local.yaml 的 systemd 单元）与 cam_ntp_sync（自动同步）。
# 在一次性容器里跑，ip / nft / systemctl 是替身（不动真的防火墙和 chrony）；写出来的 nft 文件另用真 nft -c 查语法（给了沙箱名才查）：
#   bash deploy/test/cam-ntp-test.sh [装着 nft 的容器，如 iteg]
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
NFTBOX="${1:-}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
docker run --rm --pull never -i -v "$ROOT/deploy:/d:ro" -v "$(cd "$OUT" && (pwd -W 2>/dev/null || pwd)):/out" --entrypoint bash ubuntu:24.04 -s <<'EOS'
set -uo pipefail
fail=0; n=0
ok() { n=$((n+1)); echo "  ✓ $*"; }
bad() { n=$((n+1)); echo "  ✗ $*"; fail=1; }
W=$(mktemp -d); cd "$W"; mkdir -p bin config /etc/chrony
# 替身：ip 按 /tmp/ipaddr 回答；nft list chain 回写出来的文件；systemctl 什么都不做
printf '#!/bin/sh\n[ -s /tmp/ipaddr ] && echo "3: eth1    inet $(cat /tmp/ipaddr) brd x scope global eth1"\nexit 0\n' > bin/ip
printf '#!/bin/sh\n[ "$1" = list ] && cat /etc/lsa-eg/lan1-fw.nft 2>/dev/null\n[ "$1" = -c ] && [ -f /tmp/nft-bad ] && exit 1\n[ "$1" = -f ] && echo "nft -f $2" >> /tmp/calls\nexit 0\n' > bin/nft
printf '#!/bin/sh\necho "systemctl $*" >> /tmp/calls\nexit 0\n' > bin/systemctl
chmod +x bin/*; export PATH="$W/bin:$PATH"
: > .env
SRC=/d/eg/install.sh
grep -E '^(FW_NFT|FW_UNIT|CAM_NTP_CONF|CAMNTP_PATH|CAMNTP_SVC|CAMNTP_LOG|FW_APPLY_FAILED)=' "$SRC" > fn.sh
for fn in cam_ntp_on cam_hosts_raw ip2n ipv4_ok ip_in_cidr cam_lan1_net cam_host_problem cam_hosts cam_hosts_bad lan1_cidr cam_ntp_apply cam_ntp_unwatch cam_ntp_watch cam_ntp_log cam_ntp_sync cam_ntp_drift cam_ntp_status security_notes; do awk "/^${fn}\\(\\) \\{/,/^\\}/" "$SRC" >> fn.sh; done
# fw_apply 里的 nft heredoc 有顶格的「}」：抽到下一节的标题为止
awk '/^fw_apply\(\) \{/,/^# ---------- 摄像机对时/' "$SRC" | sed '$d' >> fn.sh
. ./fn.sh
id() { echo 0; }   # cam_ntp_status 看 root 才查防火墙

echo "== 1. LAN1 网段"
for c in '192.168.1.250/24 192.168.1.0/24' '10.20.30.40/16 10.20.0.0/16' '192.168.1.64/32 192.168.1.64/32' '172.16.5.9/20 172.16.0.0/20'; do
  set -- $c; echo "$1" > /tmp/ipaddr
  [ "$(lan1_cidr eth1)" = "$2" ] && ok "$1 → $2" || bad "$1 → $(lan1_cidr eth1)（要 $2）"
done
: > /tmp/ipaddr; [ -z "$(lan1_cidr eth1)" ] && ok "没有地址 → 空" || bad "没有地址 → $(lan1_cidr eth1)"

echo "== 2. local.yaml 里的摄像机地址"
cat > config/local.yaml <<'Y'
ntp:
  server: ""
camera:
  driver: restv1
  restv1: http://192.168.1.64
  onvif: ""
  user: admin
  password: "x@y"
  rtsp:
    visible: rtsp://admin:p%40ss@192.168.1.64:554/ch0
    thermal: "rtsp://192.168.1.65/ch1"
    visibleSub: ""
    thermalSub: ""
evidence:
  api: http://10.0.0.9
Y
h="$(cam_hosts | tr '\n' ' ')"
[ "$h" = "192.168.1.64 192.168.1.65 " ] && ok "取到 192.168.1.64、192.168.1.65（带账号的、带引号的都认；camera 段外的 10.0.0.9 不算）" || bad "cam_hosts：[$h]"

echo "== 3. 开（缺省）：chrony allow 网段 + 防火墙只放行摄像机地址"
echo 192.168.1.250/24 > /tmp/ipaddr; echo 'EG_LAN1=eth1' > .env
cam_ntp_apply eth1
grep -qx 'allow 192.168.1.0/24' "$CAM_NTP_CONF" && grep -qx 'local stratum 12' "$CAM_NTP_CONF" && ok "chrony：allow 192.168.1.0/24、local stratum 12" || bad "chrony 配置：$(cat "$CAM_NTP_CONF" 2>&1)"
fw_apply eth1 >/dev/null
r="$(grep -n 'udp dport 123' "$FW_NFT" || true)"
[ "$(grep -c 'udp dport 123' "$FW_NFT")" = 2 ] && grep -q 'ip saddr 192.168.1.64 udp dport 123 accept' "$FW_NFT" && grep -q 'ip saddr 192.168.1.65 udp dport 123 accept' "$FW_NFT" && ok "防火墙：两台摄像机各一条放行" || bad "防火墙放行：$r"
a="$(grep -n 'ip saddr 192.168.1.64' "$FW_NFT" | head -1 | cut -d: -f1 || true)"; d="$(grep -n 'counter drop comment "LAN1 新入站' "$FW_NFT" | cut -d: -f1 || true)"
[ -n "$a" ] && [ -n "$d" ] && [ "$a" -lt "$d" ] && ok "放行在「一律丢」之前（第 $a 行 < 第 $d 行）" || bad "顺序：放行 $a、丢 $d"
grep -q 'iifname "eth1" ct state established,related accept' "$FW_NFT" && ok "原来的「只出不进」规则还在" || bad "原规则丢了"
s="$(cam_ntp_status)"
grep -q '摄像机对时：开（chrony 192.168.1.0/24' <<<"$s" && grep -q '防火墙放行：192.168.1.64 192.168.1.65 → UDP 123' <<<"$s" && ok "--status：开、放行两台" || bad "--status：$s"
cp "$FW_NFT" /out/lan1-fw.nft

sn="$(security_notes 2>/dev/null)"
grep -q '摄像机对时放行' <<<"$sn" && bad "地址没改、放行一致，安全提醒却报了：$sn" || ok "放行一致：安全提醒不提"
mkdir -p /etc/systemd/system
grep -qx "PathChanged=$W/config/local.yaml" "$CAMNTP_PATH" 2>/dev/null && grep -qx 'Unit=lsa-eg-camntp.service' "$CAMNTP_PATH" && grep -qx "ExecStart=/bin/bash $W/install.sh --cam-ntp-sync" "$CAMNTP_SVC" 2>/dev/null \
  && ok "0.19.0：防火墙开、对时开 → 装了 lsa-eg-camntp.path（盯 local.yaml）/ .service（install.sh --cam-ntp-sync）" || bad "盯 local.yaml 的单元：$(cat "$CAMNTP_PATH" "$CAMNTP_SVC" 2>&1 | tr '\n' ' ')"
grep -q '改摄像机地址自动同步：开' <<<"$(cam_ntp_status)" && ok "--status：自动同步开" || bad "--status：$(cam_ntp_status)"
before="$(stat -c %Y "$CAMNTP_PATH")"; sleep 1; fw_apply eth1 >/dev/null
[ "$(stat -c %Y "$CAMNTP_PATH")" = "$before" ] && ok "再跑一次：单元内容没变就不重写" || bad "单元被无谓重写"
cam_ntp_sync; [ ! -s "$CAMNTP_LOG" ] && ok "--cam-ntp-sync，地址没变：什么都不做、不记日志" || bad "地址没变也同步了：$(cat "$CAMNTP_LOG")"

echo "== 4. 改了摄像机地址、没重跑（0.7.3，现场 192.168.1.19 → .180）：--status 与安全提醒都提示"
sed -i 's#http://192.168.1.64#http://192.168.1.66#; s#admin:p%40ss@192.168.1.64#admin:p%40ss@192.168.1.66#' config/local.yaml
s="$(cam_ntp_status)"
grep -q '摄像机对时放行跟当前摄像机地址不一致（改过地址？）：缺 192.168.1.66；还放行着旧地址 192.168.1.64 —— sudo bash install.sh --cam-ntp-on' <<<"$s" && ok "--status：缺 .66、还放行着旧的 .64、要 --cam-ntp-on" || bad "--status：$s"
[ "$(cam_ntp_drift)" = '192.168.1.66|192.168.1.64' ] && ok "cam_ntp_drift：缺 .66 | 多 .64" || bad "cam_ntp_drift：$(cam_ntp_drift)"
sn="$(security_notes 2>/dev/null)"
grep -q '摄像机对时放行跟当前摄像机地址不一致（缺 192.168.1.66；还放行着旧地址 192.168.1.64）' <<<"$sn" && ok "安全提醒：同一句" || bad "安全提醒：$sn"
cam_ntp_sync   # 0.19.0：lsa-eg-camntp.path 看到 local.yaml 变了就跑 install.sh --cam-ntp-sync
[ "$(cam_ntp_drift)" = '|' ] && ! grep -q '摄像机对时放行' <<<"$(security_notes 2>/dev/null)" && grep -q '防火墙放行：192.168.1.65 192.168.1.66 → UDP 123' <<<"$(cam_ntp_status)" && ok "--cam-ntp-sync（自动同步）以后：一致、不再提示" || bad "同步后：$(cam_ntp_drift) / $(cam_ntp_status)"
grep -q '摄像机地址变了，对时放行已同步：加上 192.168.1.66；去掉 192.168.1.64；现在放行 192.168.1.65 192.168.1.66' "$CAMNTP_LOG" && ok "同步记了一行日志：$(tail -1 "$CAMNTP_LOG" | cut -c21-)" || bad "日志：$(cat "$CAMNTP_LOG" 2>&1)"
echo 'EG_LAN1_FW=off' >> .env; sed -i 's#192.168.1.66#192.168.1.67#g' config/local.yaml; n0="$(wc -l < "$CAMNTP_LOG")"
cam_ntp_sync; [ "$(wc -l < "$CAMNTP_LOG")" = "$n0" ] && ok "防火墙关着（EG_LAN1_FW=off）：--cam-ntp-sync 不动" || bad "防火墙关着还同步了"
sed -i '/^EG_LAN1_FW=off$/d' .env; sed -i 's#192.168.1.67#192.168.1.66#g' config/local.yaml

echo "== 4b. 0.8.0 坏地址：保留原来的放行、记一行，防火墙不敞开"
good="$(cat "$FW_NFT")"; : > /tmp/calls
for badip in 192.168.1.300 192.168.1.3000 10.9.9.9; do
  sed -i -E "s#(thermal: \"rtsp://)[0-9.]+(/ch1\")#\1$badip\2#" config/local.yaml
  cam_ntp_sync
  [ "$(cat "$FW_NFT")" = "$good" ] && ! grep -q 'nft -f\|restart lsa-eg-fw' /tmp/calls && ok "$badip：防火墙规则原样、没 nft -f / restart" || bad "$badip：规则被动了"
done
grep -q '192.168.1.300（不是合法的 IPv4 地址' "$CAMNTP_LOG" && ok ".300 记了「不是合法的 IPv4」" || bad "日志：$(tail -3 "$CAMNTP_LOG")"
grep -q '192.168.1.3000（不是合法的 IPv4 地址' "$CAMNTP_LOG" && ! grep -q 'saddr 192.168.1.300 ' "$FW_NFT" && ok "超长 .3000：整段取、不截成 .300" || bad "超长的：$(tail -2 "$CAMNTP_LOG")"
grep -q '10.9.9.9（不在 LAN1 网段 192.168.1.0/24）' "$CAMNTP_LOG" && ok "不在网段的 10.9.9.9：拒" || bad "网段：$(tail -1 "$CAMNTP_LOG")"
grep -q '这些摄像机地址不放行对时：10.9.9.9（不在 LAN1 网段' <<<"$(cam_ntp_status)" && ok "--status 列出不放行的地址" || bad "--status：$(cam_ntp_status)"
n1="$(wc -l < "$CAMNTP_LOG")"; for i in 1 2 3 4 5 6 7 8 9 10; do cam_ntp_sync; done
[ "$(wc -l < "$CAMNTP_LOG")" = "$n1" ] && ok "连续触发 10 次（同一个坏地址）：不刷日志、不动防火墙" || bad "连续触发刷了 $(( $(wc -l < "$CAMNTP_LOG") - n1 )) 行"
mv config/local.yaml /tmp/local.bak; : > /tmp/calls; cam_ntp_sync
[ "$(cat "$FW_NFT")" = "$good" ] && grep -q 'local.yaml 里读不到摄像机地址：保留现有的对时放行' "$CAMNTP_LOG" && ok "local.yaml 不见了：放行留着（没删光）、记一行" || bad "local.yaml 缺失：$(tail -1 "$CAMNTP_LOG")"
mv /tmp/local.bak config/local.yaml
sed -i -E "s#(thermal: \"rtsp://)[0-9.]+(/ch1\")#\1192.168.1.65\2#" config/local.yaml
sed -i 's#192.168.1.66#192.168.1.68#g' config/local.yaml; touch /tmp/nft-bad; : > /tmp/calls
cam_ntp_sync
[ "$(cat "$FW_NFT")" = "$good" ] && [ ! -e "$FW_NFT.new" ] && grep -q '新的防火墙规则没通过检查' "$CAMNTP_LOG" && ok "新规则过不了 nft -c：原文件不动、临时文件删掉、记一行" || bad "nft -c 失败时：$(tail -1 "$CAMNTP_LOG")"
rm -f /tmp/nft-bad; : > /tmp/calls; cam_ntp_sync
grep -q 'saddr 192.168.1.68 udp dport 123' "$FW_NFT" && grep -q "nft -f $FW_NFT" /tmp/calls && ! grep -q 'restart lsa-eg-fw' /tmp/calls && ok "改对以后同步：nft -f 原子换，没 stop / restart" || bad "原子加载：$(tr '\n' ';' < /tmp/calls)"
sed -i 's#192.168.1.68#192.168.1.66#g' config/local.yaml; cam_ntp_sync
grep -qx 'TriggerLimitBurst=200' "$CAMNTP_PATH" && grep -qx 'StartLimitIntervalSec=0' "$CAMNTP_SVC" && ok "单元放宽限流：path TriggerLimitBurst=200、service StartLimitIntervalSec=0（连续保存不进 failed）" || bad "限流：$(cat "$CAMNTP_PATH" "$CAMNTP_SVC" | tr '\n' ' ')"
cam_ntp_unwatch; [ ! -e "$CAMNTP_PATH" ] && [ ! -e "$CAMNTP_SVC" ] && ok "cam_ntp_unwatch（回退到老版本时调）：单元撤掉" || bad "unwatch 没撤"
grep -q "grep -q 'lsa-eg-camntp' install.sh || { cam_ntp_unwatch" "$SRC" && ok "回退：老版本 install.sh 不认 lsa-eg-camntp 就撤掉" || bad "回退没撤单元"
fw_apply eth1 >/dev/null

echo "== 5. 关（EG_CAM_NTP=off）"
echo 'EG_CAM_NTP=off' >> .env
cam_ntp_apply eth1; fw_apply eth1 >/dev/null
[ ! -f "$CAM_NTP_CONF" ] && ok "chrony 配置撤掉" || bad "关了还有 $CAM_NTP_CONF"
grep -q 'udp dport 123' "$FW_NFT" && bad "关了防火墙还放行" || ok "防火墙不再放行"
grep -q '摄像机对时：关' <<<"$(cam_ntp_status)" && ok "--status：关" || bad "--status：$(cam_ntp_status)"
[ ! -e "$CAMNTP_PATH" ] && [ ! -e "$CAMNTP_SVC" ] && ok "对时关了：盯 local.yaml 的单元撤掉" || bad "对时关了单元还在"

echo "== 6. 没有摄像机地址、LAN1 没地址"
echo 'EG_LAN1=eth1' > .env; printf 'camera:\n  restv1: ""\n' > config/local.yaml
cam_ntp_apply eth1; fw_apply eth1 >/dev/null
grep -q 'udp dport 123' "$FW_NFT" && bad "没有摄像机地址也放行了" || ok "没有摄像机地址：防火墙不放行"
grep -q 'local.yaml 里还没有摄像机地址' <<<"$(cam_ntp_status)" && ok "--status 提示去填摄像机地址" || bad "--status：$(cam_ntp_status)"
: > /tmp/ipaddr; out="$(cam_ntp_apply eth1)"
[ ! -f "$CAM_NTP_CONF" ] && grep -q '还没有 IPv4 地址' <<<"$out" && ok "LAN1 没地址：先不开、说清楚" || bad "LAN1 没地址：$out"
rm -f /etc/lsa-eg/lan1-fw.nft; out="$(cam_ntp_apply '')"; [ ! -f "$CAM_NTP_CONF" ] && ok "没给过 --lan1：不开" || bad "没 --lan1：$out"

echo "== 7. 还没开时 --status 的说法（0.7.1）"
rm -f "$CAM_NTP_CONF" config/eg.yaml; echo 'EG_LAN1=eth1' > .env; echo 192.168.100.1/24 > /tmp/ipaddr
printf 'camera:\n  driver: restv1\n  restv1: http://192.168.100.64\n' > config/local.yaml
s="$(cam_ntp_status)"
grep -q '摄像机对时：待接入，接入子站后自动打开（LAN1 eth1；防火墙已为摄像机 192.168.100.64 放行）' <<<"$s" && ! grep -q 'IPv4' <<<"$s" && ok "待接入（没有 eg.yaml）：说接入后自动打开，不问 IPv4" || bad "待接入：$s"
echo 'schema: 2' > config/eg.yaml; : > /tmp/ipaddr
grep -q '没有 IPv4 地址：netplan' <<<"$(cam_ntp_status)" && ok "已接入、LAN1 真没地址：提示配 netplan" || bad "已接入没地址：$(cam_ntp_status)"
echo 192.168.100.1/24 > /tmp/ipaddr
s="$(cam_ntp_status)"; grep -q '没开（sudo bash install.sh --cam-ntp-on 打开）' <<<"$s" && ok "已接入、有地址、还没开：提示 --cam-ntp-on" || bad "$s"
rm -f config/eg.yaml

echo
[ "$fail" = 0 ] && echo "== 通过（$n 项）" || { echo "== 有失败项"; exit 1; }
EOS
if [ -n "$NFTBOX" ]; then
  echo "== 真 nft -c 查语法（$NFTBOX，只检查、不加载）"
  docker cp "$(cd "$OUT" && (pwd -W 2>/dev/null || pwd))/lan1-fw.nft" "$NFTBOX:/tmp/lan1-fw-check.nft" >/dev/null
  if docker exec "$NFTBOX" nft -c -f /tmp/lan1-fw-check.nft; then echo "  ✓ nft -c 通过"; else echo "  ✗ nft -c 不过"; exit 1; fi
fi
