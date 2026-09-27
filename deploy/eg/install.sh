#!/usr/bin/env bash
# EG 安装 / 升级 / 回退（在 EG 上、部署目录里跑，可反复跑）。步骤说明见 docs/EG部署手册.md。
#
#   sudo bash install.sh [--lan1 <网口>]   装 / 升级：没有 Docker 先装离线包、导入镜像、起本地 TB；config/eg.yaml 齐了就起全部
#   sudo bash install.sh --status          只看状态
#   sudo bash install.sh --rollback        回到上一个装好的版本（镜像还在本机；本地 TB 版本变过的不许回退）
#
# --lan1：摄像机网口名（如 enp2s0）。管理页对从它进来的请求一律 403（I5-2），记在 .env 里，以后不用再给。
#
# 分两轮是因为本地 TB 的设备、告警规则由子站跑 provision:eg 建（经 SSH 隧道连这台 EG 的 127.0.0.1:18080），
# 它同时把本地 TB 账号写进 eg.yaml —— 所以：第一轮起本地 TB → 子站 provision:eg → 拷回 eg.yaml → 第二轮起全部。
set -euo pipefail
cd "$(dirname "$0")"
DC='docker compose'
LAN1=''
MODE='install'
while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE='status' ;;
    --rollback) MODE='rollback' ;;
    --lan1) LAN1="${2:?--lan1 后面给网口名}"; shift ;;
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
[ "$MODE" = 'status' ] && { status; exit 0; }
[ "$(id -u)" = 0 ] || { echo '要用 sudo 跑' >&2; exit 1; }

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
  # apt 装本地 .deb：自己排依赖顺序、顺手卸掉与 chrony 冲突的 systemd-timesyncd；不联网
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-download \
    -o Dir::Etc::SourceList=/dev/null -o Dir::Etc::SourceParts=/dev/null ./debs/*.deb
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
[ -n "$LAN1" ] && env_set EG_LAN1 "$LAN1"
grep -q '^EG_LAN1=.' .env || echo '（提示：没给 --lan1：管理页在摄像机网口上也能打开，只能靠防火墙挡）'
mkdir -p config/gateway/config config/mediamtx recordings

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
  1. 在子站主机上开 SSH 隧道到这台 EG：ssh -N -L 18080:127.0.0.1:18080 <账号>@<这台 EG 的 LAN2 地址>
  2. 在子站后端库跑：pnpm provision:eg -- --cabinet <柜号> --url http://127.0.0.1:18080 --hook http://host.docker.internal/hooks/alarm --sp <子站地址>
  3. 在子站后端库出这台的配置包：scripts/pack-eg.sh --sp <子站地址> --only <柜号>，把 dist/eg/<柜号>/ 里的 eg.yaml 与 sp-ca.pem 拷到这里的 config/
  4. 再跑一次 sudo bash install.sh
EOF
  exit 0
fi
[ -f config/sp-ca.pem ] || echo '（提示：config/ 里没有 sp-ca.pem —— 子站用自签证书时，上送与事件会因证书不受信而连不上）'

# 对时：chrony 跟子站主机（eg.yaml sp.host）
sp_host="$(awk '/^sp:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="host:"{gsub(/["'\'']/,"",$2);print $2;exit}' config/eg.yaml)"
if [ -n "$sp_host" ] && [ -d /etc/chrony ]; then
  mkdir -p /etc/chrony/sources.d
  echo "server $sp_host iburst prefer" > /etc/chrony/sources.d/lsa-eg.sources
  systemctl enable --now chrony >/dev/null 2>&1 || true
  chronyc reload sources >/dev/null 2>&1 || true
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
