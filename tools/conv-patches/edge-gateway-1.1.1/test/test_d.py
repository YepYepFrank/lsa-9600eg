"""补丁 D 的直接检验：老库（1.1.1 原表结构，没有 device 列）迁移、按「传感器 → 设备」回填、补传按设备分组发到各自的主题。
   docker run --rm --network none -v <工作目录>:/ct -e PYTHONPATH=/ct/deps:/ct/app -w /ct/app python:3.12-slim python3 /ct/test_d.py
   prep.sh 准备的工作目录（打了补丁的 app/）；--no-patch 的对照版应该失败。"""
import asyncio
import os
import sqlite3
import sys
import tempfile

sys.argv = ['x']
from src.storage.db import DatabaseManager  # noqa: E402
from src.storage.replay import DataReplayer  # noqa: E402

OLD = """CREATE TABLE telemetry_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sensor_name TEXT NOT NULL,
  values_json TEXT NOT NULL, quality TEXT DEFAULT 'GOOD', created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000));"""


class FakeMqtt:
    is_connected = True
    device_name = 'SAM-AH03-B'

    def __init__(self):
        self.sent = []

    async def publish_telemetry_batch(self, data_list, device=None):
        self.sent.append((device or self.device_name, [d['ts'] for d in data_list]))
        return True


async def main():
    path = os.path.join(tempfile.mkdtemp(), 'cache.db')
    con = sqlite3.connect(path)
    con.executescript(OLD)
    con.executemany('INSERT INTO telemetry_cache (ts, sensor_name, values_json) VALUES (?, ?, ?)', [
        (1, 'environment', '{"env.t": 25}'), (2, 'arc_light', '{"uv.int": 3}'), (3, 'environment', '{"env.t": 26}'), (4, 'retired', '{"x": 1}')])
    con.commit()
    con.close()
    fails = 0

    def check(ok, msg):
        nonlocal fails
        fails += 0 if ok else 1
        print(('✓ ' if ok else '✗ ') + msg)

    db = DatabaseManager(path)
    await db.initialize()
    if not hasattr(db, 'backfill_device'):
        check(False, '没有 backfill_device（没打补丁 D）')
        await db.close()  # 不关的话 aiosqlite 的工作线程会让进程退不出去
        sys.exit(1)
    await db.backfill_device({'environment': 'SAM-AH03-A', 'arc_light': 'SAM-AH03-B'})
    rows = sqlite3.connect(path).execute('SELECT ts, device FROM telemetry_cache ORDER BY ts').fetchall()
    check([r[1] for r in rows] == ['SAM-AH03-A', 'SAM-AH03-B', 'SAM-AH03-A', None], f'老库补上 device 列、按传感器回填：{rows}（配置里没有的传感器保持空）')
    m = FakeMqtt()
    await DataReplayer(db, {'replay_batch_size': 50})._replay_batch(m)
    got = {}
    for dev, tss in m.sent:
        got.setdefault(dev, []).extend(tss)
    check(got.get('SAM-AH03-A') == [1, 3] and sorted(got.get('SAM-AH03-B', [])) == [2, 4] and len(m.sent) == 2,
          f'补传按设备分组、每个设备一批：{m.sent}（没有设备名的并到缺省设备名 B）')
    check(await db.count() == 0, '发成功的都删了')
    await db.close()
    # 新库：直接带 device 列，插入时记设备名
    db2 = DatabaseManager(os.path.join(tempfile.mkdtemp(), 'new.db'))
    await db2.initialize()
    await db2.insert_telemetry(9, 'environment', '{"env.t": 1}', 'GOOD', 'SAM-AH03-A')
    r = await db2.fetch_oldest(10)
    check(r and r[0].get('device') == 'SAM-AH03-A', f'新库插入时记设备名：{r}')
    await db2.close()
    sys.exit(1 if fails else 0)


asyncio.run(main())
