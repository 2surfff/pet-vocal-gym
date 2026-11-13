"""Головний модуль FastAPI-сервера Vocal Gym."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from backend.database import get_all_exercises, get_stats, init_db, save_session
from backend.schemas import (
    ExerciseResponse,
    SessionCreateRequest,
    SessionCreateResponse,
    StatsResponse,
)
from backend.seed_data import seed_initial_data

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Ініціалізує SQLite БД та стартові вправи під час запуску сервера."""
    await init_db()
    await seed_initial_data()
    yield


app = FastAPI(
    title="Vocal Gym API",
    description="Локальний аудіо-тренажер для вокалістів та музикантів (MVP)",
    version="0.1.0",
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
    """Повертає загальний XP, поточний стрік та список найпроблемніших нот."""
    return await get_stats()


# Монтуємо статику фронтенду після API-роутів, щоб не перекривати /api/...
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
