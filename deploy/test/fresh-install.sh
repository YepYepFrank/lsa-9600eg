#!/bin/bash
# 全新安装验收（0.13 验收后定的规矩：每个发布件都要真跑一遍全新安装，不能只测片段）。
# 起一台一次性的特权 ubuntu:24.04 容器当「裸 EG」，从空目录跑一键安装文件 --role eg，两轮都走完：
#   1. 第一轮：.run --role eg --yes（没有 eg.yaml）→ 用安装文件自带的离线 deb 装 Docker / chrony、导入镜像、起本地 TB
#   2. provision:eg（后端库，开发机上跑）给沙箱本地 TB 建实体、出 eg.yaml：只读开发机子站 TB 取令牌、--no-cleanup 不动子站；
#      后端库 tb/provision/out/eg/<柜号>/ 先备份、跑完原样还原。上送地址给 TEST-NET 192.0.2.1（连不上）——
#      不让沙箱 EG 冒充开发机子站上正在跑的柜子；也不给 sp-ca.pem（走「没有证书」那条路）
#   3. 第二轮：.run --role eg --yes --eg-config → 起全部；查容器（一分钟后没有重启）、agent（maint 登录 /api/status：总线连上、
#      设备清单）、/api/components（本地 TB、IoT Gateway、总线、视频）
#   4. --kiosk（0.16）的拒绝路径：--role eg --kiosk 要拒绝；安装文件不带 sp/kiosk/ 时 --role sp --kiosk 要在装任何东西之前拒绝（/opt/lsa9600sp 不能出现）。
#      安装文件带 kiosk 时只验 eg 那条（子站与双屏不在这个沙箱里装）
#   5. 删掉沙箱（--keep 留着，之后 docker rm -f -v egfresh）
#
#   用法（开发机 Git Bash；后端库在 ../lsa-9600sp-backend，开发机子站在跑）：
#     bash deploy/test/fresh-install.sh <一键安装文件 .run> [单元号，缺省 AH07] [--keep]
#   单元号（EG 0.7.0 起，舱室 EG 方案 v0.5）：舱室单元 AH07-A（provision:eg --unit，出 eg.yaml schema 2）；
#   照旧一柜一台的柜就是柜号 AH07（--cabinet，schema 1）。开发机子站要有这个单元（model 里这面柜不是 legacyEg）。
#   装完核对本 EG 的身份：/api/status 的 unit、mediamtx 路径、IoT Gateway clientId 都是这个单元号
#   不下载任何东西：ubuntu:24.04 用本机已有的（--pull never），Docker 用安装文件里的 deb，镜像用安装文件里的。
#
# 沙箱与真机的差别（只为在容器里跑得起来，不改安装脚本）：
#   - 没有 systemd：放一个 systemctl 替身 —— enable/start/restart docker 时手工起 containerd + dockerd（安装文件里的 29.x，
#     与现场一样是 containerd 镜像存储，IMAGES.txt 的镜像 ID 才对得上；docker:27-dind 是老存储，ID 对不上，不能用）；
#     is-active 一律答「没在跑」（install.sh 会提醒 chrony 没起来，属正常），其余答成功（看门狗、journald、chrony 只是写配置）
#   - /usr/sbin/policy-rc.d 返回 101：dpkg 装包时不去起服务（Docker 官方镜像的做法）
#   - 没有 modprobe：看门狗打「加载不了 softdog」的提醒，属正常
set -uo pipefail
RUNFILE="${1:?用法：fresh-install.sh <安装文件 .run> [单元号] [--keep]}"
CAB="${2:-AH07}"; [ "$CAB" = --keep ] && CAB=AH07
KEEP=0; for a in "$@"; do [ "$a" = --keep ] && KEEP=1; done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BE="${LSA_BACKEND:-$ROOT/../lsa-9600sp-backend}"
D=egfresh
export MSYS_NO_PATHCONV=1
RUNDIR="$(cd "$(dirname "$RUNFILE")" && { pwd -W 2>/dev/null || pwd; })"   # Git Bash 给 Windows 路径（docker -v 要）
RUN="$(basename "$RUNFILE")"
OUT="$BE/tb/provision/out/eg/$CAB"
BAK="$(mktemp -d)"
fail=0
# 舱室单元（柜号-字母）按 --unit provision、出 schema 2；照旧一柜一台按 --cabinet
if [[ "$CAB" =~ ^.+-[A-Z]$ ]]; then PROV_KEY=--unit; else PROV_KEY=--cabinet; fi
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
os() { docker exec "$D" "$@"; }
cleanup() {
  if [ -d "$BAK/orig" ]; then rm -rf "$OUT"; cp -a "$BAK/orig" "$OUT"; echo "后端库 out/eg/$CAB 已原样还原"
  # 跑之前没有这个目录：provision:eg 新建的（eg.yaml、改过的 sysadmin 口令 tb-sysadmin.json）一并删掉 ——
  # 不删的话下一次 fresh-install 会拿这台已删沙箱的口令去登新沙箱的本地 TB，401（0.18.1 r1 kiosk 版连续三次就是这么挂的）
  elif [ "${PROV_STARTED:-0}" = 1 ]; then rm -rf "$OUT"; echo "后端库 out/eg/$CAB 是这次新建的，已删"; fi
  rm -rf "$BAK"
  if [ "$KEEP" = 1 ]; then echo "沙箱留着：docker exec -it $D bash（删：docker rm -f -v $D）"
  else docker rm -f -v "$D" >/dev/null 2>&1 && echo "沙箱已删（docker rm -f -v $D）"; fi
}
trap cleanup EXIT

echo "== 0. 沙箱：特权 ubuntu:24.04 容器 $D（本机已有的镜像，不拉）"
docker rm -f -v "$D" >/dev/null 2>&1
docker run -d --pull never --privileged --name "$D" --hostname eg-fresh -p 127.0.0.1:38080:38080 \
  -v /var/lib/docker -v /var/lib/containerd -v "$RUNDIR:/rel:ro" ubuntu:24.04 sleep infinity >/dev/null || { echo '起不了沙箱' >&2; exit 1; }
os sh -c 'printf "#!/bin/sh\nexit 101\n" > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d'
docker exec -i "$D" sh -c 'cat > /usr/local/bin/systemctl' <<'EOF'
#!/bin/sh
# 沙箱里的 systemctl 替身（deploy/test/fresh-install.sh）：没有 systemd，docker 手工起，其余答成功
log() { echo "systemctl $*" >> /var/log/systemctl-shim.log; }
log "$@"
case " $* " in
  *" is-active "*) exit 3 ;;
  *" show "*) echo ''; exit 0 ;;
  *" docker"*)
    case " $* " in *" enable "*|*" start "*|*" restart "*|*"--now"*)
      if ! docker info >/dev/null 2>&1; then
        # 容器里的 cgroup v2：先把现有进程挪进子 cgroup、再打开各控制器，dockerd 才建得了子 cgroup（同 docker:dind 的入口脚本）
        if [ -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/init ]; then
          mkdir -p /sys/fs/cgroup/init
          xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
          sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control || :
        fi
        pgrep -x containerd >/dev/null || (containerd > /var/log/containerd.log 2>&1 &)
        sleep 2
        (dockerd > /var/log/dockerd.log 2>&1 &)
        i=0; while [ $i -lt 30 ] && ! docker info >/dev/null 2>&1; do sleep 1; i=$((i + 1)); done
      fi ;;
    esac ;;
esac
exit 0
EOF
os chmod +x /usr/local/bin/systemctl
echo "  $(os sh -c '. /etc/os-release; echo $PRETTY_NAME')；docker：$(os sh -c 'command -v docker || echo 没有')；chronyd：$(os sh -c 'command -v chronyd || echo 没有')；/opt/lsa-eg：$(os sh -c 'ls -A /opt/lsa-eg 2>/dev/null | wc -l') 个文件"

echo; echo "== 1. 第一轮：$RUN --role eg --yes"
t0=$(date +%s)
os bash "/rel/$RUN" --role eg --yes > "$BAK/r1.log" 2>&1; rc=$?
tail -14 "$BAK/r1.log" | sed 's/^/    /'
[ "$rc" = 0 ] && ok "rc 0（$(( $(date +%s) - t0 )) s）" || bad "rc $rc"
grep -q '本地 TB 已起' "$BAK/r1.log" && ok '走到「本地 TB 已起。下一步…」' || bad '没走到「本地 TB 已起」'
echo "  Docker $(os docker version -f '{{.Server.Version}}' 2>/dev/null)（$(os docker info -f '{{.DriverStatus}}' 2>/dev/null | grep -o 'containerd[^]]*' | head -1)）"
[ "$fail" = 0 ] || exit 1

echo; echo "== 2. provision:eg $CAB（本地 TB 经 127.0.0.1:38080；只读开发机子站取令牌）"
VER="$(os cat /opt/lsa-eg/VERSION)"
os docker run -d --name egfresh-fwd --network host "lsa-eg-app:$VER" node -e \
  'const n=require("net");n.createServer(c=>{const u=n.connect(18080,"127.0.0.1");c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(38080,"0.0.0.0")' >/dev/null
sleep 2
[ -d "$OUT" ] && cp -a "$OUT" "$BAK/orig"
PROV_STARTED=1
( cd "$BE" && pnpm -s provision:eg -- "$PROV_KEY" "$CAB" --url http://127.0.0.1:38080 --sp 192.0.2.1 --hook http://host.docker.internal/hooks/alarm --thresholds model --no-cleanup ) > "$BAK/prov.log" 2>&1; rc=$?
tail -6 "$BAK/prov.log" | sed 's/^/    /'
[ "$rc" = 0 ] && ok 'provision:eg rc 0' || { bad "provision:eg rc $rc"; exit 1; }
os mkdir -p /cfg
# 经 stdin 传（Git Bash 下 $OUT 是 /d/… 写法，docker cp 认不出）
docker exec -i "$D" sh -c 'cat > /cfg/eg.yaml' < "$OUT/eg.yaml" && ok "eg.yaml 拷进沙箱（schema $(sed -n 's/^schema: *//p' "$OUT/eg.yaml" | head -1)；tb: 段 $(grep -c '^tb:' "$OUT/eg.yaml") 个；上送 $(grep -oE 'mqtts?://[^ "]+' "$OUT/eg.yaml" | head -1)）"
os docker rm -f egfresh-fwd >/dev/null

echo; echo "== 3. 第二轮：$RUN --role eg --yes --eg-config /cfg"
t0=$(date +%s)
os bash "/rel/$RUN" --role eg --yes --eg-config /cfg > "$BAK/r2.log" 2>&1; rc=$?
tail -25 "$BAK/r2.log" | sed 's/^/    /'
[ "$rc" = 0 ] && ok "rc 0（$(( $(date +%s) - t0 )) s）" || bad "rc $rc"
grep -q '^装好了' "$BAK/r2.log" && ok '走到「装好了」' || bad '没走到「装好了」'
echo "  已装版本 $(os cat /opt/lsa-eg/.installed/VERSION 2>/dev/null)"

echo; echo "== 4. 一分钟后看容器、agent"
sleep 60
os docker ps -a --format '{{.Names}} {{.Status}}' | grep lsa-eg | sort | sed 's/^/    /'
for c in $(os docker ps -a --format '{{.Names}}' | grep lsa-eg); do
  r=$(os docker inspect -f '{{.RestartCount}} {{.State.Running}}' "$c")
  [ "$r" = '0 true' ] || bad "$c：重启次数 / 在跑 = $r"
done
[ "$fail" = 0 ] && ok '容器都在跑、没有重启过'
rc=0; st="$(os bash /opt/lsa-eg/install.sh --status 2>&1)" || rc=$?
[ "$rc" = 0 ] && echo "$st" | grep -q '本地 TB：' && echo "$st" | grep -q '看门狗' && ok "单独跑 install.sh --status：rc 0，$(echo "$st" | grep -m1 '本地 TB：')" || bad "单独跑 install.sh --status：rc $rc；$(echo "$st" | tail -2 | tr '\n' ' ')"
os docker exec lsa-eg-agent node -e '
const fs=require("fs");const pw=fs.readFileSync("/config/initial-password.txt","utf8").trim();
(async()=>{const B="http://127.0.0.1";
const r=await fetch(B+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({user:"maint",password:pw})});
const j=await r.json().catch(()=>({}));const H={authorization:"Bearer "+j.token};
console.log("    登录 maint："+r.status);
const s=await (await fetch(B+"/api/status",{headers:H})).json();
console.log("    /api/status：eg "+s.eg+"，版本 "+s.version+"，总线 "+(s.bus&&s.bus.connected?"连上":"没连上")+"，设备 "+(s.devices||[]).length+" 台");
console.log("    UNIT="+(s.unit?s.unit.code:"（没报）")+" AT="+(s.unit?s.unit.at:""));
const c=await (await fetch(B+"/api/components",{headers:H})).json();
for(const x of (Array.isArray(c)?c:c.rows||c.items||[]))console.log("    组件 "+JSON.stringify(x).slice(0,160));
if(!Array.isArray(c))console.log("    /api/components "+JSON.stringify(c).slice(0,400));
})().catch(e=>{console.log("    !! "+e.message);process.exit(1)})' > "$BAK/api.txt" 2>&1 || bad 'agent 查不了'
grep -v '^    UNIT=' "$BAK/api.txt"
# 本 EG 的身份（EG 0.7.0）：agent 报的单元号、mediamtx 路径、IoT Gateway clientId 都是 $CAB
u="$(sed -n 's/^    UNIT=\([^ ]*\) AT=.*/\1/p' "$BAK/api.txt" || true)"; at="$(sed -n 's/^    UNIT=[^ ]* AT=//p' "$BAK/api.txt" || true)"
if [ "$u" = "$CAB" ]; then ok "/api/status 的单元号 $u${at:+（$at）}"; else bad "/api/status 的单元号是 ${u:-（没报）}，不是 $CAB"; fi
if [ "$PROV_KEY" = --unit ] && [ -z "$at" ]; then bad '舱室单元却没有舱室名（eg.yaml 不是 schema 2？）'; fi
if os grep -qE "^  $CAB(-sub|-ir|-ir-sub)?:" /opt/lsa-eg/config/mediamtx/mediamtx.yml 2>/dev/null; then ok "mediamtx 路径按单元号：$(os grep -oE "^  $CAB[a-z-]*:" /opt/lsa-eg/config/mediamtx/mediamtx.yml | tr -d ' :' | tr '\n' ' ')"
else echo "  （mediamtx 还没有 $CAB 的路径：沙箱没接摄像机时 eg-video 不出路径，不算失败）"; fi
cid="$(os sh -c 'grep -rhoE "tb-gateway-[A-Za-z0-9-]+" /opt/lsa-eg/config/gateway/config 2>/dev/null' | sort -u | tr '\n' ' ')"
[ "$cid" = "tb-gateway-$CAB " ] && ok "IoT Gateway clientId $cid" || bad "IoT Gateway clientId：${cid:-（没找到）}，应为 tb-gateway-$CAB"

echo; echo "== 5. --kiosk 的拒绝路径（0.16）"
rc=0; out="$(os bash "/rel/$RUN" --role eg --kiosk --yes 2>&1)" || rc=$?
[ "$rc" != 0 ] && echo "$out" | grep -q '只用于子站主机' && ok "--role eg --kiosk → 拒绝（rc $rc）：$(echo "$out" | grep '只用于子站主机' | head -1 | sed 's/^错误：//')" || bad "--role eg --kiosk：rc $rc；$(echo "$out" | tail -3)"
skip=$(awk '/^__LSA_PAYLOAD_BELOW__$/ { print NR + 1; exit }' "$RUNFILE")
# 不能 | grep -q：pipefail 下 grep 一匹配就退出，tar 吃 SIGPIPE 非 0，整条判成「没有」（release-0.16 r2 kiosk 版就这样误跑了 --role sp --kiosk）
nk=$(tail -n +"$skip" "$RUNFILE" | tar -t 2>/dev/null | grep -c '^lsa9600sp-bundle/sp/kiosk/' || true)
if [ "${nk:-0}" -gt 0 ]; then
  echo "  （安装文件带 sp/kiosk/：--role sp --kiosk 会真装子站与双屏，不在这个沙箱里做）"
else
  rc=0; out="$(os bash "/rel/$RUN" --role sp --kiosk --yes 2>&1)" || rc=$?
  if [ "$rc" != 0 ] && echo "$out" | grep -q '没有机柜双屏组件' && ! os test -e /opt/lsa9600sp; then
    ok "安装文件不带 kiosk、--role sp --kiosk → 装之前拒绝（rc $rc），/opt/lsa9600sp 没出现"
    echo "$out" | grep -A1 '没有机柜双屏组件' | sed 's/^/      /'
  else
    bad "--role sp --kiosk（不带 kiosk 的安装文件）：rc $rc，/opt/lsa9600sp $(os test -e /opt/lsa9600sp && echo 出现了 || echo 没有)；$(echo "$out" | tail -3)"
  fi
fi

echo; [ "$fail" = 0 ] && echo "== 全新安装通过（$RUN）" || echo "== 全新安装有失败项（见上）"
exit $fail
