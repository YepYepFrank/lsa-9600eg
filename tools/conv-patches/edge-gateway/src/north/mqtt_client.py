"""
内部 MQTT 客户端
发布数据到 EG 本机 Mosquitto (127.0.0.1:1884)
再由 TB IoT Gateway 转发到 EG 本地 TB, eg-agent 上送子站

LSA 补丁 (2026-10-13, 基于 1.1.0 —— 1.1.0 的这个文件与 1.0 相同; 《EG 内部 MQTT 格式》v0.7 §2、§3; 用户定: Mosquitto 这一侧由 EG 方改):
    - 按设备发: publish_* 多一个 device 参数, 发到 lsa/<device>/...; 不给用配置里的设备名。每次连上给每个设备名各发一次 attributes
    - 断线后每 reconnect_interval (3 s) 重连; 启动时连不上也循环重试 (run() 常驻)
    - 每次连上: 先发 attributes, 再通知补传 (on_connected 回调)
    - publish 加短超时 (publish_timeout, 缺省 2 s): 超时 / 出错当作断线, 立即返回 False (调用方转入缓存),
      并让 run() 断开重连 —— 总线卡住时不会把调用方挂住几十秒
    - clientId = lsa-conv-<柜号>: 柜号从 EG 只读挂进来的 eg.yaml (环境变量 LSA_EG_YAML, 缺省 /eg/eg.yaml) 取;
      取不到用配置里的 client_id; 配置还是老的 lsa-conv-eg 时从设备名 (SAM-AH03-B → AH03) 推
    - 总线地址可由环境变量 LSA_MQTT_URL (mqtt://127.0.0.1:1884) 覆盖, EG 的 compose 会给
"""

import asyncio
import json
import os
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional
import aiomqtt
from src.core.logger import setup_logger

logger = setup_logger("mqtt_client")


def _cabinet_from_eg_yaml(path: str) -> Optional[str]:
    """eg.yaml 的 cabinet.code (如 AH03); 读不到返回 None"""
    try:
        import yaml
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f) or {}
        code = (doc.get("cabinet") or {}).get("code")
        return str(code) if code else None
    except FileNotFoundError:
        return None
    except Exception as e:
        logger.warning("读 %s 取柜号失败: %s", path, e)
        return None


def _resolve_client_id(cfg_id: str, device_name: str) -> str:
    cab = _cabinet_from_eg_yaml(os.environ.get("LSA_EG_YAML", "/eg/eg.yaml"))
    if cab:
        return f"lsa-conv-{cab}"
    if cfg_id and cfg_id != "lsa-conv-eg":
        return cfg_id
    m = re.match(r"^(?:SAM|PM2?|PM6|EG)-([A-Za-z0-9]+)", device_name or "")
    return f"lsa-conv-{m.group(1)}" if m else (cfg_id or "lsa-conv-eg")


class InternalMQTTClient:
    """
    EG 内部 MQTT 客户端

    依据《EG内部MQTT格式 v0.7》:
        - 只与本机 Mosquitto 通信 (127.0.0.1:1884)
        - 不直连本地 TB / 子站
        - QoS 1, 不用 retain; 断开后 3 s 重连

    主题格式:
        - lsa/<设备名>/telemetry   遥测数据
        - lsa/<设备名>/attributes  静态属性 (上电/重连后发一次)

    用法: 启动时 asyncio.create_task(client.run()) 常驻; publish_* 在没连上 / 超时时返回 False, 由调用方转入缓存
    """

    def __init__(self, mqtt_config: Dict[str, Any], device_name: str):
        self._config = mqtt_config
        self._device_name = device_name
        self._host = mqtt_config.get("host", "127.0.0.1")
        self._port = int(mqtt_config.get("port", 1884))
        url = os.environ.get("LSA_MQTT_URL", "")
        m = re.match(r"^mqtts?://([^:/]+)(?::(\d+))?", url)
        if m:
            self._host = m.group(1)
            self._port = int(m.group(2) or 1883)
        self._username = mqtt_config.get("username", "")
        self._password = mqtt_config.get("password", "")
        self._client_id = _resolve_client_id(mqtt_config.get("client_id", "lsa-conv-eg"), device_name)
        self._keepalive = mqtt_config.get("keepalive", 30)
        self._qos = mqtt_config.get("qos", 1)
        self._reconnect_interval = mqtt_config.get("reconnect_interval", 3)
        self._publish_timeout = mqtt_config.get("publish_timeout", 2)
        self._connect_timeout = mqtt_config.get("connect_timeout", 5)

        self._client: Optional[aiomqtt.Client] = None
        self._connected = False
        self._lost: Optional[asyncio.Event] = None
        self._stopping = False
        # 每次连上先发的属性 (上电/重连后发一次, §3), 每个设备名各发一次
        self._attributes: Dict[str, Any] = {"status": "online", "fw": "1.0.0"}
        self._devices: List[str] = [device_name]
        # 连上后要做的事 (补传), 由 app 注册
        self._on_connected: List[Callable[[], Awaitable[None]]] = []
        self.connects = 0

        # 主题前缀: lsa/<设备名>/
        self._topic_prefix = f"lsa/{self._device_name}"

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def device_name(self) -> str:
        return self._device_name

    @property
    def topic_prefix(self) -> str:
        return self._topic_prefix

    @property
    def client_id(self) -> str:
        return self._client_id

    def on_connected(self, fn: Callable[[], Awaitable[None]]) -> None:
        """注册「每次连上后」要做的事 (在发完 attributes 之后调用)"""
        self._on_connected.append(fn)

    def set_connect_attributes(self, attributes: Dict[str, Any]) -> None:
        """每次连上先发的属性 (覆盖缺省的 status / fw)"""
        self._attributes = dict(attributes)

    def set_devices(self, devices: List[str]) -> None:
        """本程序发数据的全部设备名 (各传感器 yaml 的 device:), 每次连上各发一次 attributes"""
        self._devices = sorted({d for d in devices if d}) or [self._device_name]

    async def run(self) -> None:
        """常驻: 连上 → 发属性 → 通知补传 → 等到断开 → 隔 reconnect_interval 再连。启动时连不上也一直重试"""
        self._quiet_aiomqtt_futures()
        attempt = 0
        while not self._stopping:
            attempt += 1
            client = self._new_client()
            try:
                async with client:
                    self._client = client
                    self._lost = asyncio.Event()
                    self._connected = True
                    self.connects += 1
                    logger.info("MQTT 连接成功: %s:%d (client_id=%s, 第 %d 次连上%s)",
                                self._host, self._port, self._client_id, self.connects,
                                f", 尝试 {attempt} 次" if attempt > 1 else "")
                    attempt = 0
                    for dev in self._devices:
                        await self.publish_attributes(self._attributes, dev)
                    for fn in self._on_connected:
                        asyncio.create_task(self._safe(fn))
                    watch = asyncio.create_task(self._watch(client))
                    lost = asyncio.create_task(self._lost.wait())
                    done, pending = await asyncio.wait({watch, lost}, return_when=asyncio.FIRST_COMPLETED)
                    for t in pending:
                        t.cancel()
                    self._connected = False
                    if not self._stopping:
                        logger.warning("MQTT 连接断开, %ss 后重连", self._reconnect_interval)
            except asyncio.CancelledError:
                self._connected = False
                raise
            except Exception as e:
                self._connected = False
                if attempt == 1 or attempt % 20 == 0:
                    logger.error("MQTT 连接失败 (%s:%d, 第 %d 次): %s; %ss 后重试",
                                 self._host, self._port, attempt, e, self._reconnect_interval)
            finally:
                self._connected = False
                self._client = None
                # aiomqtt 断线时把异常放在内部的 _disconnected 里, 没人取的话会打一条 "Future exception was never retrieved" —— 取掉它
                fut = getattr(client, "_disconnected", None)
                if fut is not None and fut.done() and not fut.cancelled():
                    fut.exception()
            if not self._stopping:
                await asyncio.sleep(self._reconnect_interval)

    @staticmethod
    def _quiet_aiomqtt_futures() -> None:
        """总线卡住时, 没连成的 aiomqtt 客户端过后才收到 paho 的断线回调, 把 MqttError 放进一个没人等的 future,
        回收时 asyncio 会打 "Future exception was never retrieved"。断线我们自己已经处理并记了日志, 这类只记 debug; 别的异常照常处理"""
        loop = asyncio.get_running_loop()
        prev = loop.get_exception_handler()

        def handler(lp: asyncio.AbstractEventLoop, ctx: Dict[str, Any]) -> None:
            if isinstance(ctx.get("exception"), aiomqtt.MqttError) and "never retrieved" in str(ctx.get("message", "")):
                logger.debug("aiomqtt 断线 future 未取回 (已处理): %s", ctx.get("exception"))
                return
            if prev:
                prev(lp, ctx)
            else:
                lp.default_exception_handler(ctx)

        loop.set_exception_handler(handler)

    def _new_client(self) -> aiomqtt.Client:
        kw: Dict[str, Any] = {
            "hostname": self._host,
            "port": self._port,
            "identifier": self._client_id,
            "keepalive": self._keepalive,
            "timeout": self._connect_timeout,
        }
        # 有账号密码时才设置
        if self._username:
            kw["username"] = self._username
            if self._password:
                kw["password"] = self._password
        return aiomqtt.Client(**kw)

    async def _watch(self, client: aiomqtt.Client) -> None:
        """不订阅任何主题, 只靠消息迭代器察觉断线 (aiomqtt 断线时抛 MqttError)"""
        try:
            async for _ in client.messages:
                pass
        except aiomqtt.MqttError as e:
            logger.warning("MQTT 断线: %s", e)

    async def _safe(self, fn: Callable[[], Awaitable[None]]) -> None:
        try:
            await fn()
        except Exception as e:
            logger.error("连上后的回调出错: %s", e)

    def _mark_lost(self, why: str) -> None:
        if self._connected:
            logger.warning("MQTT 发布失败 (%s): 当作断线, 转入缓存并重连", why)
        self._connected = False
        if self._lost:
            self._lost.set()

    async def _publish(self, topic: str, payload: str) -> bool:
        client = self._client
        if not self._connected or client is None:
            return False
        try:
            await client.publish(topic, payload=payload, qos=self._qos, timeout=self._publish_timeout)
            return True
        except Exception as e:
            self._mark_lost(str(e) or type(e).__name__)
            return False

    async def connect(self) -> bool:
        """兼容老调用: 现在由 run() 常驻负责连接。这里只等最多 connect_timeout 秒看能不能连上"""
        for _ in range(int(self._connect_timeout * 10)):
            if self._connected:
                return True
            await asyncio.sleep(0.1)
        return self._connected

    async def disconnect(self) -> None:
        """停止重连并断开"""
        self._stopping = True
        if self._lost:
            self._lost.set()
        self._connected = False
        logger.info("MQTT 连接已断开")

    def _prefix(self, device: Optional[str]) -> str:
        return f"lsa/{device}" if device else self._topic_prefix

    async def publish_telemetry(self, ts: int, values: Dict[str, Any], device: Optional[str] = None) -> bool:
        """
        发布遥测数据 (§4): {"ts": 采样时刻毫秒, "values": {...}}, 本周期全部量打成一条; 发到 lsa/<device>/telemetry

        Returns:
            发布是否成功 (没连上 / 超时返回 False, 调用方转入缓存)
        """
        payload = json.dumps({"ts": ts, "values": values}, ensure_ascii=False)
        ok = await self._publish(f"{self._prefix(device)}/telemetry", payload)
        if ok:
            logger.debug("发布遥测: %s ts=%d, keys=%s", device or self._device_name, ts, list(values.keys()))
        return ok

    async def publish_telemetry_batch(self, data_list: list, device: Optional[str] = None) -> bool:
        """
        批量发布遥测数据 (用于断点补传): [{"ts": ..., "values": {...}}, ...], ts 保持原采样时刻; 同一批只能是一个设备的
        """
        return await self._publish(f"{self._prefix(device)}/telemetry", json.dumps(data_list, ensure_ascii=False))

    async def publish_attributes(self, attributes: Dict[str, Any], device: Optional[str] = None) -> bool:
        """发布静态属性 (上电/重连后发一次)"""
        ok = await self._publish(f"{self._prefix(device)}/attributes", json.dumps(attributes, ensure_ascii=False))
        if ok:
            logger.info("发布属性: topic=%s/attributes, keys=%s", self._prefix(device), list(attributes.keys()))
        return ok
