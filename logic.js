/*
 * QbCheck web — logic.js
 *
 * Módulo de lógica PURA: sin DOM, sin canvas, sin localStorage, sin MediaPipe.
 * Funciona en dos entornos sin build step:
 *   1. Como <script src="logic.js"></script> clásico (NO type="module") en
 *      index.html abierto vía file:// en Chrome (los módulos ES rompen por
 *      CORS sobre file://, los scripts clásicos no).
 *   2. Como módulo importable desde Node vía createRequire() en los tests
 *      (node:test), porque exporta a module.exports cuando existe.
 *
 * Patrón UMD simplificado: todo se define en el scope del script y al final
 * se exporta a module.exports (Node) o a window.QbCheckLogic (navegador).
 */

(function () {
  'use strict';

  var SHAPES = ['circle', 'square'];
  var COLORS = ['gray', 'red'];

  // Las 4 combinaciones posibles de estímulo (forma x color), en orden fijo.
  var COMBINATIONS = [];
  for (var si = 0; si < SHAPES.length; si++) {
    for (var ci = 0; ci < COLORS.length; ci++) {
      COMBINATIONS.push({ shape: SHAPES[si], color: COLORS[ci] });
    }
  }

  var TARGET_RATE = 0.25;
  var ANTICIPATORY_THRESHOLD_MS = 200;
  var MOVEMENT_SPEED_THRESHOLD = 0.08;
  var SESSION_SCHEMA_VERSION = 2;

  /**
   * PRNG mulberry32: pequeño generador determinista de floats en [0,1),
   * a partir de una semilla entera de 32 bits. Se exporta para poder
   * generar secuencias reproducibles en los tests.
   * @param {number} seed
   * @returns {function(): number}
   */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sameStimulus(a, b) {
    return !!a && !!b && a.shape === b.shape && a.color === b.color;
  }

  /**
   * Genera el array booleano isTarget[0..n-1] respetando:
   *  - isTarget[0] siempre false.
   *  - Cuenta de objetivos ≈ round(n * 0.25).
   *  - Nunca 3 objetivos seguidos (isTarget[i] && isTarget[i-1] && isTarget[i-2]).
   *
   * LIMITACIÓN ACEPTADA (hallazgo #18 del audit externo 2026-08-16): la
   * restricción de máximo 2 objetivos seguidos introduce predictibilidad
   * condicionada — tras 2 objetivos seguidos, el siguiente estímulo NUNCA es
   * objetivo. Es una propiedad estadística del generador conocida y aceptada
   * (documentada en la spec), no un bug. No se cambia el generador.
   *
   * Estrategia: barajar posiciones candidatas (1..n-1) con Fisher-Yates usando
   * rng, ir colocando objetivos en cuanto no violen la restricción de racha,
   * y si el barajado no alcanza el conteo exacto, reparar por una segunda
   * pasada buscando huecos válidos.
   * @param {number} n
   * @param {function(): number} rng
   * @returns {boolean[]}
   */
  function generateTargetMask(n, rng) {
    var targetCount = Math.round(n * TARGET_RATE);
    var isTarget = new Array(n).fill(false);
    if (n <= 1 || targetCount <= 0) {
      return isTarget;
    }

    // Posiciones candidatas: 1..n-1 (la posición 0 nunca es objetivo).
    var candidates = [];
    for (var i = 1; i < n; i++) candidates.push(i);

    // Fisher-Yates shuffle con rng inyectable.
    for (var j = candidates.length - 1; j > 0; j--) {
      var k = Math.floor(rng() * (j + 1));
      var tmp = candidates[j];
      candidates[j] = candidates[k];
      candidates[k] = tmp;
    }

    function wouldExceedStreak(pos) {
      // ¿Colocar un objetivo en pos crearía una racha de 3 seguidos?
      var a = pos - 2 >= 0 ? isTarget[pos - 2] : false;
      var b = pos - 1 >= 0 ? isTarget[pos - 1] : false;
      var c = pos + 1 < n ? isTarget[pos + 1] : false;
      var d = pos + 2 < n ? isTarget[pos + 2] : false;
      if (a && b) return true; // pos-2, pos-1, pos → racha de 3
      if (b && c) return true; // pos-1, pos, pos+1 → racha de 3
      if (c && d) return true; // pos, pos+1, pos+2 → racha de 3
      return false;
    }

    var placed = 0;
    for (var ci = 0; ci < candidates.length && placed < targetCount; ci++) {
      var pos = candidates[ci];
      if (!wouldExceedStreak(pos)) {
        isTarget[pos] = true;
        placed++;
      }
    }

    // Reparación: si el shuffle + restricción de racha no alcanzó el
    // conteo objetivo, recorre secuencialmente huecos válidos restantes.
    if (placed < targetCount) {
      for (var p = 1; p < n && placed < targetCount; p++) {
        if (!isTarget[p] && !wouldExceedStreak(p)) {
          isTarget[p] = true;
          placed++;
        }
      }
    }

    return isTarget;
  }

  /**
   * Genera una secuencia de n estímulos con tarea 1-back (25% objetivos).
   * @param {number} n - longitud de la secuencia.
   * @param {function(): number} [rng] - generador [0,1); por defecto Math.random.
   * @returns {{shape: string, color: string, isTarget: boolean}[]}
   */
  function generateSequence(n, rng) {
    var random = typeof rng === 'function' ? rng : Math.random;
    var isTarget = generateTargetMask(n, random);
    var sequence = new Array(n);

    for (var i = 0; i < n; i++) {
      var combo;
      if (i === 0) {
        combo = COMBINATIONS[Math.floor(random() * COMBINATIONS.length)];
      } else if (isTarget[i]) {
        combo = sequence[i - 1];
      } else {
        var prev = sequence[i - 1];
        var pool = COMBINATIONS.filter(function (c) {
          return !(c.shape === prev.shape && c.color === prev.color);
        });
        combo = pool[Math.floor(random() * pool.length)];
      }
      sequence[i] = { shape: combo.shape, color: combo.color, isTarget: isTarget[i] };
    }

    return sequence;
  }

  /**
   * Índice de trial (ventana semiabierta [onset, onset+stimulusMs)) al que
   * pertenece un instante de tiempo, calculado desde el inicio de sesión
   * (grid teórico, NO desde el índice de trial activo del runtime).
   * Hallazgo #3: atribución de respuesta por tiempo, no por activeIndex.
   * @param {number} eventTimeMs - instante del evento (misma base que startTimeMs).
   * @param {number} startTimeMs - performance.now() al inicio de la sesión.
   * @param {number} stimulusMs - cadencia onset-a-onset (2000 ms).
   * @returns {number} índice de trial (puede ser negativo o >= n; el llamador
   *   debe comprobar los límites).
   */
  function trialIndexForTime(eventTimeMs, startTimeMs, stimulusMs) {
    return Math.floor((eventTimeMs - startTimeMs) / stimulusMs);
  }

  /**
   * ¿Un offset de respuesta (ms desde el onset REAL del trial) es anticipatorio?
   * Hallazgo #6: anticipatoria es un contador aparte, no consume la ventana.
   * @param {number} offsetMs
   * @returns {boolean}
   */
  function isAnticipatoryOffset(offsetMs) {
    return offsetMs < ANTICIPATORY_THRESHOLD_MS;
  }

  /**
   * Clasificación FINAL de un trial (no de una respuesta individual).
   * Semántica (hallazgo #6, decidida en el audit 2026-08-16):
   *  - Las respuestas anticipatorias (<200ms) no consumen la ventana y no
   *    entran aquí como firstValidOffsetMs: se cuentan aparte.
   *  - La primera respuesta VÁLIDA (>=200ms) del trial decide acierto/comisión.
   *  - Un objetivo sin ninguna respuesta válida es SIEMPRE omisión, haya
   *    habido o no respuestas anticipatorias antes.
   *  - Invariante garantizada: hits + omissions === targets.
   * @param {{isTarget: boolean, firstValidOffsetMs: (number|null|undefined)}} args
   * @returns {'omission'|'correctRejection'|'hit'|'commission'}
   */
  function classifyTrial(args) {
    var isTarget = !!args.isTarget;
    var offset = args.firstValidOffsetMs;
    if (offset === null || offset === undefined) {
      return isTarget ? 'omission' : 'correctRejection';
    }
    return isTarget ? 'hit' : 'commission';
  }

  // Media aritmética. null (no 0) si el array está vacío: la media de un
  // conjunto vacío no está definida (hallazgo #7).
  function mean(values) {
    if (!values || values.length === 0) return null;
    var sum = 0;
    for (var i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  // Desviación típica MUESTRAL (divide por n-1). null con 0 o 1 valores: la
  // SD muestral no está definida con n<2 (hallazgo #7).
  function sampleStdDev(values) {
    if (!values || values.length < 2) return null;
    var m = mean(values);
    var sumSq = 0;
    for (var i = 0; i < values.length; i++) {
      var d = values[i] - m;
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / (values.length - 1));
  }

  // Mediana. null si el array está vacío.
  function median(values) {
    if (!values || values.length === 0) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
    return sorted[mid];
  }

  /**
   * Calcula las métricas de una sesión a partir de los trials.
   * Cada trial ya trae su clasificación FINAL (hit/omission/commission/
   * correctRejection, nunca 'anticipatory': eso es un contador aparte por
   * trial, anticipatoryCount, que se suma aquí en el total de sesión).
   * @param {{isTarget: boolean, classification: string, rt?: number, anticipatoryCount?: number}[]} trials
   */
  function computeSessionMetrics(trials) {
    var stimuli = trials.length;
    var targets = 0;
    var omissions = 0;
    var commissions = 0;
    var anticipatory = 0;
    var hits = 0;
    var rtValues = [];
    var rtSeries = [];

    for (var i = 0; i < trials.length; i++) {
      var t = trials[i];
      if (t.isTarget) targets++;
      anticipatory += typeof t.anticipatoryCount === 'number' ? t.anticipatoryCount : 0;
      switch (t.classification) {
        case 'omission':
          omissions++;
          break;
        case 'commission':
          commissions++;
          break;
        case 'hit':
          hits++;
          rtValues.push(t.rt);
          rtSeries.push({ index: i, rt: t.rt });
          break;
        default:
          break; // correctRejection u otros
      }
    }

    var nonTargets = stimuli - targets;
    var rtMean = mean(rtValues);
    var rtSd = sampleStdDev(rtValues);
    var rtCv = (rtMean === null || rtSd === null || rtMean === 0) ? null : rtSd / rtMean;

    return {
      stimuli: stimuli,
      targets: targets,
      omissions: omissions,
      omissionPct: targets === 0 ? 0 : (omissions / targets) * 100,
      commissions: commissions,
      nonTargets: nonTargets,
      commissionPct: nonTargets === 0 ? 0 : (commissions / nonTargets) * 100,
      anticipatory: anticipatory,
      hits: hits,
      rtMean: rtMean,
      rtSd: rtSd,
      rtCv: rtCv,
      rtSeries: rtSeries
    };
  }

  /**
   * Estadísticas de calidad temporal de presentación (hallazgo #2): mediana
   * y máximo del retraso (actualOnset - plannedOnset) entre los trials que
   * tienen ambos valores numéricos.
   * @param {{plannedOnset?: (number|null), actualOnset?: (number|null)}[]} trials
   * @returns {{medianMs: (number|null), maxMs: (number|null)}}
   */
  function computeOnsetDelayStats(trials) {
    var delays = [];
    if (Array.isArray(trials)) {
      for (var i = 0; i < trials.length; i++) {
        var t = trials[i];
        if (t && typeof t.plannedOnset === 'number' && typeof t.actualOnset === 'number') {
          delays.push(t.actualOnset - t.plannedOnset);
        }
      }
    }
    if (delays.length === 0) return { medianMs: null, maxMs: null };
    return { medianMs: median(delays), maxMs: Math.max.apply(null, delays) };
  }

  /**
   * Métricas por bloque temporal de duración fija (hallazgo #16, deriva por
   * bloques de 1 min). Los bloques se definen por tiempo teórico de sesión
   * (índice de trial * stimulusMs), no por tiempo real, para que el número
   * de bloques sea determinista dada la duración de la sesión.
   * Bloques sin aciertos se devuelven igualmente (rtMedianMs: null): el
   * llamador debe mostrarlos explícitamente, no omitirlos.
   * @param {{isTarget: boolean, classification: string, rt?: number}[]} trials
   * @param {{stimulusMs?: number, blockMs?: number}} [opts]
   * @returns {Array<{blockIndex:number, startMs:number, endMs:number, trialsCount:number, targets:number, omissions:number, commissions:number, hits:number, rtMedianMs:(number|null)}>}
   */
  function computeBlockMetrics(trials, opts) {
    opts = opts || {};
    var stimulusMs = typeof opts.stimulusMs === 'number' && opts.stimulusMs > 0 ? opts.stimulusMs : 2000;
    var blockMs = typeof opts.blockMs === 'number' && opts.blockMs > 0 ? opts.blockMs : 60000;

    if (!Array.isArray(trials) || trials.length === 0) return [];

    var totalMs = trials.length * stimulusMs;
    var blockCount = Math.max(1, Math.ceil(totalMs / blockMs));
    var blocks = [];
    for (var b = 0; b < blockCount; b++) {
      blocks.push({
        blockIndex: b,
        startMs: b * blockMs,
        endMs: Math.min((b + 1) * blockMs, totalMs),
        trialsCount: 0,
        targets: 0,
        omissions: 0,
        commissions: 0,
        hits: 0,
        rtValues: []
      });
    }

    for (var i = 0; i < trials.length; i++) {
      var trialStartMs = i * stimulusMs;
      var blockIndex = Math.min(Math.floor(trialStartMs / blockMs), blockCount - 1);
      var block = blocks[blockIndex];
      var t = trials[i];
      block.trialsCount++;
      if (t.isTarget) block.targets++;
      if (t.classification === 'omission') block.omissions++;
      if (t.classification === 'commission') block.commissions++;
      if (t.classification === 'hit') {
        block.hits++;
        if (typeof t.rt === 'number') block.rtValues.push(t.rt);
      }
    }

    return blocks.map(function (blk) {
      return {
        blockIndex: blk.blockIndex,
        startMs: blk.startMs,
        endMs: blk.endMs,
        trialsCount: blk.trialsCount,
        targets: blk.targets,
        omissions: blk.omissions,
        commissions: blk.commissions,
        hits: blk.hits,
        rtMedianMs: blk.rtValues.length > 0 ? median(blk.rtValues) : null
      };
    });
  }

  /**
   * Submuestrea un array de puntos a como máximo maxPoints, por decimación
   * de índices equiespaciados (nearest-neighbor), preservando siempre el
   * primer y último punto.
   * @param {Array} points
   * @param {number} [maxPoints=2000]
   */
  function subsampleTrace(points, maxPoints) {
    var max = typeof maxPoints === 'number' ? maxPoints : 2000;
    if (!Array.isArray(points) || points.length === 0) return [];
    if (points.length <= max) return points.slice();
    if (max <= 1) return [points[0]];

    var result = new Array(max);
    var lastIndex = points.length - 1;
    for (var i = 0; i < max; i++) {
      var srcIndex = Math.round((i * lastIndex) / (max - 1));
      result[i] = points[srcIndex];
    }
    // Garantiza explícitamente primer y último punto (por si el redondeo falla).
    result[0] = points[0];
    result[max - 1] = points[lastIndex];
    return result;
  }

  /**
   * Métricas de actividad motora (traza de nariz normalizada) a partir de
   * muestras {x, y, t}. Hallazgo #9:
   *  - Corta la traza (no suma distancia) cuando el hueco temporal entre dos
   *    muestras consecutivas supera 2 periodos de muestreo (~133ms a 15fps):
   *    evita sumar un salto grande como si fuera movimiento real cuando la
   *    cara se pierde temporalmente y se reengancha en otra posición.
   *  - movingPct se pondera por DURACIÓN válida (suma de dt de segmentos no
   *    cortados), no por número de intervalos.
   *  - Devuelve coveragePct = muestras válidas / intentos de detección
   *    totales (hallazgo #9 + auditabilidad).
   * @param {{x:number, y:number, t:number}[]} samples
   * @param {{periodMs?: number, speedThreshold?: number, totalAttempts?: number}} [opts]
   * @returns {?{pathLength:number, movingPct:number, area:number, trace:Array, coveragePct:number}}
   */
  function computeActivityMetrics(samples, opts) {
    opts = opts || {};
    var periodMs = typeof opts.periodMs === 'number' && opts.periodMs > 0 ? opts.periodMs : (1000 / 15);
    var speedThreshold = typeof opts.speedThreshold === 'number' ? opts.speedThreshold : MOVEMENT_SPEED_THRESHOLD;
    var cutoffMs = periodMs * 2;

    if (!samples || samples.length < 2) return null;

    var totalAttempts = typeof opts.totalAttempts === 'number' && opts.totalAttempts >= samples.length
      ? opts.totalAttempts
      : samples.length;

    var pathLength = 0;
    var movingDurationMs = 0;
    var validDurationMs = 0;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
      if (i > 0) {
        var prev = samples[i - 1];
        var dtMs = s.t - prev.t;
        if (dtMs > 0 && dtMs <= cutoffMs) {
          var dx = s.x - prev.x, dy = s.y - prev.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          pathLength += dist;
          validDurationMs += dtMs;
          var speed = dist / (dtMs / 1000);
          if (speed > speedThreshold) movingDurationMs += dtMs;
        }
        // dt <= 0 o dt > cutoffMs: se corta la traza, no se suma distancia
        // ni duración entre este segmento (pérdida temporal de cara).
      }
    }

    var movingPct = validDurationMs === 0 ? 0 : (movingDurationMs / validDurationMs) * 100;
    var area = (maxX - minX) * (maxY - minY);
    var trace = subsampleTrace(samples.map(function (s) { return { x: s.x, y: s.y }; }), 2000);
    var coveragePct = totalAttempts > 0 ? (samples.length / totalAttempts) * 100 : 0;

    return { pathLength: pathLength, movingPct: movingPct, area: area, trace: trace, coveragePct: coveragePct };
  }

  // ================= PERSISTENCIA: VALIDACIÓN DE ESQUEMA (hallazgos #13/#14) =================

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }
  function isNullableFiniteNumber(v) {
    return v === null || isFiniteNumber(v);
  }

  /**
   * Valida la forma mínima de una entrada de sesión (v1 o v2) leída de
   * localStorage. No exige campos nuevos de v2 (son opcionales / migrables).
   * @param {*} raw
   * @returns {boolean}
   */
  function isValidSessionShape(raw) {
    if (!raw || typeof raw !== 'object') return false;
    if (typeof raw.id !== 'string' || raw.id.length === 0) return false;
    if (typeof raw.dateISO !== 'string' || isNaN(new Date(raw.dateISO).getTime())) return false;
    if (!isFiniteNumber(raw.durationMin) || raw.durationMin <= 0) return false;
    if (!isFiniteNumber(raw.stimuli) || raw.stimuli < 0) return false;
    if (!isFiniteNumber(raw.targets) || raw.targets < 0) return false;
    if (!isFiniteNumber(raw.omissions) || raw.omissions < 0) return false;
    if (!isFiniteNumber(raw.commissions) || raw.commissions < 0) return false;
    if (!isFiniteNumber(raw.anticipatory) || raw.anticipatory < 0) return false;
    if (!isNullableFiniteNumber(raw.rtMean)) return false;
    if (!isNullableFiniteNumber(raw.rtSd)) return false;
    if (!isNullableFiniteNumber(raw.rtCv)) return false;
    if (!Array.isArray(raw.rtSeries)) return false;
    if (raw.activity !== null && raw.activity !== undefined && typeof raw.activity !== 'object') return false;
    return true;
  }

  /**
   * Migra una entrada de sesión válida (v1 o v2) a schemaVersion 2, rellenando
   * con null los campos nuevos que no existan. Devuelve null si la entrada no
   * pasa la validación de esquema (para que el llamador la aísle, no la tire).
   * @param {*} raw
   * @returns {?object}
   */
  function migrateSessionEntry(raw) {
    if (!isValidSessionShape(raw)) return null;
    var out = {};
    for (var k in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
    }
    out.schemaVersion = SESSION_SCHEMA_VERSION;
    if (out.trials === undefined) out.trials = null;
    if (out.onsetDelayMedianMs === undefined) out.onsetDelayMedianMs = null;
    if (out.onsetDelayMaxMs === undefined) out.onsetDelayMaxMs = null;
    if (out.activity === undefined) out.activity = null;
    return out;
  }

  /**
   * Separa un array (potencialmente heterogéneo, tal como sale de
   * JSON.parse sobre datos de usuario) en entradas válidas (migradas a v2)
   * e inválidas (conservadas tal cual, sin modificar, para poder aislarlas
   * sin perder el dato original).
   * @param {*} rawArray
   * @returns {{valid: object[], invalid: Array}}
   */
  function partitionSessions(rawArray) {
    var valid = [];
    var invalid = [];
    if (!Array.isArray(rawArray)) {
      if (rawArray !== undefined && rawArray !== null) invalid.push(rawArray);
      return { valid: valid, invalid: invalid };
    }
    for (var i = 0; i < rawArray.length; i++) {
      var migrated = migrateSessionEntry(rawArray[i]);
      if (migrated) valid.push(migrated); else invalid.push(rawArray[i]);
    }
    return { valid: valid, invalid: invalid };
  }

  var api = {
    SHAPES: SHAPES,
    COLORS: COLORS,
    COMBINATIONS: COMBINATIONS,
    TARGET_RATE: TARGET_RATE,
    ANTICIPATORY_THRESHOLD_MS: ANTICIPATORY_THRESHOLD_MS,
    MOVEMENT_SPEED_THRESHOLD: MOVEMENT_SPEED_THRESHOLD,
    SESSION_SCHEMA_VERSION: SESSION_SCHEMA_VERSION,
    mulberry32: mulberry32,
    generateTargetMask: generateTargetMask,
    generateSequence: generateSequence,
    trialIndexForTime: trialIndexForTime,
    isAnticipatoryOffset: isAnticipatoryOffset,
    classifyTrial: classifyTrial,
    mean: mean,
    sampleStdDev: sampleStdDev,
    median: median,
    computeSessionMetrics: computeSessionMetrics,
    computeOnsetDelayStats: computeOnsetDelayStats,
    computeBlockMetrics: computeBlockMetrics,
    computeActivityMetrics: computeActivityMetrics,
    subsampleTrace: subsampleTrace,
    sameStimulus: sameStimulus,
    isValidSessionShape: isValidSessionShape,
    migrateSessionEntry: migrateSessionEntry,
    partitionSessions: partitionSessions
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    window.QbCheckLogic = api;
  }
})();
