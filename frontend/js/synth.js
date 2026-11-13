/**
 * Модуль синтезатора та метронома на базі Tone.js (CDN).
 *
 * Відповідає за:
 * 1. Побудову єдиного таймлайну вправи (з підтримкою глісандо slide_to та транспонування).
 * 2. Програвання 1 такту відліку метронома (4 долі) перед стартом мелодії.
 * 3. Виконання нот і плавних переходів (rampTo) тембром м'якого електропіаніно.
 */

import { midiToFrequency, midiToNoteName, noteNameToMidi } from "./pitch_detector.js";

/**
 * Повертає цільовий MIDI-номер у конкретний момент часу (з урахуванням глісандо).
 * Для звичайної ноти повертає event.midi, для глісандо — лінійно інтерполює
 * між event.midi та event.endMidi (у півтонах).
 */
export function getEventTargetMidiAtTime(event, timeSec) {
  if (!event) return null;
  if (!event.isGlissando) {
    return event.midi;
  }
  const duration = Math.max(0.001, event.durationSec);
  const progress = Math.max(0, Math.min(1, (timeSec - event.startTimeSec) / duration));
  return event.midi + progress * (event.endMidi - event.midi);
}

/**
 * Конвертує JSON-опис вправи у нормалізований таймлайн у секундах.
 * Ця сама структура використовується і синтезатором, і Canvas-візуалізатором.
 *
 * @param {Object} exercise Об'єкт вправи з /api/exercises
 * @param {number} [transposeSemitones=0] Зсув у півтонах (-12..+12)
 * @param {number|null} [customBpm=null] Користувацький темп (BPM)
 */
export function buildExerciseTimeline(exercise, transposeSemitones = 0, customBpm = null) {
  const bpm = Number(customBpm) || Number(exercise.bpm) || 80;
  const beatSec = 60 / bpm;
  const countInBeats = 4; // 1 такт 4/4 перед стартом мелодії
  const countInSec = countInBeats * beatSec;

  let beatCursor = countInBeats;
  let minMidi = Infinity;
  let maxMidi = -Infinity;

  const events = (exercise.notes || []).map((item, index) => {
    const startMidi = noteNameToMidi(item.note) + transposeSemitones;
    const note = midiToNoteName(startMidi);
    const endMidi = item.slide_to
      ? noteNameToMidi(item.slide_to) + transposeSemitones
      : startMidi;
    const slideToNote = item.slide_to ? midiToNoteName(endMidi) : null;
    const isGlissando = Boolean(item.slide_to && endMidi !== startMidi);

    const frequency = midiToFrequency(startMidi);
    const endFrequency = midiToFrequency(endMidi);
    const durationBeats = Number(item.duration) || 1.0;
    const startBeat = beatCursor;
    const startTimeSec = startBeat * beatSec;
    const durationSec = durationBeats * beatSec;
    const endTimeSec = startTimeSec + durationSec;

    beatCursor += durationBeats;
    minMidi = Math.min(minMidi, startMidi, endMidi);
    maxMidi = Math.max(maxMidi, startMidi, endMidi);

    return {
      index,
      note,
      slideToNote,
      isGlissando,
      midi: startMidi,
      endMidi,
      frequency,
      endFrequency,
      syllable: item.syllable || "",
      durationBeats,
      startBeat,
      startTimeSec,
      durationSec,
      endTimeSec,
    };
  });

  if (events.length === 0) {
    minMidi = 48;
    maxMidi = 60;
  }

  return {
    bpm,
    transposeSemitones,
    beatSec,
    countInBeats,
    countInSec,
    totalBeats: beatCursor,
    totalDurationSec: beatCursor * beatSec,
    minMidi,
    maxMidi,
    events,
  };
}

export class ExerciseSynth {
  constructor() {
    this.isInitialized = false;
    this.isPlaying = false;
    this.piano = null;
    this.metronome = null;
    this.reverb = null;
    this.scheduledIds = [];
    this.currentTimeline = null;
  }

  /**
   * Ініціалізує AudioContext Tone.js (обов'язково викликати по кліку користувача)
   * та створює ланцюжок електропіаніно і метронома.
   */
  async ensureStarted() {
    const Tone = window.Tone;
    if (!Tone) {
      throw new Error("Tone.js не завантажено. Перевірте підключення CDN.");
    }

    await Tone.start();

    if (this.isInitialized) return;

    this.reverb = new Tone.Reverb({
      decay: 1.4,
      wet: 0.18,
    }).toDestination();

    // Монофонічний Synth з теплим тембром електропіаніно: підтримує плавний frequency.rampTo для глісандо
    this.piano = new Tone.Synth({
      oscillator: {
        type: "triangle8",
      },
      envelope: {
        attack: 0.015,
        decay: 0.35,
        sustain: 0.55,
        release: 0.55,
      },
      volume: -6,
    }).connect(this.reverb);

    // Чіткий дерев'яний клік метронома
    this.metronome = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: {
        attack: 0.002,
        decay: 0.06,
        sustain: 0,
        release: 0.03,
      },
      volume: -4,
    }).toDestination();

    this.isInitialized = true;
  }

  /**
   * Програє одну контрольну ноту (для орієнтації перед стартом).
   */
  async playReferenceNote(noteName, durationSec = 0.8) {
    await this.ensureStarted();
    this.piano.frequency.cancelScheduledValues(window.Tone.now());
    this.piano.triggerAttackRelease(noteName, durationSec);
  }

  /**
   * Запускає вправу: 1 такт відліку метронома + мелодія електропіаніно (зі слайдами rampTo).
   *
   * @param {Object} exercise Вправа з бекенду
   * @param {Object} callbacks
   * @param {number} [callbacks.transposeSemitones=0] Транспозиція в півтонах
   * @param {number|null} [callbacks.bpm=null] Користувацький темп (BPM)
   * @param {boolean} [callbacks.keepMetronomeOnExercise=true] Продовжувати тихий метроном під час співу
   * @param {(beatNumber: number) => void} [callbacks.onCountInBeat] Колбек на кожен удар відліку (1..4)
   * @param {() => void} [callbacks.onComplete] Колбек після завершення останньої ноти
   */
  async startExercise(exercise, callbacks = {}) {
    await this.ensureStarted();
    this.stop();

    const Tone = window.Tone;
    const transposeSemitones = callbacks.transposeSemitones ?? 0;
    const customBpm = callbacks.bpm ?? null;
    const timeline = buildExerciseTimeline(exercise, transposeSemitones, customBpm);
    this.currentTimeline = timeline;

    const transport = Tone.Transport;
    transport.cancel(0);
    transport.stop();
    transport.position = 0;
    transport.bpm.value = timeline.bpm;

    const keepMetronome = callbacks.keepMetronomeOnExercise ?? true;
    const totalMetronomeBeats = keepMetronome
      ? Math.ceil(timeline.totalBeats)
      : timeline.countInBeats;

    // 1. Плануємо удари метронома (перші 4 удари — відлік перед початком вправи)
    for (let beat = 0; beat < totalMetronomeBeats; beat += 1) {
      const timeSec = beat * timeline.beatSec;
      const isCountIn = beat < timeline.countInBeats;
      const isDownbeat = beat % 4 === 0;

      const eventId = transport.schedule((time) => {
        if (isCountIn) {
          const clickNote = isDownbeat ? "C6" : "G5";
          this.metronome.triggerAttackRelease(clickNote, 0.04, time, isDownbeat ? 0.9 : 0.6);
          if (callbacks.onCountInBeat) {
            Tone.Draw.schedule(() => callbacks.onCountInBeat(beat + 1), time);
          }
        } else if (keepMetronome) {
          const clickNote = isDownbeat ? "C6" : "G5";
          this.metronome.triggerAttackRelease(clickNote, 0.03, time, isDownbeat ? 0.28 : 0.16);
        }
      }, timeSec);
      this.scheduledIds.push(eventId);
    }

    // 2. Плануємо ноти мелодії та плавні переходи (slide_to -> rampTo)
    for (const item of timeline.events) {
      const eventId = transport.schedule((time) => {
        const playLen = Math.max(0.1, item.durationSec * (item.isGlissando ? 0.98 : 0.9));
        this.piano.frequency.setValueAtTime(item.frequency, time);
        this.piano.triggerAttackRelease(item.frequency, playLen, time, 0.78);
        if (item.isGlissando) {
          this.piano.frequency.rampTo(item.endFrequency, playLen, time);
        }
      }, item.startTimeSec);
      this.scheduledIds.push(eventId);
    }

    // 3. Подія завершення вправи з невеликим хвостом 0.35 сек
    const finishId = transport.schedule((time) => {
      Tone.Draw.schedule(() => {
        this.isPlaying = false;
        if (callbacks.onComplete) {
          callbacks.onComplete();
        }
      }, time);
    }, timeline.totalDurationSec + 0.35);
    this.scheduledIds.push(finishId);

    this.isPlaying = true;
    transport.start("+0.05");
    return timeline;
  }

  /**
   * Повертає поточний час відтворення в секундах прямо з Tone.Transport.
   */
  getCurrentTimeSec() {
    if (!window.Tone || !this.isPlaying) return 0;
    return window.Tone.Transport.seconds;
  }

  /**
   * Зупиняє відтворення та очищує заплановані події Tone.Transport.
   */
  stop() {
    this.isPlaying = false;
    if (window.Tone) {
      const transport = window.Tone.Transport;
      transport.stop();
      transport.cancel(0);
      transport.position = 0;
    }
    if (this.piano) {
      this.piano.triggerRelease();
    }
    this.scheduledIds = [];
  }
}
