# 测试用的假转换程序（I11 编排框架的实机验证用；真镜像等同事给，待确认事项 Q5）：
# 从串口 /dev/ttyS1 读一行「设备名 key 值」，按《EG 内部 MQTT 格式》§4 发到本机总线 127.0.0.1:1884。
# 基于 eclipse-mosquitto（自带 mosquitto_pub 与 busybox，发布件里本来就有这个镜像，不用另外下载）。
#   docker build -t lsa-eg-conv:fake-<日期> deploy/test/conv-fake
FROM eclipse-mosquitto:2.1.2
COPY conv.sh /conv.sh
ENTRYPOINT ["/bin/sh", "/conv.sh"]
