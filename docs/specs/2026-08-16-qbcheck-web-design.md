# QbCheck web — especificación de diseño (2026-08-16, revisada 2026-08-16 tras audit externo)

Test de atención tipo CPT (continuous performance task) inspirado en QbCheck, para uso personal en navegador. No es un instrumento diagnóstico; incluye aviso permanente al respecto.

> Revisión: esta versión incorpora las correcciones del audit externo
> `docs/audits/2026-08-16-audit-externo.md` (19 hallazgos, 18 confirmados y
> corregidos, 1 confirmado y documentado como limitación aceptada sin cambio
> de código). Cambia la semántica de clasificación, la validez de sesión, el
> manejo de valores sin datos suficientes, el esquema de persistencia
> (schemaVersion 2) y el histórico. El paradigma del test (2000 ms de
> cadencia, 100 ms de visibilidad, 25% de objetivos, tarea 1-back) no cambia.

## Alcance

- Un solo archivo `index.html` autocontenido (HTML + CSS + JS vanilla). Única dependencia externa: MediaPipe Tasks Vision por CDN.
- Lógica pura (generación de secuencia, clasificación, métricas, validación de esquema) vive en `logic.js`, sin DOM/canvas/localStorage, para poder testearse con `node:test` sin navegador.
- Sin backend. Histórico en `localStorage`. Debe funcionar abriendo el archivo con `file://` en Chrome.
- UI en español.

## Paradigma del test

- Estímulos: círculo o cuadrado, gris o rojo → 4 combinaciones equiprobables en apariencia.
- Cadencia: un estímulo cada 2000 ms (onset a onset), visible 100 ms, fondo oscuro neutro con punto de fijación entre estímulos.
- Tarea 1-back: el usuario responde (barra espaciadora o clic/tap en cualquier parte) cuando el estímulo actual coincide con el anterior en forma Y color.
- Tasa de objetivos: 25% (generación de secuencia controlada, no puramente aleatoria). El primer estímulo nunca es objetivo.
- Duración seleccionable al inicio: 5 / 10 / 20 min (150 / 300 / 600 estímulos).

### Limitación conocida y aceptada del generador (hallazgo #18)

El generador de secuencia impone un máximo de 2 objetivos consecutivos (nunca
3 seguidos). Esto introduce **predictibilidad condicionada**: tras dos
objetivos seguidos, el siguiente estímulo **nunca** es objetivo — un
participante que detecte el patrón podría explotarlo. Es una propiedad
estadística conocida del algoritmo (`generateTargetMask` en `logic.js`), no
un bug, y se acepta explícitamente sin cambiar el generador: mantener el
límite de racha y a la vez eliminar por completo esa predicción exigiría un
generador probabilístico distinto (fuera de alcance de esta revisión). Ver
`test/logic.test.mjs`, describe "limitación aceptada (hallazgo #18)".

## Validez de sesión (hallazgo #1, #2 — nuevo)

Una sesión puede quedar **invalidada** y descartarse en dos momentos distintos:

1. **Abort inmediato durante el test** (hallazgo #1). Si mientras la pantalla
   activa es "Test":
   - `document.visibilitychange` pasa a `document.hidden === true` (pestaña
     oculta / navegador suspendido), o
   - la ventana pierde el foco (`window` `blur`), o
   - el salto entre dos timestamps consecutivos de `requestAnimationFrame`
     supera 500 ms (hilo principal bloqueado o rAF suspendido sin que
     dispararan los eventos anteriores),

   la sesión se aborta y se descarta de inmediato: no se procesan los
   trials vencidos durante el salto (nunca se "recuperan" onsets no
   pintados), no se guarda nada en el histórico, y se muestra un aviso claro
   ("Sesión invalidada: la pestaña perdió el foco / el navegador se
   suspendió."). El usuario vuelve a la pantalla de Inicio.

2. **Invalidación al terminar por calidad temporal insuficiente** (hallazgo
   #2). Cada trial registra `plannedOnset` (onset teórico, calculado desde
   el inicio de sesión) y `actualOnset` (timestamp del frame de
   `requestAnimationFrame` que efectivamente pinta el estímulo). Si en
   **cualquier** trial `actualOnset - plannedOnset > 100 ms`, la sesión se
   invalida al terminar: se calculan las métricas mentalmente pero **no se
   guarda** en el histórico, y se informa al usuario con un aviso claro. La
   mediana y el máximo de ese retraso se guardan como métrica de calidad
   temporal (`onsetDelayMedianMs`, `onsetDelayMaxMs`) en toda sesión que sí
   se guarda (no solo en las invalidadas).

El estímulo se oculta 100 ms después del `actualOnset` real (no del onset
teórico), para que la duración de presentación medida sea siempre ~100 ms
independientemente del retraso de un frame concreto.

## Registro de respuestas

- Temporización con `performance.now()`; bucle con `requestAnimationFrame` para presentación y un scheduler tolerante a drift (los onsets se calculan desde el inicio de sesión, no acumulando timeouts).
- Los eventos de entrada (teclado y puntero) usan `event.timeStamp` (misma base temporal que `performance.now()`) para atribuir la respuesta a un trial y calcular el RT — no el instante de ejecución del listener, que puede desplazarse por bloqueos del hilo principal (hallazgo #4).
- Atribución de respuesta por **tiempo**, no por el índice de trial activo del runtime (hallazgo #3): `trialIndex = floor((tEvento - startTime) / 2000)`, con ventanas semiabiertas `[onset, onset + 2000)`. Una respuesta que cae exactamente en el onset del siguiente trial pertenece a ese siguiente trial, nunca al anterior.
- El RT se calcula respecto al `actualOnset` (real) del trial atribuido, no respecto al onset teórico (hallazgo #2/#3).
- El auto-repeat del teclado (`event.repeat`) se ignora: mantener pulsada la barra espaciadora no genera una respuesta nueva en cada trial (hallazgo #5).
- Solo cuenta el botón principal del puntero primario: se exige `event.isPrimary && event.button === 0` (hallazgo #19).
- Ventana de respuesta: desde el onset real del estímulo hasta el onset del siguiente (2000 ms nominales).
- **Clasificación** (semántica revisada, hallazgo #6):
  - Una respuesta con offset `< 200 ms` desde el onset real es **anticipatoria**. Es un contador aparte por trial (`anticipatoryCount`) y **no consume la ventana**: el trial sigue esperando una respuesta válida después de ella.
  - La **primera respuesta válida** (`>= 200 ms`) del trial decide la clasificación final: objetivo → acierto (se registra RT relativo al `actualOnset`); no-objetivo → comisión.
  - Un objetivo que llega al cierre de su ventana **sin ninguna respuesta válida** es **siempre** omisión, haya habido o no respuestas anticipatorias antes. Invariante garantizada: `hits + omissions === targets` en toda sesión.
  - Un no-objetivo sin respuesta válida es rechazo correcto (`correctRejection`; no se persiste como métrica de sesión aparte, pero cuenta para `nonTargets`).
  - Respuestas múltiples válidas en una ventana: solo cuenta la primera; las siguientes se ignoran.

## Métricas por sesión

- Omisiones: n y % sobre objetivos (atención).
- Comisiones: n y % sobre no-objetivos (impulsividad).
- RT medio, desviación típica (muestral) y coeficiente de variación (solo aciertos). **Con 0 aciertos, los tres son `null`** (no 0: la media/SD de un conjunto vacío no está definida). **Con 1 acierto, `rtMean` es el valor único pero `rtSd`/`rtCv` son `null`** (SD muestral indefinida con n=1). La UI muestra "—" para `null`; el histórico y los promedios comparativos **excluyen** las sesiones con valor `null` en vez de tratarlas como 0 (hallazgo #7).
- Respuestas anticipatorias: n (suma de `anticipatoryCount` de todos los trials; puede haber más de una por trial).
- Serie temporal de RT (para gráfico intra-sesión).
- **Métricas por bloque de 1 minuto** (hallazgo #16, antes solo mencionado en la spec y nunca implementado): la sesión se divide en bloques de 60000 ms de duración teórica (por índice de trial × 2000 ms, no por tiempo real), y para cada bloque se calculan RT mediana (o `null` si el bloque no tuvo aciertos), omisiones, comisiones y objetivos. Se muestran en la pantalla de Resultados como tabla; **los bloques sin aciertos se muestran explícitamente con RT mediana "—", nunca se ocultan de la tabla.**
- Calidad temporal de presentación de la sesión: `onsetDelayMedianMs`, `onsetDelayMaxMs` (mediana y máximo del retraso `actualOnset - plannedOnset` entre todos los trials).

## Actividad motora (webcam)

- MediaPipe Face Landmarker (paquete `@mediapipe/tasks-vision` por CDN, modelo desde el CDN oficial de MediaPipe), en modo VIDEO a ~15 fps durante el test.
- Punto de seguimiento: punta de la nariz (landmark 1). Normalización: se **centra primero respecto al punto medio de los ojos** (landmarks de ojos) y **después** se divide por la distancia interocular (hallazgo #8) — así la métrica es invariante tanto a la posición como a la distancia a la cámara. Dividir directamente sin centrar antes generaba movimiento aparente al acercarse/alejarse de la cámara con la cabeza quieta.
- Pérdida temporal de cara (hallazgo #9): si el hueco temporal entre dos muestras consecutivas supera 2 periodos de muestreo (~133 ms a 15 fps), la traza se **corta** en ese punto — no se suma la distancia ni la duración de ese segmento a las métricas, para no contabilizar un salto de posición (cara reenganchada en otro sitio) como movimiento real.
- Métricas:
  - Distancia total recorrida (en unidades de anchura de cara), sumando solo segmentos no cortados.
  - % de tiempo en movimiento (velocidad por encima de umbral fijo documentado en el código), **ponderado por duración válida** de cada segmento (no por número de intervalos), para que un segmento largo cortado no distorsione el porcentaje.
  - Área de movimiento (bounding box de las posiciones).
  - **% de cobertura facial** (`coveragePct`, hallazgo #9): proporción de intentos de detección que sí encontraron cara, sobre el total de intentos durante la sesión.
- Traza de posiciones para el gráfico (submuestreada; máximo ~2000 puntos guardados).
- Fallos consecutivos de detección (hallazgo #10): si `detectForVideo()` falla 5 veces seguidas, la actividad motora se **desactiva** para el resto de la sesión (o de la preview), se avisa en la UI ("seguimiento de cara desactivado (fallos repetidos)") y se deja de invocar el detector. El test sigue funcionando igual, sin esa métrica.
- Si el usuario deniega la cámara o falla la carga de MediaPipe: el test corre igual, sin métricas de actividad, con aviso visible antes de empezar.
- El vídeo se procesa en local; nunca se guarda ni se transmite.
- Ciclo de vida de la cámara (hallazgos #11, #12):
  - El stream de cámara se detiene al salir de la pantalla de Inicio, **salvo** en la transición inmediata a la prueba (que la sigue necesitando).
  - Una petición `getUserMedia()` pendiente lleva un token de cancelación: si resuelve cuando ya no hace falta (se navegó fuera de Inicio/Test mientras el permiso estaba pendiente), sus tracks se detienen de inmediato en vez de asignarse a la sesión de vídeo.

## Pantallas

1. **Inicio**: selector de duración, vista previa de cámara con indicador de "cara detectada", instrucciones breves de la tarea (con ejemplo visual de objetivo/no-objetivo), aviso de no-diagnóstico, botón empezar (cuenta atrás 3 s). El botón "Empezar" se deshabilita en el primer clic para evitar runtimes concurrentes por doble inicio (hallazgo #17); la cuenta atrás se cancela (botón vuelve a habilitarse) si se navega fuera de Inicio mientras está en marcha.
2. **Test**: pantalla completa oscura, estímulo centrado, sin feedback durante la prueba, sin reloj visible. Tecla Esc aborta (sesión descartada). Ver "Validez de sesión" para los abort automáticos por pérdida de foco/suspensión/salto de frame.
3. **Resultados**: tarjetas de métricas (con "—" para RT medio/SD/CV cuando son `null`), gráfico RT a lo largo de la sesión, tabla de deriva por bloques de 1 min, traza 2D del movimiento de cabeza, comparación con la media del histórico de la misma duración (excluyendo `null`).
4. **Histórico**: selector de duración (5/10/20 min) que filtra **tanto la tabla como los tres gráficos de evolución** (hallazgo #15: antes mezclaban sesiones de duraciones distintas en una sola serie), exportar JSON, borrar sesión / borrar todo. Toda escritura (borrar sesión, borrar todo, guardar sesión nueva) informa de éxito o error en la UI mediante un aviso flotante, incluyendo `QuotaExceededError` cuando `localStorage` está lleno (hallazgo #13/#14).

Gráficos dibujados con `<canvas>`, sin librerías.

## Persistencia (hallazgos #13/#14 — validación de esquema; schemaVersion 2)

- Clave `qbcheck.sessions`: array de objetos de sesión.
- **Objeto de sesión, schemaVersion 2**:
  ```
  {
    schemaVersion: 2,
    id, dateISO, durationMin,
    stimuli, targets, omissions, commissions, anticipatory,
    rtMean, rtSd, rtCv,        // number | null (hallazgo #7)
    rtSeries,
    activity: { pathLength, movingPct, area, trace, coveragePct } | null,
    onsetDelayMedianMs, onsetDelayMaxMs,   // number | null (hallazgo #2)
    trials: [                              // array por-trial, auditabilidad
      { plannedOnset, actualOnset, type: 'objetivo'|'no-objetivo', classification, rt, inputMethod: 'keyboard'|'pointer'|null }
      ...
    ] | null   // null en sesiones migradas desde v1 sin datos por trial
  }
  ```
- **Migración v1 → v2**: al leer el histórico, cualquier entrada sin `schemaVersion` se trata como v1 y se migra en memoria a v2 rellenando los campos nuevos (`trials`, `onsetDelayMedianMs`, `onsetDelayMaxMs`) con `null`. No se recalculan retroactivamente: los datos por-trial simplemente no existen para sesiones anteriores a esta versión (la tabla de bloques en Resultados y cualquier vista que dependa de `trials` lo indica explícitamente en vez de fallar).
- **Validación de esquema al cargar** (hallazgos #13/#14): cada entrada del array se valida (`logic.js#isValidSessionShape`). Las entradas que no cumplen la forma mínima **se aíslan sin descartarlas**: se copian a la clave de respaldo `qbcheck.sessions.corrupt` (con timestamp) y se excluyen de la lista de sesiones válidas devuelta a la UI, que además avisa cuántas entradas se aislaron. Si el JSON completo de `qbcheck.sessions` no parsea (corrupción total), el string original se copia íntegro a `qbcheck.sessions.corrupt` **antes** de que cualquier escritura posterior pueda sobrescribirlo, y se trata como histórico vacío a partir de ahí (con aviso).
- Exportación: descarga de JSON con todas las sesiones válidas del histórico (todas las duraciones), independientemente del filtro de duración activo en la vista de Histórico.

## Pruebas / verificación

- Carga en Chrome sin errores de consola.
- Sesión de humo corta: secuencia respeta 25% de objetivos, respuestas se clasifican bien (acierto, omisión, comisión, anticipatoria), métricas coherentes, `hits + omissions === targets`.
- Denegación de cámara: el test funciona sin actividad motora.
- `node --test test/logic.test.mjs`: cubre generación de secuencia, atribución de respuesta por tiempo (fronteras exactas 199.999/200/1999.999/2000 ms), clasificación final de trial y semántica anticipatoria/omisión, métricas de sesión con valores `null`, mediana, estadísticas de retraso de onset, métricas por bloque de 1 min, submuestreo de traza con corte por hueco temporal, y validación/migración de esquema de sesión.

### Solo verificable en navegador real (no cubierto por `node --test`)

- Abort real por `visibilitychange`/`blur`/salto de `requestAnimationFrame` durante una sesión en curso.
- Duración efectiva de presentación del estímulo (100 ms) bajo carga real del hilo principal.
- Ciclo de vida real de la cámara (parada de tracks al navegar, cancelación de `getUserMedia` pendiente).
- Fallos continuos reales de MediaPipe y la desactivación tras 5 errores consecutivos.
- `QuotaExceededError` real de `localStorage` y su aviso en UI.
- Doble clic real en "Empezar" y cancelación de cuenta atrás al navegar fuera de Inicio.
