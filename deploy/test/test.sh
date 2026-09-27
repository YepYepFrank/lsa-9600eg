#!/usr/bin/env bash
# 测试件起停（只在虚拟样机 / 实验台上用，现场不装）。放在部署目录 /opt/lsa-eg/test/ 下：
#
#   sudo bash test/test.sh up       导入测试镜像、摄像机改用仿真器 + 本机测试源、起 emu 与 camera、重启 eg-video
#   sudo bash test/test.sh down     停掉测试件（摄像机配置不改回，要改在本地管理页「视频接入配置」里改）
#   sudo bash test/test.sh status
#
# 要在正式编排第二轮装完（config/eg.yaml 齐了）之后跑。
set -euo pipefail
cd "$(dirname "$0")"
DC='docker compose -f compose.test.yaml'
export EG_EMU_IMAGE="lsa-eg-emu:$(cat VERSION)"

case "${1:-status}" in
  up)
    [ -f ../config/eg.yaml ] || { echo '先装好正式编排（config/eg.yaml）' >&2; exit 1; }
    for f in images-test-*.tar.gz; do
      [ -f "$f" ] || continue
      [ -f ".loaded-$f" ] && continue
      echo "导入测试镜像 $f ..."
      gunzip -c "$f" | docker load >/dev/null
      touch ".loaded-$f"
    done
    docker run --rm --network host -e EG_CONFIG_DIR=/config -v "$(cd .. && pwd)/config:/config" -w /app/apps/agent "$EG_EMU_IMAGE" \
      node --import @swc-node/register/esm-register ../../packages/emu/src/setup-test.ts
    $DC up -d
    docker restart lsa-eg-video >/dev/null
    $DC ps --format 'table {{.Name}}\t{{.Status}}'
    ;;
  down) $DC down ;;
  status) $DC ps --format 'table {{.Name}}\t{{.Status}}' ;;
  *) echo '用法：test.sh up | down | status' >&2; exit 2 ;;
esac
