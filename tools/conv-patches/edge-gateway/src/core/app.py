"""
边缘网关核心应用
负责组件生命周期管理、数据流转协调
依据《EG内部MQTT格式 v0.7》

LSA 补丁 (2026-10-13, 基于 1.1.0; 用户定: Mosquitto 这一侧 —— 连接、发布、缓存补传 —— 由 EG 方改, 传感器解析不动):
    A. 不再重复发送: 1.1.0 每条读数都写缓存、补传任务 5 s 后又发一遍 (所有数据发两遍、弧光脉冲也两次)。
       现在只有发布失败 (没连上 / 超时) 的才进缓存
    B. 发布不阻塞采集: 采集回调只把读数放进队列 (_pub_queue), 单独的发布任务 (_publisher) 发, 2 s 超时转缓存
       (1.1.0 实测总线卡住时一次阻塞 13.1 s, 期间不采集)
    C. 按设备发: 读数发到它所属传感器 yaml 里 device: 的 lsa/<device>/telemetry (1.1.0 全发到 device.name 一个主题);
       缓存记 device, 补传按设备分组; 每次连上给每个设备名各发一次 attributes
    D. clientId = lsa-conv-<柜号> (mqtt_client.py, 柜号取 /eg/eg.yaml)
    E. SIGTERM / SIGINT 优雅退出: 停采集, 队列里没发的转入缓存, 再关库
    连接: 只留一套 —— InternalMQTTClient.run() 常驻 (断线 3 s 重连、启动时连不上也一直重试、连上先发 attributes 再触发补传);
          1.1.0 的 _mqtt_reconnect_loop 与 DataReplayer.start_replay 不再启动
    ts 单调: 重连后先把缓存补完 (同一设备按 ts 升序), 补完才放行实时数据, 同一设备收到的 ts 不会往回走
"""

import asyncio
import json
import signal
from typing import Any, Dict, List, Optional
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
from src.storage.cache import DataCache
from src.storage.db import DatabaseManager
from src.storage.replay import DataReplayer
from src.north.mqtt_client import InternalMQTTClient
from src.monitor.health import HealthMonitor
from src.monitor.watchdog import Watchdog

logger = setup_logger("app")

FW_VERSION = "1.1.0"


class Application:
    """
    边缘网关应用主类

    数据流:
        传感器驱动 → 调度器 → 数据标准化 → 分析引擎 → 发布队列 → 发布任务 → MQTT (lsa/<device>/telemetry)
                                                                  └→ 发不出去 (没连上 / 超时) → 缓存 → 连上后补传
        健康监控 → 仅本地日志 (不发 CPU/内存)
    """

    def __init__(self, config_dir: str = "config"):
        self._config = ConfigManager(config_dir)
        self._running = False

        # 核心组件
        self._modbus_client: Optional[ModbusRTUClient] = None
        self._drivers: Dict[str, Any] = {}
        self._scheduler: Optional[AcquisitionScheduler] = None
        self._normalizer: Optional[DataNormalizer] = None
        self._engine: Optional[AnalysisEngine] = None
        self._cache: Optional[DataCache] = None
        self._db: Optional[DatabaseManager] = None
        self._replay: Optional[DataReplayer] = None
        self._mqtt: Optional[InternalMQTTClient] = None
        self._health: Optional[HealthMonitor] = None
        self._watchdog: Optional[Watchdog] = None

        # asyncio event loop
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._tasks = []

        # LSA 补丁: 传感器名 → 设备名; 发布队列; 补传控制
        self._device_name = "SAM-AH03-B"
        self._sensor_device: Dict[str, str] = {}
        self._pub_queue: Optional[asyncio.Queue] = None
        self._replay_kick: Optional[asyncio.Event] = None
        self._replay_lock: Optional[asyncio.Lock] = None
        # 放行实时数据: 重连后先补传, 补完才 set (同一设备 ts 不往回走)
        self._live: Optional[asyncio.Event] = None
        self._replay_batch_size = 50
        self._replay_interval = 5

    def initialize(self) -> None:
        """同步初始化所有组件"""
        logger.info("边缘网关初始化中...")

        # 1. 加载配置
        self._config.load()

        # 2. 初始化 Modbus 客户端
        serial_cfg = self._config.get_serial_config()
        self._modbus_client = ModbusRTUClient(serial_cfg)

        # 3. 加载传感器驱动
        self._load_drivers()

        # 4. 初始化数据标准化器
        self._normalizer = DataNormalizer()

        # 5. 初始化分析引擎
        self._engine = AnalysisEngine(self._config)

        # 6. 初始化数据库
        storage_cfg = self._config.get_storage_config()
        db_path = storage_cfg.get("db_path", "/data/cache.db")
        self._db = DatabaseManager(db_path)
        self._replay_batch_size = storage_cfg.get("replay_batch_size", 50)
        self._replay_interval = storage_cfg.get("replay_interval", 5)

        # 7. 初始化缓存
        self._cache = DataCache(self._db, storage_cfg)

        # 8. 初始化重传管理 (LSA 补丁: 补传改由 _replay_loop 按设备分组做, DataReplayer 留着不启动)
        self._replay = DataReplayer(self._db, storage_cfg)

        # 9. 初始化 MQTT 客户端
        mqtt_cfg = self._config.get_mqtt_config()
        self._device_name = self._config.get("device", "name", "SAM-AH03-B")
        self._mqtt = InternalMQTTClient(mqtt_cfg, self._device_name)
        # LSA 补丁 C: 每个传感器的设备名 (yaml 的 device:, 没写用 device.name), 连上后每个设备名各发一次属性
        self._sensor_device = {name: (getattr(d, "device", "") or self._device_name) for name, d in self._drivers.items()}
        self._mqtt.set_devices(list(self._sensor_device.values()))
        self._mqtt.set_connect_attributes({"status": "online", "fw": FW_VERSION})
        self._mqtt.on_connected(self._kick_replay)
        logger.info("设备名: %s", ", ".join(f"{s}→{d}" for s, d in self._sensor_device.items()))

        # 10. 初始化调度器
        acq_cfg = self._config.get_acquisition_config()
        self._scheduler = AcquisitionScheduler(
            config=acq_cfg,
            drivers=self._drivers,
            normalizer=self._normalizer,
        )
        self._scheduler.on_data = self._on_sensor_data

        # 11. 初始化健康监控 (仅本地日志, 不发MQTT)
        self._health = HealthMonitor(self._config)

        # 12. 初始化看门狗
        monitor_cfg = self._config.get_monitor_config()
        self._watchdog = Watchdog(timeout_seconds=monitor_cfg.get("report_interval", 60) * 2)

        logger.info("边缘网关初始化完成")

    def _load_drivers(self) -> None:
        """根据配置加载传感器驱动"""
        enabled_sensors = self._config.get_enabled_sensors()
        logger.info("已启用传感器: %s", list(enabled_sensors.keys()))

        # 驱动映射表
        driver_map = {
            "environment": TemperatureHumidityDriver,
            "smoke": SmokeSensorDriver,
            "partial_discharge": PartialDischargeDriver,
            "arc_light": ArcLightDriver,
            "infrared": InfraredDriver,
        }
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
            device = sensor_cfg.get("sensor", {}).get("device", "?")
            poll_interval = sensor_cfg.get("sensor", {}).get("poll_interval", 0)
            priority = sensor_cfg.get("sensor", {}).get("priority", "?")
            interval_str = f"{poll_interval}s" if poll_interval > 0 else priority
            logger.info("  ✓ 已加载驱动: name=%s, slave=%s, device=%s, interval=%s",
                         name, slave_id, device, interval_str)

    def run(self) -> None:
        """同步启动 (创建事件循环并运行)"""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        # LSA 补丁 E: SIGTERM (容器停止) / SIGINT 优雅退出
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                self._loop.add_signal_handler(sig, self.stop)
            except (NotImplementedError, RuntimeError):
                pass
        try:
            self._loop.run_until_complete(self._async_run())
        finally:
            self._loop.close()

    async def _async_run(self) -> None:
        """异步运行主逻辑"""
        try:
            # 连接 Modbus
            if self._modbus_client:
                connected = await self._modbus_client.connect()
                if not connected:
                    logger.error("Modbus 串口连接失败")
                    return

            # 初始化数据库 (LSA 补丁: 在发布 / 补传任务起来之前)
            if self._db:
                await self._db.initialize()

            # 启动后台任务 (MQTT 连接由 InternalMQTTClient.run() 在后台负责, 连上前的数据先进缓存)
            self._running = True
            self._start_background_tasks()

            logger.info("边缘网关运行中...")

            # 主循环: 保持运行
            while self._running:
                await asyncio.sleep(1)
                if self._watchdog:
                    self._watchdog.feed()

        except KeyboardInterrupt:
            logger.info("收到退出信号")
        except Exception as e:
            logger.error("运行异常: %s", e)
        finally:
            await self._shutdown()

    def _start_background_tasks(self) -> None:
        """启动所有后台异步任务"""
        self._pub_queue = asyncio.Queue(maxsize=2000)
        self._replay_kick = asyncio.Event()
        self._replay_lock = asyncio.Lock()
        self._live = asyncio.Event()

        # 采集调度器
        if self._scheduler:
            self._tasks.append(asyncio.create_task(self._scheduler.run()))

        # LSA 补丁: MQTT 常驻连接 + 发布任务 + 按设备分组的补传
        if self._mqtt:
            self._tasks.append(asyncio.create_task(self._mqtt.run()))
            self._tasks.append(asyncio.create_task(self._publisher()))
            self._tasks.append(asyncio.create_task(self._replay_loop()))
            logger.info("MQTT: client_id=%s, 设备 %s; 连上前的数据先进缓存", self._mqtt.client_id, sorted(set(self._sensor_device.values())))

        # 健康监控
        if self._health:
            self._tasks.append(asyncio.create_task(self._health.start()))

        # 看门狗
        if self._watchdog:
            self._tasks.append(asyncio.create_task(self._watchdog.run()))

        logger.info("后台任务已启动: %d 个", len(self._tasks))

    async def _on_sensor_data(self, sensor_name: str, data: Dict[str, Any]) -> None:
        """
        传感器数据回调

        数据流: 驱动 → 标准化 → 分析 → 发布队列 (LSA 补丁: 不在这里写缓存、也不在这里等发布)
        联调意见 #6: 不发 alarm_status (告警由 EG/子站算)
        联调意见 #7: 不发 CPU/内存 (由 eg-agent 发)
        """
        # 1. 数据标准化
        if not self._normalizer:
            return
        normalized = self._normalizer.normalize(sensor_name, data)
        if not normalized:
            return

        ts = normalized.get("ts", 0)
        values = normalized.get("values", {})

        # 2. 运行分析引擎 (仅本地日志, 不发 alarm_status)
        if self._engine:
            await self._engine.analyze(sensor_name, values)

        # 3. 放进发布队列 (LSA 补丁 A / B); 队列满了直接进缓存
        device = self._sensor_device.get(sensor_name, self._device_name)
        if self._pub_queue is None:
            await self._cache.save(sensor_name, {"ts": ts, "values": values}, device)
            return
        try:
            self._pub_queue.put_nowait((sensor_name, device, ts, values))
        except asyncio.QueueFull:
            await self._cache.save(sensor_name, {"ts": ts, "values": values}, device)

    # ── LSA 补丁: 发布任务 / 补传 ─────────────────────────────

    async def _publisher(self) -> None:
        """从队列取数据发布到 lsa/<device>/telemetry; 没连上或发布失败 (超时 2 s) 才写缓存"""
        while True:
            sensor_name, device, ts, values = await self._pub_queue.get()
            ok = False
            try:
                # 重连后先等补传补完再发实时数据 (同一设备 ts 不往回走); 等的时候断了就直接进缓存
                while self._mqtt.is_connected and not self._live.is_set():
                    try:
                        await asyncio.wait_for(self._live.wait(), 0.5)
                    except asyncio.TimeoutError:
                        pass
                if self._mqtt.is_connected:
                    ok = await self._mqtt.publish_telemetry(ts, values, device)
                if not ok:
                    self._live.clear()  # 断了: 下次连上要先补传
                    await self._cache.save(sensor_name, {"ts": ts, "values": values}, device)
            except asyncio.CancelledError:
                if not ok:
                    await self._cache.save(sensor_name, {"ts": ts, "values": values}, device)
                raise
            except Exception as e:
                logger.error("发布 / 缓存出错: %s", e)
            finally:
                self._pub_queue.task_done()

    async def _kick_replay(self) -> None:
        """连上后马上补传 (InternalMQTTClient 发完 attributes 之后调用); 补完前不放行实时数据"""
        self._live.clear()
        self._replay_kick.set()

    def _device_of(self, record: Dict[str, Any]) -> str:
        """缓存记录的设备名: 新记录有 device 列; 老库迁移来的按传感器名推"""
        return record.get("device") or self._sensor_device.get(record.get("sensor_name", ""), self._device_name)

    async def _replay_once(self) -> int:
        """补一批 (replay_batch_size 条, 按 ts 升序), 按设备分组发; 返回删掉的条数 (0 = 没有了或发不出去)"""
        records = await self._db.fetch_oldest(self._replay_batch_size)
        if not records:
            return 0
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for r in records:
            groups.setdefault(self._device_of(r), []).append(r)
        done: List[int] = []
        for device, rows in groups.items():
            batch, ids = [], []
            for r in rows:
                try:
                    batch.append({"ts": r["ts"], "values": json.loads(r["values_json"])})
                    ids.append(r["id"])
                except Exception as e:
                    logger.warning("解析缓存记录失败: id=%s, err=%s", r.get("id"), e)
                    done.append(r["id"])  # 坏记录删掉, 免得一直卡在最前面
            if batch and not await self._mqtt.publish_telemetry_batch(batch, device):
                break  # 断了: 剩下的等下次连上
            done.extend(ids)
        if done:
            await self._db.delete_by_ids(done)
        return len(done)

    async def _replay_loop(self) -> None:
        """补传: 连上时立即、平时每 replay_interval 秒查一次; 一批接一批发到空, 发完放行实时数据"""
        while True:
            try:
                await asyncio.wait_for(self._replay_kick.wait(), timeout=self._replay_interval)
            except asyncio.TimeoutError:
                pass
            self._replay_kick.clear()
            if not self._mqtt.is_connected:
                continue
            async with self._replay_lock:
                try:
                    total = await self._db.count()
                    if total:
                        self._live.clear()
                        logger.info("发现 %d 条缓存数据, 开始补传 (按设备分组)", total)
                    sent = 0
                    while self._mqtt.is_connected:
                        n = await self._replay_once()
                        if not n:
                            break
                        sent += n
                    if sent:
                        logger.info("补传完成: 共 %d 条, 剩 %d 条", sent, await self._db.count())
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error("补传异常: %s", e)
                finally:
                    if self._mqtt.is_connected:
                        self._live.set()

    async def _shutdown(self) -> None:
        """关闭所有组件 (LSA 补丁 E: 队列里没发的转入缓存, 再关库)"""
        logger.info("边缘网关停止中...")
        self._running = False

        # 取消所有后台任务
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        # 队列里还没发的转入缓存 (下次启动补传)
        n = 0
        while self._pub_queue is not None and not self._pub_queue.empty():
            sensor_name, device, ts, values = self._pub_queue.get_nowait()
            await self._cache.save(sensor_name, {"ts": ts, "values": values}, device)
            n += 1
        if n:
            logger.info("停止时队列里 %d 条没发, 已转入缓存", n)

        # 断开 MQTT
        if self._mqtt:
            await self._mqtt.disconnect()

        # 关闭数据库
        if self._db:
            await self._db.close()

        # 关闭 Modbus
        if self._modbus_client:
            await self._modbus_client.close()

        logger.info("边缘网关已停止")

    def stop(self) -> None:
        """外部调用停止 (SIGTERM / SIGINT)"""
        if self._running:
            logger.info("收到停止信号, 优雅退出")
        self._running = False
