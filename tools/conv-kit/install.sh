#!/usr/bin/env bash
# 转换程序测试总线：一键装 / 卸 EG 本机 Mosquitto（与 EG 上的 lsa-eg-mosquitto 同版本、同配置、同端口 127.0.0.1:1884）。
# 在 Ubuntu / Debian 上跑（EG 用 Ubuntu 24.04）。说明见同目录 README.md。
#
#   sudo bash install.sh              装：有 Docker 用容器（eclipse-mosquitto 2.1.2，与 EG 一致），没有就 apt 装系统自带的 mosquitto
#   sudo bash install.sh --lan        同上，但听 0.0.0.0：局域网里别的电脑（比如在 Windows 上调试的转换程序）也能连
#   sudo bash install.sh --docker     强制用容器        --native   强制用 apt 装
#   sudo bash install.sh --port 1885  换端口（缺省 1884，与 EG 一致；别处冲突时才换）
#   sudo bash install.sh --status     看状态
#   sudo bash install.sh --uninstall  卸掉（容器连同数据卷删掉；apt 装的只删本套件的配置，mosquitto 包留着）
#
# 镜像：本机已有 eclipse-mosquitto:2.1.2 就不拉；同目录有 images/eclipse-mosquitto-2.1.2.tar（离线包带的）就先导入；都没有才从 Docker Hub 拉。
# 装完自动自检：发 6 s 示范数据、用 lsa_check.py 收一遍，确认总线通。
set -euo pipefail
cd "$(dirname "$0")"
KIT="$(pwd)"
MODE=install
ENGINE=auto
BIND=127.0.0.1
PORT=1884
VER=2.1.2
NATIVE_CONF=/etc/mosquitto/conf.d/lsa-conv-kit.conf
while [ $# -gt 0 ]; do
  case "$1" in
    --lan) BIND=0.0.0.0 ;;
    --docker) ENGINE=docker ;;
    --native) ENGINE=native ;;
    --port) PORT="$2"; shift ;;
    --status) MODE=status ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

has_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }
need_root() { [ "$(id -u)" = 0 ] || die "要 root：sudo bash $0 $*"; }
PY=python3
command -v python3 >/dev/null 2>&1 || PY=''

# 这台就是装好的 EG：总线本来就在，不要再装一份
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx lsa-eg-mosquitto; then
  say "这台是 EG（lsa-eg-mosquitto 在跑），总线已在 127.0.0.1:1884，不用装。直接自检："
  echo "    python3 $KIT/lsa_check.py --eg-yaml /opt/lsa-eg/config/eg.yaml"
  exit 0
fi

listening() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$PORT\$"; }
docker_up() { docker ps --format '{{.Names}}' 2>/dev/null | grep -qx lsa-conv-mosquitto; }
native_up() { [ -f "$NATIVE_CONF" ] && systemctl is-active --quiet mosquitto 2>/dev/null; }

status() {
  if has_docker && docker_up; then
    say "容器 lsa-conv-mosquitto 在跑：$(docker port lsa-conv-mosquitto 1883/tcp | tr '\n' ' ')"
  elif native_up; then
    say "系统 mosquitto 在跑（$(mosquitto -h 2>/dev/null | head -1 | awk '{print $3}')），本套件配置 $NATIVE_CONF："
    grep -E '^listener' "$NATIVE_CONF" | sed 's/^/    /'
  else
    warn "没装（或没在跑）"
    return 1
  fi
}

uninstall() {
  need_root --uninstall
  if has_docker && docker ps -a --format '{{.Names}}' | grep -qx lsa-conv-mosquitto; then
    docker compose -p lsa-conv-kit -f "$KIT/compose.yaml" down -v
    say "容器与数据卷已删"
  fi
  if [ -f "$NATIVE_CONF" ]; then
    rm -f "$NATIVE_CONF"
    systemctl restart mosquitto 2>/dev/null || true
    say "已删 $NATIVE_CONF（mosquitto 包留着；不要了用 apt remove mosquitto）"
  fi
}

install_docker() {
  if ! docker image inspect "eclipse-mosquitto:$VER" >/dev/null 2>&1; then
    if [ -f "$KIT/images/eclipse-mosquitto-$VER.tar" ]; then
      say "导入离线镜像 images/eclipse-mosquitto-$VER.tar"
      docker load -i "$KIT/images/eclipse-mosquitto-$VER.tar"
    else
      say "拉镜像 eclipse-mosquitto:$VER"
      docker pull "eclipse-mosquitto:$VER" || die "拉不到镜像（没外网？）：在有网的机器上 docker save eclipse-mosquitto:$VER -o images/eclipse-mosquitto-$VER.tar 拷过来，或改用 --native"
    fi
  fi
  if ! docker_up && listening; then die "端口 $PORT 已被别的程序占用（ss -ltnp | grep :$PORT 看是谁），换一个：--port 1885"; fi
  LSA_BUS_BIND="$BIND" LSA_BUS_PORT="$PORT" MOSQUITTO_VERSION="$VER" docker compose -p lsa-conv-kit -f "$KIT/compose.yaml" up -d
}

install_native() {
  command -v apt-get >/dev/null 2>&1 || die "没有 Docker 也没有 apt-get：请装 Docker，或手工装 mosquitto（配置见 README「手工安装」）"
  if ! command -v mosquitto >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    say "apt 装 mosquitto mosquitto-clients python3"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mosquitto mosquitto-clients python3
  fi
  PY=python3
  if [ ! -f "$NATIVE_CONF" ] && listening; then die "端口 $PORT 已被别的程序占用（ss -ltnp | grep :$PORT 看是谁），换一个：--port 1885"; fi
  # Ubuntu 的 /etc/mosquitto/mosquitto.conf 已开 persistence 并 include conf.d；这里只加监听与排队上限
  cat > "$NATIVE_CONF" <<EOF
# 转换程序测试总线（tools/conv-kit/install.sh 生成；--uninstall 删掉）。与 EG 正式总线等价：不鉴权、持久化、放宽排队上限
listener $PORT $BIND
allow_anonymous true
max_queued_messages 50000
EOF
  systemctl enable mosquitto >/dev/null 2>&1 || true
  systemctl restart mosquitto
}

selftest() {
  local host=127.0.0.1
  for _ in 1 2 3 4 5 6 7 8 9 10; do listening && break; sleep 0.5; done
  listening || die "端口 $PORT 没起来：容器看 docker logs lsa-conv-mosquitto，apt 装的看 journalctl -u mosquitto"
  if [ -z "$PY" ]; then warn "没有 python3，跳过自检（检查工具 lsa_check.py 要 Python 3.8+）"; return; fi
  say "自检：发 6 s 示范数据并收一遍"
  "$PY" "$KIT/lsa_check.py" demo --cab TEST --host "$host" --port "$PORT" --duration 6 >/dev/null &
  local demo=$!
  if "$PY" "$KIT/lsa_check.py" --host "$host" --port "$PORT" --duration 8 --quiet >/tmp/lsa-conv-selftest.log 2>&1; then
    say "自检通过：总线收发正常"
  else
    tail -20 /tmp/lsa-conv-selftest.log
    die "自检没过（完整输出 /tmp/lsa-conv-selftest.log）"
  fi
  wait "$demo" 2>/dev/null || true
  # 自检的示范设备（*-TEST）只在总线上过了一遍，不留 retain、不留会话，不影响之后的检查
}

case "$MODE" in
  status) status; exit $? ;;
  uninstall) uninstall; exit 0 ;;
esac

need_root
if [ "$ENGINE" = auto ]; then
  if has_docker; then ENGINE=docker; else
    command -v docker >/dev/null 2>&1 && warn "装了 docker 但用不了（没起？缺 docker compose 插件？docker info 看看），改用 apt 装的 mosquitto"
    ENGINE=native
  fi
fi
[ "$ENGINE" = docker ] && ! has_docker && die "没有可用的 Docker（docker info 失败，或缺 docker compose 插件）；改用 --native"
say "安装方式：$([ "$ENGINE" = docker ] && echo "容器 eclipse-mosquitto:$VER" || echo 'apt 系统 mosquitto')，监听 $BIND:$PORT"
if [ "$ENGINE" = docker ]; then install_docker; else install_native; fi
selftest
status || true
echo
say "装好了。转换程序连 mqtt://127.0.0.1:$PORT（QoS 1、不 retain，格式见 EG内部MQTT格式.md）"
[ "$BIND" = 0.0.0.0 ] && echo "    局域网里别的电脑连 mqtt://<本机 IP>:$PORT（本机 IP：$(hostname -I 2>/dev/null | awk '{print $1}')）；正式 EG 上只听 127.0.0.1，联调完记得去掉 --lan 重装"
echo "    检查：python3 $KIT/lsa_check.py --cab <柜号> --group mv|tr|lv"
echo "    看原始消息：mosquitto_sub -h 127.0.0.1 -p $PORT -v -t 'lsa/#'（容器方式没装客户端时用 python3 lsa_check.py --raw）"
