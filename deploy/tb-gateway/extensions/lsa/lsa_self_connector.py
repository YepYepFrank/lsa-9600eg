# LSA 自定义连接器：把 EG 自身的数据（本机总线 lsa/EG-<柜号>/telemetry | attributes）经 IoT Gateway **自己的会话**
# 发到 v1/devices/me/telemetry | attributes。
#
# 为什么要它（G0 实测，TB Edge 4.2.2.4 + IoT Gateway 3.8.5）：
#   1. 内置 MQTT 连接器把 EG-<柜号> 当子设备发（v1/gateway/telemetry），设备名与网关自己相同，
#      Edge 立刻以「Normal disconnection」断开网关会话，5 s 后重连 —— 每发一次断一次；
#   2. 另开一条 MQTT 连接用 EG 的令牌直发 v1/devices/me/telemetry，两条会话互相挤掉（TB 一台设备只留一个会话）。
# 所以 EG 自身指标（eg.*，eg-agent 发）与 EG 级信号（sw.cb、eg.power，同事发）只能走网关自己的会话。
#
# 配置（lsa_self.json）：{"broker": {"host": "mosquitto", "port": 1883, "username": "", "password": ""}, "device": "EG-AH03"}
# 载荷与其他设备相同：{"ts": 毫秒, "values": {...}} 或其数组；属性为平铺对象。

import json
import threading
from random import randint

import paho.mqtt.client as paho

from thingsboard_gateway.connectors.connector import Connector
from thingsboard_gateway.tb_utility.tb_logger import init_logger


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
        self.__client = paho.Client(paho.CallbackAPIVersion.VERSION2,
                                    client_id=f'tb-gateway-self-{self.__device}-{randint(0, 0xffff):04x}')
        if broker.get('username'):
            self.__client.username_pw_set(broker['username'], broker.get('password') or None)
        self.__client.on_connect = self.__on_connect
        self.__client.on_disconnect = self.__on_disconnect
        self.__client.on_message = self.__on_message
        self.__client.reconnect_delay_set(1, 5)

    def open(self):
        self.__stopped = False
        self.__client.connect_async(self.__host, self.__port, keepalive=30)
        self.__client.loop_start()
        self.__log.info('%s: 订阅本机总线 %s:%s 的 %s', self.name, self.__host, self.__port, ', '.join(self.__topics))

    def close(self):
        self.__stopped = True
        try:
            self.__client.disconnect()
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
        if kind is None:
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
        except Exception as e:
            self.__log.error('%s: 上送失败 %s', self.name, e)
