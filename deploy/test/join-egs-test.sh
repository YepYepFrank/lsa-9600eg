#!/bin/bash
# join-egs.sh 编排测试（0.18.0 舱室单元：--unit / --cabinet / --split / --from-file、预检四种情况、--force、拆柜改 model.site.yaml）。
# 子站、EG 都是假的（deploy/test/join-egs/：假 ssh 仿 EG 升级入口、假 docker 出 eg-list、假 provision / pack / up.sh），
# 在一次性容器里跑（要 node + bash；缺省用本机的 EG 应用镜像，不下载）：
#   bash deploy/test/join-egs-test.sh [镜像]
set -euo pipefail
export MSYS_NO_PATHCONV=1
IMG="${1:-$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 '^lsa-eg-app:' || true)}"
[ -n "$IMG" ] || { echo '本机没有 lsa-eg-app 镜像：给一个带 node 与 bash 的镜像名' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
echo "镜像 $IMG"
docker run --rm --pull never --entrypoint bash -u 0 -v "$ROOT/deploy:/deploy:ro" "$IMG" -c \
  'cp -r /deploy /d && find /d -type f \( -name "*.sh" -o -path "*/bin/*" \) -exec sed -i "s/\r$//" {} + && chmod +x /d/test/join-egs/bin/* && bash /d/test/join-egs/run.sh'
