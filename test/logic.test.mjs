// QbCheck web — tests de logic.js
//
// Usa node:test + assert nativos (sin dependencias npm). logic.js es un
// script clásico (no ESM) para poder cargarse con <script src> sobre
// file://, así que aquí lo importamos con createRequire() en vez de
// `import`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  generateSequence,
  trialIndexForTime,
  isAnticipatoryOffset,
  classifyTrial,
  mean,
  sampleStdDev,
  median,
  computeSessionMetrics,
  computeOnsetDelayStats,
  computeBlockMetrics,
  computeActivityMetrics,
  subsampleTrace,
  mulberry32,
  isValidSessionShape,
  migrateSessionEntry,
  partitionSessions,
  SESSION_SCHEMA_VERSION
} = require('../logic.js');

const LENGTHS = [150, 300, 600];
const SEEDS = [1, 42, 1234, 999999, 7];

function hasStreakOfThree(sequence) {
  for (let i = 2; i < sequence.length; i++) {
    if (sequence[i].isTarget && sequence[i - 1].isTarget && sequence[i - 2].isTarget) {
      return true;
    }
  }
  return false;
}

describe('generateSequence — tasa de objetivos', () => {
  for (const n of LENGTHS) {
    for (const seed of SEEDS) {
      test(`n=${n} seed=${seed}: tasa de objetivos dentro de 25% ± 2pp`, () => {
        const rng = mulberry32(seed);
        const seq = generateSequence(n, rng);
        const targetCount = seq.filter((s) => s.isTarget).length;
        const pct = (targetCount / n) * 100;
        assert.ok(
          Math.abs(pct - 25) <= 2,
          `esperado 25% ± 2pp, obtenido ${pct.toFixed(2)}% (n=${n}, seed=${seed})`
        );
      });
    }
  }
});

describe('generateSequence — el primer estímulo nunca es objetivo', () => {
  for (const n of LENGTHS) {
    for (const seed of SEEDS) {
      test(`n=${n} seed=${seed}: seq[0].isTarget === false`, () => {
        const rng = mulberry32(seed);
        const seq = generateSequence(n, rng);
        assert.strictEqual(seq[0].isTarget, false);
      });
    }
  }
});

describe('generateSequence — sin rachas de más de 2 objetivos seguidos', () => {
  for (const n of LENGTHS) {
    for (const seed of SEEDS) {
      test(`n=${n} seed=${seed}: nunca 3 objetivos seguidos`, () => {
        const rng = mulberry32(seed);
        const seq = generateSequence(n, rng);
        assert.strictEqual(hasStreakOfThree(seq), false);
      });
    }
  }
});

describe('generateSequence — coherencia forma/color de los objetivos', () => {
  test('cada objetivo coincide exactamente con el estímulo anterior', () => {
    const rng = mulberry32(42);
    const seq = generateSequence(300, rng);
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].isTarget) {
        assert.strictEqual(seq[i].shape, seq[i - 1].shape);
        assert.strictEqual(seq[i].color, seq[i - 1].color);
      } else {
        assert.ok(
          seq[i].shape !== seq[i - 1].shape || seq[i].color !== seq[i - 1].color,
          `posición ${i}: no-objetivo no debería coincidir con el anterior`
        );
      }
    }
  });

  test('sin rng inyectado, usa Math.random como fallback y no lanza', () => {
    const seq = generateSequence(50);
    assert.strictEqual(seq.length, 50);
    assert.strictEqual(seq[0].isTarget, false);
  });
});

describe('generateSequence — limitación aceptada (hallazgo #18): predictibilidad condicionada', () => {
  test('tras 2 objetivos seguidos, el siguiente estímulo nunca es objetivo', () => {
    // Documentado como limitación aceptada del generador (spec, sección
    // "Limitaciones conocidas"): no se cambia el algoritmo, solo se
    // verifica y documenta la propiedad.
    const rng = mulberry32(42);
    const seq = generateSequence(300, rng);
    let sawStreakOfTwo = false;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].isTarget && seq[i - 1].isTarget) {
        sawStreakOfTwo = true;
        if (i + 1 < seq.length) {
          assert.strictEqual(
            seq[i + 1].isTarget,
            false,
            `posición ${i + 1}: tras una racha de 2 objetivos, el siguiente debe ser NO-objetivo`
          );
        }
      }
    }
    assert.ok(sawStreakOfTwo, 'la secuencia de prueba debería contener al menos una racha de 2 objetivos');
  });
});

describe('trialIndexForTime — atribución por tiempo con fronteras exactas', () => {
  const startTime = 0;
  const stimulusMs = 2000;

  test('1999.999ms pertenece al trial 0 (ventana semiabierta [0, 2000))', () => {
    assert.strictEqual(trialIndexForTime(1999.999, startTime, stimulusMs), 0);
  });

  test('2000ms pertenece al trial 1, no al 0 (frontera superior excluyente)', () => {
    assert.strictEqual(trialIndexForTime(2000, startTime, stimulusMs), 1);
  });

  test('3999.999ms pertenece al trial 1', () => {
    assert.strictEqual(trialIndexForTime(3999.999, startTime, stimulusMs), 1);
  });

  test('4000ms pertenece al trial 2', () => {
    assert.strictEqual(trialIndexForTime(4000, startTime, stimulusMs), 2);
  });

  test('funciona con un startTime distinto de cero (desplazamiento de sesión)', () => {
    const shiftedStart = 123456.789;
    assert.strictEqual(trialIndexForTime(shiftedStart + 1999.999, shiftedStart, stimulusMs), 0);
    assert.strictEqual(trialIndexForTime(shiftedStart + 2000, shiftedStart, stimulusMs), 1);
  });

  test('un evento antes del inicio de sesión da índice negativo (el llamador debe descartarlo)', () => {
    assert.strictEqual(trialIndexForTime(-1, startTime, stimulusMs), -1);
  });
});

describe('isAnticipatoryOffset — frontera exacta de 200ms', () => {
  test('199.999ms es anticipatoria', () => {
    assert.strictEqual(isAnticipatoryOffset(199.999), true);
  });
  test('200ms NO es anticipatoria (frontera inclusiva hacia válida)', () => {
    assert.strictEqual(isAnticipatoryOffset(200), false);
  });
  test('0ms es anticipatoria', () => {
    assert.strictEqual(isAnticipatoryOffset(0), true);
  });
});

describe('classifyTrial — semántica final del trial (hallazgo #6)', () => {
  test('objetivo + primera respuesta válida (>=200ms) → hit', () => {
    assert.strictEqual(classifyTrial({ isTarget: true, firstValidOffsetMs: 250 }), 'hit');
  });
  test('objetivo sin respuesta válida → omission', () => {
    assert.strictEqual(classifyTrial({ isTarget: true, firstValidOffsetMs: null }), 'omission');
  });
  test('objetivo sin respuesta válida (undefined) → omission', () => {
    assert.strictEqual(classifyTrial({ isTarget: true, firstValidOffsetMs: undefined }), 'omission');
  });
  test('no-objetivo + respuesta válida → commission', () => {
    assert.strictEqual(classifyTrial({ isTarget: false, firstValidOffsetMs: 300 }), 'commission');
  });
  test('no-objetivo sin respuesta válida → correctRejection', () => {
    assert.strictEqual(classifyTrial({ isTarget: false, firstValidOffsetMs: null }), 'correctRejection');
  });
  test('exactamente 200ms cuenta como válida: hit en objetivo, commission en no-objetivo', () => {
    assert.strictEqual(classifyTrial({ isTarget: true, firstValidOffsetMs: 200 }), 'hit');
    assert.strictEqual(classifyTrial({ isTarget: false, firstValidOffsetMs: 200 }), 'commission');
  });
  test('un objetivo con SOLO respuestas anticipatorias (sin firstValidOffsetMs) sigue siendo omission', () => {
    // La anticipatoria no se pasa aquí como firstValidOffsetMs (no consume
    // la ventana): el runtime nunca debe pasarla como respuesta válida.
    assert.strictEqual(classifyTrial({ isTarget: true, firstValidOffsetMs: null }), 'omission');
  });
});

describe('mean / sampleStdDev — null en conjuntos insuficientes (hallazgo #7)', () => {
  test('mean([]) es null, no 0', () => {
    assert.strictEqual(mean([]), null);
  });
  test('mean([500]) es 500', () => {
    assert.strictEqual(mean([500]), 500);
  });
  test('sampleStdDev([]) es null', () => {
    assert.strictEqual(sampleStdDev([]), null);
  });
  test('sampleStdDev([500]) es null (SD muestral indefinida con n=1)', () => {
    assert.strictEqual(sampleStdDev([500]), null);
  });
  test('sampleStdDev([300, 400]) es un número definido', () => {
    const sd = sampleStdDev([300, 400]);
    assert.ok(typeof sd === 'number' && sd > 0);
  });
});

describe('median', () => {
  test('array vacío devuelve null', () => {
    assert.strictEqual(median([]), null);
  });
  test('longitud impar devuelve el valor central', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
  });
  test('longitud par devuelve la media de los dos centrales', () => {
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  });
});

describe('computeSessionMetrics — invariante hits + omissions === targets (hallazgo #6)', () => {
  test('trial objetivo con anticipatoryCount>0 pero classification=omission cuenta como omisión, no se pierde', () => {
    const trials = [
      { isTarget: true, classification: 'omission', anticipatoryCount: 2 },
      { isTarget: true, classification: 'hit', rt: 350, anticipatoryCount: 0 },
      { isTarget: false, classification: 'correctRejection', anticipatoryCount: 1 },
      { isTarget: false, classification: 'commission', anticipatoryCount: 0 }
    ];
    const metrics = computeSessionMetrics(trials);
    assert.strictEqual(metrics.targets, 2);
    assert.strictEqual(metrics.hits, 1);
    assert.strictEqual(metrics.omissions, 1);
    assert.strictEqual(metrics.hits + metrics.omissions, metrics.targets);
    // anticipatory es un CONTADOR de eventos, no de trials: 2 + 0 + 1 + 0 = 3
    assert.strictEqual(metrics.anticipatory, 3);
  });

  test('invariante hits+omissions===targets se mantiene en muchas combinaciones aleatorias', () => {
    const rng = mulberry32(2024);
    for (let iter = 0; iter < 50; iter++) {
      const n = 20;
      const trials = [];
      for (let i = 0; i < n; i++) {
        const isTarget = rng() < 0.25;
        const hadAnticipatory = rng() < 0.3 ? Math.floor(rng() * 3) : 0;
        const gotValidResponse = rng() < 0.5;
        const offset = gotValidResponse ? 200 + rng() * 1500 : null;
        const classification = classifyTrial({ isTarget, firstValidOffsetMs: offset });
        trials.push({
          isTarget,
          classification,
          rt: classification === 'hit' ? offset : null,
          anticipatoryCount: hadAnticipatory
        });
      }
      const metrics = computeSessionMetrics(trials);
      assert.strictEqual(metrics.hits + metrics.omissions, metrics.targets, `iter=${iter}`);
    }
  });
});

describe('computeSessionMetrics', () => {
  // 6 trials construidos a mano:
  //   0: no-objetivo, sin respuesta        -> correctRejection
  //   1: objetivo, rt=350                  -> hit
  //   2: no-objetivo, respuesta            -> commission
  //   3: objetivo, sin respuesta           -> omission
  //   4: objetivo, rt=450                  -> hit
  //   5: no-objetivo, con 1 anticipatoria pero classification=correctRejection -> correctRejection
  //
  // Cálculo a mano:
  //   stimuli=6, targets=3, nonTargets=3
  //   omissions=1 -> omissionPct = 1/3*100 = 33.3333...
  //   commissions=1 -> commissionPct = 1/3*100 = 33.3333...
  //   anticipatory=1 (evento en trial 5), hits=2
  //   rtMean = (350+450)/2 = 400
  //   rtSd (muestral, n-1): desviaciones -50,+50 -> sumSq=5000 -> /1 = 5000 -> sqrt = 70.71067811865476
  //   rtCv = rtSd/rtMean = 0.17677669529663687
  const trials = [
    { isTarget: false, classification: 'correctRejection', anticipatoryCount: 0 },
    { isTarget: true, classification: 'hit', rt: 350, anticipatoryCount: 0 },
    { isTarget: false, classification: 'commission', anticipatoryCount: 0 },
    { isTarget: true, classification: 'omission', anticipatoryCount: 0 },
    { isTarget: true, classification: 'hit', rt: 450, anticipatoryCount: 0 },
    { isTarget: false, classification: 'correctRejection', anticipatoryCount: 1 }
  ];

  const metrics = computeSessionMetrics(trials);
  const EPS = 1e-6;

  test('conteos básicos', () => {
    assert.strictEqual(metrics.stimuli, 6);
    assert.strictEqual(metrics.targets, 3);
    assert.strictEqual(metrics.nonTargets, 3);
    assert.strictEqual(metrics.omissions, 1);
    assert.strictEqual(metrics.commissions, 1);
    assert.strictEqual(metrics.anticipatory, 1);
    assert.strictEqual(metrics.hits, 2);
    assert.strictEqual(metrics.hits + metrics.omissions, metrics.targets);
  });

  test('porcentajes de omisión y comisión', () => {
    assert.ok(Math.abs(metrics.omissionPct - (100 / 3)) < EPS);
    assert.ok(Math.abs(metrics.commissionPct - (100 / 3)) < EPS);
  });

  test('rtMean, rtSd (muestral) y rtCv', () => {
    assert.ok(Math.abs(metrics.rtMean - 400) < EPS);
    assert.ok(Math.abs(metrics.rtSd - 70.71067811865476) < 1e-6);
    assert.ok(Math.abs(metrics.rtCv - 0.17677669529663687) < 1e-6);
  });

  test('rtSeries incluye solo los hits, en orden, con su índice', () => {
    assert.deepStrictEqual(metrics.rtSeries, [
      { index: 1, rt: 350 },
      { index: 4, rt: 450 }
    ]);
  });

  test('caso sin hits: rtMean, rtSd, rtCv son null (hallazgo #7, no 0)', () => {
    const noHits = computeSessionMetrics([
      { isTarget: true, classification: 'omission', anticipatoryCount: 0 },
      { isTarget: false, classification: 'correctRejection', anticipatoryCount: 0 }
    ]);
    assert.strictEqual(noHits.rtMean, null);
    assert.strictEqual(noHits.rtSd, null);
    assert.strictEqual(noHits.rtCv, null);
  });

  test('caso sin objetivos: omissionPct es 0 (no división por cero)', () => {
    const noTargets = computeSessionMetrics([
      { isTarget: false, classification: 'correctRejection', anticipatoryCount: 0 },
      { isTarget: false, classification: 'commission', anticipatoryCount: 0 }
    ]);
    assert.strictEqual(noTargets.targets, 0);
    assert.strictEqual(noTargets.omissionPct, 0);
  });

  test('caso un solo hit: rtMean definido, rtSd/rtCv null (hallazgo #7)', () => {
    const oneHit = computeSessionMetrics([
      { isTarget: true, classification: 'hit', rt: 500, anticipatoryCount: 0 }
    ]);
    assert.strictEqual(oneHit.rtMean, 500);
    assert.strictEqual(oneHit.rtSd, null);
    assert.strictEqual(oneHit.rtCv, null);
  });
});

describe('computeOnsetDelayStats — calidad temporal de presentación (hallazgo #2)', () => {
  test('sin trials con onset registrado, medianMs y maxMs son null', () => {
    const stats = computeOnsetDelayStats([{ plannedOnset: null, actualOnset: null }]);
    assert.strictEqual(stats.medianMs, null);
    assert.strictEqual(stats.maxMs, null);
  });

  test('calcula mediana y máximo de actualOnset - plannedOnset', () => {
    const trials = [
      { plannedOnset: 0, actualOnset: 5 },
      { plannedOnset: 2000, actualOnset: 2012 },
      { plannedOnset: 4000, actualOnset: 4130 }
    ];
    const stats = computeOnsetDelayStats(trials);
    assert.strictEqual(stats.medianMs, 12);
    assert.strictEqual(stats.maxMs, 130);
  });

  test('ignora trials sin plannedOnset/actualOnset numéricos', () => {
    const trials = [
      { plannedOnset: 0, actualOnset: 10 },
      { plannedOnset: null, actualOnset: null }
    ];
    const stats = computeOnsetDelayStats(trials);
    assert.strictEqual(stats.medianMs, 10);
    assert.strictEqual(stats.maxMs, 10);
  });
});

describe('computeBlockMetrics — deriva por bloques de 1 min (hallazgo #16)', () => {
  test('90 trials a 2000ms = 180000ms = 3 bloques de 1 min', () => {
    const trials = [];
    for (let i = 0; i < 90; i++) {
      trials.push({ isTarget: false, classification: 'correctRejection', rt: null });
    }
    const blocks = computeBlockMetrics(trials, { stimulusMs: 2000, blockMs: 60000 });
    assert.strictEqual(blocks.length, 3);
    assert.strictEqual(blocks[0].trialsCount, 30);
    assert.strictEqual(blocks[1].trialsCount, 30);
    assert.strictEqual(blocks[2].trialsCount, 30);
  });

  test('bloque sin aciertos se devuelve explícitamente con rtMedianMs null, no se omite', () => {
    const trials = [];
    for (let i = 0; i < 30; i++) trials.push({ isTarget: false, classification: 'correctRejection', rt: null });
    for (let i = 0; i < 30; i++) trials.push({ isTarget: true, classification: 'hit', rt: 400 + i });
    const blocks = computeBlockMetrics(trials, { stimulusMs: 2000, blockMs: 60000 });
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].hits, 0);
    assert.strictEqual(blocks[0].rtMedianMs, null);
    assert.strictEqual(blocks[1].hits, 30);
    assert.ok(typeof blocks[1].rtMedianMs === 'number');
  });

  test('cuenta omisiones y comisiones por bloque', () => {
    const trials = [
      { isTarget: true, classification: 'omission', rt: null },
      { isTarget: false, classification: 'commission', rt: null },
      { isTarget: true, classification: 'hit', rt: 300 }
    ];
    const blocks = computeBlockMetrics(trials, { stimulusMs: 2000, blockMs: 60000 });
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].omissions, 1);
    assert.strictEqual(blocks[0].commissions, 1);
    assert.strictEqual(blocks[0].hits, 1);
    assert.strictEqual(blocks[0].targets, 2);
  });

  test('array de trials vacío devuelve array de bloques vacío', () => {
    assert.deepStrictEqual(computeBlockMetrics([], {}), []);
  });
});

describe('computeActivityMetrics — submuestreo con cortes de traza (hallazgo #9)', () => {
  test('sin corte: dt regular, path y movingPct se calculan sobre todos los segmentos', () => {
    const periodMs = 1000 / 15; // ~66.67ms
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 0.1, y: 0, t: periodMs },
      { x: 0.2, y: 0, t: periodMs * 2 }
    ];
    const metrics = computeActivityMetrics(samples, { periodMs, speedThreshold: 0.08 });
    assert.ok(metrics !== null);
    assert.ok(Math.abs(metrics.pathLength - 0.2) < 1e-9);
  });

  test('corta la traza cuando dt > 2 periodos: no suma distancia del segmento cortado', () => {
    const periodMs = 1000 / 15; // ~66.67ms, cutoff = ~133.3ms
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 0, t: periodMs }, // segmento normal, dist=0
      // salto grande en tiempo (cara perdida y reencontrada lejos): se corta
      { x: 5, y: 5, t: periodMs + periodMs * 5 },
      { x: 5, y: 5, t: periodMs + periodMs * 5 + periodMs } // segmento normal tras el corte, dist=0
    ];
    const metrics = computeActivityMetrics(samples, { periodMs, speedThreshold: 0.08 });
    // La distancia entre (0,0) y (5,5) (~7.07) NO debe sumarse: solo quedan
    // dos segmentos válidos de distancia 0 cada uno.
    assert.ok(metrics.pathLength < 0.01, `pathLength=${metrics.pathLength} debería ser ~0, no incluir el salto`);
  });

  test('movingPct se pondera por duración válida, no por número de intervalos', () => {
    const periodMs = 100;
    // Un segmento largo casi-estático (dt válido) y uno corto rápido: si se
    // ponderase por cuenta de intervalos (50/50), movingPct sería 50%; al
    // ponderar por duración, el segmento largo estático domina.
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 0, t: periodMs }, // lento (dist 0), dt=100ms
      { x: 1, y: 0, t: periodMs + 10 } // rápido (dist 1 en 10ms = 100 u/s), dt=10ms
    ];
    const metrics = computeActivityMetrics(samples, { periodMs, speedThreshold: 0.08 });
    // Duración total válida = 110ms; duración "en movimiento" = 10ms.
    assert.ok(Math.abs(metrics.movingPct - (10 / 110) * 100) < 1e-6);
  });

  test('devuelve coveragePct = muestras válidas / intentos totales', () => {
    const periodMs = 100;
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 0, t: periodMs }
    ];
    const metrics = computeActivityMetrics(samples, { periodMs, totalAttempts: 4 });
    assert.strictEqual(metrics.coveragePct, 50);
  });

  test('menos de 2 muestras devuelve null', () => {
    assert.strictEqual(computeActivityMetrics([], {}), null);
    assert.strictEqual(computeActivityMetrics([{ x: 0, y: 0, t: 0 }], {}), null);
  });
});

describe('subsampleTrace', () => {
  test('si points.length <= maxPoints, se devuelve tal cual (copia)', () => {
    const points = [{ x: 0 }, { x: 1 }, { x: 2 }];
    const result = subsampleTrace(points, 2000);
    assert.deepStrictEqual(result, points);
    assert.notStrictEqual(result, points); // es una copia, no la misma referencia
  });

  test('reduce a como máximo maxPoints preservando primer y último punto', () => {
    const points = [];
    for (let i = 0; i < 5000; i++) points.push({ x: i, y: i * 2 });
    const result = subsampleTrace(points, 2000);
    assert.ok(result.length <= 2000);
    assert.deepStrictEqual(result[0], points[0]);
    assert.deepStrictEqual(result[result.length - 1], points[points.length - 1]);
  });

  test('array vacío devuelve array vacío', () => {
    assert.deepStrictEqual(subsampleTrace([], 2000), []);
  });
});

describe('validación de esquema de sesión (hallazgos #13/#14)', () => {
  function validSession(overrides) {
    return Object.assign(
      {
        id: 's_1',
        dateISO: '2026-08-16T10:00:00.000Z',
        durationMin: 10,
        stimuli: 300,
        targets: 75,
        omissions: 5,
        commissions: 10,
        anticipatory: 3,
        rtMean: 420,
        rtSd: 60,
        rtCv: 0.14,
        rtSeries: [],
        activity: null
      },
      overrides || {}
    );
  }

  test('isValidSessionShape acepta una sesión v1 completa', () => {
    assert.strictEqual(isValidSessionShape(validSession()), true);
  });

  test('isValidSessionShape acepta rtMean/rtSd/rtCv null (hallazgo #7)', () => {
    assert.strictEqual(isValidSessionShape(validSession({ rtMean: null, rtSd: null, rtCv: null })), true);
  });

  test('isValidSessionShape rechaza null/undefined/no-objeto', () => {
    assert.strictEqual(isValidSessionShape(null), false);
    assert.strictEqual(isValidSessionShape(undefined), false);
    assert.strictEqual(isValidSessionShape('no soy una sesión'), false);
    assert.strictEqual(isValidSessionShape(42), false);
  });

  test('isValidSessionShape rechaza id ausente o vacío', () => {
    assert.strictEqual(isValidSessionShape(validSession({ id: '' })), false);
    assert.strictEqual(isValidSessionShape(validSession({ id: undefined })), false);
  });

  test('isValidSessionShape rechaza dateISO inválido', () => {
    assert.strictEqual(isValidSessionShape(validSession({ dateISO: 'no es una fecha' })), false);
  });

  test('isValidSessionShape rechaza rtSeries que no es array', () => {
    assert.strictEqual(isValidSessionShape(validSession({ rtSeries: 'no soy array' })), false);
  });

  test('isValidSessionShape rechaza durationMin negativo o no numérico', () => {
    assert.strictEqual(isValidSessionShape(validSession({ durationMin: -5 })), false);
    assert.strictEqual(isValidSessionShape(validSession({ durationMin: 'diez' })), false);
  });

  test('migrateSessionEntry devuelve null para una entrada inválida', () => {
    assert.strictEqual(migrateSessionEntry({ foo: 'bar' }), null);
  });

  test('migrateSessionEntry añade schemaVersion:2 y rellena campos nuevos con null en una entrada v1', () => {
    const migrated = migrateSessionEntry(validSession());
    assert.strictEqual(migrated.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.strictEqual(migrated.trials, null);
    assert.strictEqual(migrated.onsetDelayMedianMs, null);
    assert.strictEqual(migrated.onsetDelayMaxMs, null);
    // Los campos originales se conservan.
    assert.strictEqual(migrated.id, 's_1');
    assert.strictEqual(migrated.stimuli, 300);
  });

  test('migrateSessionEntry conserva campos v2 ya presentes sin sobrescribirlos', () => {
    const v2 = validSession({
      schemaVersion: 2,
      trials: [{ plannedOnset: 0, actualOnset: 3, type: 'objetivo', classification: 'hit', rt: 300, inputMethod: 'keyboard' }],
      onsetDelayMedianMs: 5,
      onsetDelayMaxMs: 12
    });
    const migrated = migrateSessionEntry(v2);
    assert.strictEqual(migrated.trials.length, 1);
    assert.strictEqual(migrated.onsetDelayMedianMs, 5);
    assert.strictEqual(migrated.onsetDelayMaxMs, 12);
  });

  test('partitionSessions separa entradas válidas e inválidas sin descartarlas', () => {
    const raw = [validSession({ id: 's_1' }), { foo: 'entrada corrupta' }, validSession({ id: 's_2' }), 42];
    const result = partitionSessions(raw);
    assert.strictEqual(result.valid.length, 2);
    assert.strictEqual(result.invalid.length, 2);
    assert.deepStrictEqual(result.invalid[0], { foo: 'entrada corrupta' });
    assert.strictEqual(result.invalid[1], 42);
    result.valid.forEach((s) => assert.strictEqual(s.schemaVersion, SESSION_SCHEMA_VERSION));
  });

  test('partitionSessions con un valor que no es array trata el valor entero como inválido', () => {
    const result = partitionSessions({ not: 'an array' });
    assert.strictEqual(result.valid.length, 0);
    assert.strictEqual(result.invalid.length, 1);
  });

  test('partitionSessions con array vacío devuelve ambos arrays vacíos', () => {
    const result = partitionSessions([]);
    assert.deepStrictEqual(result.valid, []);
    assert.deepStrictEqual(result.invalid, []);
  });
});
