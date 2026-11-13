"""Асинхронний шар роботи з SQLite (aiosqlite) для Vocal Gym."""

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from backend.schemas import SessionCreateRequest

DB_PATH = Path(__file__).resolve().parent.parent / "vocal_gym.db"


async def init_db() -> None:
    """Створює таблиці БД, якщо вони ще не існують."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON;")
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS exercises (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                difficulty TEXT NOT NULL,
                bpm INTEGER NOT NULL,
                notes_json TEXT NOT NULL
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exercise_id INTEGER NOT NULL,
                score_percent REAL NOT NULL,
                avg_cents_off REAL NOT NULL,
                xp_earned INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (exercise_id) REFERENCES exercises(id)
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS note_accuracy (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                note_name TEXT NOT NULL,
                midi_number INTEGER NOT NULL,
                avg_cents_off REAL NOT NULL,
                hit_ratio REAL NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
            """
        )
        await db.commit()


async def get_all_exercises() -> list[dict[str, Any]]:
    """Повертає всі доступні вправи з розпарсеним масивом нот."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, title, description, difficulty, bpm, notes_json FROM exercises ORDER BY id ASC"
        )
        rows = await cursor.fetchall()

    exercises: list[dict[str, Any]] = []
    for row in rows:
        exercises.append(
            {
                "id": row["id"],
                "title": row["title"],
                "description": row["description"],
                "difficulty": row["difficulty"],
                "bpm": row["bpm"],
                "notes": json.loads(row["notes_json"]),
            }
        )
    return exercises


async def _calculate_streak_days(db: aiosqlite.Connection) -> int:
    """Обчислює поточний щоденний стрік за унікальними датами тренувань (UTC)."""
    cursor = await db.execute(
        "SELECT DISTINCT substr(created_at, 1, 10) AS session_date FROM sessions ORDER BY session_date DESC"
    )
    rows = await cursor.fetchall()
    if not rows:
        return 0

    active_dates = {date.fromisoformat(row[0]) for row in rows if row[0]}
    today = datetime.now(timezone.utc).date()

    # Стрік триває, якщо користувач займався сьогодні або вчора
    if today in active_dates:
        cursor_date = today
    elif (today - timedelta(days=1)) in active_dates:
        cursor_date = today - timedelta(days=1)
    else:
        return 0

    streak = 0
    while cursor_date in active_dates:
        streak += 1
        cursor_date -= timedelta(days=1)
    return streak


async def save_session(payload: SessionCreateRequest) -> dict[str, Any]:
    """Зберігає пройдену сесію, детальну статистику по нотах і повертає оновлений XP та стрік."""
    xp_earned = int(round(50 + payload.score_percent * 0.5))
    now_iso = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON;")

        # Перевіряємо існування вправи
        ex_cursor = await db.execute(
            "SELECT id FROM exercises WHERE id = ?",
            (payload.exercise_id,),
        )
        if await ex_cursor.fetchone() is None:
            raise ValueError(f"Exercise with id={payload.exercise_id} not found")

        cursor = await db.execute(
            """
            INSERT INTO sessions (exercise_id, score_percent, avg_cents_off, xp_earned, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                payload.exercise_id,
                round(payload.score_percent, 2),
                round(payload.avg_cents_off, 2),
                xp_earned,
                now_iso,
            ),
        )
        session_id = cursor.lastrowid

        if payload.note_results:
            await db.executemany(
                """
                INSERT INTO note_accuracy (session_id, note_name, midi_number, avg_cents_off, hit_ratio, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        session_id,
                        item.note_name,
                        item.midi_number,
                        round(item.avg_cents_off, 2),
                        round(item.hit_ratio, 4),
                        now_iso,
                    )
                    for item in payload.note_results
                ],
            )

        await db.commit()

        xp_cursor = await db.execute("SELECT COALESCE(SUM(xp_earned), 0) FROM sessions")
        total_xp_row = await xp_cursor.fetchone()
        total_xp = int(total_xp_row[0]) if total_xp_row else xp_earned

        streak_days = await _calculate_streak_days(db)

    return {
        "session_id": session_id,
        "xp_earned": xp_earned,
        "total_xp": total_xp,
        "streak_days": streak_days,
        "score_percent": round(payload.score_percent, 2),
        "avg_cents_off": round(payload.avg_cents_off, 2),
    }


async def get_stats() -> dict[str, Any]:
    """Повертає загальний XP, стрік, кількість сесій і топ найпроблемніших нот."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        summary_cursor = await db.execute(
            "SELECT COALESCE(SUM(xp_earned), 0) AS total_xp, COUNT(*) AS sessions_count FROM sessions"
        )
        summary = await summary_cursor.fetchone()

        streak_days = await _calculate_streak_days(db)

        notes_cursor = await db.execute(
            """
            SELECT
                note_name,
                midi_number,
                ROUND(AVG(ABS(avg_cents_off)), 1) AS avg_cents_off,
                ROUND(AVG(hit_ratio), 3) AS avg_hit_ratio,
                COUNT(*) AS attempts
            FROM note_accuracy
            GROUP BY note_name, midi_number
            ORDER BY avg_cents_off DESC, avg_hit_ratio ASC
            LIMIT 5
            """
        )
        note_rows = await notes_cursor.fetchall()

    return {
        "total_xp": int(summary["total_xp"]) if summary else 0,
        "streak_days": streak_days,
        "sessions_count": int(summary["sessions_count"]) if summary else 0,
        "problematic_notes": [
            {
                "note_name": row["note_name"],
                "midi_number": int(row["midi_number"]),
                "avg_cents_off": float(row["avg_cents_off"]),
                "avg_hit_ratio": float(row["avg_hit_ratio"]),
                "attempts": int(row["attempts"]),
            }
            for row in note_rows
        ],
    }
