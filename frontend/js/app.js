/**
 * Головний контролер стану Vocal Gym (ES6 Module).
 *
 * Зв'язує бекенд API (/api/exercises, /api/sessions, /api/stats),
 * YIN-детектор висоти тону (pitch_detector.js), синтезатор (synth.js)
 * та візуалізатор на Canvas (visualizer.js).
 */

import {
  PitchDetector,
  frequencyToPitchData,
  midiToFrequency,
  midiToNoteName,
  transposeNoteName,
} from "./pitch_detector.js";
import {
  ExerciseSynth,
  buildExerciseTimeline,
  getEventTargetMidiAtTime,
} from "./synth.js";
import { PitchVisualizer, getAccuracyColor } from "./visualizer.js";

class VocalGymApp {
  constructor() {
    this.detector = new PitchDetector({
      bufferSize: 4096,
      rmsThreshold: 0.025,
      clarityThreshold: 0.85,
      medianWindowSize: 4,
    });
    this.synth = new ExerciseSynth();
    this.visualizer = null;

    this.exercises = [];
    this.selectedExercise = null;
    this.currentTimeline = null;
    this.transposeSemitones = 0;
    this.currentBpm = 80;

    this.isSessionActive = false;
    this.isMicEnabled = false;
    this.isDemoMode = false;
    this.rafId = null;

    // Статистика кадрів під час поточної сесії
    this.sessionNoteBuckets = new Map();
    this.sessionFrameScores = [];
    this.sessionFrameCents = [];

    this.dom = {
      totalXp: document.getElementById("stat-total-xp"),
      streakDays: document.getElementById("stat-streak"),
      sessionsCount: document.getElementById("stat-sessions"),
      problematicNotesList: document.getElementById("problematic-notes-list"),
      exerciseList: document.getElementById("exercise-list"),
      exerciseTitle: document.getElementById("active-exercise-title"),
      exerciseDesc: document.getElementById("active-exercise-desc"),
      exerciseBpm: document.getElementById("meta-bpm"),
      exerciseCount: document.getElementById("meta-notes-count"),
      exerciseDifficulty: document.getElementById("meta-difficulty"),
      btnMic: document.getElementById("btn-mic"),
      btnDemo: document.getElementById("btn-demo"),
      btnPreviewNote: document.getElementById("btn-preview-note"),
      btnTransposeDown: document.getElementById("btn-transpose-down"),
      btnTransposeUp: document.getElementById("btn-transpose-up"),
      btnTransposeReset: document.getElementById("btn-transpose-reset"),
      transposeValue: document.getElementById("transpose-value"),
      btnBpmDown: document.getElementById("btn-bpm-down"),
      btnBpmUp: document.getElementById("btn-bpm-up"),
      btnBpmReset: document.getElementById("btn-bpm-reset"),
      bpmValue: document.getElementById("bpm-value"),
      btnStartStop: document.getElementById("btn-start-stop"),
      chkMetronome: document.getElementById("chk-metronome"),
      micStatusText: document.getElementById("mic-status-text"),
      rmsFill: document.getElementById("rms-meter-fill"),
      rmsGateMarker: document.getElementById("rms-gate-marker"),
      sliderNoiseGate: document.getElementById("slider-noise-gate"),
      noiseGateValue: document.getElementById("noise-gate-value"),
      tunerNote: document.getElementById("tuner-note"),
      tunerFreq: document.getElementById("tuner-freq"),
      tunerCents: document.getElementById("tuner-cents"),
      tunerBarIndicator: document.getElementById("tuner-bar-indicator"),
      targetNoteBadge: document.getElementById("target-note-badge"),
      sessionProgressFill: document.createElement ? document.getElementById("session-progress-fill") : null,
      canvas: document.getElementById("pitch-canvas"),
      modal: document.getElementById("results-modal"),
      modalClose: document.getElementById("modal-close-btn"),
      modalRetry: document.getElementById("modal-retry-btn"),
      resScore: document.getElementById("result-score"),
      resCents: document.getElementById("result-cents"),
      resXp: document.getElementById("result-xp"),
      resTotalXp: document.getElementById("result-total-xp"),
      resNotesBreakdown: document.getElementById("result-notes-breakdown"),
      toast: document.getElementById("status-toast"),
    };
  }

  async init() {
    this.visualizer = new PitchVisualizer(this.dom.canvas);
    this._bindEvents();
    this._syncNoiseGateUI(this.detector.rmsThreshold);
    this._syncTransposeUI();

    await Promise.all([this.loadExercises(), this.loadStats()]);
    this._startRenderLoop();
  }

  _bindEvents() {
    this.dom.btnMic.addEventListener("click", () => this.toggleMicrophone());
    this.dom.btnDemo.addEventListener("click", () => this.toggleDemoMode());
    this.dom.btnPreviewNote.addEventListener("click", () => this.previewFirstNote());
    this.dom.btnTransposeDown.addEventListener("click", () => this.shiftTranspose(-1));
    this.dom.btnTransposeUp.addEventListener("click", () => this.shiftTranspose(1));
    this.dom.btnTransposeReset.addEventListener("click", () => this.setTranspose(0));
    this.dom.btnBpmDown.addEventListener("click", () => this.shiftBpm(-5));
    this.dom.btnBpmUp.addEventListener("click", () => this.shiftBpm(5));
    this.dom.btnBpmReset.addEventListener("click", () => {
      if (this.selectedExercise) this.setBpm(this.selectedExercise.bpm);
    });
    this.dom.sliderNoiseGate.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      this.detector.setRmsThreshold(val);
      this._syncNoiseGateUI(val);
    });
    this.dom.btnStartStop.addEventListener("click", () => this.toggleSession());
    this.dom.modalClose.addEventListener("click", () => this.closeModal());
    this.dom.modalRetry.addEventListener("click", () => {
      this.closeModal();
      this.startSession();
    });
    this.dom.modal.addEventListener("click", (e) => {
      if (e.target === this.dom.modal) this.closeModal();
    });

    window.addEventListener("resize", () => {
      if (this.visualizer) {
        this.visualizer.render();
      }
    });
  }

  _syncNoiseGateUI(threshold) {
    this.dom.sliderNoiseGate.value = threshold.toFixed(3);
    this.dom.noiseGateValue.textContent = threshold.toFixed(3);
    // Індикатор RMS розрахований на шкалу 0..0.25
    const markerPct = Math.min(100, Math.max(0, (threshold / 0.25) * 100));
    this.dom.rmsGateMarker.style.left = `${markerPct}%`;
  }

  _syncTransposeUI() {
    const sign = this.transposeSemitones > 0 ? "+" : "";
    this.dom.transposeValue.textContent = `${sign}${this.transposeSemitones} пт`;
  }

  shiftTranspose(delta) {
    this.setTranspose(this.transposeSemitones + delta);
  }

  setTranspose(semitones) {
    if (this.isSessionActive) {
      this.showToast("Спочатку зупиніть поточну вправу, щоб змінити тональність", true);
      return;
    }
    this.transposeSemitones = Math.max(-12, Math.min(12, semitones));
    this._syncTransposeUI();
    if (this.selectedExercise) {
      this.currentTimeline = buildExerciseTimeline(
        this.selectedExercise,
        this.transposeSemitones,
        this.currentBpm
      );
      this.visualizer.setTimeline(this.currentTimeline);
    }
  }

  _syncBpmUI() {
    this.dom.bpmValue.textContent = `${this.currentBpm} BPM`;
    this.dom.exerciseBpm.textContent = `${this.currentBpm} BPM`;
  }

  shiftBpm(delta) {
    this.setBpm(this.currentBpm + delta);
  }

  setBpm(bpm) {
    if (this.isSessionActive) {
      this.showToast("Спочатку зупиніть поточну вправу, щоб змінити темп", true);
      return;
    }
    this.currentBpm = Math.max(50, Math.min(160, Number(bpm) || 80));
    this._syncBpmUI();
    if (this.selectedExercise) {
      this.currentTimeline = buildExerciseTimeline(
        this.selectedExercise,
        this.transposeSemitones,
        this.currentBpm
      );
      this.visualizer.setTimeline(this.currentTimeline);
    }
  }

  showToast(message, isError = false) {
    const toast = this.dom.toast;
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove("visible");
    }, 3400);
  }

  async loadExercises() {
    try {
      const res = await fetch("/api/exercises");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.exercises = await res.json();
      this._renderExerciseList();
      if (this.exercises.length > 0) {
        this.selectExercise(this.exercises[0]);
      }
    } catch (err) {
      this.showToast(`Помилка завантаження вправ: ${err.message}`, true);
    }
  }

  async loadStats() {
    try {
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const stats = await res.json();
      this._renderStats(stats);
    } catch (err) {
      this.showToast(`Помилка завантаження статистики: ${err.message}`, true);
    }
  }

  _renderStats(stats) {
    this.dom.totalXp.textContent = `${stats.total_xp} XP`;
    this.dom.streakDays.textContent = `${stats.streak_days} дн.`;
    this.dom.sessionsCount.textContent = String(stats.sessions_count);

    const container = this.dom.problematicNotesList;
    container.innerHTML = "";
    if (!stats.problematic_notes || stats.problematic_notes.length === 0) {
      const empty = document.createElement("span");
      empty.className = "muted-chip";
      empty.textContent = "Ще немає даних — пройдіть першу вправу";
      container.appendChild(empty);
      return;
    }

    for (const item of stats.problematic_notes) {
      const chip = document.createElement("span");
      chip.className = "note-stat-chip";
      const pct = Math.round(item.avg_hit_ratio * 100);
      chip.innerHTML = `<strong>${item.note_name}</strong> · ±${item.avg_cents_off.toFixed(0)}¢ (${pct}%)`;
      container.appendChild(chip);
    }
  }

  _renderExerciseList() {
    const list = this.dom.exerciseList;
    list.innerHTML = "";

    const difficultyMap = {
      easy: { label: "Базова", cls: "badge-easy" },
      medium: { label: "Середня", cls: "badge-medium" },
      hard: { label: "Складна", cls: "badge-hard" },
    };

    for (const ex of this.exercises) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "exercise-card";
      btn.dataset.exerciseId = String(ex.id);
      const diff = difficultyMap[ex.difficulty] || { label: ex.difficulty, cls: "badge-easy" };
      const firstNote = ex.notes[0]?.note || "";
      const lastItem = ex.notes[ex.notes.length - 1];
      const lastNote = lastItem?.slide_to || lastItem?.note || "";

      btn.innerHTML = `
        <div class="exercise-card-top">
          <span class="exercise-card-title">${ex.title}</span>
          <span class="difficulty-badge ${diff.cls}">${diff.label}</span>
        </div>
        <div class="exercise-card-meta">
          <span>${ex.bpm} BPM</span>
          <span>•</span>
          <span>${ex.notes.length} ел. (${firstNote} → ${lastNote})</span>
        </div>
      `;

      btn.addEventListener("click", () => {
        if (this.isSessionActive) {
          this.showToast("Спочатку зупиніть поточну вправу", true);
          return;
        }
        this.selectExercise(ex);
      });

      list.appendChild(btn);
    }
  }

  selectExercise(exercise) {
    this.selectedExercise = exercise;
    this.currentBpm = Math.max(50, Math.min(160, Number(exercise.bpm) || 80));
    this.currentTimeline = buildExerciseTimeline(
      exercise,
      this.transposeSemitones,
      this.currentBpm
    );

    this.dom.exerciseTitle.textContent = exercise.title;
    this.dom.exerciseDesc.textContent = exercise.description;
    this._syncBpmUI();
    this.dom.exerciseCount.textContent = `${exercise.notes.length} ел.`;

    const diffLabels = { easy: "Базова", medium: "Середня", hard: "Складна" };
    this.dom.exerciseDifficulty.textContent = diffLabels[exercise.difficulty] || exercise.difficulty;

    document.querySelectorAll(".exercise-card").forEach((el) => {
      el.classList.toggle("active", el.dataset.exerciseId === String(exercise.id));
    });

    this.visualizer.setTimeline(this.currentTimeline);
    this.dom.sessionProgressFill.style.width = "0%";
    this.dom.targetNoteBadge.textContent = "Готово до старту";
  }

  async toggleMicrophone() {
    if (this.isMicEnabled) {
      await this.detector.stop();
      this.isMicEnabled = false;
      this.dom.btnMic.classList.remove("active");
      this.dom.btnMic.textContent = "Увімкнути мікрофон";
      this.dom.micStatusText.textContent = this.isDemoMode
        ? "Демо-режим активний"
        : "Мікрофон вимкнено";
      this._updateTunerUI(null, null, 0);
      return;
    }

    try {
      // Вмикаємо апаратне ехо- та шумозаглушення, щоб мікрофон не ловив звук піаніно з динаміків
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      await this.detector.start(stream);
      this.isMicEnabled = true;
      this.isDemoMode = false;
      this.dom.btnDemo.classList.remove("active");
      this.dom.btnMic.classList.add("active");
      this.dom.btnMic.textContent = "Вимкнути мікрофон";
      this.dom.micStatusText.textContent = "Мікрофон активний (AEC/NS)";
      this.showToast("Мікрофон підключено з шумо- та ехозаглушенням!");
    } catch (err) {
      this.showToast(
        `Не вдалося отримати доступ до мікрофона: ${err.message}. Можна увімкнути Демо-режим.`,
        true
      );
    }
  }

  toggleDemoMode() {
    this.isDemoMode = !this.isDemoMode;
    this.dom.btnDemo.classList.toggle("active", this.isDemoMode);
    if (this.isDemoMode) {
      this.dom.micStatusText.textContent = "Демо-симуляція голосу активна";
      this.showToast("Демо-режим увімкнено (симуляція співу в межах ±12 центів)");
    } else {
      this.dom.micStatusText.textContent = this.isMicEnabled
        ? "Мікрофон активний (AEC/NS)"
        : "Мікрофон вимкнено";
    }
  }

  async previewFirstNote() {
    if (!this.selectedExercise || !this.selectedExercise.notes.length) return;
    try {
      const first = this.selectedExercise.notes[0];
      const transposedNote = transposeNoteName(first.note, this.transposeSemitones);
      await this.synth.playReferenceNote(transposedNote, 0.9);
      this.showToast(`Еталонна нота: ${transposedNote} (${first.syllable})`);
    } catch (err) {
      this.showToast(`Помилка аудіо: ${err.message}`, true);
    }
  }

  async toggleSession() {
    if (this.isSessionActive) {
      this.stopSession(false);
    } else {
      await this.startSession();
    }
  }

  async startSession() {
    if (!this.selectedExercise) return;

    if (!this.isMicEnabled && !this.isDemoMode) {
      await this.toggleMicrophone();
      if (!this.isMicEnabled) {
        this.showToast("Увімкніть мікрофон або Демо-режим перед стартом вправи", true);
        return;
      }
    }

    this.sessionNoteBuckets = new Map();
    this.sessionFrameScores = [];
    this.sessionFrameCents = [];
    this.visualizer.resetTrail();

    this.isSessionActive = true;
    this.dom.btnStartStop.textContent = "Стоп";
    this.dom.btnStartStop.classList.add("danger");

    try {
      this.currentTimeline = await this.synth.startExercise(this.selectedExercise, {
        transposeSemitones: this.transposeSemitones,
        bpm: this.currentBpm,
        keepMetronomeOnExercise: this.dom.chkMetronome.checked,
        onCountInBeat: (beat) => {
          this.dom.targetNoteBadge.textContent = `Відлік: ${beat} / 4`;
        },
        onComplete: () => {
          if (this.isSessionActive) {
            this.finishSession();
          }
        },
      });
      this.visualizer.setTimeline(this.currentTimeline);
    } catch (err) {
      this.isSessionActive = false;
      this.dom.btnStartStop.textContent = "Старт вправи";
      this.dom.btnStartStop.classList.remove("danger");
      this.showToast(`Не вдалося запустити синтезатор: ${err.message}`, true);
    }
  }

  stopSession(completed = false) {
    this.isSessionActive = false;
    this.synth.stop();
    this.dom.btnStartStop.textContent = "Старт вправи";
    this.dom.btnStartStop.classList.remove("danger");
    this.dom.sessionProgressFill.style.width = completed ? "100%" : "0%";
    if (!completed) {
      this.dom.targetNoteBadge.textContent = "Зупинено";
    }
  }

  async finishSession() {
    this.stopSession(true);
    this.dom.targetNoteBadge.textContent = "Завершено!";

    const totalFrames = this.sessionFrameScores.length;
    const scorePercent =
      totalFrames > 0
        ? (this.sessionFrameScores.reduce((acc, v) => acc + v, 0) / totalFrames) * 100
        : 0;
    const avgCentsOff =
      totalFrames > 0
        ? this.sessionFrameCents.reduce((acc, v) => acc + v, 0) / totalFrames
        : 50;

    const noteResults = [];
    for (const bucket of this.sessionNoteBuckets.values()) {
      const noteAvgCents =
        bucket.frameCount > 0 ? bucket.absCentsSum / bucket.frameCount : 50;
      const hitRatio = bucket.frameCount > 0 ? bucket.hitFrames / bucket.frameCount : 0;
      noteResults.push({
        note_name: bucket.noteName,
        midi_number: bucket.midiNumber,
        avg_cents_off: Number(noteAvgCents.toFixed(2)),
        hit_ratio: Number(hitRatio.toFixed(4)),
      });
    }

    if (noteResults.length === 0 && this.currentTimeline) {
      const seen = new Set();
      for (const ev of this.currentTimeline.events) {
        if (seen.has(ev.note)) continue;
        seen.add(ev.note);
        noteResults.push({
          note_name: ev.note,
          midi_number: ev.midi,
          avg_cents_off: 50.0,
          hit_ratio: 0.0,
        });
      }
    }

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exercise_id: this.selectedExercise.id,
          score_percent: Number(scorePercent.toFixed(2)),
          avg_cents_off: Number(avgCentsOff.toFixed(2)),
          note_results: noteResults,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json();
      await this.loadStats();
      this._openResultsModal(saved, noteResults);
    } catch (err) {
      this.showToast(`Не вдалося зберегти результат: ${err.message}`, true);
    }
  }

  _openResultsModal(saved, noteResults) {
    this.dom.resScore.textContent = `${Math.round(saved.score_percent)}%`;
    this.dom.resCents.textContent = `±${saved.avg_cents_off.toFixed(1)} ¢`;
    this.dom.resXp.textContent = `+${saved.xp_earned} XP`;
    this.dom.resTotalXp.textContent = `${saved.total_xp} XP (Стрік: ${saved.streak_days} дн.)`;

    const list = this.dom.resNotesBreakdown;
    list.innerHTML = "";
    for (const nr of noteResults) {
      const row = document.createElement("div");
      row.className = "modal-note-row";
      const pct = Math.round(nr.hit_ratio * 100);
      const badgeColor = getAccuracyColor(nr.avg_cents_off);
      row.innerHTML = `
        <span class="modal-note-name">${nr.note_name}</span>
        <span class="modal-note-metrics">±${nr.avg_cents_off.toFixed(1)} ¢ · ${pct}% влучань</span>
        <span class="modal-note-dot" style="background:${badgeColor}"></span>
      `;
      list.appendChild(row);
    }

    this.dom.modal.classList.add("open");
  }

  closeModal() {
    this.dom.modal.classList.remove("open");
  }

  /**
   * Симулює голос у Демо-режимі (підтримує як рівні ноти, так і глісандо slide_to).
   */
  _getDemoPitch(currentTimeSec, targetEvent) {
    if (!targetEvent) {
      return {
        isSilent: true,
        rms: 0.004,
        frequency: null,
        midiFloat: null,
        midiNumber: null,
        noteName: null,
        centsOff: null,
      };
    }
    const baseMidi = getEventTargetMidiAtTime(targetEvent, currentTimeSec);
    const vibratoCents = Math.sin(currentTimeSec * 11) * 9 + Math.cos(currentTimeSec * 3.7) * 5;
    const simulatedMidi = baseMidi + vibratoCents / 100;
    const freq = midiToFrequency(simulatedMidi);
    const data = frequencyToPitchData(freq);
    return {
      isSilent: false,
      rms: 0.14,
      ...data,
    };
  }

  _findActiveTarget(currentTimeSec) {
    if (!this.currentTimeline) return null;
    return (
      this.currentTimeline.events.find(
        (ev) => currentTimeSec >= ev.startTimeSec && currentTimeSec <= ev.endTimeSec
      ) || null
    );
  }

  _recordFrameAccuracy(pitchData, targetEvent, currentTimeSec) {
    if (!targetEvent) return;

    const targetMidi = getEventTargetMidiAtTime(targetEvent, currentTimeSec);
    const bucketMidi = Math.round(targetMidi);
    const bucketNoteName = targetEvent.isGlissando
      ? `${targetEvent.note}→${targetEvent.slideToNote}`
      : targetEvent.note;
    const key = targetEvent.isGlissando
      ? `gliss:${targetEvent.index}:${bucketNoteName}`
      : `${targetEvent.midi}:${targetEvent.note}`;

    if (!this.sessionNoteBuckets.has(key)) {
      this.sessionNoteBuckets.set(key, {
        noteName: bucketNoteName,
        midiNumber: bucketMidi,
        absCentsSum: 0,
        frameCount: 0,
        hitFrames: 0,
      });
    }
    const bucket = this.sessionNoteBuckets.get(key);

    if (!pitchData || pitchData.isSilent || pitchData.midiFloat === null) {
      this.sessionFrameScores.push(0);
      this.sessionFrameCents.push(50);
      bucket.absCentsSum += 50;
      bucket.frameCount += 1;
      return;
    }

    const absCents = Math.abs(pitchData.midiFloat - targetMidi) * 100;
    let frameScore = 0;
    if (absCents <= 15) {
      frameScore = 1.0;
    } else if (absCents <= 35) {
      frameScore = 1.0 - ((absCents - 15) / 20) * 0.5;
    } else if (absCents <= 100) {
      frameScore = Math.max(0, 0.5 - ((absCents - 35) / 65) * 0.5);
    }

    this.sessionFrameScores.push(frameScore);
    this.sessionFrameCents.push(Math.min(100, absCents));

    bucket.absCentsSum += Math.min(100, absCents);
    bucket.frameCount += 1;
    if (absCents <= 35) {
      bucket.hitFrames += 1;
    }
  }

  _updateTunerUI(pitchData, targetEvent, currentTimeSec) {
    const rmsPercent = pitchData ? Math.min(100, Math.round((pitchData.rms / 0.25) * 100)) : 0;
    this.dom.rmsFill.style.width = `${rmsPercent}%`;

    if (!pitchData || pitchData.isSilent || !pitchData.noteName) {
      this.dom.tunerNote.textContent = "—";
      this.dom.tunerNote.style.color = "#94a3b8";
      this.dom.tunerFreq.textContent = "0.0 Hz";
      this.dom.tunerCents.textContent = "0 ¢";
      this.dom.tunerBarIndicator.style.left = "50%";
      this.dom.tunerBarIndicator.style.backgroundColor = "#475569";
      return;
    }

    const targetMidi = targetEvent
      ? getEventTargetMidiAtTime(targetEvent, currentTimeSec)
      : null;
    const displayCents =
      targetMidi !== null
        ? Math.round((pitchData.midiFloat - targetMidi) * 100)
        : pitchData.centsOff;
    const absCents = Math.abs(displayCents);
    const color =
      targetMidi !== null
        ? getAccuracyColor(absCents)
        : getAccuracyColor(Math.abs(pitchData.centsOff));

    this.dom.tunerNote.textContent = pitchData.noteName;
    this.dom.tunerNote.style.color = color;
    this.dom.tunerFreq.textContent = `${pitchData.frequency.toFixed(1)} Hz`;

    const sign = displayCents > 0 ? "+" : "";
    this.dom.tunerCents.textContent = `${sign}${displayCents} ¢`;

    const clamped = Math.max(-50, Math.min(50, displayCents));
    const percent = 50 + clamped;
    this.dom.tunerBarIndicator.style.left = `${percent}%`;
    this.dom.tunerBarIndicator.style.backgroundColor = color;
  }

  _startRenderLoop() {
    const tick = () => {
      const currentTimeSec = this.isSessionActive ? this.synth.getCurrentTimeSec() : 0;
      const targetEvent = this.isSessionActive ? this._findActiveTarget(currentTimeSec) : null;

      let pitchData = null;
      if (this.isMicEnabled) {
        pitchData = this.detector.getPitch();
      } else if (this.isDemoMode && this.isSessionActive) {
        pitchData = this._getDemoPitch(currentTimeSec, targetEvent);
      }

      if (this.isSessionActive && this.currentTimeline) {
        const progress = Math.min(
          100,
          Math.max(0, (currentTimeSec / this.currentTimeline.totalDurationSec) * 100)
        );
        this.dom.sessionProgressFill.style.width = `${progress.toFixed(1)}%`;

        if (targetEvent) {
          if (targetEvent.isGlissando) {
            const curNote = midiToNoteName(
              Math.round(getEventTargetMidiAtTime(targetEvent, currentTimeSec))
            );
            this.dom.targetNoteBadge.textContent = `Сирена: ${targetEvent.note}→${targetEvent.slideToNote} (${curNote} · ${targetEvent.syllable})`;
          } else {
            this.dom.targetNoteBadge.textContent = `Ціль: ${targetEvent.note} (${targetEvent.syllable})`;
          }
          this._recordFrameAccuracy(pitchData, targetEvent, currentTimeSec);
        } else if (currentTimeSec >= this.currentTimeline.countInSec) {
          this.dom.targetNoteBadge.textContent = "Завершення...";
        }

        this.visualizer.pushPitchSample(currentTimeSec, pitchData, targetEvent);
      }

      this._updateTunerUI(pitchData, targetEvent, currentTimeSec);
      this.visualizer.render(currentTimeSec, pitchData);

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new VocalGymApp();
  app.init();
});
