"""
SQLite 数据库管理
负责连接管理和表结构定义

LSA 补丁 (2026-10-13, 基于 1.1.0): 缓存表加 device 列 (读数所属设备名, 补传按设备分组发到 lsa/<device>/telemetry)。
    老库启动时自动加列 (ALTER TABLE), 老记录 device 为空, 补传时按传感器名 → 设备名推回去
"""

import aiosqlite
from pathlib import Path
from typing import Any, Dict, List, Optional
from src.core.logger import setup_logger

logger = setup_logger("database")

# 建表 SQL
CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS telemetry_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,              -- 毫秒级时间戳
    sensor_name TEXT NOT NULL,        -- 传感器名称
    values_json TEXT NOT NULL,        -- JSON 格式的遥测值
    quality TEXT DEFAULT 'GOOD',      -- 数据质量码
    device TEXT,                      -- LSA 补丁: 设备名 (lsa/<device>/telemetry), 老库自动加列
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ts ON telemetry_cache(ts);
CREATE INDEX IF NOT EXISTS idx_sensor ON telemetry_cache(sensor_name);
"""


class DatabaseManager:
    """
    SQLite 数据库管理器

    职责:
        - 初始化数据库连接和表结构
        - 提供异步读写接口
        - 管理连接生命周期
    """

    def __init__(self, db_path: str = "/data/cache.db"):
        self._db_path = db_path
        self._db: Optional[aiosqlite.Connection] = None

    async def initialize(self) -> None:
        """初始化数据库: 创建目录、建立连接、建表"""
        db_file = Path(self._db_path)
        db_file.parent.mkdir(parents=True, exist_ok=True)

        self._db = await aiosqlite.connect(self._db_path)
        await self._db.executescript(CREATE_TABLE_SQL)
        # LSA 补丁: 老库 (1.1.0 及以前建的表) 没有 device 列, 加上
        cursor = await self._db.execute("PRAGMA table_info(telemetry_cache)")
        cols = [row[1] for row in await cursor.fetchall()]
        if "device" not in cols:
            await self._db.execute("ALTER TABLE telemetry_cache ADD COLUMN device TEXT")
            logger.info("缓存表加 device 列 (老库迁移)")
        await self._db.execute("CREATE INDEX IF NOT EXISTS idx_device ON telemetry_cache(device)")
        await self._db.commit()
        logger.info("数据库初始化完成: %s", self._db_path)

    async def close(self) -> None:
        """关闭数据库连接"""
        if self._db:
            await self._db.close()
            self._db = None
            logger.info("数据库连接已关闭")

    async def insert_telemetry(
        self,
        ts: int,
        sensor_name: str,
        values_json: str,
        quality: str = "GOOD",
        device: Optional[str] = None,
    ) -> int:
        """
        插入一条遥测缓存记录

        Returns:
            插入的行 ID
        """
        if not self._db:
            await self.initialize()

        cursor = await self._db.execute(
            "INSERT INTO telemetry_cache (ts, sensor_name, values_json, quality, device) VALUES (?, ?, ?, ?, ?)",
            (ts, sensor_name, values_json, quality, device),
        )
        await self._db.commit()
        return cursor.lastrowid

    async def fetch_oldest(self, limit: int = 50) -> List[Dict[str, Any]]:
        """
        获取最旧的 N 条缓存记录 (用于补传)

        Returns:
            记录列表, 按时间戳升序
        """
        if not self._db:
            return []

        cursor = await self._db.execute(
            "SELECT id, ts, sensor_name, values_json, quality, device FROM telemetry_cache ORDER BY ts ASC, id ASC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [
            {
                "id": row[0],
                "ts": row[1],
                "sensor_name": row[2],
                "values_json": row[3],
                "quality": row[4],
                "device": row[5],
            }
            for row in rows
        ]

    async def delete_by_ids(self, ids: List[int]) -> None:
        """按 ID 删除已补传的记录"""
        if not self._db or not ids:
            return
        placeholders = ",".join("?" * len(ids))
        await self._db.execute(
            f"DELETE FROM telemetry_cache WHERE id IN ({placeholders})",
            ids,
        )
        await self._db.commit()

    async def count(self) -> int:
        """获取缓存记录总数"""
        if not self._db:
            return 0
        cursor = await self._db.execute("SELECT COUNT(*) FROM telemetry_cache")
        row = await cursor.fetchone()
        return row[0] if row else 0

    async def cleanup_old(self, max_records: int) -> None:
        """清理超出上限的旧记录"""
        if not self._db:
            return
        total = await self.count()
        if total > max_records:
            delete_count = total - max_records
            await self._db.execute(
                "DELETE FROM telemetry_cache WHERE id IN (SELECT id FROM telemetry_cache ORDER BY ts ASC LIMIT ?)",
                (delete_count,),
            )
            await self._db.commit()
            logger.info("清理旧记录: 删除 %d 条", delete_count)
