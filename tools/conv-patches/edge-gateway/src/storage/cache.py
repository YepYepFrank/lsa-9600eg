"""
断网数据缓存
网络断开时将采集数据写入 SQLite

LSA 补丁 (2026-10-13, 基于 1.1.0): save() 多一个 device 参数 (读数所属设备名), 补传按设备分组发
"""

import json
from typing import Any, Dict, Optional
from src.storage.db import DatabaseManager
from src.core.logger import setup_logger

logger = setup_logger("cache")


class DataCache:
    """
    数据缓存器

    职责:
        - 网络断开时缓存遥测数据到 SQLite
        - 定期清理超出上限的旧记录
    """

    def __init__(self, db: DatabaseManager, storage_config: Dict[str, Any]):
        self._db = db
        self._max_records = storage_config.get("max_records", 100000)

    async def save(self, sensor_name: str, data: Dict[str, Any], device: Optional[str] = None) -> None:
        """
        缓存一条数据

        Args:
            sensor_name: 传感器名称
            data: 包含 ts 和 values 的数据字典
        """
        try:
            ts = data.get("ts", 0)
            values = data.get("values", data)
            quality = data.get("quality", "GOOD")
            values_json = json.dumps(values, ensure_ascii=False)

            await self._db.insert_telemetry(ts, sensor_name, values_json, quality, device)
            logger.debug("数据已缓存: sensor=%s, ts=%d", sensor_name, ts)

            # 定期检查并清理
            count = await self._db.count()
            if count > self._max_records:
                await self._db.cleanup_old(self._max_records)

        except Exception as e:
            logger.error("缓存数据失败: %s", e)
