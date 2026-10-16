#!/bin/bash
# 打「转换程序接入包」：bash tools/conv-addon/pack.sh <同事仓库> <输出目录> [镜像 tag，缺省 lsa-eg-conv:1.1.1-p5]
# 镜像要先用 tools/conv-image/build.sh 打好。产物：
#   install-conv.sh、CONV_IMAGE.txt、images-conv.tar.gz、硬件联调步骤.md、conv-kit/（lsa_check、sim.py…）、
#   source/（同事仓库连 .git 打包，现场改了好重打）、patches/（我方补丁 0001–0005 + 说明）、build/（离线打镜像的脚本）、SHA256SUMS
set -euo pipefail
export MSYS_NO_PATHCONV=1
SRC="${1:?同事仓库}"; OUT="${2:?输出目录}"; TAG="${3:-lsa-eg-conv:1.1.1-p5}"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
docker image inspect "$TAG" >/dev/null
mkdir -p "$OUT"
cp "$HERE/install-conv.sh" "$HERE/硬件联调步骤.md" "$OUT/"
echo "$TAG" > "$OUT/CONV_IMAGE.txt"
echo "导出镜像 $TAG …"
docker save "$TAG" | gzip -6 > "$OUT/images-conv.tar.gz"
rm -rf "$OUT/conv-kit" "$OUT/patches" "$OUT/build" "$OUT/source"
mkdir -p "$OUT/conv-kit" "$OUT/patches" "$OUT/build" "$OUT/source"
( cd "$ROOT/tools/conv-kit" && tar -cf - --exclude=__pycache__ . ) | tar -xf - -C "$OUT/conv-kit"
cp "$ROOT/tools/conv-patches/edge-gateway-1.1.1/"*.patch "$ROOT/tools/conv-patches/edge-gateway-1.1.1/说明.md" "$OUT/patches/"
cp "$ROOT/tools/conv-image/"* "$OUT/build/"
rev="$(git -C "$SRC" rev-parse --short HEAD)"
( cd "$(dirname "$SRC")" && tar -czf - --exclude=__pycache__ --exclude='data/*' "$(basename "$SRC")" ) > "$OUT/source/edge-gateway-1.1.1-$rev.tar.gz"
( cd "$OUT" && find . -type f ! -name SHA256SUMS | sed 's#^\./##' | LC_ALL=C sort | xargs -d '\n' sha256sum > SHA256SUMS )
echo "镜像 $(docker image inspect -f '{{.Id}}' "$TAG")"
du -sh "$OUT"
