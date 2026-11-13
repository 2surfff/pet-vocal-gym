"""Асинхронний шар роботи з SQLite (aiosqlite) та захистом квоти Gemini API."""

import json
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from backend.schemas import (
    GeneratedExerciseSchema,
    SessionCreateRequest,
    VocalAnalysisResponse,
)

DB_PATH = Path(__file__).resolve().parent.parent / "vocal_gym.db"


class DailyQuotaExceededError(Exception):
    """Піднімається, коли денний ліміт запитів до Gemini API вичерпано."""


def get_daily_ai_limit() -> int:
    """Повертає максимальну кількість AI-запитів на день із .env (за замовчуванням 15)."""
    raw = os.getenv("DAILY_AI_LIMIT", "15")
    try:
        return max(1, int(raw))
    except ValueError:
        return 15


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
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS voice_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                voice_type TEXT NOT NULL,
                vocal_range TEXT NOT NULL,
                passaggio_zone TEXT NOT NULL,
                tension_detected INTEGER NOT NULL,
                tension_analysis TEXT NOT NULL,
                tips_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_usage_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                endpoint TEXT NOT NULL,
                model_name TEXT NOT NULL,
                created_at TEXT NOT NULL
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


async def get_ai_requests_today() -> int:
    """Повертає кількість AI-запитів, виконаних за поточну дату (UTC)."""
    today_str = datetime.now(timezone.utc).date().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM ai_usage_logs WHERE substr(created_at, 1, 10) = ?",
            (today_str,),
        )
        row = await cursor.fetchone()
        return int(row[0]) if row else 0


async def enforce_daily_ai_limit() -> tuple[int, int]:
    """Перевіряє, чи не перевищено денний ліміт AI-запитів перед викликом Gemini."""
    limit = get_daily_ai_limit()
    used = await get_ai_requests_today()
    if used >= limit:
        raise DailyQuotaExceededError(f"Денний ліміт AI-запитів ({limit}/день) вичерпано")
    return used, limit


async def log_ai_usage(endpoint: str, model_name: str) -> int:
    """Фіксує успішний виклик Gemini API у таблиці ai_usage_logs."""
    now_iso = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO ai_usage_logs (endpoint, model_name, created_at)
            VALUES (?, ?, ?)
            """,
            (endpoint, model_name, now_iso),
        )
        await db.commit()
    return await get_ai_requests_today()


async def save_voice_profile(analysis: VocalAnalysisResponse) -> dict[str, Any]:
    """Зберігає аналіз голосу у таблицю voice_profiles."""
    now_iso = datetime.now(timezone.utc).isoformat()
    tips_json = json.dumps(analysis.tips, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO voice_profiles (
                voice_type,
                vocal_range,
                passaggio_zone,
                tension_detected,
                tension_analysis,
                tips_json,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                analysis.voice_type,
                analysis.vocal_range,
                analysis.passaggio_zone,
                1 if analysis.tension_detected else 0,
                analysis.tension_analysis,
                tips_json,
                now_iso,
            ),
        )
        profile_id = cursor.lastrowid
        await db.commit()

    return {
        "id": profile_id,
        "voice_type": analysis.voice_type,
        "vocal_range": analysis.vocal_range,
        "passaggio_zone": analysis.passaggio_zone,
        "tension_detected": analysis.tension_detected,
        "tension_analysis": analysis.tension_analysis,
        "tips": analysis.tips,
        "created_at": now_iso,
    }


async def get_latest_voice_profile() -> dict[str, Any] | None:
    """Повертає останній збережений профіль голосу або None."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT
                id,
                voice_type,
                vocal_range,
                passaggio_zone,
                tension_detected,
                tension_analysis,
                tips_json,
                created_at
            FROM voice_profiles
            ORDER BY id DESC
            LIMIT 1
            """
        )
        row = await cursor.fetchone()

    if row is None:
        return None

    return {
        "id": int(row["id"]),
        "voice_type": row["voice_type"],
        "vocal_range": row["vocal_range"],
        "passaggio_zone": row["passaggio_zone"],
        "tension_detected": bool(row["tension_detected"]),
        "tension_analysis": row["tension_analysis"],
        "tips": json.loads(row["tips_json"]),
        "created_at": row["created_at"],
    }


async def save_generated_exercise(generated: GeneratedExerciseSchema) -> dict[str, Any]:
    """Зберігає згенеровану AI вправу в таблицю exercises та повертає її з ID."""
    notes_payload = [item.model_dump() for item in generated.notes]
    notes_json = json.dumps(notes_payload, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO exercises (title, description, difficulty, bpm, notes_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                generated.title,
                generated.description,
                generated.difficulty,
                generated.bpm,
                notes_json,
            ),
        )
        exercise_id = cursor.lastrowid
        await db.commit()

    return {
        "id": exercise_id,
        "title": generated.title,
        "description": generated.description,
        "difficulty": generated.difficulty,
        "bpm": generated.bpm,
        "notes": notes_payload,
    }


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
    """Повертає загальний XP, стрік, кількість сесій, проблемні ноти та AI-ліміт."""
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

    ai_requests_today = await get_ai_requests_today()
    ai_daily_limit = get_daily_ai_limit()

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
        "ai_requests_today": ai_requests_today,
        "ai_daily_limit": ai_daily_limit,
    }
