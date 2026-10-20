#!/bin/bash
# field-install-egs.sh 编排测试（在一次性 ubuntu:24.04 里跑，入口 deploy/test/field-install-test.sh）。
# 子站侧是真脚本；网络、EG 都是假的：bin/ssh（按地址找假 EG、主机密钥、口令认证）、bin/tcp（端口通不通 + 机架队列自动「插上」下一台）、
# bin-eg/（EG 上的 sudo / ip / netplan / hostname）；安装文件 = 真的 deploy/bundle/stub.sh + 假负载（setup.sh 记参数、写待接入状态）。
set -uo pipefail
T=/d/sp/field-install-egs.sh
H=/d/test/field-install
PW='Fld-test-pw-0x7Q'          # 测试口令（只为测试；跑完核对任何文件里都没有它，除了 /fake/pw）
fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; [ -n "${out:-}" ] && tail -8 <<< "$out" | sed "s/^/      | /"; }
chk() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

rm -rf /fake; mkdir -p /fake/eg /fake/sd
printf '%s\n' "$PW" > /fake/pw; : > /fake/rack
export PATH="$H/bin:$PATH" LSA_FIELD_TCP="$H/bin/tcp" LSA_FIELD_REVERT_S=4 LSA_FIELD_RECONNECT_S=8 LSA_FIELD_POLL_S=1
JK_BODY='LSAJOIN1 192.168.10.2 ssh-ed25519 AAAAtunnelkeyfake ssh-ed25519 AAAAupgradekeyfake'
JK="$JK_BODY $(printf '%s' "$JK_BODY" | sha256sum | cut -c1-8)"

# mk_eg <id> <SN> [主机密钥]：假 EG（出厂状态：两个网口 enp1s0 / enp2s0，LAN2 = enp2s0 192.168.1.250/24，没插上）
mk_eg() {
  local d="/fake/eg/$1"
  mkdir -p "$d/home" "$d/root/etc/netplan" "$d/root/var/tmp"
  echo "lsaeg-$2" > "$d/hostname"
  echo "ssh-ed25519 ${3:-AAAAC3Nza$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')}" > "$d/hostkey"
  printf 'enp1s0 00:11:22:%s:01\nenp2s0 00:11:22:%s:02\n' "${1: -2}" "${1: -2}" > "$d/nics"
  echo 'enp2s0 192.168.1.250/24' > "$d/addr.init"
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$d/root/etc/machine-id"
  printf 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\n' > "$d/root/etc/os-release"
  printf 'network:\n  version: 2\n  ethernets:\n    enp2s0:\n      dhcp4: false\n      addresses: [192.168.1.250/24]\n      optional: true\n    enp1s0:\n      dhcp4: false\n      optional: true\n' > "$d/root/etc/netplan/50-lsa-eg.yaml"
}
plug() { echo "$1" >> /fake/rack; }
fis() { LSA_EG_PW="$PW" timeout 300 bash "$T" --state-dir /fake/sd --join-key "$JK" "$@" < /dev/null; }
phase() { sed -n 's/^phase=//p' "/fake/sd/$1/state" 2>/dev/null | tail -1; }

echo '== 准备：安装文件（真 stub.sh + 假负载 12 MB）'
W=/tmp/mkrun; rm -rf "$W"; mkdir -p "$W/lsa9600sp-bundle"
cat > "$W/lsa9600sp-bundle/setup.sh" <<'EOF'
#!/bin/bash
# 假 setup.sh：记参数、写「待接入」；$FAKE_EG/fail-install 时失败
R="${LSA_FIELD_ROOT:-}"
echo "假 setup.sh $*"
[ -f "$FAKE_EG/fail-install" ] && { echo '错误：假装这一步装失败了'; exit 1; }
while [ $# -gt 0 ]; do case "$1" in --lan1) L1="$2"; shift ;; --join-key) JK="$2"; shift ;; esac; shift; done
mkdir -p "$R/opt/lsa-eg/config"
printf '%s\n' "lan1=$L1" "jk=$JK" > "$R/opt/lsa-eg/args"
echo 0.7.1-fake > "$R/opt/lsa-eg/VERSION"
printf '{"sp": "%s"}\n' "$(awk '{ print $2 }' <<< "$JK")" > "$R/opt/lsa-eg/config/join.json"
printf '%s\n' '#!/bin/bash' 'R="${LSA_FIELD_ROOT:-}"; sp="$(sed -n "s/.*\"sp\": \"\([^\"]*\)\".*/\1/p" "$R/opt/lsa-eg/config/join.json")"' \
  'echo "接入：待接入 —— 已授权子站 $sp（假），等子站 join-egs.sh"' > "$R/opt/lsa-eg/install.sh"
sleep 2
echo '假 setup.sh 装好了'
EOF
head -c 12000000 /dev/urandom > "$W/lsa9600sp-bundle/pad.bin"
tar -C "$W" -cf "$W/payload.tar" lsa9600sp-bundle
mkdir -p /rel; cat /d/bundle/stub.sh "$W/payload.tar" > /rel/LSA-9600SP-test.run
RUN=/rel/LSA-9600SP-test.run
echo "  $(stat -c %s $RUN) 字节"

cat > /fake/plan.tsv <<'EOF'
# SN          LAN2 正式地址/前缀    网关           单元号   LAN1 网口
SNA001        192.168.10.31/24      192.168.10.1   1G-A     enp1s0
SNA002        192.168.10.32/24      -              1G-B     -
SNA003,192.168.10.33/24,192.168.10.1,DP1-A,-
SNB001        192.168.10.41/24      192.168.10.1   T-A      enp2s0
SNB002        192.168.10.42/24      192.168.10.1   T-B      -
SNB003        192.168.10.43/24      192.168.10.1   T-C      -
SNB004        192.168.10.44/24      192.168.10.1   -        -
SNB005        192.168.10.45/24      192.168.10.1   T-E      -
EOF

echo; echo '== 1. 分配表校验'
printf 'X1 192.168.10.5/24\nX1 192.168.10.6/24\n' > /fake/p-dup.tsv
out="$(fis --plan /fake/p-dup.tsv --status 2>&1)"; chk "SN 重复拒绝" '[[ "$out" == *"出现了两次"* ]]'
printf 'X1 192.168.10.5/24\nX2 192.168.10.5/24\n' > /fake/p-dup.tsv
out="$(fis --plan /fake/p-dup.tsv --status 2>&1)"; chk "地址重复拒绝" '[[ "$out" == *"分给了两台"* ]]'
printf 'X1 192.168.1.250/24\n' > /fake/p-dup.tsv
out="$(fis --plan /fake/p-dup.tsv --status 2>&1)"; chk "用 .250 当正式地址拒绝" '[[ "$out" == *"出厂临时地址"* ]]'
printf 'X1 192.168.10.5\n' > /fake/p-dup.tsv
out="$(fis --plan /fake/p-dup.tsv --status 2>&1)"; chk "地址不带前缀拒绝" '[[ "$out" == *"地址/前缀"* ]]'
out="$(LSA_EG_PW="$PW" bash "$T" --state-dir /fake/sd --plan /fake/plan.tsv --run $RUN --join-key "${JK%?}0" < /dev/null 2>&1)"
chk "join-key 校验位不对拒绝" '[[ "$out" == *"校验不对"* ]]'

echo; echo '== 2. 连续 3 台（机架队列：插一台、改好地址自动插下一台；SNA002 推送中途断一次、SNA003 收到的 sha 不对一次）'
mk_eg a1 SNA001; mk_eg a2 SNA002; mk_eg a3 SNA003
echo 5000000 > /fake/eg/a2/cut_once; touch /fake/eg/a3/wrongsha_once
plug a1; plug a2; plug a3
t0=$(date +%s)
fis --plan /fake/plan.tsv --run $RUN --yes --count 3 --parallel 2 > /fake/t2.out 2>&1; rc=$?
echo "  （用时 $(( $(date +%s) - t0 )) s，退出码 $rc）"
chk "退出码 0" '[ "$rc" = 0 ]'
for s in SNA001 SNA002 SNA003; do chk "$s 待接入" '[ "$(phase $s)" = pending ]'; done
chk "SNA001 地址：LAN2 .31、LAN1 192.168.100.1/24" 'grep -qx "enp2s0 192.168.10.31/24" /fake/eg/a1/addr && grep -qx "enp1s0 192.168.100.1/24" /fake/eg/a1/addr'
chk "SNA001 netplan：缺省路由、LAN1 ignore-carrier、600" 'grep -q "routes: \[{to: default, via: 192.168.10.1}\]" /fake/eg/a1/root/etc/netplan/50-lsa-eg.yaml && grep -q "ignore-carrier: true" /fake/eg/a1/root/etc/netplan/50-lsa-eg.yaml && [ "$(stat -c %a /fake/eg/a1/root/etc/netplan/50-lsa-eg.yaml)" = 600 ]'
chk "SNA002 网关 -：没有缺省路由" '! grep -q routes /fake/eg/a2/root/etc/netplan/50-lsa-eg.yaml'
chk "出厂 netplan 留在 /var/lib/lsa-field/netplan.orig" 'grep -q 192.168.1.250 /fake/eg/a1/root/var/lib/lsa-field/netplan.orig/50-lsa-eg.yaml'
chk "SNA002 LAN1 自动认成 enp1s0、join-key 原样传给 .run" 'grep -qx "lan1=enp1s0" /fake/eg/a2/root/opt/lsa-eg/args && grep -qxF "jk=$JK" /fake/eg/a2/root/opt/lsa-eg/args'
chk "SNA002 推送断了以后续传" 'grep -q "续传" /fake/sd/SNA002/log'
chk "SNA003 sha 不对删掉重推" 'grep -q "sha256 不对.*删掉重推" /fake/sd/SNA003/log'
chk "EG 上的 .run 拷贝装完删掉" '! ls /fake/eg/a*/root/var/tmp/lsa-field/*.run 2>/dev/null | grep -q .'
chk "自动换回没触发（确认后撤了）" 'sleep 5; ! ls /fake/eg/a*/root/var/lib/lsa-field/revert.log 2>/dev/null | grep -q .'
chk "每台只口令认证一次（ControlMaster），.250 与正式地址各一次" '[ "$(grep -c " 192.168.1.250$" /fake/eg/a1/auth.log)" = 1 ] && [ "$(grep -c " 192.168.10.31$" /fake/eg/a1/auth.log)" -le 2 ]'
chk "主机密钥按 SN 钉住" 'grep -q "^lsaeg-SNA001 ssh-ed25519 " /fake/sd/SNA001/known_hosts'
chk "join 清单 3 行" '[ "$(grep -vc "^#" /fake/sd/join-list.txt)" = 3 ] && grep -qx "1G-B 192.168.10.32" /fake/sd/join-list.txt'
chk "后台安装和下一台改地址并行（SNA002 开始装早于 SNA003 改好地址）" '[ "$(grep -n "\[SNA002\] 开始安装" /fake/t2.out | cut -d: -f1)" -lt "$(grep -n "\[SNA003\] 地址已改好" /fake/t2.out | cut -d: -f1)" ]'
grep -E '^\S+ \S+ \[' /fake/t2.out | sed 's/^/    /' | head -40

echo; echo '== 3. --status'
out="$(fis --plan /fake/plan.tsv --status 2>&1)"
chk "全表：3 台待接入、5 台没做" '[ "$(grep -c 待接入 <<< "$out")" -ge 3 ] && [ "$(grep -c 没做 <<< "$out")" = 5 ]'

echo; echo '== 4. 不在分配表里的机器（--once）'
mk_eg x1 NOPE99; plug x1
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "报「不在分配表里」、不改地址" '[[ "$out" == *"不在分配表里"* ]] && grep -q 192.168.1.250 /fake/eg/x1/addr'
rm -f /fake/eg/x1/addr

echo; echo '== 5. 分配表的 LAN1 正是持有 .250 的口（插反）'
mk_eg b1 SNB001; plug b1
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "停下、退出码非 0、不改地址" '[ "$rc" != 0 ] && [[ "$out" == *"插反"* ]] && grep -q 192.168.1.250 /fake/eg/b1/addr && [ "$(phase SNB001)" = failed-a ]'
rm -f /fake/eg/b1/addr

echo; echo '== 6. 新地址连不回来 → EG 自动换回 .250；修好后重做'
mk_eg b2 SNB002; touch /fake/eg/b2/badnet; plug b2
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "报连不回来、记失败" '[ "$rc" != 0 ] && [[ "$out" == *"连不回来"* ]] && [ "$(phase SNB002)" = failed-a ]'
sleep 6
chk "${LSA_FIELD_REVERT_S} s 后自动换回 .250（netplan 原文件恢复）" 'grep -qx "enp2s0 192.168.1.250/24" /fake/eg/b2/addr && grep -q 192.168.1.250 /fake/eg/b2/root/etc/netplan/50-lsa-eg.yaml && [ -s /fake/eg/b2/root/var/lib/lsa-field/revert.log ]'
rm -f /fake/eg/b2/badnet
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "修好网络后重做：待接入" '[ "$rc" = 0 ] && [ "$(phase SNB002)" = pending ] && grep -qx "enp2s0 192.168.10.42/24" /fake/eg/b2/addr'

echo; echo '== 7. 克隆没换主机密钥（和 SNA001 同一把）：提醒、照做'
mk_eg b3 SNB003 "$(cut -d' ' -f2 /fake/eg/a1/hostkey)"; plug b3
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "提醒克隆、照样装好" '[[ "$out" == *"克隆后没换主机密钥"* ]] && [ "$(phase SNB003)" = pending ]'

echo; echo '== 8. --readdress-only，再 --resume 装'
mk_eg b4 SNB004; plug b4
out="$(fis --plan /fake/plan.tsv --yes --once --readdress-only 2>&1)"; rc=$?
chk "只改地址：地址已改、没装" '[ "$rc" = 0 ] && [ "$(phase SNB004)" = readdressed ] && [ ! -f /fake/eg/b4/root/opt/lsa-eg/args ]'
out="$(fis --plan /fake/plan.tsv --run $RUN --resume 2>&1)"; rc=$?
chk "--resume：待接入；分配表没写单元号的不进 join 清单（注释行）" '[ "$rc" = 0 ] && [ "$(phase SNB004)" = pending ] && grep -q "^# SNB004 192.168.10.44" /fake/sd/join-list.txt'

echo; echo '== 9. 安装失败 → --resume 重装'
mk_eg b5 SNB005; touch /fake/eg/b5/fail-install; plug b5
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "安装失败：退出码非 0、记 failed-b、日志里有 setup.sh 的输出" '[ "$rc" != 0 ] && [ "$(phase SNB005)" = failed-b ] && grep -q "假装这一步装失败了" /fake/sd/SNB005/log'
rm -f /fake/eg/b5/fail-install
out="$(fis --plan /fake/plan.tsv --run $RUN --resume 2>&1)"; rc=$?
chk "--resume 重装：待接入" '[ "$rc" = 0 ] && [ "$(phase SNB005)" = pending ]'

echo; echo '== 10. 换了机器（同 SN、主机密钥不同）：停下；--redo 后重做'
mk_eg b6 SNB004; plug b6
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "主机密钥变了：停下" '[ "$rc" != 0 ] && [[ "$out" == *"主机密钥和上次记下的不一样"* ]]'
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once --redo SNB004 2>&1)"; rc=$?
chk "--redo 后重做：正式地址 .44 上原来那台还在 → 地址冲突、停下" '[ "$rc" != 0 ] && [[ "$out" == *"已经有机器应答"* ]]'
rm -f /fake/eg/b4/addr
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "拿走旧机后：新机待接入" '[ "$rc" = 0 ] && [ "$(phase SNB004)" = pending ] && grep -qx "enp2s0 192.168.10.44/24" /fake/eg/b6/addr'

echo; echo '== 11. 口令不对'
mk_eg c1 SNC001; plug c1; echo 'SNC001 192.168.10.51/24 192.168.10.1 C-A -' >> /fake/plan.tsv
out="$(LSA_EG_PW=wrong-pw bash "$T" --state-dir /fake/sd --join-key "$JK" --plan /fake/plan.tsv --run $RUN --yes --once < /dev/null 2>&1)"; rc=$?
chk "认证失败：退出码非 0、说 Permission denied、什么都没改" '[ "$rc" != 0 ] && [[ "$out" == *"Permission denied"* ]] && grep -q 192.168.1.250 /fake/eg/c1/addr'

rm -f /fake/eg/c1/addr

echo; echo '== 11a. .250 上同时有两台（ARP 表里还有别的 MAC）'
mk_eg c2 SNC002; plug c2; echo 'SNC002 192.168.10.52/24 192.168.10.1 C-B -' >> /fake/plan.tsv
echo 'aa:bb:cc:dd:ee:ff' > /fake/dup250
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "停下、说清另一个 MAC、不改地址" '[ "$rc" != 0 ] && [[ "$out" == *"不止这一台"*"aa:bb:cc:dd:ee:ff"* ]] && grep -q 192.168.1.250 /fake/eg/c2/addr'
rm -f /fake/dup250
out="$(fis --plan /fake/plan.tsv --run $RUN --yes --once 2>&1)"; rc=$?
chk "另一台拿走后：待接入" '[ "$rc" = 0 ] && [ "$(phase SNC002)" = pending ]'

echo; echo '== 11b. 站内网段就在 192.168.1.x：提醒'
printf 'X1 192.168.1.31/24 192.168.1.1\n' > /fake/p-same.tsv
out="$(fis --plan /fake/p-same.tsv --status 2>&1)"
chk "提醒同一段、建议单独交换机" '[[ "$out" == *"同一段"*"单独的交换机"* ]]'

echo; echo '== 12. 口令没落盘'
hits="$(grep -rlF -- "$PW" /fake /tmp /var /root /home /etc /rel 2>/dev/null | grep -vx /fake/pw || true)"
chk "除了 /fake/pw，任何文件里都没有口令" '[ -z "$hits" ]'
[ -z "$hits" ] || echo "$hits" | sed 's/^/    /'
chk "临时目录（askpass、控制连接）退出后删掉" '! ls -d /tmp/lsa-field.* 2>/dev/null | grep -q .'

echo
if [ "$fail" = 0 ]; then echo '== 全部通过'; else echo '== 有失败（见上面 ✗）'; fi
exit "$fail"
