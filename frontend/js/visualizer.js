/**
 * Модуль візуалізації нотної доріжки, глісандо-блоків та кривої голосу на HTML5 Canvas.
 *
 * Координатна система:
 * - Вісь X: час (блоки рухаються справа наліво; лінія "Зараз" на 28% ширини полотна).
 * - Вісь Y: висота тону у півтонах (MIDI), де кожен півтон має фіксовану висоту в пікселях.
 *
 * Колірна індикація голосу:
 * - Зелений (#22c55e): точне потрапляння (відхилення <= 15 центів)
 * - Жовтий (#eab308): допустиме відхилення (15 < |центи| <= 35)
 * - Червоний (#ef4444): фальш (> 35 центів)
 */

import { midiToNoteName } from "./pitch_detector.js";
import { getEventTargetMidiAtTime } from "./synth.js";

const COLORS = {
  bgTop: "#0b101b",
  bgBottom: "#111827",
  gridLine: "rgba(148, 163, 184, 0.10)",
  gridOctaveLine: "rgba(148, 163, 184, 0.24)",
  labelText: "#94a3b8",
  playhead: "#38bdf8",
  playheadGlow: "rgba(56, 189, 248, 0.28)",
  noteFill: "rgba(59, 130, 246, 0.24)",
  noteBorder: "rgba(96, 165, 250, 0.72)",
  noteActiveFill: "rgba(56, 189, 248, 0.36)",
  noteActiveBorder: "#7dd3fc",
  slideFill: "rgba(168, 85, 247, 0.24)",
  slideBorder: "rgba(192, 132, 252, 0.78)",
  slideActiveFill: "rgba(192, 132, 252, 0.36)",
  slideActiveBorder: "#e9d5ff",
  noteText: "#f8fafc",
  pitchGreen: "#22c55e",
  pitchYellow: "#eab308",
  pitchRed: "#ef4444",
  pitchNeutral: "#38bdf8",
};

/**
 * Повертає колір лінії голосу залежно від відхилення в центах від цільової ноти.
 * @param {number|null} absCents
 */
export function getAccuracyColor(absCents) {
  if (absCents === null || absCents === undefined) {
    return COLORS.pitchNeutral;
  }
  if (absCents <= 15) return COLORS.pitchGreen;
  if (absCents <= 35) return COLORS.pitchYellow;
  return COLORS.pitchRed;
}

export class PitchVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.timeline = null;
    this.pitchTrail = []; // Масив точок: { timeSec, midiFloat, absCents, color }
    this.currentPitch = null;
    this.currentTimeSec = 0;
    this.pixelsPerSecond = 145;
    this.leftGutterPx = 58;

    this.resize();
  }

  /**
   * Адаптує внутрішню роздільність Canvas під devicePixelRatio для чіткого рендерингу.
   */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(260, Math.floor(rect.height));

    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
    }

    this.width = width;
    this.height = height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Встановлює новий таймлайн вправи та скидає попередню криву голосу.
   */
  setTimeline(timeline) {
    this.timeline = timeline;
    this.pitchTrail = [];
    this.currentTimeSec = 0;
    this.render();
  }

  /**
   * Очищає слід голосу перед новим стартом вправи.
   */
  resetTrail() {
    this.pitchTrail = [];
    this.currentTimeSec = 0;
    this.currentPitch = null;
  }

  /**
   * Додає нову точку висоти голосу до історії.
   */
  pushPitchSample(timeSec, pitchData, targetEvent) {
    this.currentTimeSec = timeSec;
    this.currentPitch = pitchData;

    if (!pitchData || pitchData.isSilent || pitchData.midiFloat === null) {
      return;
    }

    const targetMidi = targetEvent ? getEventTargetMidiAtTime(targetEvent, timeSec) : null;
    const absCents = targetMidi !== null ? Math.abs(pitchData.midiFloat - targetMidi) * 100 : null;

    this.pitchTrail.push({
      timeSec,
      midiFloat: pitchData.midiFloat,
      absCents,
      color: getAccuracyColor(absCents),
    });

    const minKeepTime = timeSec - 12;
    while (this.pitchTrail.length > 0 && this.pitchTrail[0].timeSec < minKeepTime) {
      this.pitchTrail.shift();
    }
  }

  /**
   * Обчислює діапазон нот на екрані (додаємо +-3 півтони запасу зверху та знизу).
   */
  _getMidiBounds() {
    if (!this.timeline) {
      return { lowMidi: 45, highMidi: 65 };
    }
    return {
      lowMidi: this.timeline.minMidi - 3,
      highMidi: this.timeline.maxMidi + 3,
    };
  }

  /**
   * Перетворює дробовий MIDI у Y-координату на полотні (вищі ноти — вище на екрані).
   */
  _midiToY(midiFloat, lowMidi, highMidi) {
    const padTop = 24;
    const padBottom = 24;
    const usableHeight = Math.max(80, this.height - padTop - padBottom);
    const ratio = (midiFloat - lowMidi) / Math.max(1, highMidi - lowMidi);
    return this.height - padBottom - ratio * usableHeight;
  }

  /**
   * Малює один кадр Canvas.
   * @param {number} [currentTimeSec] Поточний час із Tone.Transport.seconds
   * @param {Object|null} [livePitch] Поточний замір голосу
   */
  render(currentTimeSec = this.currentTimeSec, livePitch = this.currentPitch) {
    this.resize();
    this.currentTimeSec = currentTimeSec;
    this.currentPitch = livePitch;

    const ctx = this.ctx;
    const { width, height } = this;
    const { lowMidi, highMidi } = this._getMidiBounds();
    const semitoneCount = Math.max(1, highMidi - lowMidi);
    const noteRowHeight = Math.max(12, Math.min(28, (height - 48) / semitoneCount));
    const playheadX = Math.max(this.leftGutterPx + 70, Math.round(width * 0.28));

    // 1. Фон
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, COLORS.bgTop);
    bgGrad.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 2. Горизонтальна сітка півтонів та підписи нот зліва
    ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";

    for (let midi = lowMidi; midi <= highMidi; midi += 1) {
      const y = this._midiToY(midi, lowMidi, highMidi);
      const isOctaveC = ((midi % 12) + 12) % 12 === 0;
      const isNatural = ![1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

      ctx.strokeStyle = isOctaveC ? COLORS.gridOctaveLine : COLORS.gridLine;
      ctx.lineWidth = isOctaveC ? 1.2 : 1;
      ctx.beginPath();
      ctx.moveTo(this.leftGutterPx, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      if (isNatural || isOctaveC) {
        ctx.fillStyle = isOctaveC ? "#e2e8f0" : COLORS.labelText;
        ctx.fillText(midiToNoteName(midi), this.leftGutterPx - 10, y);
      }
    }

    ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.leftGutterPx, 0);
    ctx.lineTo(this.leftGutterPx, height);
    ctx.stroke();

    // Обрізаємо область треку праворуч від шкали нот
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.leftGutterPx, 0, width - this.leftGutterPx, height);
    ctx.clip();

    // 3. Блоки цільових нот та похилі блоки глісандо (slide_to)
    let activeTarget = null;
    if (this.timeline) {
      for (const item of this.timeline.events) {
        const xStart = playheadX + (item.startTimeSec - currentTimeSec) * this.pixelsPerSecond;
        const blockW = Math.max(18, item.durationSec * this.pixelsPerSecond - 4);
        const xEnd = xStart + blockW;

        if (xEnd < this.leftGutterPx || xStart > width + 20) {
          continue;
        }

        const isActive =
          currentTimeSec >= item.startTimeSec && currentTimeSec <= item.endTimeSec;
        if (isActive) {
          activeTarget = item;
        }

        const blockH = Math.max(14, noteRowHeight * 0.9);
        const halfH = blockH / 2;

        if (item.isGlissando) {
          const yStart = this._midiToY(item.midi, lowMidi, highMidi);
          const yEnd = this._midiToY(item.endMidi, lowMidi, highMidi);

          // Малюємо похилу стрічку глісандо
          ctx.fillStyle = isActive ? COLORS.slideActiveFill : COLORS.slideFill;
          ctx.strokeStyle = isActive ? COLORS.slideActiveBorder : COLORS.slideBorder;
          ctx.lineWidth = isActive ? 2 : 1.4;

          ctx.beginPath();
          ctx.moveTo(xStart, yStart - halfH);
          ctx.lineTo(xEnd, yEnd - halfH);
          ctx.lineTo(xEnd, yEnd + halfH);
          ctx.lineTo(xStart, yStart + halfH);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          // Осьова пунктирна траєкторія всередині похилого блоку
          ctx.save();
          ctx.setLineDash([5, 5]);
          ctx.strokeStyle = "rgba(233, 213, 255, 0.55)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(xStart, yStart);
          ctx.lineTo(xEnd, yEnd);
          ctx.stroke();
          ctx.restore();

          // Підпис сирени / глісандо
          const label = item.syllable
            ? `${item.note} → ${item.slideToNote} · ${item.syllable}`
            : `${item.note} → ${item.slideToNote}`;
          const midX = (xStart + xEnd) / 2;
          const midY = (yStart + yEnd) / 2;
          ctx.fillStyle = COLORS.noteText;
          ctx.font = "600 12px Inter, system-ui, -apple-system, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, midX, midY, Math.max(40, blockW - 12));
        } else {
          const yCenter = this._midiToY(item.midi, lowMidi, highMidi);
          const yTop = yCenter - halfH;

          ctx.fillStyle = isActive ? COLORS.noteActiveFill : COLORS.noteFill;
          ctx.strokeStyle = isActive ? COLORS.noteActiveBorder : COLORS.noteBorder;
          ctx.lineWidth = isActive ? 2 : 1.25;

          this._roundRect(ctx, xStart, yTop, blockW, blockH, 7);
          ctx.fill();
          ctx.stroke();

          const label = item.syllable ? `${item.note} · ${item.syllable}` : item.note;
          ctx.fillStyle = COLORS.noteText;
          ctx.font = "600 12px Inter, system-ui, -apple-system, sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          if (blockW > 36) {
            ctx.fillText(label, xStart + 9, yCenter, blockW - 14);
          }
        }
      }
    }

    // 4. Вертикальна лінія поточного моменту ("Зараз")
    ctx.save();
    ctx.strokeStyle = COLORS.playheadGlow;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
    ctx.restore();

    // 5. Крива голосу (шлейф ліворуч від playheadX)
    if (this.pitchTrail.length > 1) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;

      for (let i = 1; i < this.pitchTrail.length; i += 1) {
        const prev = this.pitchTrail[i - 1];
        const curr = this.pitchTrail[i];

        if (curr.timeSec - prev.timeSec > 0.14) continue;

        const x1 = playheadX + (prev.timeSec - currentTimeSec) * this.pixelsPerSecond;
        const y1 = this._midiToY(prev.midiFloat, lowMidi, highMidi);
        const x2 = playheadX + (curr.timeSec - currentTimeSec) * this.pixelsPerSecond;
        const y2 = this._midiToY(curr.midiFloat, lowMidi, highMidi);

        if (x2 < this.leftGutterPx || x1 > width) continue;

        ctx.strokeStyle = curr.color;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    // 6. Поточна точка голосу на лінії playheadX
    if (livePitch && !livePitch.isSilent && livePitch.midiFloat !== null) {
      const clampedMidi = Math.max(lowMidi - 0.5, Math.min(highMidi + 0.5, livePitch.midiFloat));
      const yDot = this._midiToY(clampedMidi, lowMidi, highMidi);
      const targetMidi = activeTarget
        ? getEventTargetMidiAtTime(activeTarget, currentTimeSec)
        : null;
      const absCents =
        targetMidi !== null ? Math.abs(livePitch.midiFloat - targetMidi) * 100 : null;
      const dotColor = getAccuracyColor(absCents);

      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(playheadX, yDot, 6.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 7. Індикатор відліку метронома перед першою нотою
    if (this.timeline && currentTimeSec > 0 && currentTimeSec < this.timeline.countInSec) {
      const beatNum = Math.min(
        this.timeline.countInBeats,
        Math.floor(currentTimeSec / this.timeline.beatSec) + 1
      );
      const badgeText = `ВІДЛІК: ${beatNum} / ${this.timeline.countInBeats}`;
      ctx.fillStyle = "rgba(15, 23, 42, 0.84)";
      this._roundRect(ctx, width / 2 - 86, 14, 172, 34, 17);
      ctx.fill();
      ctx.strokeStyle = "rgba(56, 189, 248, 0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#38bdf8";
      ctx.font = "700 13px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeText, width / 2, 31);
    }

    ctx.restore();
  }

  /**
   * Хелпер для малювання прямокутника із заокругленими кутами.
   */
  _roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}
