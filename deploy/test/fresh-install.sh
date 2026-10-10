#!/bin/bash
# 全新安装验收（0.13 验收后定的规矩：每个发布件都要真跑一遍全新安装，不能只测片段）。
# 起一台一次性的特权 ubuntu:24.04 容器当「裸 EG」，从空目录跑一键安装文件 --role eg，两轮都走完：
#   1. 第一轮：.run --role eg --yes（没有 eg.yaml）→ 用安装文件自带的离线 deb 装 Docker / chrony、导入镜像、起本地 TB
#   2. provision:eg（后端库，开发机上跑）给沙箱本地 TB 建实体、出 eg.yaml：只读开发机子站 TB 取令牌、--no-cleanup 不动子站；
#      后端库 tb/provision/out/eg/<柜号>/ 先备份、跑完原样还原。上送地址给 TEST-NET 192.0.2.1（连不上）——
#      不让沙箱 EG 冒充开发机子站上正在跑的柜子；也不给 sp-ca.pem（走「没有证书」那条路）
#   3. 第二轮：.run --role eg --yes --eg-config → 起全部；查容器（一分钟后没有重启）、agent（maint 登录 /api/status：总线连上、
#      设备清单）、/api/components（本地 TB、IoT Gateway、总线、视频）
#   4. 删掉沙箱（--keep 留着，之后 docker rm -f -v egfresh）
#
#   用法（开发机 Git Bash；后端库在 ../lsa-9600sp-backend，开发机子站在跑）：
#     bash deploy/test/fresh-install.sh <一键安装文件 .run> [柜号，缺省 AH07] [--keep]
#   不下载任何东西：ubuntu:24.04 用本机已有的（--pull never），Docker 用安装文件里的 deb，镜像用安装文件里的。
#
# 沙箱与真机的差别（只为在容器里跑得起来，不改安装脚本）：
#   - 没有 systemd：放一个 systemctl 替身 —— enable/start/restart docker 时手工起 containerd + dockerd（安装文件里的 29.x，
#     与现场一样是 containerd 镜像存储，IMAGES.txt 的镜像 ID 才对得上；docker:27-dind 是老存储，ID 对不上，不能用）；
#     is-active 一律答「没在跑」（install.sh 会提醒 chrony 没起来，属正常），其余答成功（看门狗、journald、chrony 只是写配置）
#   - /usr/sbin/policy-rc.d 返回 101：dpkg 装包时不去起服务（Docker 官方镜像的做法）
#   - 没有 modprobe：看门狗打「加载不了 softdog」的提醒，属正常
set -uo pipefail
RUNFILE="${1:?用法：fresh-install.sh <安装文件 .run> [柜号] [--keep]}"
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
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
os() { docker exec "$D" "$@"; }
cleanup() {
  [ -d "$BAK/orig" ] && { rm -rf "$OUT"; cp -a "$BAK/orig" "$OUT"; echo "后端库 out/eg/$CAB 已原样还原"; }
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
( cd "$BE" && pnpm -s provision:eg -- --cabinet "$CAB" --url http://127.0.0.1:38080 --sp 192.0.2.1 --hook http://host.docker.internal/hooks/alarm --thresholds model --no-cleanup ) > "$BAK/prov.log" 2>&1; rc=$?
tail -6 "$BAK/prov.log" | sed 's/^/    /'
[ "$rc" = 0 ] && ok 'provision:eg rc 0' || { bad "provision:eg rc $rc"; exit 1; }
os mkdir -p /cfg
# 经 stdin 传（Git Bash 下 $OUT 是 /d/… 写法，docker cp 认不出）
docker exec -i "$D" sh -c 'cat > /cfg/eg.yaml' < "$OUT/eg.yaml" && ok "eg.yaml 拷进沙箱（tb: 段 $(grep -c '^tb:' "$OUT/eg.yaml") 个；上送 $(grep -oE 'mqtts?://[^ "]+' "$OUT/eg.yaml" | head -1)）"
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
os docker exec lsa-eg-agent node -e '
const fs=require("fs");const pw=fs.readFileSync("/config/initial-password.txt","utf8").trim();
(async()=>{const B="http://127.0.0.1";
const r=await fetch(B+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({user:"maint",password:pw})});
const j=await r.json().catch(()=>({}));const H={authorization:"Bearer "+j.token};
console.log("    登录 maint："+r.status);
const s=await (await fetch(B+"/api/status",{headers:H})).json();
console.log("    /api/status：eg "+s.eg+"，版本 "+s.version+"，总线 "+(s.bus&&s.bus.connected?"连上":"没连上")+"，设备 "+(s.devices||[]).length+" 台");
const c=await (await fetch(B+"/api/components",{headers:H})).json();
for(const x of (Array.isArray(c)?c:c.rows||c.items||[]))console.log("    组件 "+JSON.stringify(x).slice(0,160));
if(!Array.isArray(c))console.log("    /api/components "+JSON.stringify(c).slice(0,400));
})().catch(e=>{console.log("    !! "+e.message);process.exit(1)})' || bad 'agent 查不了'

echo; [ "$fail" = 0 ] && echo "== 全新安装通过（$RUN）" || echo "== 全新安装有失败项（见上）"
exit $fail
