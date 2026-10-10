#!/usr/bin/env bash
# LSA-9600SP 一键安装入口（在解包目录里；通常由 .run 自解压后调用）。
#
#   sudo bash setup.sh                                  交互选角色
#   sudo bash setup.sh --role sp [--ip <本机站内 IP>] [--ntp <站内时钟源>] [--yes]
#       子站主机：Docker（没有就装离线包）→ 导入镜像 → /opt/lsa9600sp → 首次自动生成 docker/.env（随机口令、
#       本机 IP、证书 SAN）→ scripts/up.sh --prod（证书、建库、provision、扩展服务、Nginx、视频）→ TB 系统管理员改随机口令。
#       已装过的按升级处理：保留 .env。
#       对时：子站主机给各 EG 当时间服务器（chrony allow 站内私网、local stratum 10 orphan —— 没有上级时全站至少跟子站一致）；
#       --ntp 给站内时钟源（GPS / 北斗授时或上级 NTP），记住，以后升级不用再给。
#   sudo bash setup.sh --role eg [--lan1 <摄像机网口>] [--sp-key <子站公钥>] [--eg-config <目录>] [--yes]
#       EG：/opt/lsa-eg → install.sh（离线装 Docker / chrony、导入镜像、起本地 TB）。
#       --eg-config：该目录里的 eg.yaml、sp-ca.pem（子站对**这台** EG 跑过 provision:eg 之后 pack-eg.sh 出的）拷进 config/ 并起全部。
#
# 只支持 x86_64；离线 Docker 包按 Ubuntu 24.04 准备，其它发行版（麒麟 / UOS）请先自行装好 Docker 与 compose 插件。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ROLE=''
IP=''
LAN1=''
EGCFG=''
YES=0
FORCE=0
SPKEY=''
NTP=''
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:?}"; shift ;;
    --ip) IP="${2:?}"; shift ;;
    --ntp) NTP="${2:?--ntp 后面给站内时钟源地址}"; shift ;;
    --lan1) LAN1="${2:?}"; shift ;;
    --force) FORCE=1 ;;
    --sp-key) SPKEY="$(readlink -f "${2:?}" 2>/dev/null || echo "$2")"; shift ;;
    --eg-config) EGCFG="$(readlink -f "${2:?}")"; shift ;;
    --yes | -y) YES=1 ;;
    --keep) ;;
    --help | -h) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "错误：$*" >&2; exit 1; }
ask() { # ask <提示> <缺省>：--yes 或非交互终端直接取缺省
  local ans
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then echo "$2"; return; fi
  read -r -p "$1 [$2]: " ans </dev/tty
  echo "${ans:-$2}"
}
rnd() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-16}"; }
# envget <文件> <键>：取值（不 source：.env 里有带空格和中文的值）
envget() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | tr -d '"' || true; }
# setv <文件> <键> <值>：只改行首是「键=」的那一行
setv() {
  local v="${3//\\/\\\\}"
  v="${v//&/\\&}"
  v="${v//|/\\|}"
  sed -i "s|^$2=.*|$2=$v|" "$1"
}

[ "$(id -u)" = 0 ] || die '要用 sudo 跑'
[ "$(uname -m)" = x86_64 ] || die "只支持 x86_64（本机 $(uname -m)）"

echo "LSA-9600SP 离线安装 $(cat VERSION)"
# set -euo pipefail 下：单独一行的管道、x="$(会失败的管道)"、函数最后一句 [ ] && … 失败都会让脚本悄悄退出 —— 可能失败的都带 || true（0.13 验收后通扫）
sed -n '2,20p' MANIFEST.txt 2>/dev/null | sed 's/^/  /' || true

say '校验安装文件'
sha256sum --quiet -c SHA256SUMS || die '文件校验不过（拷贝不完整？重新拷一遍安装文件）'
echo '全部文件校验通过'

if [ -z "$ROLE" ]; then
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then die '非交互时要给 --role sp 或 --role eg'; fi
  echo
  echo '这台机器装成：'
  echo '  1) 子站主机（ThingsBoard、扩展服务、前端、Nginx、视频转发）'
  echo '  2) EG 边缘网关（每面柜一台：本地 TB、IoT Gateway、eg-agent、视频）'
  case "$(ask '选 1 或 2' 1)" in
    1) ROLE=sp ;;
    2) ROLE=eg ;;
    *) die '只能选 1 或 2' ;;
  esac
fi
case "$ROLE" in sp | eg) ;; *) die "--role 只能是 sp 或 eg" ;; esac

# ---------- Docker（没有就装离线包；Ubuntu 24.04） ----------
install_debs() {
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] && [ "${VERSION_CODENAME:-}" = noble ] ||
    die "离线 Docker 包只适用于 Ubuntu 24.04（本机 ${PRETTY_NAME:-未知}）：请先装好 Docker 与 compose 插件再跑"
  say '装离线包（Docker、compose 插件、chrony）'
  installed() { dpkg-query -W -f '${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
  if installed systemd-timesyncd; then DEBIAN_FRONTEND=noninteractive apt-get remove -y systemd-timesyncd >/dev/null; fi
  local todo=() d pkg ver cur
  for d in debs/*.deb; do
    pkg="$(dpkg-deb -f "$d" Package)"
    ver="$(dpkg-deb -f "$d" Version)"
    cur="$(dpkg-query -W -f '${Status} ${Version}' "$pkg" 2>/dev/null | awk '$3=="installed"{print $4}' || true)"
    if [ -z "$cur" ] || dpkg --compare-versions "$ver" gt "$cur"; then todo+=("$d"); fi
  done
  [ ${#todo[@]} -eq 0 ] || DEBIAN_FRONTEND=noninteractive dpkg -i "${todo[@]}" >/dev/null
  systemctl enable --now docker chrony >/dev/null 2>&1 || true
}
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then install_debs; fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die 'Docker 没起来（systemctl status docker）'
echo "Docker $(docker version -f '{{.Server.Version}}')，compose $(docker compose version --short)"

# ---------- 子站主机 ----------
SP_DEST=/opt/lsa9600sp
SP_B="$SP_DEST/lsa9600sp-backend"
SP_ENV="$SP_B/docker/.env"
SP_CRED="$SP_DEST/初始账号口令.txt"

# 首次生成 docker/.env：4 个「改成强口令」、会话密钥随机；本机 IP 与证书 SAN；前端与备份目录
sp_new_env() {
  say '生成 docker/.env（首次安装）'
  local guess
  # 站内网常常没有缺省路由：ip route get 报 Network is unreachable（返回 2），不带 || true 会在这里悄悄退出
  guess="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)"
  [ -n "$IP" ] || IP="$(ask '本机在站内网的 IP（浏览器、EG 都用它连子站）' "${guess:-}")"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "IP 不对：'$IP'（用 --ip 指定）"
  local pg tenant seed screen
  pg="$(rnd 20)"; tenant="Lsa$(rnd 13)"; seed="Lsa$(rnd 13)"; screen="Scr$(rnd 13)"
  cp "$SP_B/docker/.env.prod.example" "$SP_ENV"
  chmod 600 "$SP_ENV"
  setv "$SP_ENV" SP_HOST_IP "$IP"
  setv "$SP_ENV" SP_TLS_SAN "$IP"
  setv "$SP_ENV" PG_PASSWORD "$pg"
  setv "$SP_ENV" TB_TENANT_PASSWORD "$tenant"
  setv "$SP_ENV" EXT_SEED_PASSWORD "$seed"
  setv "$SP_ENV" SCREEN_PASSWORD "$screen"
  setv "$SP_ENV" EXT_JWT_SECRET "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if grep -q '^WEB_ROOT=' "$SP_ENV"; then setv "$SP_ENV" WEB_ROOT "$SP_DEST/web-root"; else setv "$SP_ENV" WEB_DIST_DIR "$SP_DEST/web"; fi
  setv "$SP_ENV" BACKUP_DIR /data/lsa9600sp/backup
  # TB 系统管理员：tb-install 建出来是出厂口令，provision 首次建租户要用它登录 —— 先留出厂值，up.sh 之后再改（sp_sysadmin）
  grep -q '改成强口令' "$SP_ENV" && die '模板里还有没替换的「改成强口令」（安装包与本脚本不配套）'
  (
    umask 077
    cat > "$SP_CRED" <<EOF
LSA-9600SP 子站 初始账号口令（安装时随机生成；首次登录后各自修改，改完删掉本文件）
生成时间：$(date '+%F %T')    本机 IP：$IP

浏览器入口             http://$IP/
业务管理员             admin / $tenant   （TB 租户管理员 $(envget "$SP_ENV" TB_TENANT_USER) 同一口令）
其余业务账号初始口令   $seed
上屏只读账号口令       $screen
PostgreSQL             postgres / $pg   （只绑本机）
EOF
  )
  echo "口令已写入 $SP_CRED（权限 600）"
}

# TB 系统管理员还是出厂口令就改成随机的（TB 只听本机 8080），写回 docker/.env 与口令文件
sp_sysadmin() {
  local u p url tok new
  u="$(envget "$SP_ENV" TB_SYSADMIN_USER)"
  p="$(envget "$SP_ENV" TB_SYSADMIN_PASSWORD)"
  [ "$p" = sysadmin ] || return 0
  url="http://127.0.0.1:$(envget "$SP_ENV" TB_HTTP_PORT)"
  # post <路径> <JSON> [令牌]：有 curl 用 curl，没有（最小安装）就借子站 app 镜像里的 node 发
  post() {
    if command -v curl >/dev/null; then
      curl -sf -X POST "$url$1" -H 'Content-Type: application/json' ${3:+-H "X-Authorization: Bearer $3"} -d "$2"
    else
      docker run --rm --network host --entrypoint node -e U="$url$1" -e B="$2" -e T="${3:-}" "lsa9600sp/app:$(envget "$SP_ENV" APP_VERSION)" -e \
        'fetch(process.env.U,{method:"POST",headers:{"Content-Type":"application/json",...(process.env.T?{"X-Authorization":"Bearer "+process.env.T}:{})},body:process.env.B}).then(async r=>{const t=await r.text();if(!r.ok)process.exit(1);process.stdout.write(t)},()=>process.exit(1))'
    fi
  }
  tok="$(post /api/auth/login "{\"username\":\"$u\",\"password\":\"sysadmin\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
  if [ -z "$tok" ]; then
    echo "提醒：ThingsBoard 系统管理员用出厂口令登录不上（已被改过？），docker/.env 的 TB_SYSADMIN_PASSWORD 请手工改成实际口令"
    return 0
  fi
  new="Sys$(rnd 17)"
  post /api/auth/changePassword "{\"currentPassword\":\"sysadmin\",\"newPassword\":\"$new\"}" "$tok" >/dev/null || die 'ThingsBoard 系统管理员改口令失败'
  setv "$SP_ENV" TB_SYSADMIN_PASSWORD "$new"
  (
    umask 077
    echo "TB 系统管理员         $u / $new   （TB 管理界面只绑本机：ssh -L 8080:127.0.0.1:8080 <子站主机>）" >> "$SP_CRED"
  )
  echo "ThingsBoard 系统管理员出厂口令已改成随机口令（见 $SP_CRED）"
}

# 子站主机当站内时间服务器：各 EG 的 chrony 指向 eg.yaml 的 sp.host（EG install.sh 写）。
# 0.9.3 现场流程里发现子站的 chrony 只有 Ubuntu 的公网 pool、不 allow 客户端 —— EG 对不上时，
# 各自漂（10 天差到 1 分钟）、断电重启后差更多，子站下发配置的票据因「时间在未来」被拒。
sp_chrony() {
  # 子站离线包自带对时脚本时用它（与后端会话商定：同名同内容，另管防火墙、chrony 3.x / 麒麟的主配置块、--check）；
  # 老包没有就用下面这份
  if [ -f "$SP_B/scripts/setup-ntp.sh" ]; then
    bash "$SP_B/scripts/setup-ntp.sh" ${NTP:+--ntp "$NTP"} || echo '提醒：子站对时脚本报错（见上）—— 不处理的话 EG 对不上时，子站下发配置会被拒'
    return 0
  fi
  [ -d /etc/chrony ] || { echo '提醒：本机没有 chrony，子站主机不能给 EG 对时'; return 0; }
  local conf=/etc/chrony/conf.d/lsa9600sp.conf src=/etc/chrony/sources.d/lsa9600sp.sources
  mkdir -p /etc/chrony/conf.d /etc/chrony/sources.d
  # --ntp 没给就沿用上次记下的
  [ -n "$NTP" ] || NTP="$(awk '$1 == "server" { print $2; exit }' "$src" 2>/dev/null || true)"
  cat > "$conf" <<'EOF'
# LSA-9600SP（一键安装 setup.sh 写）：子站主机给站内各 EG 对时（UDP 123）
allow 10.0.0.0/8
allow 172.16.0.0/12
allow 192.168.0.0/16
# 没有上级时钟源、或暂时连不上时，用本机时钟继续服务：全站至少都跟子站一致
local stratum 10 orphan
EOF
  if [ -n "$NTP" ]; then echo "server $NTP iburst prefer" > "$src"; else rm -f "$src"; fi
  systemctl enable chrony >/dev/null 2>&1 || true
  systemctl restart chrony
  echo "对时：子站主机给站内 EG 当时间服务器（UDP 123）；上级时钟源 ${NTP:-未给（以后 --ntp <地址> 补上），先用本机时钟、全站跟子站一致}"
}

# 站内 CA 私钥的 sha256：0.9.3 起在 docker/tls-ca/，更早在 docker/tls/；都没有输出空
ca_key_sum() {
  local f
  for f in "$SP_B/docker/tls-ca/sp-ca.key" "$SP_B/docker/tls/sp-ca.key"; do
    [ -f "$f" ] && { sha256sum < "$f" | cut -c1-64; return 0; }
  done
  return 0
}

install_sp() {
  local mem_gb ver ip
  mem_gb=$(( $(awk '/MemTotal/ { print $2 }' /proc/meminfo) / 1024 / 1024 ))
  [ "$mem_gb" -ge 7 ] || echo "提醒：本机内存约 ${mem_gb} GB，子站 ThingsBoard 缺省堆 4 GB，建议 ≥ 8 GB（docker/.env 的 TB_JAVA_OPTS 可调小）"

  say '导入子站镜像（几分钟）'
  if [ "$(cat "$SP_DEST/.loaded" 2>/dev/null)" = "$(cat VERSION)" ]; then echo '这一版的镜像已导入过，跳过'
  else gunzip -c sp/images.tar.gz | docker load | sed 's/^/  /'; fi

  # 站内 CA 变了，各 EG 手上的 sp-ca.pem 就全部失效、连不上 8883：证书与私钥升级前后都必须一致。
  # 私钥 0.9.3 起在 docker/tls-ca/（不挂进容器），更早在 docker/tls/；up.sh 会自动迁，所以两处都认。
  local ca="$SP_B/docker/tls/sp-ca.pem" ca0='' k0=''
  [ -f "$ca" ] && ca0="$(sha256sum < "$ca" | cut -c1-64)"
  k0="$(ca_key_sum)"
  if [ -f "$SP_ENV" ] && { [ -z "$ca0" ] || [ -z "$k0" ]; } && [ "$FORCE" != 1 ]; then
    die "已有 docker/.env，但站内 CA 不全（docker/tls/sp-ca.pem $([ -n "$ca0" ] && echo 在 || echo 缺)；私钥 docker/tls-ca/ 或 docker/tls/ 下的 sp-ca.key $([ -n "$k0" ] && echo 在 || echo 缺)）：继续的话 up.sh 会新生成 CA，所有 EG 的 sp-ca.pem 失效。先把原来的 docker/tls、docker/tls-ca 放回 $SP_B/docker/；确实要换 CA（之后每台 EG 重出配置包）加 --force"
  fi

  say "放置文件到 $SP_DEST"
  mkdir -p "$SP_B"
  # 部署文件整体覆盖；docker/.env、docker/tls（服务端证书、CA 证书）、docker/tls-ca（CA 私钥）一律不碰，安装包里万一带了也跳过
  tar -C sp/lsa9600sp-backend --exclude=./docker/.env --exclude=./docker/tls --exclude=./docker/tls-ca -cf - . | tar -C "$SP_B" -xf -
  find "$SP_B/scripts" -name '*.sh' -exec chmod +x {} +
  cp -a docs "$SP_DEST/" 2>/dev/null || true

  ver="$(envget "$SP_B/docker/.env.prod.example" APP_VERSION)"
  if [ -f "$SP_ENV" ]; then
    echo "已有 docker/.env：按升级处理（保留配置，只把 APP_VERSION 改成 $ver）"
    setv "$SP_ENV" APP_VERSION "$ver"
  else
    sp_new_env
  fi

  say '前端'
  if [ -f "$SP_B/scripts/install-web.sh" ]; then
    # 0.9.3 起交给子站自己的 install-web.sh：WEB_ROOT/releases/<版本> + current 符号链接原子切换（--rollback 可回退）；
    # 网页检查留给 up.sh 收尾时做
    bash "$SP_B/scripts/install-web.sh" --no-check "$PWD/sp/web"
  else
    # 早先的包：原地换内容、不换目录 —— Nginx 绑定挂载的是目录本身，删了重建的话没被重建的 Nginx 看到的是已删除的空目录，
    # 整站 403（0.9.2 升级验证踩到）。先拷新的再删新版本里没有的旧文件（旧的带哈希的 assets）。
    mkdir -p "$SP_DEST/web"
    cp -a sp/web/. "$SP_DEST/web/"
    (cd "$SP_DEST/web" && find . -mindepth 1 -depth -print0) | while IFS= read -r -d '' f; do
      [ -e "sp/web/$f" ] || rm -rf "${SP_DEST:?}/web/$f"
    done
  fi

  say '对时'
  sp_chrony

  say '启动（证书 → 建库 → provision → 扩展服务、Nginx、视频）'
  bash "$SP_B/scripts/up.sh" --prod
  # 早先版本的安装文件升级时换过前端目录，Nginx 可能还挂着已删除的旧目录：看不到 index.html 就重启它（重新挂载）
  if ! docker exec lsa-nginx sh -c 'test -f /usr/share/nginx/web-root/current/index.html || test -f /usr/share/nginx/html/index.html' 2>/dev/null; then
    echo 'Nginx 看不到前端文件（挂着已删除的旧目录），重启 Nginx'
    docker restart lsa-nginx >/dev/null
  fi
  if [ -n "$ca0" ]; then
    local ca1 k1
    ca1="$(sha256sum < "$ca" 2>/dev/null | cut -c1-64 || true)"; k1="$(ca_key_sum)"
    if [ "$ca1" = "$ca0" ] && [ "$k1" = "$k0" ]; then echo "站内 CA 未变（证书 sha256 ${ca0:0:16}…、私钥 sha256 ${k0:0:16}…），各 EG 的 sp-ca.pem 照常可用"
    else die "站内 CA 在升级中变了（证书 ${ca0:0:16}… → ${ca1:0:16}…，私钥 ${k0:0:16}… → ${k1:0:16}…）：各 EG 的 sp-ca.pem 全部失效。用备份的 docker/tls、docker/tls-ca 换回去再跑 up.sh --prod"; fi
  fi
  cat VERSION > "$SP_DEST/.loaded"
  # TB 系统管理员出厂口令改随机：子站 up.sh 自己会改（rotate_sysadmin，与后端会话商定只留那一份）时不再做，
  # 否则这里用出厂口令登不进去会误报「请手工改」；老包的 up.sh 没有这一步，照旧由这里改
  if grep -q 'rotate_sysadmin' "$SP_B/scripts/up.sh" 2>/dev/null; then :; else sp_sysadmin; fi

  ip="$(envget "$SP_ENV" SP_HOST_IP)"
  say '子站装好了'
  echo "  浏览器打开 http://$ip/    账号口令见 $SP_CRED（首次安装时生成，权限 600）"
  echo "  自检：curl -s http://127.0.0.1/ext/health"
  echo "  接 EG：每台 EG 先用本安装文件 --role eg --sp-key <本机公钥> 装第一轮，再在 $SP_B 跑 scripts/provision-eg.sh --ssh lsa-sp@<EG> …、scripts/pack-eg.sh（docs/子站部署手册.md §5b）"
}

# ---------- EG ----------
install_eg() {
  local DEST=/opt/lsa-eg
  say "放置文件到 $DEST"
  mkdir -p "$DEST/debs"
  # 发布件整体覆盖（config/、recordings/、.env 不在安装包里，不会被动到）；离线 deb 与子站共用一份
  cp -a eg/. "$DEST/"
  cp -a debs/. "$DEST/debs/"
  cp -a docs "$DEST/" 2>/dev/null || true
  if [ -z "$LAN1" ] && ! grep -q '^EG_LAN1=.' "$DEST/.env" 2>/dev/null; then
    echo '网口：'
    ip -br -4 addr 2>/dev/null | grep -v '^lo ' | sed 's/^/  /' || true
    LAN1="$(ask '哪个是接摄像机的 LAN1（管理页对它关闭；直接回车跳过）' '')"
  fi
  if [ -n "$EGCFG" ]; then
    [ -f "$EGCFG/eg.yaml" ] || die "$EGCFG 里没有 eg.yaml"
    mkdir -p "$DEST/config"
    install -m 600 "$EGCFG/eg.yaml" "$DEST/config/eg.yaml"
    [ -f "$EGCFG/sp-ca.pem" ] && install -m 600 "$EGCFG/sp-ca.pem" "$DEST/config/sp-ca.pem"
    echo "已拷入 $EGCFG 的 eg.yaml$([ -f "$EGCFG/sp-ca.pem" ] && echo '、sp-ca.pem')（权限 600）"
  fi
  say '安装（install.sh）'
  local args=()
  [ -n "$LAN1" ] && args+=(--lan1 "$LAN1")
  [ "$FORCE" = 1 ] && args+=(--force)
  [ -n "$SPKEY" ] && args+=(--sp-key "$SPKEY")
  bash "$DEST/install.sh" "${args[@]}"
}

case "$ROLE" in
  sp) install_sp ;;
  eg) install_eg ;;
esac
