#!/bin/bash
# 准备 MQTT 补丁的联调工作目录（不改同事的目录）：
#   bash prep.sh <edge-gateway 源码目录> <pyserial-3.5-py2.py3-none-any.whl> <工作目录>
# 工作目录里：app/（同事的 src + config，覆盖本补丁的两个文件；串口指向模拟器 /tmp/ttyV0、打开弧光）、
#             eg/eg.yaml（柜号 AH03）、deps/（同事 wheels/ 里的包 + pyserial，在断网的 python:3.12-slim 里装；PyYAML 只取纯 Python 部分）
# 之后：bash run.sh <工作目录>，再 python3 analyze.py <工作目录>
set -euo pipefail
export MSYS_NO_PATHCONV=1
SRC="${1:?edge-gateway 源码目录}"
SERIAL_WHL="${2:?pyserial whl}"
W="${3:?工作目录}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$(cd "$HERE/.." && pwd)"
mkdir -p "$W/app" "$W/eg" "$W/wheels" "$W/out"
rm -rf "$W/app/src" "$W/app/config"
cp -r "$SRC/src" "$SRC/config" "$W/app/"
cp "$PATCH/src/core/app.py" "$W/app/src/core/app.py"
cp "$PATCH/src/north/mqtt_client.py" "$W/app/src/north/mqtt_client.py"
sed -i 's#^\(  port: \)"/dev/ttyS[0-9]*"#\1"/tmp/ttyV0"#' "$W/app/config/gateway.yaml"
sed -i 's/^\(  enabled: \)false\(.*\)$/\1true\2/' "$W/app/config/sensors/arc_light.yaml"
grep -q '"/tmp/ttyV0"' "$W/app/config/gateway.yaml" || { echo 'gateway.yaml 的 serial.port 没改成 /tmp/ttyV0' >&2; exit 1; }
printf 'schema: 1\ncabinet:\n  code: AH03\n  name: 联调柜\n' > "$W/eg/eg.yaml"
cp "$SRC"/wheels/*.whl "$SERIAL_WHL" "$W/wheels/"
cp "$HERE/rec.py" "$W/"
WD="$(cd "$W" && (pwd -W 2>/dev/null || pwd))"
docker run --rm --pull never --network none -v "$WD:/ct" python:3.12-slim sh -c '
  pip install -q --root-user-action=ignore --no-index --find-links /ct/wheels --target /ct/deps aiomqtt aiosqlite paho-mqtt pyserial
  python3 - <<EOF
import zipfile, glob
z = zipfile.ZipFile(glob.glob("/ct/wheels/pyyaml-*.whl")[0])
for f in z.namelist():
    if f.startswith("yaml/") and f.endswith(".py"):
        z.extract(f, "/ct/deps")
EOF
  PYTHONPATH=/ct/deps python3 -c "import aiomqtt, aiosqlite, serial, yaml; print(\"依赖就绪（断网装的）\")"'
echo "工作目录：$W"
