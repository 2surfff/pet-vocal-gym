/**
 * Ізольований детектор висоти тону (Pitch Detector) на базі Web Audio API та алгоритму YIN.
 *
 * Ключові покращення порівняно з базовою автокореляцією:
 * 1. Буфер AnalyserNode.fftSize = 4096 семплів (~85–93 мс), що дає щонайменше 2 повні
 *    періоди навіть для низьких нот A2 (110 Гц) – D3 (146.8 Гц) без октавних помилок.
 * 2. Алгоритм YIN із кумулятивно-усередненою нормалізованою різницевою функцією (CMNDF)
 *    та високим порогом впевненості clarityThreshold = 0.85 (тобто поріг CMNDF <= 0.15).
 *    Аперіодичні звуки (дихання, шум кімнати, шиплячі) відсікаються як isSilent: true.
 * 3. Регульований поріг тиші (Noise Gate) за RMS (за замовчуванням 0.025).
 * 4. Медіанний фільтр по останніх 4 кадрах частоти для згладжування мікротремтіння
 *    на приголосних звуках («м», «н», «г»).
 */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * Перетворює назву ноти (наприклад, "C#4", "A3") у MIDI-номер (61, 57).
 * Формула: MIDI = (октава + 1) * 12 + індекс_ноти_в_октаві.
 */
export function noteNameToMidi(noteName) {
  const match = /^([A-G])(#|b)?(-?\d+)$/.exec(String(noteName).trim());
  if (!match) {
    throw new Error(`Некоректна назва ноти: ${noteName}`);
  }
  const [, letter, accidental, octaveStr] = match;
  let index = NOTE_NAMES.indexOf(letter);
  if (accidental === "#") index += 1;
  if (accidental === "b") index -= 1;
  const octave = parseInt(octaveStr, 10);
  return (octave + 1) * 12 + index;
}

/**
 * Перетворює цілий MIDI-номер у назву ноти (напр. 69 -> "A4").
 */
export function midiToNoteName(midiNumber) {
  const rounded = Math.round(midiNumber);
  const noteIndex = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[noteIndex]}${octave}`;
}

/**
 * Транспонує назву ноти на задану кількість півтонів (напр. "C3", +2 -> "D3").
 */
export function transposeNoteName(noteName, semitones = 0) {
  return midiToNoteName(noteNameToMidi(noteName) + semitones);
}

/**
 * Перетворює MIDI-номер (може бути дробовим) у частоту в Гц за строєм A4 = 440 Гц.
 */
export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Перетворює частоту в Гц у ноту, MIDI-номер та відхилення в центах (-50..+50).
 */
export function frequencyToPitchData(frequency) {
  const midiFloat = 69 + 12 * Math.log2(frequency / 440);
  const midiNumber = Math.round(midiFloat);
  const centsOff = Math.round((midiFloat - midiNumber) * 100);
  return {
    frequency: Number(frequency.toFixed(2)),
    midiFloat,
    midiNumber,
    noteName: midiToNoteName(midiNumber),
    centsOff,
  };
}

/**
 * Повертає медіану числового масиву (не змінює вхідний масив).
 */
function computeMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function silentResult(rms, clarity = 0) {
  return {
    isSilent: true,
    rms,
    clarity,
    frequency: null,
    midiFloat: null,
    midiNumber: null,
    noteName: null,
    centsOff: null,
  };
}

export class PitchDetector {
  /**
   * @param {Object} options
   * @param {number} [options.bufferSize=4096] Розмір AnalyserNode.fftSize (4096 для стабільних басів A2–D3)
   * @param {number} [options.rmsThreshold=0.025] Поріг шумового гейта (RMS нижче цього значення ігнорується)
   * @param {number} [options.minFreq=65] Мінімальна частота детектування (Гц, ~C2)
   * @param {number} [options.maxFreq=1100] Максимальна частота детектування (Гц, ~C6)
   * @param {number} [options.clarityThreshold=0.85] Поріг впевненості (YIN CMNDF поріг = 1 - 0.85 = 0.15)
   * @param {number} [options.medianWindowSize=4] Розмір вікна медіанного фільтра для усунення тремтіння
   */
  constructor(options = {}) {
    this.bufferSize = options.bufferSize ?? 4096;
    this.rmsThreshold = options.rmsThreshold ?? 0.025;
    this.minFreq = options.minFreq ?? 65;
    this.maxFreq = options.maxFreq ?? 1100;
    this.clarityThreshold = options.clarityThreshold ?? 0.85;
    this.medianWindowSize = options.medianWindowSize ?? 4;

    this.audioContext = null;
    this.analyser = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.buffer = new Float32Array(this.bufferSize);
    this.recentFrequencies = [];
    this.isRunning = false;
  }

  /**
   * Динамічно оновлює поріг Noise Gate з повзунка в UI.
   */
  setRmsThreshold(value) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) {
      this.rmsThreshold = num;
    }
  }

  /**
   * Ініціалізує ланцюжок Web Audio API для мікрофона.
   * Приймає готовий MediaStream або об'єкт обмежень MediaTrackConstraints.
   * @param {MediaStream|MediaTrackConstraints} [streamOrConstraints]
   */
  async start(
    streamOrConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    }
  ) {
    if (this.isRunning) return;

    if (typeof MediaStream !== "undefined" && streamOrConstraints instanceof MediaStream) {
      this.mediaStream = streamOrConstraints;
    } else {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: streamOrConstraints,
      });
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = this.bufferSize;
    this.analyser.smoothingTimeConstant = 0;

    // Підключаємо мікрофон до AnalyserNode (без виводу в динаміки)
    this.sourceNode.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.recentFrequencies = [];
    this.isRunning = true;
  }

  /**
   * Зупиняє захоплення мікрофона та звільняє аудіоресурси.
   */
  async stop() {
    this.isRunning = false;
    this.recentFrequencies = [];
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
  }

  /**
   * Зчитує поточний аудіобуфер з мікрофона та повертає висоту тону.
   */
  getPitch() {
    if (!this.isRunning || !this.analyser || !this.audioContext) {
      return silentResult(0);
    }

    this.analyser.getFloatTimeDomainData(this.buffer);
    return this.analyzeBuffer(this.buffer, this.audioContext.sampleRate);
  }

  /**
   * Повноцінний алгоритм YIN + медіанний фільтр по останніх 4 кадрах.
   *
   * @param {Float32Array} buf Сигнал у діапазоні [-1.0, 1.0]
   * @param {number} sampleRate Частота дискретизації (напр. 44100 або 48000 Гц)
   */
  analyzeBuffer(buf, sampleRate) {
    const n = buf.length;

    // -------------------------------------------------------------------------
    // Крок 1. Noise Gate за RMS.
    // RMS = sqrt( (1 / N) * sum(buf[i]^2) )
    // Якщо сигнал нижче порога rmsThreshold (за замовчуванням 0.025) — очищуємо
    // історію медіанного фільтра та повертаємо тишу.
    // -------------------------------------------------------------------------
    let sumSquares = 0;
    for (let i = 0; i < n; i += 1) {
      sumSquares += buf[i] * buf[i];
    }
    const rms = Math.sqrt(sumSquares / n);

    if (rms < this.rmsThreshold) {
      this.recentFrequencies = [];
      return silentResult(rms, 0);
    }

    // -------------------------------------------------------------------------
    // Крок 2. Різницева функція YIN (Squared Difference Function):
    //   d(τ) = sum_{j=0}^{W-1} (x[j] - x[j + τ])^2
    // де W = floor(N / 2). На відміну від прямої автокореляції, різницева
    // функція менш чутлива до змін амплітуди та гармонік, що прибирає стрибки
    // на октаву вгору на низьких нотах.
    // -------------------------------------------------------------------------
    const halfSize = Math.floor(n / 2);
    const minLag = Math.max(2, Math.floor(sampleRate / this.maxFreq));
    const maxLag = Math.min(halfSize - 1, Math.ceil(sampleRate / this.minFreq));
    if (maxLag <= minLag) {
      this.recentFrequencies = [];
      return silentResult(rms, 0);
    }

    const diff = new Float32Array(maxLag + 1);
    for (let tau = 1; tau <= maxLag; tau += 1) {
      let sum = 0;
      for (let j = 0; j < halfSize; j += 1) {
        const delta = buf[j] - buf[j + tau];
        sum += delta * delta;
      }
      diff[tau] = sum;
    }

    // -------------------------------------------------------------------------
    // Крок 3. Cumulative Mean Normalized Difference Function (CMNDF):
    //   d'(0) = 1
    //   d'(τ) = d(τ) / ( (1 / τ) * sum_{k=1}^{τ} d(k) )
    // Це нормалізує різницю так, щоб при малих τ вона не падала хибно до 0,
    // а перша глибока "долина" (мінімум < 0.15) чітко відповідала періоду T0.
    // -------------------------------------------------------------------------
    const cmndf = new Float32Array(maxLag + 1);
    cmndf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= maxLag; tau += 1) {
      runningSum += diff[tau];
      cmndf[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
    }

    // -------------------------------------------------------------------------
    // Крок 4. Абсолютний поріг впевненості YIN.
    // clarity = 1 - cmndf[τ]. При clarityThreshold = 0.85 поріг для CMNDF
    // становить yinThreshold = 1 - 0.85 = 0.15.
    // Шукаємо ПЕРШИЙ локальний мінімум нижче yinThreshold — це запобігає вибору
    // субгармоніки (2*T0) або неперіодичного шуму.
    // -------------------------------------------------------------------------
    const yinThreshold = 1 - this.clarityThreshold;
    let bestLag = -1;
    for (let tau = minLag; tau <= maxLag; tau += 1) {
      if (cmndf[tau] < yinThreshold) {
        // Спускаємося до дна поточної долини
        while (tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau]) {
          tau += 1;
        }
        bestLag = tau;
        break;
      }
    }

    if (bestLag <= 0) {
      // Сигнал аперіодичний (дихання, шум, глухі приголосні)
      this.recentFrequencies = [];
      return silentResult(rms, 0);
    }

    const clarity = Math.max(0, Math.min(1, 1 - cmndf[bestLag]));
    if (clarity < this.clarityThreshold) {
      this.recentFrequencies = [];
      return silentResult(rms, clarity);
    }

    // -------------------------------------------------------------------------
    // Крок 5. Параболічна інтерполяція навколо bestLag на кривій CMNDF
    // для субсемплової точності частоти (до часток цента).
    // -------------------------------------------------------------------------
    let refinedLag = bestLag;
    if (bestLag > 0 && bestLag < maxLag) {
      const s0 = cmndf[bestLag - 1];
      const s1 = cmndf[bestLag];
      const s2 = cmndf[bestLag + 1];
      const denom = 2 * s1 - s0 - s2;
      if (Math.abs(denom) > 1e-9) {
        const shift = (s2 - s0) / (2 * denom);
        if (Math.abs(shift) < 1) {
          refinedLag = bestLag + shift;
        }
      }
    }

    const rawFrequency = sampleRate / refinedLag;
    if (
      rawFrequency < this.minFreq ||
      rawFrequency > this.maxFreq ||
      !Number.isFinite(rawFrequency)
    ) {
      this.recentFrequencies = [];
      return silentResult(rms, clarity);
    }

    // -------------------------------------------------------------------------
    // Крок 6. Медіанний фільтр по останніх 4 кадрах частоти.
    // Прибирає короткочасне тремтіння на носових і дзвінких приголосних («м», «н», «г»).
    // Якщо голос стрибнув одразу більше ніж на октаву — скидаємо буфер, щоб
    // не затримувати реальні інтервальні стрибки (напр. у сирені чи квінтах).
    // -------------------------------------------------------------------------
    if (this.recentFrequencies.length > 0) {
      const prevMedian = computeMedian(this.recentFrequencies);
      const ratio = rawFrequency / prevMedian;
      if (ratio > 1.9 || ratio < 0.52) {
        this.recentFrequencies = [];
      }
    }

    this.recentFrequencies.push(rawFrequency);
    if (this.recentFrequencies.length > this.medianWindowSize) {
      this.recentFrequencies.shift();
    }

    const smoothedFrequency = computeMedian(this.recentFrequencies);
    const pitch = frequencyToPitchData(smoothedFrequency);

    return {
      isSilent: false,
      rms,
      clarity: Number(clarity.toFixed(3)),
      ...pitch,
    };
  }
}
