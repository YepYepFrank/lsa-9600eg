#!/bin/bash
# 装错机器 / 参数不对时「什么都不动地退出」（0.19.3 / EG 0.8.3，现场 10-29：.run --role eg --lan1 enp1s0 误在子站主机上跑，
# install.sh 查网口退出前已经拷了 /opt/lsa-eg、写了 .env、导了镜像、改了 journald）。
#
#   bash deploy/test/role-guard-test.sh            （开发机 Git Bash，Docker 起着；用本机已有的 ubuntu:24.04，不下载）
#
# 一次性容器里跑一键包的 setup.sh（假安装目录：只有 setup.sh、VERSION 和一个校验文件）与 EG 的 install.sh：
#   setup.sh --role eg 遇到 /opt/lsa9600sp → 拒；--force 放过这一关
#   setup.sh --role sp 遇到 /opt/lsa-eg → 拒；--force 放过这一关
#   setup.sh --role eg --lan1 <没有的网口> → 拒
#   install.sh 遇到 /opt/lsa9600sp → 拒；--lan1 <没有的网口> → 拒；--lan1 唯一的网口 → 拒
#   每一种拒绝之后：/opt/lsa-eg、/etc/systemd/journald.conf.d/lsa-eg.conf、.env 都没出现
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export MSYS_NO_PATHCONV=1
D=lsa-role-guard
docker rm -f "$D" >/dev/null 2>&1 || true
docker run -d --pull never --name "$D" -v "$(cd "$ROOT/deploy" && (pwd -W 2>/dev/null || pwd)):/deploy:ro" ubuntu:24.04 sleep infinity >/dev/null || exit 1
trap 'docker rm -f "$D" >/dev/null 2>&1' EXIT
docker exec -i "$D" bash -s <<'IN'
set -uo pipefail
n_ok=0; fail=0
ok() { echo "  ✓ $*"; n_ok=$((n_ok + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
untouched() { [ ! -e /opt/lsa-eg ] && [ ! -e /etc/systemd/journald.conf.d/lsa-eg.conf ] && [ ! -e /w/e/.env ]; }
# 假一键包目录
mkdir -p /w/b /w/e
sed 's/\r$//' /deploy/bundle/setup.sh > /w/b/setup.sh
echo '0.0.0-test' > /w/b/VERSION; echo x > /w/b/x; (cd /w/b && sha256sum x > SHA256SUMS)
sed 's/\r$//' /deploy/eg/install.sh > /w/e/install.sh; echo '0.0.0-test' > /w/e/VERSION
sb() { (cd /w/b && bash setup.sh "$@" < /dev/null 2>&1); }
ie() { (cd /w/e && bash install.sh "$@" < /dev/null 2>&1); }

echo '== 一键包 setup.sh'
mkdir -p /opt/lsa9600sp
out="$(sb --role eg --yes)"; rc=$?
[ $rc != 0 ] && grep -q '这台是子站主机（有 /opt/lsa9600sp）' <<<"$out" && untouched && ok "--role eg 在子站主机上：拒（rc $rc），什么都没动" || bad "--role eg 在子站主机上：rc $rc：$(tail -2 <<<"$out")"
out="$(sb --role eg --lan1 enp1s0 --yes)"; rc=$?
[ $rc != 0 ] && grep -q '这台是子站主机' <<<"$out" && untouched && ok '现场那条（--role eg --lan1 enp1s0，子站主机上）：拒，什么都没动' || bad "现场那条：rc $rc：$(tail -2 <<<"$out")"
out="$(sb --role eg --force --yes)"; rc=$?
! grep -q '这台是子站主机' <<<"$out" && ok "--force：放过这一关（接着往下装，到 Docker 那步：$(grep -m1 -E '错误|装离线包' <<<"$out" | head -c 60)）" || bad '--force 没放过'
rm -rf /opt/lsa9600sp /opt/lsa-eg /etc/systemd/journald.conf.d/lsa-eg.conf
mkdir -p /opt/lsa-eg
out="$(sb --role sp --yes)"; rc=$?
[ $rc != 0 ] && grep -q '这台是 EG（有 /opt/lsa-eg）' <<<"$out" && [ ! -e /opt/lsa9600sp ] && ok "--role sp 在 EG 上：拒（rc $rc），/opt/lsa9600sp 没出现" || bad "--role sp 在 EG 上：rc $rc：$(tail -2 <<<"$out")"
out="$(sb --role sp --force --yes)"; rc=$?
! grep -q '这台是 EG' <<<"$out" && ok '--role sp --force：放过这一关' || bad '--role sp --force 没放过'
rm -rf /opt/lsa-eg /opt/lsa9600sp
out="$(sb --role eg --lan1 nosuch0 --yes)"; rc=$?
[ $rc != 0 ] && grep -q '没有网口 nosuch0' <<<"$out" && untouched && ok "--role eg --lan1 没有的网口：拒（rc $rc），什么都没动" || bad "--lan1 没有的网口：rc $rc：$(tail -2 <<<"$out")"

echo '== EG install.sh'
mkdir -p /opt/lsa9600sp
out="$(ie)"; rc=$?
[ $rc != 0 ] && grep -q '这台是子站主机（有 /opt/lsa9600sp）' <<<"$out" && untouched && ok "子站主机上：拒（rc $rc），journald / .env 没动" || bad "子站主机上：rc $rc：$(tail -2 <<<"$out")"
out="$(ie --force)"; rc=$?
! grep -q '这台是子站主机' <<<"$out" && ok '--force：放过这一关' || bad 'install.sh --force 没放过'
rm -rf /opt/lsa9600sp /etc/systemd/journald.conf.d/lsa-eg.conf /w/e/.env
out="$(ie --lan1 nosuch0)"; rc=$?
[ $rc != 0 ] && grep -q '没有网口 nosuch0' <<<"$out" && untouched && ok "--lan1 没有的网口：拒（rc $rc），journald / .env 没动（以前在导镜像、写 journald 之后才查）" || bad "--lan1 没有的网口：rc $rc：$(tail -2 <<<"$out")"
nic="$(ls /sys/class/net | grep -v '^lo$' | head -1)"
out="$(ie --lan1 "$nic")"; rc=$?
[ $rc != 0 ] && grep -q "会把唯一的网口也挡掉" <<<"$out" && untouched && ok "--lan1 $nic（容器里没有第二个物理网口）：拒（rc $rc），什么都没动" || bad "--lan1 唯一网口：rc $rc：$(tail -2 <<<"$out")"
echo; echo "== 结果：✓ $n_ok，✗ $fail"
[ "$fail" = 0 ]
IN
