"""Головний модуль FastAPI-сервера Vocal Gym."""

from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles

from backend.ai_coach import analyze_vocal_take, generate_personalized_exercise
from backend.database import (
    DailyQuotaExceededError,
    enforce_daily_ai_limit,
    get_all_exercises,
    get_daily_ai_limit,
    get_latest_voice_profile,
    get_stats,
    init_db,
    log_ai_usage,
    save_generated_exercise,
    save_session,
    save_voice_profile,
)
from backend.schemas import (
    ExerciseResponse,
    GenerateExerciseRequest,
    SessionCreateRequest,
    SessionCreateResponse,
    StatsResponse,
    VoiceProfileRecord,
)
from backend.seed_data import seed_initial_data

load_dotenv()

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024  # 5 МБ


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Завантажує .env, ініціалізує SQLite БД та стартові вправи під час запуску."""
    load_dotenv()
    await init_db()
    await seed_initial_data()
    yield


app = FastAPI(
    title="Vocal Gym API",
    description="Локальний аудіо-тренажер для вокалістів та музикантів (MVP + Gemini 4 AI Coach)",
    version="0.2.0",
    lifespan=lifespan,
)


@app.get("/api/exercises", response_model=list[ExerciseResponse])
async def list_exercises() -> list[dict]:
    """Повертає список доступних розспівок із SQLite."""
    return await get_all_exercises()


@app.post("/api/sessions", response_model=SessionCreateResponse)
async def create_session(payload: SessionCreateRequest) -> dict:
    """Зберігає результат проходження вправи та статистику точності по кожній ноті."""
    try:
        return await save_session(payload)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/stats", response_model=StatsResponse)
async def read_stats() -> dict:
    """Повертає загальний XP, стрік, проблемні ноти та денний ліміт AI-запитів."""
    return await get_stats()


@app.post("/api/voice-analyze", response_model=VoiceProfileRecord)
async def analyze_voice_endpoint(
    audio: UploadFile = File(...),
    context: str = Form(default=""),
) -> dict:
    """
    Аналізує аудіодубль через Gemini 4 Argon (із перевіркою денного ліміту та розміру <= 5 МБ).
    """
    try:
        await enforce_daily_ai_limit()
    except DailyQuotaExceededError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    audio_bytes = await audio.read()
    if len(audio_bytes) > MAX_AUDIO_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Розмір аудіофайлу перевищує максимально допустимий ліміт 5 МБ.",
        )
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Отримано порожній аудіофайл.")

    try:
        analysis, model_used = await analyze_vocal_take(
            audio_bytes=audio_bytes,
            mime_type=audio.content_type or "audio/webm",
            context=context,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Помилка Gemini API: {exc}") from exc

    used_today = await log_ai_usage("/api/voice-analyze", model_used)
    saved = await save_voice_profile(analysis)
    saved["ai_requests_today"] = used_today
    saved["ai_daily_limit"] = get_daily_ai_limit()
    return saved


@app.get("/api/voice-profile/latest", response_model=VoiceProfileRecord | None)
async def read_latest_voice_profile() -> dict | None:
    """Повертає останній збережений профіль голосу користувача."""
    return await get_latest_voice_profile()


@app.post("/api/exercises/generate", response_model=ExerciseResponse)
async def generate_exercise_endpoint(payload: GenerateExerciseRequest) -> dict:
    """
    Генерує персональну вправу через Gemini 4 з урахуванням профілю голосу
    та топ-5 проблемних нот користувача.
    """
    try:
        await enforce_daily_ai_limit()
    except DailyQuotaExceededError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    profile = await get_latest_voice_profile()
    stats = await get_stats()

    try:
        generated, model_used = await generate_personalized_exercise(
            profile=profile,
            problematic_notes=stats.get("problematic_notes", []),
            goal=payload.goal,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Помилка Gemini API: {exc}") from exc

    await log_ai_usage("/api/exercises/generate", model_used)
    return await save_generated_exercise(generated)


# Монтуємо статику фронтенду після API-роутів, щоб не перекривати /api/...
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
