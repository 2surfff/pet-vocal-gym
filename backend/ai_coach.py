"""AI-коуч для вокалістів на базі Gemini 4 (офіційний SDK google-genai)."""

import asyncio
import json
import os
import re
from typing import Any

from google import genai
from google.genai import types

from backend.schemas import (
    GeneratedExerciseSchema,
    NoteItem,
    VocalAnalysisResponse,
)

MODEL_VOCAL_ANALYSIS = "gemini-4-argon"
MODEL_EXERCISE_GEN = "gemini-4-hydrogen"
MODEL_EXERCISE_FALLBACK = "gemini-3.8-flash"

NOTE_PATTERN = re.compile(r"^([A-G])(#|b)?([2-6])$")


def _get_client() -> genai.Client:
    """Ініціалізує клієнт google-genai, перевіряючи наявність GEMINI_API_KEY."""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key or api_key == "your_api_key_here":
        raise RuntimeError(
            "GEMINI_API_KEY не налаштовано. Додайте ваш ключ у файл .env перед викликом AI-коуча."
        )
    return genai.Client(api_key=api_key)


def _normalize_note(note_str: str | None, fallback: str = "C3") -> str:
    if not note_str:
        return fallback
    cleaned = note_str.strip()
    if NOTE_PATTERN.match(cleaned):
        return cleaned
    return fallback


def _sanitize_generated_exercise(raw_data: dict[str, Any]) -> GeneratedExerciseSchema:
    """Гарантує сумісність згенерованої вправи з synth.js та visualizer.js."""
    difficulty = str(raw_data.get("difficulty", "medium")).lower().strip()
    if difficulty not in {"easy", "medium", "hard"}:
        difficulty = "medium"

    try:
        bpm = int(round(float(raw_data.get("bpm", 84))))
    except (TypeError, ValueError):
        bpm = 84
    bpm = max(50, min(160, bpm))

    raw_notes = raw_data.get("notes") or []
    sanitized_notes: list[NoteItem] = []
    for item in raw_notes[:24]:
        if not isinstance(item, dict):
            continue
        note_name = _normalize_note(item.get("note"), fallback="C3")
        raw_slide = item.get("slide_to")
        slide_to = None
        if isinstance(raw_slide, str) and raw_slide.strip():
            candidate = raw_slide.strip()
            if NOTE_PATTERN.match(candidate) and candidate != note_name:
                slide_to = candidate

        try:
            duration = float(item.get("duration", 1.0))
        except (TypeError, ValueError):
            duration = 1.0
        duration = max(0.5, min(8.0, round(duration * 2) / 2))

        syllable = str(item.get("syllable") or "мі").strip()[:16] or "мі"
        sanitized_notes.append(
            NoteItem(
                note=note_name,
                slide_to=slide_to,
                duration=duration,
                syllable=syllable,
            )
        )

    if len(sanitized_notes) < 2:
        sanitized_notes = [
            NoteItem(note="C3", duration=1.0, syllable="бррр"),
            NoteItem(note="E3", duration=1.0, syllable="бррр"),
            NoteItem(note="G3", duration=2.0, syllable="бррр"),
            NoteItem(note="C3", duration=2.0, syllable="бррр"),
        ]

    title = str(raw_data.get("title") or "Персональна AI-розспівка").strip()[:120]
    description = str(
        raw_data.get("description")
        or "Персоналізована вправа на основі вашого вокального профілю."
    ).strip()[:400]

    return GeneratedExerciseSchema(
        title=title,
        description=description,
        difficulty=difficulty,
        bpm=bpm,
        notes=sanitized_notes,
    )


async def analyze_vocal_take(
    audio_bytes: bytes,
    mime_type: str,
    context: str = "",
) -> tuple[VocalAnalysisResponse, str]:
    """
    Аналізує аудіозапис вокалу через gemini-4-argon (Multimodal Audio + Structured Output).
    Повертає провалідовану модель VocalAnalysisResponse та назву використаної моделі.
    """
    client = _get_client()
    clean_mime = (mime_type or "audio/webm").split(";")[0].strip()
    audio_part = types.Part.from_bytes(data=audio_bytes, mime_type=clean_mime)

    context_note = f"\nКонтекст запису від вокаліста: {context.strip()}" if context.strip() else ""
    prompt = (
        "Ти — професійний естрадно-академічний вокальний педагог (фахівець із біомеханіки голосу, "
        "SOVT, міксту, twang та зняття гортанних затисків). "
        "Прослухай цей аудіодубль уважно, оціни реальний тембр, дихальну опору, стабільність вібрато/інтонації, "
        "наявність затиску гортані або форсування на перехідних нотах (passaggio). "
        "Відповідай виключно українською мовою. "
        "У полі tips надай рівно 3 конкретні, практичні технічні правки (наприклад, вправи з «нг», SOVT, "
        "округлення голосних, зміна позиції щелепи чи опори). "
        "Якщо на записі майже тиша або нерозбірливий звук — чесно зазнач це в аналізі."
        f"{context_note}"
    )

    def _call_model() -> VocalAnalysisResponse:
        response = client.models.generate_content(
            model=MODEL_VOCAL_ANALYSIS,
            contents=[audio_part, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=VocalAnalysisResponse.model_json_schema(),
                temperature=0.3,
            ),
        )
        if not response.text:
            raise RuntimeError("Модель повернула порожню відповідь під час аналізу аудіо.")
        parsed = VocalAnalysisResponse.model_validate_json(response.text)
        # Нормалізуємо до 3 порад, якщо модель повернула іншу кількість
        tips = [t.strip() for t in parsed.tips if t.strip()][:3]
        if not tips:
            tips = ["Виконайте 1–2 хвилини SOVT Lip Roll («бррр») на м'якому видиху перед співом."]
        return VocalAnalysisResponse(
            voice_type=parsed.voice_type,
            vocal_range=parsed.vocal_range,
            passaggio_zone=parsed.passaggio_zone,
            tension_detected=parsed.tension_detected,
            tension_analysis=parsed.tension_analysis,
            tips=tips,
        )

    result = await asyncio.to_thread(_call_model)
    return result, MODEL_VOCAL_ANALYSIS


async def generate_personalized_exercise(
    profile: dict[str, Any] | None,
    problematic_notes: list[dict[str, Any]],
    goal: str,
) -> tuple[GeneratedExerciseSchema, str]:
    """
    Генерує персональну вокальну вправу через gemini-4-hydrogen (з фолбеком на gemini-3.8-flash,
    якщо модель недоступна для ключа), враховуючи профіль голосу, проблемні ноти та ціль.
    """
    client = _get_client()

    profile_summary = (
        json.dumps(
            {
                "voice_type": profile.get("voice_type"),
                "vocal_range": profile.get("vocal_range"),
                "passaggio_zone": profile.get("passaggio_zone"),
                "tension_detected": profile.get("tension_detected"),
                "tension_analysis": profile.get("tension_analysis"),
            },
            ensure_ascii=False,
        )
        if profile
        else "Профіль голосу ще не визначений (орієнтуйся на універсальний середній діапазон C3–G4)."
    )

    notes_summary = (
        json.dumps(problematic_notes[:5], ensure_ascii=False)
        if problematic_notes
        else "Даних про проблемні ноти ще немає."
    )

    prompt = (
        "Ти — вокальний педагог і композитор розспівок для тренажера Vocal Gym. "
        "Створи одну персоналізовану вправу українською мовою під поставлену ціль.\n\n"
        f"Ціль вокаліста: {goal.strip()}\n"
        f"Останній профіль голосу: {profile_summary}\n"
        f"Найпроблемніші ноти з попередніх сесій: {notes_summary}\n\n"
        "Правила для вправи:\n"
        "- difficulty: одне зі значень 'easy', 'medium', 'hard'.\n"
        "- bpm: ціле число від 60 до 120.\n"
        "- notes: масив із 5–12 нот у науковій нотації (тільки діапазон октав 2–5, напр. 'C3', 'E3', 'F#4').\n"
        "- duration: тривалість у долях такту (0.5, 1.0, 1.5, 2.0 або 4.0).\n"
        "- slide_to: опційно вкажи кінцеву ноту для плавного глісандо (сирени), інакше null.\n"
        "- syllable: використовуй ефективні вокальні склади ('нг', 'бррр', 'ний', 'мяу', 'мі', 'ме', 'ма', 'гу', 'го', 'га').\n"
        "- Побудуй мелодію так, щоб вона м'яко підводила до проблемних нот або перехідної зони без різких стрибків, якщо є затиск."
    )

    def _call_with_model(model_name: str) -> GeneratedExerciseSchema:
        response = client.models.generate_content(
            model=model_name,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=GeneratedExerciseSchema.model_json_schema(),
                temperature=0.5,
            ),
        )
        if not response.text:
            raise RuntimeError("Модель повернула порожню відповідь під час генерації вправи.")
        raw_json = json.loads(response.text)
        return _sanitize_generated_exercise(raw_json)

    used_model = MODEL_EXERCISE_GEN
    try:
        exercise = await asyncio.to_thread(_call_with_model, MODEL_EXERCISE_GEN)
    except Exception as exc:
        err_msg = str(exc).lower()
        if "404" in err_msg or "not found" in err_msg or "not supported" in err_msg:
            used_model = MODEL_EXERCISE_FALLBACK
            exercise = await asyncio.to_thread(_call_with_model, MODEL_EXERCISE_FALLBACK)
        else:
            raise

    return exercise, used_model
