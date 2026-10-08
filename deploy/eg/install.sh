#!/usr/bin/env bash
# EG 安装 / 升级 / 回退（在 EG 上、部署目录里跑，可反复跑）。步骤说明见 docs/EG部署手册.md。
#
#   sudo bash install.sh [--lan1 <网口>]   装 / 升级：没有 Docker 先装离线包、导入镜像、起本地 TB；config/eg.yaml 齐了就起全部
#   sudo bash install.sh --status          只看状态
#   sudo bash install.sh --rollback        回到上一个装好的版本（镜像还在本机；本地 TB 版本变过的不许回退）
#
# --lan1：摄像机网口名（如 enp2s0）。管理页对从它进来的请求一律 403（I5-2），记在 .env 里，以后不用再给。
#   网口必须存在；本机只有一个对外网口时拒绝（那样唯一的网口也会被挡住，管理页谁都打不开），确实要这样加 --force。
# 升级在原安装目录（/opt/lsa-eg）里跑：在别的目录跑、而本机已装在别处时拒绝（会生成另一份 .env 把本地库按新口令重建），--force 才另装。
# --sp-key <子站公钥文件或公钥串>：给子站 provision-eg.sh 用的隧道账号 lsa-sp 授权（可反复给、不重复加）。
#   lsa-sp 没有口令、没有 shell，authorized_keys 带 restrict,port-forwarding,permitopen="127.0.0.1:18080"：
#   只能从子站开隧道到本机的本地 TB（18080），别的都不行。部署完用 --drop-sp-key 删掉（以后要再建实体重新 --sp-key）。
# --drop-sp-key：删掉隧道账号 lsa-sp（连同它的 authorized_keys），别的不动。
# 装完与 --status 都会列「安全提醒」：初始口令文件还在、lsa-sp 还在、SSH 允许口令登录等（只提醒，不替你改系统配置）。
#
# 分两轮是因为本地 TB 的设备、告警规则由子站跑 provision:eg 建（经 SSH 隧道连这台 EG 的 127.0.0.1:18080），
# 它同时把本地 TB 账号写进 eg.yaml —— 所以：第一轮起本地 TB → 子站 provision:eg → 拷回 eg.yaml → 第二轮起全部。
set -euo pipefail
cd "$(dirname "$0")"
DC='docker compose'
LAN1=''
SPKEY=''
MODE='install'
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE='status' ;;
    --rollback) MODE='rollback' ;;
    --lan1) LAN1="${2:?--lan1 后面给网口名}"; shift ;;
    --force) FORCE=1 ;;
    --sp-key) SPKEY="${2:?--sp-key 后面给子站公钥（文件或公钥串）}"; shift ;;
    --drop-sp-key) MODE='drop-sp' ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done

status() {
  $DC ps --format 'table {{.Name}}\t{{.Status}}'
  [ -f .installed/VERSION ] && echo "已装版本：$(cat .installed/VERSION)"
  [ -f .previous/VERSION ] && echo "可回退到：$(cat .previous/VERSION)"
  true
}
# 安全提醒（只提醒，不改系统配置：自动关 SSH 口令登录可能把维护人员锁在外面）
security_notes() {
  local msg=()
  [ -f config/initial-password.txt ] && msg+=('本地维护账号 maint 的初始口令文件还在（config/initial-password.txt）：登录管理页改掉口令后删除它')
  id lsa-sp >/dev/null 2>&1 && msg+=('隧道账号 lsa-sp 还在：子站 provision-eg.sh 跑完后可删 —— sudo bash install.sh --drop-sp-key（以后要再建实体重新 --sp-key）')
  if command -v sshd >/dev/null 2>&1 && sshd -T 2>/dev/null | grep -x 'passwordauthentication yes' >/dev/null; then  # 不用 -q：提前退出会让 sshd 收 SIGPIPE，pipefail 下判成假
    msg+=('SSH 允许口令登录：维护账号改用密钥登录后建议关掉（/etc/ssh/sshd_config.d/ 下写 PasswordAuthentication no，再 systemctl reload ssh）')
  fi
  grep -q '^EG_PASSIVE=.' .env 2>/dev/null && msg+=('.env 里有 EG_PASSIVE：那是开发用的旁观模式，现场要删掉')
  [ "${#msg[@]}" -gt 0 ] || return 0
  echo
  echo '安全提醒：'
  local m
  for m in "${msg[@]}"; do echo "  - $m"; done
}
[ "$MODE" = 'status' ] && { status; security_notes; exit 0; }
[ "$(id -u)" = 0 ] || { echo '要用 sudo 跑' >&2; exit 1; }
if [ "$MODE" = 'drop-sp' ]; then
  if id lsa-sp >/dev/null 2>&1; then
    pkill -u lsa-sp 2>/dev/null || true   # 子站隧道正开着的话断掉
    userdel -r lsa-sp 2>/dev/null || userdel lsa-sp
    echo '已删除隧道账号 lsa-sp（以后要让子站再建本地实体：sudo bash install.sh --sp-key <子站公钥>）'
  else
    echo '没有隧道账号 lsa-sp，不用删'
  fi
  exit 0
fi

# .env 里设一项（有就改、没有就加）
env_set() {
  if grep -q "^$1=" .env 2>/dev/null; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}
# 本地 TB 的版本（compose.yaml 里 tb-node 的缺省标签）：回退不能跨它（库结构只升不降）
tb_version() { grep -o 'tb-node:\${TB_VERSION:-[^}]*}' "$1" | head -1 | sed 's/.*:-//; s/}//'; }
# 部署文件（升级时整个发布件覆盖过来的那些）
DEPLOY_FILES='compose.yaml mosquitto.conf install.sh diskcheck.sh VERSION IMAGES.txt extensions'

# ---------- 回退 ----------
if [ "$MODE" = 'rollback' ]; then
  [ -f .previous/VERSION ] || { echo '没有上一个版本可回退（.previous/ 不存在）' >&2; exit 1; }
  prev="$(cat .previous/VERSION)"
  if [ "$(tb_version .previous/compose.yaml)" != "$(tb_version compose.yaml)" ]; then
    echo "上一个版本 $prev 的本地 TB 是 $(tb_version .previous/compose.yaml)，现在是 $(tb_version compose.yaml)：库结构已升级，不能回退" >&2
    exit 1
  fi
  docker image inspect "lsa-eg-app:$prev" >/dev/null 2>&1 || { echo "本机没有镜像 lsa-eg-app:$prev（被清掉了？）" >&2; exit 1; }
  echo "回退到 $prev ..."
  rm -rf .rollback-tmp && mkdir .rollback-tmp
  for f in $DEPLOY_FILES; do [ -e "$f" ] && cp -a "$f" .rollback-tmp/; done
  for f in $DEPLOY_FILES; do [ -e ".previous/$f" ] && { rm -rf "$f"; cp -a ".previous/$f" .; }; done
  env_set EG_APP_IMAGE "lsa-eg-app:$prev"
  $DC up -d --remove-orphans
  rm -rf .installed && mv .previous .installed && mv .rollback-tmp .previous
  echo; status
  exit 0
fi

# ---------- 1. Docker 与 chrony（没有就装发布件里的离线包） ----------
if ! command -v docker >/dev/null || ! command -v chronyd >/dev/null; then
  ls debs/*.deb >/dev/null 2>&1 || { echo '没有 docker / chrony，发布件里也没有离线包 debs/（pack:eg -- --debs）' >&2; exit 1; }
  echo '装离线包（Docker、chrony）...'
  # 与 chrony 冲突的 systemd-timesyncd 先卸（卸载不用联网）；再 dpkg 一次装全部（同一批里自己排依赖顺序）。
  # 不用 apt-get install ./debs/*.deb：机器上留着装系统时的软件源索引时，apt 会拿索引里的记录去找包（虚拟样机上报「Pathname to install is not absolute」）
  installed() { dpkg-query -W -f '${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
  if installed systemd-timesyncd; then DEBIAN_FRONTEND=noninteractive apt-get remove -y systemd-timesyncd; fi
  # 只装本机没有、或比本机新的（debs/ 是在干净容器里下的，比服务器版多出的那些不重装、不降级）
  todo=()
  for d in debs/*.deb; do
    pkg="$(dpkg-deb -f "$d" Package)"; ver="$(dpkg-deb -f "$d" Version)"
    cur="$(dpkg-query -W -f '${Status} ${Version}' "$pkg" 2>/dev/null | awk '$3=="installed"{print $4}' || true)"
    if [ -z "$cur" ] || dpkg --compare-versions "$ver" gt "$cur"; then todo+=("$d"); fi
  done
  [ ${#todo[@]} -eq 0 ] || DEBIAN_FRONTEND=noninteractive dpkg -i "${todo[@]}"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
$DC version >/dev/null 2>&1 || { echo '没有 docker compose 插件' >&2; exit 1; }

# 系统日志封顶（容器日志在 compose.yaml 里各自 10 MB × 3）
if [ ! -f /etc/systemd/journald.conf.d/lsa-eg.conf ]; then
  mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nSystemMaxUse=200M\nSystemMaxFileSize=20M\n' > /etc/systemd/journald.conf.d/lsa-eg.conf
  systemctl restart systemd-journald || true
fi

# ---------- 2. 版本切换：上一次装好的留作回退 ----------
VERSION="$(cat VERSION 2>/dev/null || echo latest)"
if [ -f .installed/VERSION ] && [ "$(cat .installed/VERSION)" != "$VERSION" ]; then
  echo "升级：$(cat .installed/VERSION) → $VERSION（旧版留作回退：install.sh --rollback）"
  rm -rf .previous && mv .installed .previous
fi

# ---------- 3. 镜像（离线） ----------
for f in images-*.tar.gz; do
  [ -f "$f" ] || continue
  [ -f ".loaded-$f" ] && [ "$(cat ".loaded-$f")" = "$VERSION" ] && continue
  echo "导入镜像 $f（几分钟）..."
  gunzip -c "$f" | docker load >/dev/null
  echo "$VERSION" > ".loaded-$f"
done
# 镜像清单（pack:eg 写的）逐个核对：tag 在、ID 对得上
if [ -f IMAGES.txt ]; then
  bad=0
  while read -r img _ id; do
    case "$img" in ''|'#'*) continue ;; esac
    got="$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || echo 没有)"
    [ "$got" = "$id" ] || { echo "镜像 $img 不对：应为 $id，本机 $got" >&2; bad=1; }
  done < IMAGES.txt
  [ "$bad" = 0 ] || exit 1
fi

# ---------- 4. .env（本地库口令等，只生成一次） ----------
# 这台已经装在别的目录时拒绝：compose 项目名固定 lsa-eg、数据卷跟着项目名，在另一个目录跑会生成另一份 .env（新的本地库口令），
# 把正在跑的本地库 / TB 按新口令重建 → TB 连不上库反复重启（现场流程验收踩到）。升级要把新发布件拷进原目录再跑。
if [ ! -f .env ] && [ "$FORCE" != 1 ]; then
  old="$(docker inspect lsa-eg-postgres --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)"
  [ -z "$old" ] && [ -f /opt/lsa-eg/.env ] && old=/opt/lsa-eg
  if [ -n "$old" ] && [ "$(readlink -f "$old")" != "$(pwd -P)" ]; then
    echo "这台 EG 已经装在 $old（本地库口令在那里的 .env），不要在 $(pwd -P) 另装。" >&2
    echo "升级：sudo cp -a $(pwd -P)/. $old/ && sudo bash $old/install.sh，或用一键安装文件 --role eg。确实要另装加 --force" >&2
    exit 1
  fi
fi
if [ ! -f .env ]; then
  pg="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > .env <<EOF
# 这台 EG 的本地配置（install.sh 生成）—— 含本地库口令，不外传
EG_PG_PASSWORD=$pg
EOF
  chmod 600 .env
  echo '已生成 .env'
fi
env_set EG_APP_IMAGE "lsa-eg-app:$VERSION"
sed -i '/^EG_AGENT_IMAGE=/d' .env
if [ -n "$LAN1" ]; then
  [ -e "/sys/class/net/$LAN1" ] || { echo "没有网口 $LAN1（本机：$(ls /sys/class/net | tr '\n' ' ')）" >&2; exit 1; }
  # 对外网口：物理网卡（有 device 链接），不算 lo、docker、网桥、veth
  nics=$(for n in /sys/class/net/*; do if [ -e "$n/device" ]; then basename "$n"; fi; done | wc -l)
  if [ "$nics" -le 1 ] && [ "$FORCE" != 1 ]; then
    echo "本机只有 $nics 个物理网口，--lan1 $LAN1 会把唯一的网口也挡掉（管理页谁都打不开）。单网口的机器不要给 --lan1；确实要这样加 --force" >&2
    exit 1
  fi
  env_set EG_LAN1 "$LAN1"
fi
grep -q '^EG_LAN1=.' .env || echo '（提示：没给 --lan1：管理页在摄像机网口上也能打开，只能靠防火墙挡）'
mkdir -p config/gateway/config config/mediamtx recordings

# ---------- 子站 provision-eg.sh 的隧道账号（--sp-key） ----------
if [ -n "$SPKEY" ]; then
  key="$SPKEY"; [ -f "$SPKEY" ] && key="$(head -1 "$SPKEY")"
  echo "$key" | grep -Eq '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) [A-Za-z0-9+/=]+' || { echo "--sp-key 不像 SSH 公钥：$key" >&2; exit 1; }
  id lsa-sp >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/lsa-sp --shell /usr/sbin/nologin lsa-sp
  install -d -m 700 -o lsa-sp -g lsa-sp /var/lib/lsa-sp/.ssh
  ak=/var/lib/lsa-sp/.ssh/authorized_keys
  touch "$ak"
  body="$(echo "$key" | awk '{print $1" "$2}')"
  if ! grep -qF "$body" "$ak"; then
    echo "restrict,port-forwarding,permitopen=\"127.0.0.1:18080\" $key" >> "$ak"
    echo "已给子站公钥授权：lsa-sp 只能开隧道到本机 127.0.0.1:18080"
  fi
  chown lsa-sp:lsa-sp "$ak"; chmod 600 "$ak"
fi

# ---------- 5. 本地 TB：库是空的先建库 ----------
$DC up -d --wait postgres
if ! $DC exec -T postgres psql -U postgres -d thingsboard -tAc "select 1 from information_schema.tables where table_name='tb_user'" | grep -q 1; then
  echo '首次安装：建本地 TB 的库（约 1 分钟）...'
  $DC --profile install run --rm tb-install
fi
$DC up -d mosquitto tb
echo '等本地 TB 起来（首次约 1–2 分钟）...'
$DC up -d --wait tb

# ---------- 6. eg.yaml 齐了（带本地 TB 账号 tb:）才起其余 ----------
if [ ! -f config/eg.yaml ] || ! grep -q '^tb:' config/eg.yaml; then
  cat <<EOF

本地 TB 已起。下一步（手册 §4）：
  1. 给子站授权开隧道（没给过的话）：把子站主机的 SSH 公钥拷过来，sudo bash install.sh --sp-key <公钥文件>
     （建只能转发到本机 18080 的账号 lsa-sp，没有 shell）
  2. 在子站主机上（/opt/lsa9600sp/lsa9600sp-backend）：
       scripts/provision-eg.sh --cabinet <柜号> --ssh lsa-sp@<这台 EG 的 LAN2 地址> [--ssh-key <私钥>] --hook http://host.docker.internal/hooks/alarm --sp <子站地址>
     可先加 --plan 只读核对一遍。它在容器里开隧道连这台 EG 的 127.0.0.1:18080，子站主机不用装 Node
  3. 在子站主机上出这台的配置包：scripts/pack-eg.sh --sp <子站地址> --only <柜号>
     → dist/eg/<柜号>/eg.yaml 与 sp-ca.pem（上送走 mqtts 8883）
  4. 把这两个文件拷到这里的 /opt/lsa-eg/config/（用维护账号，lsa-sp 拷不了文件），再跑一次 sudo bash install.sh
EOF
  exit 0
fi
[ -f config/sp-ca.pem ] || echo '（提示：config/ 里没有 sp-ca.pem —— 子站用自签证书时，上送与事件会因证书不受信而连不上）'

# 对时：chrony 跟子站主机（eg.yaml sp.host）
sp_host="$(awk '/^sp:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="host:"{gsub(/["'\'']/,"",$2);print $2;exit}' config/eg.yaml)"
if [ -n "$sp_host" ] && [ -d /etc/chrony ]; then
  mkdir -p /etc/chrony/sources.d
  echo "server $sp_host iburst prefer" > /etc/chrony/sources.d/lsa-eg.sources
  # X26A 没有 RTC 电池：断电后开机时钟是错的，子站又可能比 EG 晚起来 —— 缺省的 makestep 1 3 只在头 3 次更新里跳，
  # 之后差几分钟也只慢慢追（几小时），这期间子站下发配置 / 单点登录的票据会因时钟差被拒。改成任何时候差 > 1 s 就跳。
  # 要改 chrony.conf 本身那一行：conf.d 在文件开头被引入，后面的 makestep 1 3 会盖掉 conf.d 里写的（Ubuntu 24.04 实测）
  # chrony 不认行尾注释（「Too many arguments for makestep」，chronyd 起不来 —— 无 AVX 样机上踩到），说明写在上一行
  if grep -q '^makestep ' /etc/chrony/chrony.conf; then
    sed -i 's/^makestep .*/makestep 1 -1/' /etc/chrony/chrony.conf
  else
    echo 'makestep 1 -1' >> /etc/chrony/chrony.conf
  fi
  grep -q '^# LSA-9600EG makestep' /etc/chrony/chrony.conf ||
    sed -i '/^makestep /i # LSA-9600EG makestep：install.sh 改为 1 -1（没有 RTC 电池，差 > 1 s 随时跳到子站时间）' /etc/chrony/chrony.conf
  systemctl enable chrony >/dev/null 2>&1 || true
  systemctl restart chrony >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet chrony; then
    echo '!! chrony 没起来（sudo journalctl -u chrony 看原因）：这台 EG 不对时，时钟差 > 60 s 后子站下发配置、单点登录会被拒' >&2
  fi
fi

# 先生成 IoT Gateway 与 mediamtx 的配置（agent / video 每次启动也会生成；先生成一次，免得它们先起来拿默认配置）
RUN="$DC run --rm --no-deps"
$RUN agent node --import @swc-node/register/esm-register src/gateway/cli.ts
$RUN video node --import @swc-node/register/esm-register src/render.ts
$DC up -d --remove-orphans

# 装好了：部署文件留一份，下次升级时作回退用
rm -rf .installed && mkdir .installed
for f in $DEPLOY_FILES; do [ -e "$f" ] && cp -a "$f" .installed/; done
echo "$VERSION" > .installed/VERSION
# 更早的 lsa-eg-app 镜像（既不是现在的也不是可回退的）清掉
keep="lsa-eg-app:$VERSION lsa-eg-app:$(cat .previous/VERSION 2>/dev/null || echo -)"
for img in $(docker image ls lsa-eg-app --format '{{.Repository}}:{{.Tag}}'); do
  case " $keep " in *" $img "*) ;; *) docker image rm "$img" >/dev/null 2>&1 || true ;; esac
done

echo
status
echo
echo "装好了。本地管理页：http://<这台 EG 的 LAN2 地址>/（本地维护账号 maint，初始口令在 config/initial-password.txt，登录后改掉并删掉这个文件）"
echo "磁盘容量 / 写入量：sudo bash diskcheck.sh"
security_notes
