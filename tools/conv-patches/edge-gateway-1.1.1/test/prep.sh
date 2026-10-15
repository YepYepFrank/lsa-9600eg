#!/bin/bash
# 准备联调工作目录（不改同事的目录）：克隆同事的 git 仓库，用 git am 打上本目录的补丁（--no-patch 不打，做对照），
# 再按测试环境改配置：总线指向一次性 Mosquitto（ct-mosq:1883）、串口指向模拟器 /tmp/ttyV0、打开弧光、温湿度挂 SAM-AH03-A（验 attributes 每设备）。
#   bash prep.sh <edge-gateway-1.1.1 仓库> <工作目录> [--no-patch]
# 依赖用同事仓库 wheels/ 里的包，在断网的 python:3.12-slim 里装（PyYAML 只取纯 Python 部分）。之后：bash run.sh <工作目录>，再 python3 analyze.py <工作目录>
set -euo pipefail
export MSYS_NO_PATHCONV=1
SRC="${1:?edge-gateway-1.1.1 仓库}"
W="${2:?工作目录}"
NOPATCH=0; [ "${3:-}" = --no-patch ] && NOPATCH=1
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHES="$(cd "$HERE/.." && (pwd -W 2>/dev/null || pwd))"   # Windows 上的 git 要 D:/… 写法（本脚本关了 MSYS 路径转换）
mkdir -p "$W/eg" "$W/wheels" "$W/out"
rm -rf "$W/repo" "$W/app"
git -c core.longpaths=true -c core.autocrlf=false clone -q "$SRC" "$W/repo"   # LF 检出：后面的 sed 才认得出（Windows 上全局 autocrlf 会检出成 CRLF）
echo "同事仓库：$(git -C "$W/repo" log --oneline -1)"
if [ "$NOPATCH" = 0 ]; then
  git -C "$W/repo" -c user.name=lsa-test -c user.email=lsa-test@localhost am -q "$PATCHES"/*.patch
  echo "git am 打上：$(git -C "$W/repo" log --oneline 316e619..HEAD | wc -l) 个提交"
else
  echo '对照：不打补丁'
fi
mkdir -p "$W/app"
cp -r "$W/repo/src" "$W/repo/config" "$W/app/"
find "$W/app" -name '__pycache__' -prune -exec rm -rf {} +
G="$W/app/config/gateway.yaml"
# 串口指向模拟器（1.1.1 提交里的值是同事自己的虚拟串口 "/tmp/arc_master"，不管原值是什么都改）
sed -i '/^serial:/,/^[a-z]/s#^\(  port: *\)"[^"]*"#\1"/tmp/ttyV0"#' "$G"
# 1.1.1 的总线地址只从 gateway.yaml 读：指向一次性 Mosquitto
sed -i '/^mqtt:/,/^[a-z]/{s#^\(  host: \)"[^"]*"#\1"ct-mosq"#;s#^\(  port: \)1884#\11883#}' "$G"
# 1.1.1 提交的配置只开了弧光：测试把温湿度、局放、气体也打开（模拟器都有），才看得出 attributes / 遥测按设备分开
for f in arc_light temperature pd gas; do sed -i 's/^\(  enabled: \)false\(.*\)$/\1true\2/' "$W/app/config/sensors/$f.yaml"; done
sed -i 's/^\(  device: \)"[^"]*"/\1"SAM-AH03-A"/' "$W/app/config/sensors/temperature.yaml"
grep -q '"/tmp/ttyV0"' "$G" || { echo 'serial.port 没改成 /tmp/ttyV0' >&2; exit 1; }
grep -q 'host: "ct-mosq"' "$G" || { echo 'mqtt.host 没改成 ct-mosq' >&2; exit 1; }
printf 'schema: 1\ncabinet:\n  code: AH03\n  name: 联调柜\n' > "$W/eg/eg.yaml"
cp "$SRC"/wheels/*.whl "$W/wheels/"
cp "$HERE/rec.py" "$W/"
WD="$(cd "$W" && (pwd -W 2>/dev/null || pwd))"
[ -d "$W/deps/aiomqtt" ] || docker run --rm --pull never --network none -v "$WD:/ct" python:3.12-slim sh -c '
  pip install -q --root-user-action=ignore --no-index --find-links /ct/wheels --target /ct/deps aiomqtt aiosqlite paho-mqtt pyserial
  python3 - <<EOF
import zipfile, glob
z = zipfile.ZipFile(glob.glob("/ct/wheels/pyyaml-*.whl")[0])
for f in z.namelist():
    if f.startswith("yaml/") and f.endswith(".py"):
        z.extract(f, "/ct/deps")
EOF'
docker run --rm --pull never --network none -v "$WD:/ct" -e PYTHONPATH=/ct/deps python:3.12-slim python3 -c "import aiomqtt, aiosqlite, serial, yaml; print('依赖就绪（断网装的）')"
echo "工作目录：$W"
