"""Початкове наповнення бази даних стартовими вокальними вправами."""

import json

import aiosqlite

from backend.database import DB_PATH

INITIAL_EXERCISES = [
    {
        "title": "SOVT Lip Roll: Тризвук 1-3-5-3-1",
        "description": "Розігрів зв'язок із напівоклюзією на вібрації губ (бррр) для зняття затиску та стабільного видиху.",
        "difficulty": "easy",
        "bpm": 88,
        "notes": [
            {"note": "C3", "duration": 1.0, "syllable": "бррр"},
            {"note": "E3", "duration": 1.0, "syllable": "бррр"},
            {"note": "G3", "duration": 1.5, "syllable": "бррр"},
            {"note": "E3", "duration": 1.0, "syllable": "бррр"},
            {"note": "C3", "duration": 2.0, "syllable": "бррр"},
        ],
    },
    {
        "title": "Сирена на «Нг» (Глісандо C3 → G4 → C3)",
        "description": "Плавне безшовне ковзання через перехідні ноти (passaggio) на носовому приголосному «нг».",
        "difficulty": "medium",
        "bpm": 72,
        "notes": [
            {"note": "C3", "slide_to": "G4", "duration": 4.0, "syllable": "нг"},
            {"note": "G4", "slide_to": "C3", "duration": 4.0, "syllable": "нг"},
        ],
    },
    {
        "title": "Cry / Twang: Арпеджіо 1-3-5-8-5-3-1",
        "description": "Октавне арпеджіо з дзвінкою позицією та м'яким «cry» для впевненого виходу у верхній регістр.",
        "difficulty": "medium",
        "bpm": 92,
        "notes": [
            {"note": "C3", "duration": 1.0, "syllable": "ний"},
            {"note": "E3", "duration": 1.0, "syllable": "ний"},
            {"note": "G3", "duration": 1.0, "syllable": "ний"},
            {"note": "C4", "duration": 2.0, "syllable": "мяу"},
            {"note": "G3", "duration": 1.0, "syllable": "мяу"},
            {"note": "E3", "duration": 1.0, "syllable": "ний"},
            {"note": "C3", "duration": 2.0, "syllable": "ний"},
        ],
    },
    {
        "title": "Округлення голосних на перехідних нотах (E4–G4)",
        "description": "Плавна модифікація голосних «гу – го – га» у зоні першого/другого переходу без форсування.",
        "difficulty": "medium",
        "bpm": 76,
        "notes": [
            {"note": "E4", "duration": 2.0, "syllable": "гу"},
            {"note": "F4", "duration": 2.0, "syllable": "го"},
            {"note": "G4", "duration": 2.0, "syllable": "га"},
            {"note": "F4", "duration": 2.0, "syllable": "го"},
            {"note": "E4", "duration": 2.0, "syllable": "гу"},
        ],
    },
    {
        "title": "Гама C3–G3 (До мажор)",
        "description": "Плавний висхідний та низхідний рух по 5 ступенях гами для вирівнювання інтонації.",
        "difficulty": "easy",
        "bpm": 80,
        "notes": [
            {"note": "C3", "duration": 1.0, "syllable": "мі"},
            {"note": "D3", "duration": 1.0, "syllable": "мі"},
            {"note": "E3", "duration": 1.0, "syllable": "мі"},
            {"note": "F3", "duration": 1.0, "syllable": "мі"},
            {"note": "G3", "duration": 2.0, "syllable": "ма"},
            {"note": "F3", "duration": 1.0, "syllable": "мі"},
            {"note": "E3", "duration": 1.0, "syllable": "мі"},
            {"note": "D3", "duration": 1.0, "syllable": "мі"},
            {"note": "C3", "duration": 2.0, "syllable": "ма"},
        ],
    },
    {
        "title": "Розспівка A3–A4 (Мажорне тризвуччя)",
        "description": "Арпеджіо по тонах ля мажору в октавному діапазоні для розвитку опори та переходу регістрів.",
        "difficulty": "medium",
        "bpm": 92,
        "notes": [
            {"note": "A3", "duration": 1.0, "syllable": "ма"},
            {"note": "C#4", "duration": 1.0, "syllable": "мо"},
            {"note": "E4", "duration": 1.0, "syllable": "мі"},
            {"note": "A4", "duration": 2.0, "syllable": "ма"},
            {"note": "E4", "duration": 1.0, "syllable": "мі"},
            {"note": "C#4", "duration": 1.0, "syllable": "мо"},
            {"note": "A3", "duration": 2.0, "syllable": "ма"},
        ],
    },
    {
        "title": "Стрибки на квінту (Інтервальний тренажер)",
        "description": "Точне потрапляння у чисту квінту від різних ступенів без під'їздів (гліссандо).",
        "difficulty": "hard",
        "bpm": 76,
        "notes": [
            {"note": "C3", "duration": 1.0, "syllable": "мі"},
            {"note": "G3", "duration": 2.0, "syllable": "ма"},
            {"note": "C3", "duration": 1.0, "syllable": "мі"},
            {"note": "D3", "duration": 1.0, "syllable": "мі"},
            {"note": "A3", "duration": 2.0, "syllable": "ма"},
            {"note": "D3", "duration": 1.0, "syllable": "мі"},
            {"note": "E3", "duration": 1.0, "syllable": "мі"},
            {"note": "B3", "duration": 2.0, "syllable": "ма"},
            {"note": "E3", "duration": 2.0, "syllable": "ма"},
        ],
    },
]


async def seed_initial_data() -> None:
    """Синхронізує стартові вправи у таблиці exercises (зі збереженням сесій)."""
    async with aiosqlite.connect(DB_PATH) as db:
        sessions_cursor = await db.execute("SELECT COUNT(*) FROM sessions")
        sessions_row = await sessions_cursor.fetchone()
        sessions_count = int(sessions_row[0]) if sessions_row else 0

        if sessions_count == 0:
            await db.execute("DELETE FROM exercises")
            await db.execute("DELETE FROM sqlite_sequence WHERE name = 'exercises'")
            exercises_to_insert = INITIAL_EXERCISES
        else:
            existing_cursor = await db.execute("SELECT title FROM exercises")
            existing_titles = {row[0] for row in await existing_cursor.fetchall()}
            exercises_to_insert = [
                ex for ex in INITIAL_EXERCISES if ex["title"] not in existing_titles
            ]

        if exercises_to_insert:
            await db.executemany(
                """
                INSERT INTO exercises (title, description, difficulty, bpm, notes_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        ex["title"],
                        ex["description"],
                        ex["difficulty"],
                        ex["bpm"],
                        json.dumps(ex["notes"], ensure_ascii=False),
                    )
                    for ex in exercises_to_insert
                ],
            )
            await db.commit()
