# 记录器：持久会话订阅 lsa/#（QoS 1、clean_session=False），broker 暂停 / 重启 / 没起时由 broker 替它排队；每条消息记到达时刻
import json, sys, time
import paho.mqtt.client as mqtt

host, out = sys.argv[1], sys.argv[2]
f = open(out, 'a', buffering=1)


def on_connect(c, u, flags, rc, props=None):
    c.subscribe('lsa/#', qos=1)
    f.write(json.dumps({'event': 'connect', 'at': int(time.time() * 1000), 'rc': str(rc)}) + '\n')


def on_message(c, u, m):
    try:
        body = json.loads(m.payload.decode())
    except Exception:
        body = None
    f.write(json.dumps({'at': int(time.time() * 1000), 'topic': m.topic, 'body': body}, ensure_ascii=False) + '\n')


c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='ct-rec', clean_session=True if '--clean' in sys.argv else False)
c.on_connect = on_connect
c.on_message = on_message
c.reconnect_delay_set(1, 2)
while True:
    try:
        c.connect(host, 1883, 30)
        break
    except Exception:
        time.sleep(1)
if '--prime' in sys.argv:          # 只建会话、订阅后退出（留下持久会话）
    c.loop_start(); time.sleep(2); c.loop_stop(); c.disconnect(); sys.exit(0)
c.loop_forever(retry_first_connection=True)
