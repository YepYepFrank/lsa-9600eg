# 同事转换程序（edge-gateway）的 EG 部署镜像：同事仓库 + 我方补丁（tools/conv-patches/edge-gateway-1.1.1），build.sh 拼构建上下文。
# 按 EG 约定（deploy/eg/compose.yaml 的 conv 服务）：配置 /config（EG 上是 config/conv，可改）、缓存库 /data、只读 /eg/eg.yaml、串口 /dev/ttyS1、
# 本机总线 127.0.0.1:1884（network_mode: host）。/config 是空的（首次）时把镜像里的缺省配置拷进去。
# 离线：基础镜像用本机的 python:3.12-slim，依赖是同事 wheels/ 里的包（build.sh 在断网容器里装好放进 deps/），构建时 --network none。
FROM python:3.12-slim
WORKDIR /app
COPY deps/ /app/deps/
COPY src/ /app/src/
COPY config/ /app/config.default/
COPY entrypoint.sh /entrypoint.sh
COPY VERSION /app/VERSION
ENV PYTHONPATH=/app/deps:/app EDGE_GATEWAY_CONFIG=/config PYTHONUNBUFFERED=1 TZ=Asia/Shanghai
ENTRYPOINT ["sh", "/entrypoint.sh"]
