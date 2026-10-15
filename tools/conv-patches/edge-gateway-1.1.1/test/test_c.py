"""补丁 C 的直接检验（不靠时机）：设备缓冲里有没发的数据、总线没连上时，停止流程要把它们转入缓存。
   docker run --rm --network none -v <工作目录>:/ct -e PYTHONPATH=/ct/deps:/ct/app python:3.12-slim python3 /ct/test_c.py
   prep.sh 准备的工作目录（打了补丁的 app/）；--no-patch 的对照版应该失败（停止时不转缓存）。"""
import asyncio
import sys

sys.argv = ['x']
from src.core.app import Application  # noqa: E402


class FakeCache:
    def __init__(self):
        self.saved = []

    async def save(self, sensor_name, data):
        self.saved.append((sensor_name, data))


class FakeMqtt:
    is_connected = False

    async def publish_telemetry_to(self, device, ts, values):
        return False


async def main():
    app = Application.__new__(Application)
    app._device_buffer = {
        'SAM-AH03-A': {'values': {'env.t': 25.1}, 'ts': 1, 'items': [('environment', {'ts': 1, 'values': {'env.t': 25.1}})]},
        'SAM-AH03-B': {'values': {'uv.int': 3.2}, 'ts': 2, 'items': [('arc_light', {'ts': 2, 'values': {'uv.int': 3.2}})]},
    }
    app._device_buffer_lock = asyncio.Lock()
    app._cache = FakeCache()
    app._mqtt = FakeMqtt()
    await app._flush_remaining_buffers()
    ok = len(app._cache.saved) == 2 and not app._device_buffer
    print(f"{'✓' if ok else '✗'} 总线没连上、缓冲里 2 台设备各 1 条：停止时转入缓存 {len(app._cache.saved)} 条，缓冲清空 {not app._device_buffer}")
    import signal
    import inspect
    src = inspect.getsource(Application._async_run) + inspect.getsource(Application._shutdown)
    ok2 = 'add_signal_handler' in src and '_flush_remaining_buffers' in inspect.getsource(Application._shutdown)
    print(f"{'✓' if ok2 else '✗'} 注册了 SIGTERM / SIGINT 处理，停止流程里调用了 _flush_remaining_buffers")
    sys.exit(0 if ok and ok2 else 1)


asyncio.run(main())
