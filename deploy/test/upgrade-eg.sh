#!/bin/bash
# EG 升级 / 回退验收（0.17 起：本地 TB 同一补丁线升级，如 4.2.2.5 → 4.2.2.6）。沙箱做法同 fresh-install.sh（一次性特权 ubuntu:24.04 当「裸 EG」）：
#   1. 旧安装文件 --role eg 装两轮（中间 provision:eg 出 eg.yaml，同 fresh-install.sh 第 2 步）
#   2. 往本地 TB 里种数据：一台 SAM 灌 120 个历史点（kp.seed）、建一条告警（kp-test）；记快照：设备、设备配置的告警规则（哈希）、
#      告警条数、种的点数、EG 的 cfg 属性、库里的 TB 版本
#   3. 新安装文件 --role eg：升级走通；本地 TB 补丁升级（先备份、不跑升级脚本、库里版本变成新的）；快照不变；一分钟后容器都在跑、没重启
#   4. --rollback 不带 --restore-tb 要拒绝；--rollback --restore-tb：库恢复成旧版本、旧 TB 镜像在跑、快照与升级前一致
#   5. 再跑新安装文件：又升上去、快照不变
#
#   用法（开发机 Git Bash；后端库在 ../lsa-9600sp-backend，开发机子站在跑）：
#     bash deploy/test/upgrade-eg.sh <旧安装文件 .run> <新安装文件 .run> [柜号，缺省 AH07] [--keep]
#   不下载任何东西（ubuntu:24.04 用本机的，Docker 与镜像用安装文件里的）。
set -uo pipefail
OLD="${1:?用法：upgrade-eg.sh <旧 .run> <新 .run> [柜号] [--keep]}"
NEW="${2:?用法：upgrade-eg.sh <旧 .run> <新 .run> [柜号] [--keep]}"
CAB="${3:-AH07}"; [ "$CAB" = --keep ] && CAB=AH07
KEEP=0; for a in "$@"; do [ "$a" = --keep ] && KEEP=1; done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BE="${LSA_BACKEND:-$ROOT/../lsa-9600sp-backend}"
D=egupg
export MSYS_NO_PATHCONV=1
winpath() { (cd "$(dirname "$1")" && { pwd -W 2>/dev/null || pwd; }); }
OLDDIR="$(winpath "$OLD")"; NEWDIR="$(winpath "$NEW")"
OLDRUN="$(basename "$OLD")"; NEWRUN="$(basename "$NEW")"
OUT="$BE/tb/provision/out/eg/$CAB"
BAK="$(mktemp -d)"
fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
os() { docker exec "$D" "$@"; }
cleanup() {
  [ -d "$BAK/orig" ] && { rm -rf "$OUT"; cp -a "$BAK/orig" "$OUT"; echo "后端库 out/eg/$CAB 已原样还原"; }
  echo "日志留在 $BAK.logs/"
  mkdir -p "$BAK.logs" && cp -a "$BAK"/*.log "$BAK.logs/" 2>/dev/null
  rm -rf "$BAK"
  if [ "$KEEP" = 1 ]; then echo "沙箱留着：docker exec -it $D bash（删：docker rm -f -v $D）"
  else docker rm -f -v "$D" >/dev/null 2>&1 && echo "沙箱已删（docker rm -f -v $D）"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM   # 被打断时也走 cleanup（还原后端库 out/eg/<柜号>、删沙箱）

echo "== 0. 沙箱：特权 ubuntu:24.04 容器 $D"
docker rm -f -v "$D" >/dev/null 2>&1
docker run -d --pull never --privileged --name "$D" --hostname eg-upg -p 127.0.0.1:38082:38080 \
  -v /var/lib/docker -v /var/lib/containerd -v "$OLDDIR:/old:ro" -v "$NEWDIR:/new:ro" ubuntu:24.04 sleep infinity >/dev/null || { echo '起不了沙箱' >&2; exit 1; }
os sh -c 'printf "#!/bin/sh\nexit 101\n" > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d'
# systemctl 替身：与 fresh-install.sh 同一份
sed -n '/^docker exec -i "\$D" sh -c .cat > \/usr\/local\/bin\/systemctl. <<.EOF.$/,/^EOF$/p' "$ROOT/deploy/test/fresh-install.sh" | sed '1d;$d' | docker exec -i "$D" sh -c 'cat > /usr/local/bin/systemctl'
os chmod +x /usr/local/bin/systemctl
os grep -q 'dockerd' /usr/local/bin/systemctl && ok 'systemctl 替身（取自 fresh-install.sh）' || { bad 'systemctl 替身没取到'; exit 1; }

echo; echo "== 1. 旧版：$OLDRUN --role eg 两轮"
os bash "/old/$OLDRUN" --role eg --yes > "$BAK/old1.log" 2>&1 && grep -q '本地 TB 已起' "$BAK/old1.log" && ok '第一轮：本地 TB 已起' || { bad "第一轮失败（$BAK.logs/old1.log）"; tail -15 "$BAK/old1.log"; exit 1; }
VER="$(os cat /opt/lsa-eg/VERSION)"
os docker run -d --name egupg-fwd --network host "lsa-eg-app:$VER" node -e \
  'const n=require("net");n.createServer(c=>{const u=n.connect(18080,"127.0.0.1");c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(38080,"0.0.0.0")' >/dev/null
sleep 2
[ -d "$OUT" ] && cp -a "$OUT" "$BAK/orig"
( cd "$BE" && pnpm -s provision:eg -- --cabinet "$CAB" --url http://127.0.0.1:38082 --sp 192.0.2.1 --hook http://host.docker.internal/hooks/alarm --thresholds model --no-cleanup ) > "$BAK/prov.log" 2>&1 \
  && ok 'provision:eg' || { bad "provision:eg 失败"; tail -8 "$BAK/prov.log"; exit 1; }
os mkdir -p /cfg
docker exec -i "$D" sh -c 'cat > /cfg/eg.yaml' < "$OUT/eg.yaml"
os docker rm -f egupg-fwd >/dev/null
os bash "/old/$OLDRUN" --role eg --yes --eg-config /cfg > "$BAK/old2.log" 2>&1 && grep -q '^装好了' "$BAK/old2.log" && ok "第二轮：装好了 $(os cat /opt/lsa-eg/.installed/VERSION)" || { bad "第二轮失败"; tail -15 "$BAK/old2.log"; exit 1; }

# 快照：沙箱里 lsa-eg-agent 容器跑 upgrade-snap.cjs（经 stdin 传进去）
snap() { docker exec -i "$D" docker exec -i -e "SEED=${1:-0}" lsa-eg-agent node - < "$ROOT/deploy/test/upgrade-snap.cjs"; }
dbver() { os docker exec lsa-eg-postgres psql -U postgres -d thingsboard -tAc 'select schema_version from tb_schema_settings limit 1' | tr -d '[:space:]'; }
tbimg() { os docker inspect -f '{{.Config.Image}}' lsa-eg-tb; }
health() {
  sleep 60
  local c r b=0
  for c in $(os docker ps -a --format '{{.Names}}' | grep lsa-eg); do
    r=$(os docker inspect -f '{{.RestartCount}} {{.State.Running}}' "$c")
    [ "$r" = '0 true' ] || { bad "$1：$c 重启次数 / 在跑 = $r"; b=1; }
  done
  local n
  n="$(os docker ps --format '{{.Names}}' | grep -c lsa-eg || true)"
  if [ "$b" = 0 ]; then ok "$1：一分钟后 lsa-eg-* 容器都在跑、没重启（$n 个）"; fi
}
same() {  # $1 名称 $2 期望 $3 实际：除 alarmsTotal 外逐项比（升级时 TB 可能自己清掉 / 生成别的告警，kp-test 那条单独比）
  local a b sd cf at
  a="$(echo "$2" | sed 's/"alarmsTotal":[0-9]*,//')"
  b="$(echo "$3" | sed 's/"alarmsTotal":[0-9]*,//')"
  sd="$(echo "$3" | grep -o '"seed":[0-9]*' || true)"
  cf="$(echo "$3" | grep -o '"cfg":[^,]*' || true)"
  at="$(echo "$3" | grep -o '"alarmsTotal":[0-9]*' || true)"
  if [ "$a" = "$b" ]; then ok "$1：设备、告警规则、kp-test 告警、种的历史点、cfg 都在（$sd，$cf，$at）"
  else bad "$1：快照不一致"; echo "      之前 $2"; echo "      现在 $3"; fi
}

echo; echo "== 2. 种数据、记快照"
S0="$(snap 1)"; echo "    $S0"
echo "$S0" | grep -q '"seed":120' && ok '种了 120 个历史点、1 条 kp-test 告警' || bad "种数据失败：$S0"
V0="$(dbver)"; I0="$(tbimg)"
ok "旧版本地 TB：$I0，库里 $V0"

echo; echo "== 3. 升级：$NEWRUN --role eg"
t0=$(date +%s)
os bash "/new/$NEWRUN" --role eg --yes > "$BAK/new1.log" 2>&1; rc=$?
grep -E '本地 TB|备份|升级：' "$BAK/new1.log" | sed 's/^/    /'
[ "$rc" = 0 ] && grep -q '^装好了' "$BAK/new1.log" && ok "rc 0、装好了（$(( $(date +%s) - t0 )) s）" || { bad "rc $rc"; tail -20 "$BAK/new1.log"; }
grep -q '同一补丁线，不跑升级脚本' "$BAK/new1.log" && ok '识别为同一补丁线' || bad '没识别成同一补丁线'
grep -q '✓ 备份好了' "$BAK/new1.log" && ok "升级前备份了本地库：$(os ls /opt/lsa-eg/backups)" || bad '没备份本地库'
os docker logs lsa-eg-tb 2>&1 | grep -q 'not supported for upgrade' && bad 'TB 报「not supported for upgrade」（跑了升级脚本？）'
V1="$(dbver)"; I1="$(tbimg)"
[ "$I1" = 'thingsboard/tb-node:4.2.2.6' ] && [ "$V1" = 4002002006 ] && ok "本地 TB：$I1，库里 $V1" || bad "本地 TB：$I1，库里 $V1"
os docker logs lsa-eg-tb 2>&1 | grep -m1 -i 'Version increased' | sed 's/^/    /'
S1="$(snap)"; same '升级后' "$S0" "$S1"
health '升级后'
rc=0; st="$(os bash /opt/lsa-eg/install.sh --status 2>&1)" || rc=$?
echo "$st" | grep -E '已装版本|可回退|本地 TB|本地库备份|看门狗|防火墙' | sed 's/^/    /'
# 单独跑 --status 要走完（0.17 r1 在「可回退到」之后 127 退出，没被发现过）
[ "$rc" = 0 ] && echo "$st" | grep -q '本地 TB：' && echo "$st" | grep -q '看门狗' && ok "单独跑 install.sh --status：rc 0，本地 TB、看门狗等各项都在" || bad "单独跑 install.sh --status：rc $rc；$(echo "$st" | tail -2 | tr '\n' ' ')"

echo; echo "== 4. 回退"
rc=0; out="$(os bash /opt/lsa-eg/install.sh --rollback 2>&1)" || rc=$?
[ "$rc" != 0 ] && echo "$out" | grep -q -- '--rollback --restore-tb' && ok "不带 --restore-tb：拒绝并说明（rc $rc）" || bad "不带 --restore-tb：rc $rc；$(echo "$out" | tail -3)"
echo "$out" | sed 's/^/      /'
[ "$(dbver)" = 4002002006 ] && [ "$(tbimg)" = 'thingsboard/tb-node:4.2.2.6' ] && ok '拒绝后什么都没动' || bad "拒绝后变了：$(tbimg) $(dbver)"
t0=$(date +%s)
os bash /opt/lsa-eg/install.sh --rollback --restore-tb > "$BAK/rb.log" 2>&1; rc=$?
grep -E '恢复|回退|本地 TB|✗' "$BAK/rb.log" | sed 's/^/    /'
[ "$rc" = 0 ] && ok "--rollback --restore-tb：rc 0（$(( $(date +%s) - t0 )) s），回到 $(os cat /opt/lsa-eg/.installed/VERSION)" || { bad "--rollback --restore-tb：rc $rc"; tail -20 "$BAK/rb.log"; }
V2="$(dbver)"; I2="$(tbimg)"
[ "$I2" = "$I0" ] && [ "$V2" = "$V0" ] && ok "本地 TB：$I2，库里 $V2（与升级前一致）" || bad "本地 TB：$I2，库里 $V2（升级前 $I0 / $V0）"
S2="$(snap)"; same '回退后' "$S0" "$S2"
health '回退后'

echo; echo "== 5. 再升级：$NEWRUN --role eg"
os bash "/new/$NEWRUN" --role eg --yes > "$BAK/new2.log" 2>&1; rc=$?
[ "$rc" = 0 ] && grep -q '^装好了' "$BAK/new2.log" && ok 'rc 0、装好了' || { bad "rc $rc"; tail -20 "$BAK/new2.log"; }
[ "$(dbver)" = 4002002006 ] && ok "库里 $(dbver)" || bad "库里 $(dbver)"
S3="$(snap)"; same '再升级后' "$S0" "$S3"
health '再升级后'

echo; [ "$fail" = 0 ] && echo "== 升级 / 回退验收通过（$OLDRUN → $NEWRUN）" || echo "== 升级 / 回退验收有失败项（见上）"
exit $fail
