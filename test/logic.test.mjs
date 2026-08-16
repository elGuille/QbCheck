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
  classifyResponse,
  computeSessionMetrics,
  subsampleTrace,
  mulberry32
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

describe('classifyResponse', () => {
  test('objetivo + respuesta >= 200ms → hit', () => {
    const result = classifyResponse({ isTarget: true, responseOffsetMs: 250 });
    assert.strictEqual(result, 'hit');
  });

  test('objetivo sin respuesta → omission', () => {
    const result = classifyResponse({ isTarget: true, responseOffsetMs: null });
    assert.strictEqual(result, 'omission');
  });

  test('no-objetivo sin respuesta → correctRejection', () => {
    const result = classifyResponse({ isTarget: false, responseOffsetMs: undefined });
    assert.strictEqual(result, 'correctRejection');
  });

  test('no-objetivo + respuesta >= 200ms → commission', () => {
    const result = classifyResponse({ isTarget: false, responseOffsetMs: 300 });
    assert.strictEqual(result, 'commission');
  });

  test('respuesta < 200ms en objetivo → anticipatory', () => {
    const result = classifyResponse({ isTarget: true, responseOffsetMs: 150 });
    assert.strictEqual(result, 'anticipatory');
  });

  test('respuesta < 200ms en no-objetivo → anticipatory', () => {
    const result = classifyResponse({ isTarget: false, responseOffsetMs: 50 });
    assert.strictEqual(result, 'anticipatory');
  });

  test('respuesta exactamente en el límite (200ms) cuenta como válida, no anticipatoria', () => {
    const hit = classifyResponse({ isTarget: true, responseOffsetMs: 200 });
    const commission = classifyResponse({ isTarget: false, responseOffsetMs: 200 });
    assert.strictEqual(hit, 'hit');
    assert.strictEqual(commission, 'commission');
  });
});

describe('computeSessionMetrics', () => {
  // 6 trials construidos a mano:
  //   0: no-objetivo, sin respuesta        -> correctRejection
  //   1: objetivo, rt=350                  -> hit
  //   2: no-objetivo, respuesta            -> commission
  //   3: objetivo, sin respuesta           -> omission
  //   4: objetivo, rt=450                  -> hit
  //   5: no-objetivo, respuesta <200ms     -> anticipatory
  //
  // Cálculo a mano:
  //   stimuli=6, targets=3, nonTargets=3
  //   omissions=1 -> omissionPct = 1/3*100 = 33.3333...
  //   commissions=1 -> commissionPct = 1/3*100 = 33.3333...
  //   anticipatory=1, hits=2
  //   rtMean = (350+450)/2 = 400
  //   rtSd (muestral, n-1): desviaciones -50,+50 -> sumSq=5000 -> /1 = 5000 -> sqrt = 70.71067811865476
  //   rtCv = rtSd/rtMean = 0.17677669529663687
  const trials = [
    { isTarget: false, classification: 'correctRejection' },
    { isTarget: true, classification: 'hit', rt: 350 },
    { isTarget: false, classification: 'commission' },
    { isTarget: true, classification: 'omission' },
    { isTarget: true, classification: 'hit', rt: 450 },
    { isTarget: false, classification: 'anticipatory' }
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

  test('caso sin hits: rtMean, rtSd, rtCv son 0', () => {
    const noHits = computeSessionMetrics([
      { isTarget: true, classification: 'omission' },
      { isTarget: false, classification: 'correctRejection' }
    ]);
    assert.strictEqual(noHits.rtMean, 0);
    assert.strictEqual(noHits.rtSd, 0);
    assert.strictEqual(noHits.rtCv, 0);
  });

  test('caso sin objetivos: omissionPct es 0 (no división por cero)', () => {
    const noTargets = computeSessionMetrics([
      { isTarget: false, classification: 'correctRejection' },
      { isTarget: false, classification: 'commission' }
    ]);
    assert.strictEqual(noTargets.targets, 0);
    assert.strictEqual(noTargets.omissionPct, 0);
  });

  test('caso un solo hit: rtSd es 0 (SD muestral indefinida con n=1)', () => {
    const oneHit = computeSessionMetrics([{ isTarget: true, classification: 'hit', rt: 500 }]);
    assert.strictEqual(oneHit.rtSd, 0);
    assert.strictEqual(oneHit.rtMean, 500);
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
