#!/bin/bash
# field-install-egs.sh 对真一键安装文件的安装段验收：特权 ubuntu:24.04 当「EG」（同 fresh-install.sh：systemctl 替身、安装文件自带的 Docker），
# 跑真脚本的阶段 B（--resume）：推 3 GB .run（经假 ssh 到本机）→ EG 上后台 .run --role eg --lan1 eth0 --join-key … --yes → 核对「待接入」→ 删拷贝。
# 阶段 A（在 .250 上改地址）事先当成做完了（state 里写好 readdressed、地址 127.0.0.1）—— 改地址的编排在 field-install-test.sh 里测。
#   bash deploy/test/field-install-real.sh <一键安装文件 .run> [--keep]
# 不下载任何东西。和真机的差别：没有 systemd（install 用 setsid nohup 的那条路）、没有 sshd / sudo（假的，口令照样从 stdin 喂）、
# 容器没有物理网口（install.sh 不加 --force 不收 --lan1：沙箱里 EG 上设 LSA_FIELD_RUN_FORCE=1）；镜像没有 sudo 包（给 /etc/sudoers.d 和 visudo 替身）。
set -uo pipefail
RUNFILE="${1:?用法：field-install-real.sh <安装文件 .run> [--keep]}"
KEEP=0; for a in "$@"; do [ "$a" = --keep ] && KEEP=1; done
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
RUNDIR="$(cd "$(dirname "$RUNFILE")" && { pwd -W 2>/dev/null || pwd; })"
RUN="$(basename "$RUNFILE")"
D=egfield
PW='Fld-real-pw-3Kd'
fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
os() { docker exec "$D" "$@"; }
cleanup() { if [ "$KEEP" = 1 ]; then echo "沙箱留着：docker exec -it $D bash（删：docker rm -f -v $D）"; else docker rm -f -v "$D" >/dev/null 2>&1 && echo "沙箱已删"; fi; }
trap cleanup EXIT

echo "== 0. 沙箱 $D（特权 ubuntu:24.04，主机名 lsaeg-SNR001）"
docker rm -f -v "$D" >/dev/null 2>&1
docker run -d --pull never --privileged --name "$D" --hostname lsaeg-SNR001 -v /var/lib/docker -v /var/lib/containerd \
  -v "$RUNDIR:/rel:ro" -v "$ROOT/deploy:/deploy:ro" ubuntu:24.04 sleep infinity >/dev/null || { echo '起不了沙箱' >&2; exit 1; }
os sh -c 'cp -r /deploy /d && find /d -type f \( -name "*.sh" -o -path "*/bin/*" -o -path "*/bin-eg/*" \) -exec sed -i "s/\r$//" {} + && chmod +x /d/test/field-install/bin/* /d/test/field-install/bin-eg/*'
os sh -c 'printf "#!/bin/sh\nexit 101\n" > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d'
# systemctl 替身：原样取 fresh-install.sh 里那一份
awk '/cat > \/usr\/local\/bin\/systemctl/ { f = 1; next } f && /^EOF$/ { exit } f' "$(dirname "$0")/fresh-install.sh" | docker exec -i "$D" sh -c 'cat > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl'
docker exec -i "$D" bash -s "$PW" <<'EOF'
set -e
# ubuntu:24.04 镜像没有 sudo 包（真机 Ubuntu Server 有）：install.sh --join-key 要写 /etc/sudoers.d/lsa-upg、用 visudo -cf 查 —— 给目录和一个只答「语法对」的 visudo 替身
mkdir -p /etc/sudoers.d && chmod 750 /etc/sudoers.d
printf '#!/bin/sh\n# 沙箱替身（field-install-real.sh）：不查语法\nexit 0\n' > /usr/local/sbin/visudo && chmod +x /usr/local/sbin/visudo
mkdir -p /fake/eg/r1 /fake/sd/SNR001 /fake/bin-real
printf '%s\n' "$1" > /fake/pw
cp /d/test/field-install/bin-eg/sudo /fake/bin-real/sudo
touch /fake/eg/r1/real
echo 'lo 127.0.0.1/8' > /fake/eg/r1/addr
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForSandboxOnly0000000000000' > /fake/eg/r1/hostkey
echo 'SNR001 127.0.0.1/8 - R-A eth0' > /fake/plan.tsv
# 阶段 A 当成做完：地址已改、主机密钥已钉住
echo "lsaeg-SNR001 $(cat /fake/eg/r1/hostkey)" > /fake/sd/SNR001/known_hosts
printf '%s\n' phase=readdressed hostname=lsaeg-SNR001 lan2=eth0 lan1=eth0 addr=127.0.0.1/8 gw=- > /fake/sd/SNR001/state
EOF
echo "  $(os sh -c '. /etc/os-release; echo $PRETTY_NAME')；docker：$(os sh -c 'command -v docker || echo 没有')；/opt/lsa-eg：$(os sh -c 'ls -A /opt/lsa-eg 2>/dev/null | wc -l') 个文件"

JKB='LSAJOIN1 192.168.10.2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeTunnelKeyForSandbox00000000000000000 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeUpgradeKeyForSandbox0000000000000000'
JK="$JKB $(printf '%s' "$JKB" | sha256sum | cut -c1-8)"
echo; echo "== 1. field-install-egs.sh --resume（$RUN）"
t0=$(date +%s)
docker exec -e LSA_EG_PW="$PW" -e LSA_FIELD_POLL_S=10 "$D" bash -c \
  'PATH=/d/test/field-install/bin:$PATH bash /d/sp/field-install-egs.sh --state-dir /fake/sd --plan /fake/plan.tsv --run "/rel/$1" --join-key "$2" --resume < /dev/null' _ "$RUN" "$JK" > /tmp/egfield-run.log 2>&1; rc=$?
sed 's/^/    /' /tmp/egfield-run.log | tail -25
[ "$rc" = 0 ] && ok "退出码 0（$(( $(date +%s) - t0 )) s）" || bad "退出码 $rc"

echo; echo '== 2. 核对'
ph="$(os sed -n 's/^phase=//p' /fake/sd/SNR001/state | tail -1)"
[ "$ph" = pending ] && ok '记「待接入」' || bad "阶段 $ph"
st="$(os bash /opt/lsa-eg/install.sh --status 2>&1)"
grep -q '接入：待接入 —— 已授权子站 192.168.10.2' <<< "$st" && ok "install.sh --status：$(grep -m1 '接入：' <<< "$st")" || bad "install.sh --status 没有待接入：$(grep -m1 '接入：' <<< "$st")"
os grep -q '"sp": "192.168.10.2"' /opt/lsa-eg/config/join.json && ok 'config/join.json 子站 192.168.10.2' || bad '没有 join.json'
os grep -qx 'EG_LAN1=eth0' /opt/lsa-eg/.env && ok '--lan1 eth0 记进 .env' || bad '.env 里没有 EG_LAN1=eth0'
os docker ps --format '{{.Names}}' | grep -qx lsa-eg-pending && ok '待接入页容器 lsa-eg-pending 在跑' || bad '待接入页没起'
os bash -c 'exec 3<>/dev/tcp/127.0.0.1/80' 2>/dev/null && ok '80 口通' || bad '80 口不通'
os sh -c 'ls /var/tmp/lsa-field/*.run 2>/dev/null' | grep -q . && bad 'EG 上的 .run 拷贝没删' || ok 'EG 上的 .run 拷贝已删'
os grep -q '待接入' /fake/sd/SNR001/log && ok "EG 上的安装输出拉回了这台的日志（$(os sh -c 'wc -l < /fake/sd/SNR001/log') 行）" || bad '这台的日志里没有安装输出'
os cat /fake/sd/SNR001/log > /tmp/egfield-SNR001.log 2>/dev/null
[ "$fail" = 0 ] || { echo '  --- 这台的日志（最后 40 行，全文 /tmp/egfield-SNR001.log）'; tail -40 /tmp/egfield-SNR001.log | sed 's/^/    /'; }
hits="$(os sh -c "grep -rlF -- '$PW' /fake /var/lib/lsa-field /opt/lsa-eg /root /tmp /var/tmp 2>/dev/null | grep -vx /fake/pw" || true)"
[ -z "$hits" ] && ok '口令没落盘（除 /fake/pw）' || bad "口令出现在：$hits"
echo
[ "$fail" = 0 ] && echo '== 全部通过' || echo '== 有失败'
exit "$fail"
