# QbCheck web — especificación de diseño (2026-08-16)

Test de atención tipo CPT (continuous performance task) inspirado en QbCheck, para uso personal en navegador. No es un instrumento diagnóstico; incluye aviso permanente al respecto.

## Alcance

- Un solo archivo `index.html` autocontenido (HTML + CSS + JS vanilla). Única dependencia externa: MediaPipe Tasks Vision por CDN.
- Sin backend. Histórico en `localStorage`. Debe funcionar abriendo el archivo con `file://` en Chrome.
- UI en español.

## Paradigma del test

- Estímulos: círculo o cuadrado, gris o rojo → 4 combinaciones equiprobables en apariencia.
- Cadencia: un estímulo cada 2000 ms (onset a onset), visible 100 ms, fondo oscuro neutro con punto de fijación entre estímulos.
- Tarea 1-back: el usuario responde (barra espaciadora o clic/tap en cualquier parte) cuando el estímulo actual coincide con el anterior en forma Y color.
- Tasa de objetivos: 25% (generación de secuencia controlada, no puramente aleatoria). El primer estímulo nunca es objetivo.
- Duración seleccionable al inicio: 5 / 10 / 20 min (150 / 300 / 600 estímulos).

## Registro de respuestas

- Temporización con `performance.now()`; bucle con `requestAnimationFrame` para presentación y un scheduler tolerante a drift (los onsets se calculan desde el inicio de sesión, no acumulando timeouts).
- Ventana de respuesta: desde el onset del estímulo hasta el onset del siguiente (2000 ms).
- Clasificación:
  - Objetivo + respuesta en ventana (≥200 ms) → acierto, se registra RT.
  - Objetivo sin respuesta → omisión.
  - No-objetivo + respuesta → comisión.
  - Respuesta <200 ms tras onset → anticipatoria (no cuenta como acierto; contador aparte).
  - Respuestas múltiples en una ventana: solo cuenta la primera.

## Métricas por sesión

- Omisiones: n y % sobre objetivos (atención).
- Comisiones: n y % sobre no-objetivos (impulsividad).
- RT medio, desviación típica y coeficiente de variación (solo aciertos).
- Respuestas anticipatorias: n.
- Serie temporal de RT (para gráfico intra-sesión y detección de deriva por bloques de 1 min).

## Actividad motora (webcam)

- MediaPipe Face Landmarker (paquete `@mediapipe/tasks-vision` por CDN, modelo desde el CDN oficial de MediaPipe), en modo VIDEO a ~15 fps durante el test.
- Punto de seguimiento: punta de la nariz (landmark 1). Normalización por distancia interocular (landmarks de ojos) para que la métrica sea invariante a la distancia a la cámara.
- Métricas:
  - Distancia total recorrida (en unidades de anchura de cara).
  - % de tiempo en movimiento (velocidad por encima de umbral fijo documentado en el código).
  - Área de movimiento (bounding box de las posiciones).
- Traza de posiciones para el gráfico (submuestreada; máximo ~2000 puntos guardados).
- Si el usuario deniega la cámara o falla la carga de MediaPipe: el test corre igual, sin métricas de actividad, con aviso visible antes de empezar.
- El vídeo se procesa en local; nunca se guarda ni se transmite.

## Pantallas

1. **Inicio**: selector de duración, vista previa de cámara con indicador de "cara detectada", instrucciones breves de la tarea (con ejemplo visual de objetivo/no-objetivo), aviso de no-diagnóstico, botón empezar (cuenta atrás 3 s).
2. **Test**: pantalla completa oscura, estímulo centrado, sin feedback durante la prueba, sin reloj visible. Tecla Esc aborta (sesión descartada).
3. **Resultados**: tarjetas de métricas, gráfico RT a lo largo de la sesión, traza 2D del movimiento de cabeza, comparación con la media del histórico de la misma duración.
4. **Histórico**: tabla de sesiones por duración, gráfico de evolución de métricas clave entre sesiones, exportar JSON, borrar sesión / borrar todo.

Gráficos dibujados con `<canvas>`, sin librerías.

## Persistencia

- Clave `qbcheck.sessions`: array de objetos `{ id, dateISO, durationMin, stimuli, targets, omissions, commissions, anticipatory, rtMean, rtSd, rtCv, rtSeries, activity: { pathLength, movingPct, area, trace } | null }`.
- Exportación: descarga de JSON con todas las sesiones.

## Pruebas / verificación

- Carga en Chrome sin errores de consola.
- Sesión de humo corta: secuencia respeta 25% de objetivos, respuestas se clasifican bien (acierto, omisión, comisión, anticipatoria), métricas coherentes.
- Denegación de cámara: el test funciona sin actividad motora.
