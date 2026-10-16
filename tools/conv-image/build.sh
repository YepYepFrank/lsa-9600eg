#!/bin/bash
# 打转换程序的 EG 部署镜像（离线）：克隆同事仓库 → git am 我方补丁 → 断网装依赖 → docker build --network none
#   bash build.sh <同事仓库> <镜像 tag，如 lsa-eg-conv:1.1.1-p4>
# 缺省配置按 EG 改两处：serial.port → /dev/ttyS1（容器里的串口，宿主机设备由 install.sh --conv-serial 映射进来）；
# 总线地址保持 127.0.0.1:1884。设备名、启用哪些传感器在 EG 的 config/conv/ 里按柜改。
set -euo pipefail
export MSYS_NO_PATHCONV=1
SRC="${1:?同事仓库}"; TAG="${2:?镜像 tag}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHES="$(cd "$HERE/../conv-patches/edge-gateway-1.1.1" && (pwd -W 2>/dev/null || pwd))"
CTX="$(cygpath -m "$(mktemp -d)" 2>/dev/null || mktemp -d)"   # Windows 上给 git / docker 的路径要 C:/… 写法
git -c core.longpaths=true -c core.autocrlf=false clone -q "$SRC" "$CTX/repo"
base="$(git -C "$CTX/repo" rev-parse --short HEAD)"
git -C "$CTX/repo" -c user.name=lsa-build -c user.email=lsa-build@localhost am -q "$PATCHES"/*.patch
n="$(git -C "$CTX/repo" rev-list --count "$base"..HEAD)"
cp -r "$CTX/repo/src" "$CTX/repo/config" "$CTX/"
find "$CTX/src" -name '__pycache__' -prune -exec rm -rf {} +
sed -i '/^serial:/,/^[a-z]/s#^\(  port: *\)"[^"]*"#\1"/dev/ttyS1"#' "$CTX/config/gateway.yaml"
grep -q '"/dev/ttyS1"' "$CTX/config/gateway.yaml" || { echo 'serial.port 没改成 /dev/ttyS1' >&2; exit 1; }
echo "1.1.1（同事 $base + 我方补丁 $n 个）" > "$CTX/VERSION"
cp "$HERE/Dockerfile" "$HERE/entrypoint.sh" "$CTX/"
mkdir -p "$CTX/wheels" && cp "$SRC"/wheels/*.whl "$CTX/wheels/"
CW="$(cd "$CTX" && (pwd -W 2>/dev/null || pwd))"
docker run --rm --pull never --network none -v "$CW:/ct" python:3.12-slim sh -c '
  pip install -q --root-user-action=ignore --no-index --find-links /ct/wheels --target /ct/deps aiomqtt aiosqlite pyserial
  python3 -c "import zipfile,glob; z=zipfile.ZipFile(glob.glob(\"/ct/wheels/pyyaml-*.whl\")[0]); [z.extract(f,\"/ct/deps\") for f in z.namelist() if f.startswith(\"yaml/\") and f.endswith(\".py\")]"'
rm -rf "$CTX/repo" "$CTX/wheels"
docker build --pull=false --network none -q -t "$TAG" "$CW"
docker run --rm --network none --entrypoint python3 "$TAG" -c "import aiomqtt, aiosqlite, serial, yaml; print('依赖就绪')"
echo "镜像 $TAG：$(docker image inspect -f '{{.Id}}' "$TAG")；$(cat "$CTX/VERSION")"
rm -rf "$CTX"
