"""Pydantic-схеми для вправ, сесій та статистики Vocal Gym."""

from pydantic import BaseModel, Field


class NoteItem(BaseModel):
    """Окрема нота у складі вправи."""

    note: str = Field(..., description="Назва ноти у науковій нотації, напр. 'C3', 'G#4'")
    slide_to: str | None = Field(default=None, description="Цільова нота для глісандо, напр. 'G4'")
    duration: float = Field(..., gt=0, description="Тривалість у долях такту (чвертях)")
    syllable: str = Field(..., description="Склад для проспівування, напр. 'мі', 'ма'")


class ExerciseResponse(BaseModel):
    """Модель вправи для видачі на фронтенд."""

    id: int
    title: str
    description: str
    difficulty: str
    bpm: int
    notes: list[NoteItem]


class NoteResultInput(BaseModel):
    """Результат точності інтонування по конкретній ноті в рамках сесії."""

    note_name: str
    midi_number: int
    avg_cents_off: float = Field(..., ge=0.0)
    hit_ratio: float = Field(..., ge=0.0, le=1.0)


class SessionCreateRequest(BaseModel):
    """Запит на збереження результату завершеної вправи."""

    exercise_id: int
    score_percent: float = Field(..., ge=0.0, le=100.0)
    avg_cents_off: float = Field(..., ge=0.0)
    note_results: list[NoteResultInput]


class SessionCreateResponse(BaseModel):
    """Відповідь після збереження сесії з оновленим прогресом."""

    session_id: int
    xp_earned: int
    total_xp: int
    streak_days: int
    score_percent: float
    avg_cents_off: float


class ProblematicNoteStat(BaseModel):
    """Агрегована статистика проблемної ноти для інтервального повторення."""

    note_name: str
    midi_number: int
    avg_cents_off: float
    avg_hit_ratio: float
    attempts: int


class StatsResponse(BaseModel):
    """Загальна статистика прогресу користувача."""

    total_xp: int
    streak_days: int
    sessions_count: int
    problematic_notes: list[ProblematicNoteStat]
