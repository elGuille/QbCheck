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
   * Clasifica la respuesta a un estímulo dado si era objetivo y el offset
   * (ms desde el onset) de la primera respuesta en la ventana, o null/undefined
   * si no hubo respuesta. Pura: no gestiona "solo la primera respuesta cuenta"
   * (eso lo hace el runtime en index.html antes de llamar aquí).
   * @param {{isTarget: boolean, responseOffsetMs: (number|null|undefined)}} args
   * @returns {'omission'|'correctRejection'|'anticipatory'|'hit'|'commission'}
   */
  function classifyResponse(args) {
    var isTarget = !!args.isTarget;
    var offset = args.responseOffsetMs;

    if (offset === null || offset === undefined) {
      return isTarget ? 'omission' : 'correctRejection';
    }
    if (offset < ANTICIPATORY_THRESHOLD_MS) {
      return 'anticipatory';
    }
    if (isTarget) {
      return 'hit';
    }
    return 'commission';
  }

  function mean(values) {
    if (values.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  // Desviación típica MUESTRAL (divide por n-1). 0 si hay 0 o 1 valores.
  // Se documenta aquí explícitamente por si se quiere cambiar a poblacional (n).
  function sampleStdDev(values) {
    if (values.length < 2) return 0;
    var m = mean(values);
    var sumSq = 0;
    for (var i = 0; i < values.length; i++) {
      var d = values[i] - m;
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / (values.length - 1));
  }

  /**
   * Calcula las métricas de una sesión a partir de los trials.
   * @param {{isTarget: boolean, classification: string, rt?: number}[]} trials
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
      switch (t.classification) {
        case 'omission':
          omissions++;
          break;
        case 'commission':
          commissions++;
          break;
        case 'anticipatory':
          anticipatory++;
          break;
        case 'hit':
          hits++;
          rtValues.push(t.rt);
          rtSeries.push({ index: i, rt: t.rt });
          break;
        default:
          break;
      }
    }

    var nonTargets = stimuli - targets;
    var rtMean = mean(rtValues);
    var rtSd = sampleStdDev(rtValues);
    var rtCv = rtMean === 0 ? 0 : rtSd / rtMean;

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

  var api = {
    SHAPES: SHAPES,
    COLORS: COLORS,
    COMBINATIONS: COMBINATIONS,
    TARGET_RATE: TARGET_RATE,
    ANTICIPATORY_THRESHOLD_MS: ANTICIPATORY_THRESHOLD_MS,
    mulberry32: mulberry32,
    generateTargetMask: generateTargetMask,
    generateSequence: generateSequence,
    classifyResponse: classifyResponse,
    computeSessionMetrics: computeSessionMetrics,
    subsampleTrace: subsampleTrace,
    sameStimulus: sameStimulus
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    window.QbCheckLogic = api;
  }
})();
