#!/bin/bash
# 摄像机对时（0.7.x，S19）回归：install.sh 的 lan1_cidr / cam_hosts / cam_ntp_apply / fw_apply / cam_ntp_status。
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
printf '#!/bin/sh\n[ "$1" = list ] && cat /etc/lsa-eg/lan1-fw.nft 2>/dev/null\nexit 0\n' > bin/nft
printf '#!/bin/sh\nexit 0\n' > bin/systemctl
chmod +x bin/*; export PATH="$W/bin:$PATH"
: > .env
SRC=/d/eg/install.sh
grep -E '^(FW_NFT|FW_UNIT|CAM_NTP_CONF)=' "$SRC" > fn.sh
for fn in cam_ntp_on cam_hosts lan1_cidr cam_ntp_apply cam_ntp_status; do awk "/^${fn}\\(\\) \\{/,/^\\}/" "$SRC" >> fn.sh; done
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

echo "== 4. 改了摄像机地址、没重跑：--status 提示"
sed -i 's#http://192.168.1.64#http://192.168.1.66#; s#admin:p%40ss@192.168.1.64#admin:p%40ss@192.168.1.66#' config/local.yaml
s="$(cam_ntp_status)"
grep -q '摄像机地址 192.168.1.66 没放行（' <<<"$s" && ok "提示 192.168.1.66 没放行、要 --cam-ntp-on" || bad "--status：$s"

echo "== 5. 关（EG_CAM_NTP=off）"
echo 'EG_CAM_NTP=off' >> .env
cam_ntp_apply eth1; fw_apply eth1 >/dev/null
[ ! -f "$CAM_NTP_CONF" ] && ok "chrony 配置撤掉" || bad "关了还有 $CAM_NTP_CONF"
grep -q 'udp dport 123' "$FW_NFT" && bad "关了防火墙还放行" || ok "防火墙不再放行"
grep -q '摄像机对时：关' <<<"$(cam_ntp_status)" && ok "--status：关" || bad "--status：$(cam_ntp_status)"

echo "== 6. 没有摄像机地址、LAN1 没地址"
echo 'EG_LAN1=eth1' > .env; printf 'camera:\n  restv1: ""\n' > config/local.yaml
cam_ntp_apply eth1; fw_apply eth1 >/dev/null
grep -q 'udp dport 123' "$FW_NFT" && bad "没有摄像机地址也放行了" || ok "没有摄像机地址：防火墙不放行"
grep -q 'local.yaml 里还没有摄像机地址' <<<"$(cam_ntp_status)" && ok "--status 提示去填摄像机地址" || bad "--status：$(cam_ntp_status)"
: > /tmp/ipaddr; out="$(cam_ntp_apply eth1)"
[ ! -f "$CAM_NTP_CONF" ] && grep -q '还没有 IPv4 地址' <<<"$out" && ok "LAN1 没地址：先不开、说清楚" || bad "LAN1 没地址：$out"
rm -f /etc/lsa-eg/lan1-fw.nft; out="$(cam_ntp_apply '')"; [ ! -f "$CAM_NTP_CONF" ] && ok "没给过 --lan1：不开" || bad "没 --lan1：$out"

echo
[ "$fail" = 0 ] && echo "== 通过（$n 项）" || { echo "== 有失败项"; exit 1; }
EOS
if [ -n "$NFTBOX" ]; then
  echo "== 真 nft -c 查语法（$NFTBOX，只检查、不加载）"
  docker cp "$(cd "$OUT" && (pwd -W 2>/dev/null || pwd))/lan1-fw.nft" "$NFTBOX:/tmp/lan1-fw-check.nft" >/dev/null
  if docker exec "$NFTBOX" nft -c -f /tmp/lan1-fw-check.nft; then echo "  ✓ nft -c 通过"; else echo "  ✗ nft -c 不过"; exit 1; fi
fi
