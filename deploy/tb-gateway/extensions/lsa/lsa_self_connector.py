# LSA 自定义连接器：把 EG 自身的数据（本机总线 lsa/EG-<柜号>/telemetry | attributes）经 IoT Gateway **自己的会话**
# 发到 v1/devices/me/telemetry | attributes。
#
# 为什么要它（G0 实测，当时 EG 本地是 TB Edge 4.2.2.4；换独立 TB CE 后照旧用 —— TB 一台设备只留一个会话，两条都一样）：
#   1. 内置 MQTT 连接器把 EG-<柜号> 当子设备发（v1/gateway/telemetry），设备名与网关自己相同，
#      平台立刻以「Normal disconnection」断开网关会话，5 s 后重连 —— 每发一次断一次；
#   2. 另开一条 MQTT 连接用 EG 的令牌直发 v1/devices/me/telemetry，两条会话互相挤掉（TB 一台设备只留一个会话）。
# 所以 EG 自身指标（eg.*，eg-agent 发）与 EG 级信号（sw.cb、eg.power，同事发）只能走网关自己的会话。
#
# 看门（G1）：子站靠 EG 设备有数据判它在线（20 s 没数据就报「通信中断」）。eg-agent 停了时传感器数据照样经本网关上送，
# 不能让子站误报中断 —— 超过 HOLD_S 秒没收到 agent 的 EG 自身数据，这里每 KEEP_S 秒自己发一条 eg.state=degraded
# （EG 确实降级了：质量码看护、负荷率这些 agent 算的量没了），agent 恢复后自然停止。
#
# 配置（lsa_self.json）：{"broker": {"host": "mosquitto", "port": 1883, "username": "", "password": ""}, "device": "EG-AH03"}
# 载荷与其他设备相同：{"ts": 毫秒, "values": {...}} 或其数组；属性为平铺对象。

import json
import threading
from time import monotonic, time

import paho.mqtt.client as paho
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

from thingsboard_gateway.connectors.connector import Connector
from thingsboard_gateway.tb_utility.tb_logger import init_logger


HOLD_S = 12
KEEP_S = 5

# 每台 EG 设备只能有一个活着的实例（I1 连通性测试发现）：IoT Gateway 发现配置文件变了会重载连接器、新建一个实例，
# 旧实例没停干净时两个用同一个固定 clientId 的客户端在 Mosquitto 上互相「session taken over」，
# 各自都收不全 agent 的数据，于是轮流代发 eg.state=degraded，EG 状态在 online / degraded 之间来回跳。
# 新实例 open() 时先把同设备的旧实例关掉，不依赖 IoT Gateway 有没有调 close()。
#
# 重载时 open() / close() 都在 IoT Gateway 的主线程里调，这里任何一步卡住，主线程就停了 —— EG 自身数据从此进不了本地 TB
# （传感器数据走内置 MQTT 连接器自己的线程，照常，所以不显眼；I4 发现）。所以：
#   - open() 在单实例表的锁外关旧实例（close() 也要拿这把锁；I1 的写法在锁里调 close()，自己把自己锁死）；
#   - close() 不等任何线程：只置标志，断开与 loop_stop（要等网络线程退出，而网络线程可能正卡在 gateway.send_* 等主线程）
#     放后台线程；已停的实例收到消息直接丢。新实例用同一个 clientId 连上时 Mosquitto 踢掉旧会话，旧客户端是主动断开状态、不会重连。
_LIVE = {}
_LIVE_LOCK = threading.RLock()


class LsaSelfConnector(Connector):
    def __init__(self, gateway, config, connector_type):
        super().__init__()
        self.__gateway = gateway
        self.__config = config
        self.__type = connector_type
        self.name = config.get('name', 'LSA EG 自身')
        self.__id = config.get('id', self.name)
        self.__log = init_logger(gateway, self.name, config.get('logLevel', 'INFO'),
                                 enable_remote_logging=config.get('enableRemoteLogging', False))
        self.__device = config['device']
        self.__topics = {f'lsa/{self.__device}/telemetry': 'telemetry', f'lsa/{self.__device}/attributes': 'attributes'}
        self.__stopped = True
        self.__connected = False
        self.__lock = threading.Lock()
        broker = config.get('broker', {})
        self.__host = broker.get('host', 'mosquitto')
        self.__port = int(broker.get('port', 1883))
        # MQTT 5：要读 eg-agent 发的消息上的用户属性 src=eg-agent（同事发到同一主题的 EG 级信号不算 agent 活着）
        # 固定 clientId + 持久会话：IoT Gateway 重启那几秒 eg-agent 发的数据由 Mosquitto 排着
        self.__client = paho.Client(paho.CallbackAPIVersion.VERSION2,
                                    client_id=f'tb-gateway-self-{self.__device}',
                                    protocol=paho.MQTTv5)
        self.__session_expiry = int(config.get('sessionExpiry', 86400))
        if broker.get('username'):
            self.__client.username_pw_set(broker['username'], broker.get('password') or None)
        self.__client.on_connect = self.__on_connect
        self.__client.on_disconnect = self.__on_disconnect
        self.__client.on_message = self.__on_message
        self.__client.reconnect_delay_set(1, 5)
        self.__last_self = monotonic()
        self.__holding = False
        self.__stop_event = threading.Event()
        self.__keeper = threading.Thread(target=self.__keep, name='lsa-self-keeper', daemon=True)

    def open(self):
        # 在锁外关旧实例：close() 也要拿这把锁（见文件头）
        with _LIVE_LOCK:
            old = _LIVE.get(self.__device)
            _LIVE[self.__device] = self
        if old is not None and old is not self:
            self.__log.warning('%s: 上一个实例还在，先关掉它', self.name)
            old.close()
        self.__stopped = False
        # 看门从开始订阅算起（构造到 open 之间可能隔几秒，从构造算会一上来就误代发）
        self.__last_self = monotonic()
        props = Properties(PacketTypes.CONNECT)
        props.SessionExpiryInterval = self.__session_expiry
        self.__client.connect_async(self.__host, self.__port, keepalive=30, clean_start=False, properties=props)
        self.__client.loop_start()
        self.__keeper.start()
        self.__log.info('%s: 订阅本机总线 %s:%s 的 %s', self.name, self.__host, self.__port, ', '.join(self.__topics))

    def close(self):
        if self.__stopped and self.__stop_event.is_set():
            return
        self.__stopped = True
        self.__stop_event.set()
        with _LIVE_LOCK:
            if _LIVE.get(self.__device) is self:
                del _LIVE[self.__device]
        # 断开与等网络线程退出放后台：调用方是 IoT Gateway 主线程，不能在这里等（见文件头）
        threading.Thread(target=self.__shutdown, name='lsa-self-close', daemon=True).start()
        self.__log.info('%s: 已停', self.name)

    def __shutdown(self):
        try:
            self.__client.disconnect()
        except Exception:
            pass
        try:
            # loop_stop 等网络线程退出；主动断开后 paho 不会再自动重连
            self.__client.loop_stop()
        except Exception:
            pass

    def get_id(self):
        return self.__id

    def get_name(self):
        return self.name

    def get_type(self):
        return self.__type

    def get_config(self):
        return self.__config

    def is_connected(self):
        return self.__connected

    def is_stopped(self):
        return self.__stopped

    def on_attributes_update(self, content):
        pass

    def server_side_rpc_handler(self, content):
        pass

    def __on_connect(self, client, userdata, flags, reason_code, properties):
        self.__connected = not reason_code.is_failure
        if self.__connected:
            client.subscribe([(t, 1) for t in self.__topics])
        else:
            self.__log.warning('%s: 连本机总线失败 %s', self.name, reason_code)

    def __on_disconnect(self, client, userdata, flags, reason_code, properties):
        self.__connected = False

    def __on_message(self, client, userdata, msg):
        kind = self.__topics.get(msg.topic)
        if kind is None or self.__stopped:
            return
        try:
            body = json.loads(msg.payload.decode('utf-8'))
        except Exception:
            self.__log.warning('%s: %s 不是 JSON，丢弃', self.name, msg.topic)
            return
        try:
            with self.__lock:
                if kind == 'attributes':
                    if isinstance(body, dict) and body:
                        self.__gateway.send_attributes(body)
                else:
                    for entry in body if isinstance(body, list) else [body]:
                        if isinstance(entry, dict) and entry:
                            self.__gateway.send_telemetry(entry)
                    if not self.__from_agent(msg):
                        return
                    self.__last_self = monotonic()
                    if self.__holding:
                        self.__holding = False
                        self.__log.info('%s: eg-agent 恢复，停止代发', self.name)
        except Exception as e:
            self.__log.error('%s: 上送失败 %s', self.name, e)

    @staticmethod
    def __from_agent(msg):
        props = getattr(msg, 'properties', None)
        return ('src', 'eg-agent') in (getattr(props, 'UserProperty', None) or [])

    def __keep(self):
        while not self.__stop_event.wait(KEEP_S):
            if monotonic() - self.__last_self < HOLD_S:
                continue
            if self.__stopped:
                return
            try:
                if not self.__gateway.tb_client.is_connected():
                    continue
                if not self.__holding:
                    self.__holding = True
                    self.__log.warning('%s: %s 秒没收到 eg-agent 的数据，代发 eg.state=degraded 维持 EG 在线', self.name, HOLD_S)
                with self.__lock:
                    self.__gateway.send_telemetry({'ts': int(time() * 1000), 'values': {'eg.state': 'degraded'}})
            except Exception as e:
                self.__log.error('%s: 代发失败 %s', self.name, e)
