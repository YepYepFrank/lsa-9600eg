#!/usr/bin/env bash
# EG 安装 / 升级（在 EG 上、部署目录里跑，可反复跑）。步骤说明见 docs/EG部署手册.md。
#
#   sudo bash install.sh           装 / 升级：导入镜像、起本地 TB；config/eg.yaml 齐了就起全部
#   sudo bash install.sh --status  只看状态
#
# 分两轮是因为本地 TB 的设备、告警规则由子站跑 provision:eg 建（经 SSH 隧道连这台 EG 的 127.0.0.1:18080），
# 它同时把本地 TB 账号写进 eg.yaml —— 所以：第一轮起本地 TB → 子站 provision:eg → 拷回 eg.yaml → 第二轮起全部。
set -euo pipefail
cd "$(dirname "$0")"
DC='docker compose'

status() {
  $DC ps --format 'table {{.Name}}\t{{.Status}}'
}
[ "${1:-}" = '--status' ] && { status; exit 0; }

command -v docker >/dev/null || { echo '没有 docker：先装 Docker（离线包见手册 §2）' >&2; exit 1; }
$DC version >/dev/null 2>&1 || { echo '没有 docker compose 插件' >&2; exit 1; }

# 1. 镜像（离线）
for f in images-*.tar.gz; do
  [ -f "$f" ] || continue
  echo "导入镜像 $f（几分钟）..."
  gunzip -c "$f" | docker load >/dev/null
done
[ -f VERSION ] && sed -i "s#^EG_AGENT_IMAGE=.*#EG_AGENT_IMAGE=lsa-eg-agent:$(cat VERSION)#" .env 2>/dev/null || true

# 2. .env（本地库口令等，只生成一次）
if [ ! -f .env ]; then
  pg="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > .env <<EOF
# 这台 EG 的本地配置（install.sh 生成）—— 含本地库口令，不外传
EG_PG_PASSWORD=$pg
EG_AGENT_IMAGE=lsa-eg-agent:$(cat VERSION 2>/dev/null || echo latest)
EOF
  chmod 600 .env
  echo '已生成 .env'
fi
mkdir -p config/gateway/config

# 3. 本地 TB：库是空的先建库
$DC up -d --wait postgres
if ! $DC exec -T postgres psql -U postgres -d thingsboard -tAc "select 1 from information_schema.tables where table_name='tb_user'" | grep -q 1; then
  echo '首次安装：建本地 TB 的库（约 1 分钟）...'
  $DC --profile install run --rm tb-install
fi
$DC up -d mosquitto tb
echo '等本地 TB 起来（首次约 1–2 分钟）...'
$DC up -d --wait tb

# 4. eg.yaml 齐了（带本地 TB 账号 tb:）才起 IoT Gateway 与 agent
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

# 5. 生成 IoT Gateway 配置（agent 每次启动也会生成；先生成一次，免得 IoT Gateway 先起来拿默认配置）
$DC run --rm --no-deps agent node --import @swc-node/register/esm-register src/gateway/cli.ts
$DC up -d
echo
status
echo
echo "装好了。本地管理页：http://<这台 EG 的 LAN2 地址>/（本地维护账号 maint，初始口令在 config/initial-password.txt，登录后改掉并删掉这个文件）"
