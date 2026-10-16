#!/bin/sh
# /config 是空的（EG 上首次启用转换程序）：拷缺省配置进去，之后在 EG 的 config/conv/ 里改
if [ ! -f /config/gateway.yaml ]; then
  mkdir -p /config && cp -r /app/config.default/. /config/
  echo "首次启动：缺省配置已拷到 /config（EG 上的 config/conv/），按这面柜改设备名、启用的传感器"
fi
echo "edge-gateway $(cat /app/VERSION)"
cd /app && exec python3 -m src.main
