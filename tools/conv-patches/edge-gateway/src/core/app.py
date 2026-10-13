"""
应用生命周期管理
负责初始化、启动、优雅关闭所有子系统
依据《EG内部MQTT格式 v0.1》架构:
    转换程序 → EG本机Mosquitto → TB IoT Gateway → TB Edge → 子站

LSA 补丁 (2026-10-13, 《EG 内部 MQTT 格式》v0.7 §2; 用户定: Mosquitto 这一侧由 EG 方改, 传感器解析不动):
    - 采集和发布分开: 采到的数据放进队列 (_pub_queue), 由单独的发布任务 (_publisher) 发;
      没连上 / 发布超时 (2 s) 就转入缓存 —— 总线卡住时不会拖住轮询
    - MQTT 连接由 InternalMQTTClient.run() 常驻负责: 断线 3 s 重连, 启动时连不上也一直重试
    - 每次连上 (发完 attributes 之后) 马上触发补传, 把缓存按原 ts 发完 (_replay_loop); 平时每 replay_interval 也查一次
    - 关闭时队列里没发的转入缓存, 不丢
"""

import asyncio
import signal
from typing import Optional

from src.core.config_manager import ConfigManager
from src.core.logger import setup_logger
from src.drivers.modbus_rtu import ModbusRTUClient
from src.drivers.temperature import TemperatureHumidityDriver
from src.drivers.gas import SmokeSensorDriver
from src.drivers.pd import PartialDischargeDriver
from src.drivers.arc_light import ArcLightDriver
from src.drivers.infrared import InfraredDriver
from src.acquisition.scheduler import AcquisitionScheduler
from src.acquisition.data_normalizer import DataNormalizer
from src.analysis.engine import AnalysisEngine
from src.north.mqtt_client import InternalMQTTClient
from src.storage.db import DatabaseManager
from src.storage.cache import DataCache
from src.storage.replay import DataReplayer
from src.monitor.health import HealthMonitor

logger = setup_logger("app")


class Application:
    """
    边缘网关应用主类 (转换程序)

    职责:
        - 从RS485传感器采集数据
        - 转换为EG内部MQTT格式
        - 发布到EG本机Mosquitto (127.0.0.1:1884)
        - 由TB IoT Gateway自动转发到TB Edge/子站
    """

    def __init__(self, config_dir: str = "config"):
        self._config = ConfigManager(config_dir)
        self._running = False
        self._shutdown_event: Optional[asyncio.Event] = None

        # 子系统实例
        self._modbus_client: Optional[ModbusRTUClient] = None
        self._drivers: dict = {}
        self._scheduler: Optional[AcquisitionScheduler] = None
        self._normalizer: Optional[DataNormalizer] = None
        self._engine: Optional[AnalysisEngine] = None
        self._mqtt_client: Optional[InternalMQTTClient] = None
        self._db: Optional[DatabaseManager] = None
        self._cache: Optional[DataCache] = None
        self._replayer: Optional[DataReplayer] = None
        self._health: Optional[HealthMonitor] = None

        # LSA 补丁: 采集 → 队列 → 发布任务 (发不出去转缓存); 连上后触发补传
        self._pub_queue: Optional[asyncio.Queue] = None
        self._replay_kick: Optional[asyncio.Event] = None
        self._replay_lock: Optional[asyncio.Lock] = None
        self._replay_interval = 5

    def initialize(self) -> None:
        """加载配置并初始化所有子系统"""
        logger.info("=" * 50)
        logger.info("LSA-9600EG 边缘网关 (转换程序) 正在初始化...")
        logger.info("=" * 50)

        # 1. 加载配置
        self._config.load()

        # 2. 获取设备名
        device_name = self._config.get("device", "name", "SAM-UNKNOWN")
        logger.info("设备名: %s", device_name)

        # 3. 初始化存储层
        storage_cfg = self._config.get_storage_config()
        self._db = DatabaseManager(storage_cfg.get("db_path", "/data/cache.db"))
        self._cache = DataCache(self._db, storage_cfg)
        self._replayer = DataReplayer(self._db, storage_cfg)
        self._replay_interval = storage_cfg.get("replay_interval", 5)

        # 4. 初始化 Modbus RTU 客户端
        serial_cfg = self._config.get_serial_config()
        self._modbus_client = ModbusRTUClient(serial_cfg)

        # 5. 初始化传感器驱动 (可插拔)
        self._init_drivers()

        # 6. 初始化采集层
        acq_cfg = self._config.get_acquisition_config()
        self._normalizer = DataNormalizer()
        self._scheduler = AcquisitionScheduler(
            config=acq_cfg,
            drivers=self._drivers,
            normalizer=self._normalizer,
        )

        # 7. 初始化分析引擎
        self._engine = AnalysisEngine(self._config)

        # 8. 初始化内部 MQTT 客户端 (发布到本机Mosquitto)
        mqtt_cfg = self._config.get_mqtt_config()
        self._mqtt_client = InternalMQTTClient(mqtt_cfg, device_name)
        # 每次连上 (发完 attributes 之后) 触发补传
        self._mqtt_client.on_connected(self._kick_replay)

        # 9. 初始化健康监控
        monitor_cfg = self._config.get_monitor_config()
        self._health = HealthMonitor(monitor_cfg, self._mqtt_client, device_name)

        # 10. 注册数据流回调: 采集 → 标准化 → 分析 → 发布/缓存
        self._scheduler.on_data = self._on_sensor_data
        self._engine.on_alarm = self._on_alarm

        logger.info("所有子系统初始化完成")

    def _init_drivers(self) -> None:
        """根据配置初始化已启用的传感器驱动"""
        enabled_sensors = self._config.get_enabled_sensors()
        driver_map = {
            "environment": TemperatureHumidityDriver,
            "smoke": SmokeSensorDriver,
            "partial_discharge": PartialDischargeDriver,
            "arc_light": ArcLightDriver,
            "infrared": InfraredDriver,
        }
        logger.info("已启用传感器: %s", list(enabled_sensors.keys()))
        logger.info("驱动映射表: %s", list(driver_map.keys()))
        for name, sensor_cfg in enabled_sensors.items():
            driver_cls = driver_map.get(name)
            if driver_cls is None:
                logger.warning("未知传感器: name='%s', 可匹配: %s, 跳过!",
                               name, list(driver_map.keys()))
                continue
            driver = driver_cls(self._modbus_client, sensor_cfg)
            self._drivers[name] = driver
            slave_id = sensor_cfg.get("sensor", {}).get("slave_id", "?")
            priority = sensor_cfg.get("sensor", {}).get("priority", "?")
            logger.info("  ✓ 已加载驱动: name=%s, slave=%s, priority=%s",
                         name, slave_id, priority)

    # ── 数据流回调 ───────────────────────────────────────────

    async def _on_sensor_data(self, sensor_name: str, data: dict) -> None:
        """
        采集数据回调: 标准化 → 分析 → 发布/缓存

        依据《EG内部MQTT格式 §4》:
            - ts: 采样时刻, 毫秒
            - values: 本周期全部量打成一条
            - 采不到的量不发0, 不发这个key
        """
        # 如果是环境温度数据, 注入到红外驱动用于计算温升
        if sensor_name == "environment" and "env.t" in data:
            self._inject_env_temp_to_infrared(data["env.t"])

        # 标准化为EG格式
        normalized = self._normalizer.normalize(sensor_name, data)
        if not normalized:
            return

        # 边缘分析
        alarms = await self._engine.analyze(sensor_name, normalized["values"])

        # 如果有告警, 添加到values中
        if alarms:
            normalized["values"]["alarm_status"] = 1

        # 提取ts和values用于发布
        ts, values = self._normalizer.to_publish_format(normalized)

        # LSA 补丁: 只放进队列, 不在采集路径上等发布 (总线卡住时不能拖住轮询); 队列满了直接进缓存
        item = (sensor_name, ts, values)
        if self._pub_queue is None:
            await self._cache.save(sensor_name, {"ts": ts, "values": values})
            return
        try:
            self._pub_queue.put_nowait(item)
        except asyncio.QueueFull:
            await self._cache.save(sensor_name, {"ts": ts, "values": values})

    # ── LSA 补丁: 发布任务 / 补传 ─────────────────────────────

    async def _publisher(self) -> None:
        """从队列取数据发布; 没连上或发布失败 (超时 2 s) 就写进缓存, 等连上后按原 ts 补传"""
        while True:
            sensor_name, ts, values = await self._pub_queue.get()
            ok = False
            try:
                if self._mqtt_client.is_connected:
                    ok = await self._mqtt_client.publish_telemetry(ts, values)
                if not ok:
                    await self._cache.save(sensor_name, {"ts": ts, "values": values})
            except asyncio.CancelledError:
                if not ok:
                    await self._cache.save(sensor_name, {"ts": ts, "values": values})
                raise
            except Exception as e:
                logger.error("发布 / 缓存出错: %s", e)
            finally:
                self._pub_queue.task_done()

    async def _kick_replay(self) -> None:
        """连上后马上补传 (由 InternalMQTTClient 在发完 attributes 之后调用)"""
        if self._replay_kick:
            self._replay_kick.set()

    async def _replay_loop(self) -> None:
        """补传: 连上时立即、平时每 replay_interval 秒查一次缓存; 一批 (replay_batch_size 条) 接一批发到空为止, ts 保持原采样时刻"""
        while True:
            try:
                await asyncio.wait_for(self._replay_kick.wait(), timeout=self._replay_interval)
            except asyncio.TimeoutError:
                pass
            self._replay_kick.clear()
            async with self._replay_lock:
                try:
                    total = await self._db.count()
                    if total and self._mqtt_client.is_connected:
                        logger.info("发现 %d 条缓存数据, 开始补传", total)
                    sent = 0
                    while self._mqtt_client.is_connected:
                        before = await self._db.count()
                        if not before:
                            break
                        await self._replayer._replay_batch(self._mqtt_client)
                        after = await self._db.count()
                        if after >= before:
                            break  # 这一批没发出去 (断了), 等下次连上
                        sent += before - after
                    if sent:
                        logger.info("补传完成: 共 %d 条, 剩 %d 条", sent, await self._db.count())
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error("补传异常: %s", e)

    async def _on_alarm(self, sensor_name: str, alarm_info: dict) -> None:
        """告警回调: 记录日志"""
        logger.warning("告警触发: sensor=%s, detail=%s", sensor_name, alarm_info)

    def _inject_env_temp_to_infrared(self, env_temp: float) -> None:
        """将环境温度注入到红外驱动, 用于计算温升 ir.rise"""
        ir_driver = self._drivers.get("infrared")
        if ir_driver and isinstance(ir_driver, InfraredDriver):
            ir_driver.set_env_temperature(env_temp)
            logger.debug("环境温度已注入红外驱动: env.t=%.1f℃", env_temp)

    # ── 启动与关闭 ───────────────────────────────────────────

    async def start(self) -> None:
        """启动所有异步任务"""
        self._running = True
        self._shutdown_event = asyncio.Event()

        logger.info("边缘网关 (转换程序) 启动中...")

        # 启动 Modbus 连接
        await self._modbus_client.connect()

        # LSA 补丁: 启动时就打开缓存库 —— 原来要等第一次写缓存才打开, 上次没补传完的缓存在下次断线前一直不补
        await self._db.initialize()

        # LSA 补丁: 队列与发布任务、补传任务; MQTT 连接常驻 (断线 3 s 重连, 启动时连不上也一直重试, 不挡采集启动)
        self._pub_queue = asyncio.Queue(maxsize=2000)
        self._replay_kick = asyncio.Event()
        self._replay_lock = asyncio.Lock()
        mqtt_task = asyncio.create_task(self._mqtt_client.run())
        publish_task = asyncio.create_task(self._publisher())
        replay_task = asyncio.create_task(self._replay_loop())
        logger.info("MQTT: %s (client_id=%s), 连上前的数据先进缓存", self._mqtt_client.topic_prefix, self._mqtt_client.client_id)

        # 启动采集调度器
        scheduler_task = asyncio.create_task(self._scheduler.run())

        # 启动健康监控
        health_task = asyncio.create_task(self._health.run())

        logger.info("边缘网关已启动, 所有任务运行中")
        logger.info("数据发布到: %s (由TB IoT Gateway转发)", self._mqtt_client.topic_prefix)

        # 等待关闭信号
        await self._shutdown_event.wait()

        # 优雅关闭
        logger.info("正在关闭边缘网关...")
        self._running = False
        scheduler_task.cancel()
        health_task.cancel()
        replay_task.cancel()
        publish_task.cancel()
        # 队列里还没发的转入缓存 (下次启动补传)
        while self._pub_queue and not self._pub_queue.empty():
            sensor_name, ts, values = self._pub_queue.get_nowait()
            await self._cache.save(sensor_name, {"ts": ts, "values": values})
        await self._mqtt_client.disconnect()
        mqtt_task.cancel()
        await self._modbus_client.close()
        await self._db.close()
        logger.info("边缘网关已安全关闭")

    def shutdown(self) -> None:
        """触发优雅关闭"""
        logger.info("收到关闭信号")
        if self._shutdown_event:
            self._shutdown_event.set()

    def run(self) -> None:
        """同步入口: 启动 asyncio 事件循环"""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        # 注册系统信号处理
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.shutdown)

        try:
            loop.run_until_complete(self.start())
        finally:
            loop.close()
