# Xense

Extensión de Chrome/Edge que recolecta los posts de una **lista de X (Twitter)** dentro de un **rango de fechas** y los exporta para analizarlos después con una IA, una hoja de cálculo o tus propias herramientas.

La fecha de cada post se toma de los datos reales que carga x.com, no del texto relativo de la interfaz («hace 2 h»). Las expresiones como «ayer» se interpretan en tu zona horaria local y se convierten a UTC para delimitar la búsqueda.

> Herramienta de uso personal, sin servidor propio. Todos los datos se guardan en tu navegador.

---

## Funciones

- Selección de una lista de X (descubierta automáticamente o añadida por URL).
- Fechas en lenguaje natural en español: `ayer`, `hoy`, `anteayer`, `esta semana`, `mes pasado`, `últimos 7 días`, `1–10 nov 2026`, etc.
- Selector de calendario con fecha de inicio y fin.
- Recolección por ventanas diarias mediante la búsqueda de X (`list:<id> since:… until:…`), con fallback al timeline de la lista.
- Captura de respuestas GraphQL ya cargadas por x.com, con extracción desde el DOM como respaldo.
- **Seguimiento por lista** con punto de continuación seguro y recolección incremental de novedades.
- Pausar, reanudar y cancelar.
- Panel lateral para controlar la recolección y dashboard independiente para revisar resultados.
- Filtros por texto, tipo de post y presencia de media.
- Exportación a **JSON**, **CSV**, **Markdown** y **NDJSON**.
- **Digest para IA**: texto compacto con contexto, autores, fechas, métricas y enlaces, listo para pegar en un chat de IA.
- Almacenamiento local en IndexedDB, con borrado por recolección o global.

---

## Requisitos

- Chrome 116+ o Edge 116+ (Manifest V3).
- Una sesión iniciada en [x.com](https://x.com).
- Al menos una lista creada en X.

---

## Instalación desde el código fuente

```bash
npm install
npm run build
```

El resultado queda en `.output/chrome-mv3`.

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona la carpeta `.output/chrome-mv3`.
4. Fija Xense en la barra de herramientas. Al pulsar el icono se abre el panel lateral.

Para desarrollo con recarga automática:

```bash
npm run dev
```

Chrome abrirá un perfil de desarrollo con la extensión cargada.

---

## Uso

### 1. Elegir la lista

En el panel lateral, pestaña **Recolectar**:

- **Cargar mis listas**: abre `x.com/i/lists` y espera a que Xense lea tus listas. La página se recarga una vez para inyectar el lector.
- **Añadir por URL**: pega `https://x.com/i/lists/123456789` (o solo el ID numérico).

### 2. Indicar las fechas

Puedes escribir una expresión o usar el calendario.

| Ejemplo | Resultado |
| --- | --- |
| `ayer` | El día anterior completo, en tu zona horaria |
| `hoy` | Desde las 00:00 hasta ahora (parcial) |
| `anteayer` | Dos días antes |
| `ayer y hoy` | Desde el inicio de ayer hasta ahora |
| `esta semana` | Desde el lunes hasta ahora |
| `semana pasada` | Lunes a domingo de la semana anterior |
| `este mes` / `mes pasado` | Mes natural correspondiente |
| `últimos 7 días` | Ventana móvil de 7 días hasta ahora |
| `últimas 24 horas` | Ventana móvil de 24 horas |
| `12 nov 2026` | Ese día completo |
| `1–10 nov 2026` | Del 1 al 10 de noviembre de 2026 |
| `del 1 al 10 de noviembre de 2026` | Igual que el anterior |
| `noviembre 2026` | El mes completo |

La vista previa muestra el rango en tu zona horaria y los límites UTC exactos que se enviarán a X. El límite final es **exclusivo**.

### 3. Recolectar novedades desde el último análisis

Cada lista guarda su propio **punto de continuación**: el instante hasta el que la cobertura está confirmada. Cuando la lista ya tiene seguimiento, el panel abre por defecto el modo **Novedades**:

- La vista previa muestra «desde el último análisis → ahora» en tu zona horaria.
- El rango real se calcula en el background al iniciar, no cuando abriste el panel.
- No necesitas recordar la hora exacta ni buscar el último post a mano.

El punto de continuación **no es simplemente la hora del último post**. X devuelve los resultados del más nuevo al más viejo; si una recolección se corta a mitad de un tramo, continuar desde el último post guardado dejaría sin recoger la parte más antigua de ese tramo. Por eso:

- Si un tramo terminó completo, el cursor avanza hasta su final.
- Si un tramo quedó a medias (cancelación, límite de posts, error, rate limit o ventana omitida), el cursor se queda al inicio de ese tramo y la próxima recolección lo repite.
- Puede haber posts repetidos entre recolecciones tras un corte, pero no huecos. Los duplicados se pueden deduplicar por ID en la fase de análisis.

La tarjeta **Seguimiento** muestra el último análisis, el último post capturado (con enlace a X, autor, fecha y extracto) y la fecha exacta desde la que continuará. **Reiniciar seguimiento** borra solo el cursor y sus metadatos; las recolecciones y los posts guardados se conservan. El siguiente rango personalizado establece un nuevo punto de partida.

Eliminar una recolección del historial **no hace retroceder** el cursor. Si han pasado más de 180 días desde el último análisis, Xense pide dividir el periodo con un rango personalizado.

La pestaña **Historial** muestra una tarjeta por lista en seguimiento, permite filtrar las recolecciones por lista y ofrece un acceso directo **Recolectar novedades** que preselecciona la lista y el modo.

### 4. Iniciar la recolección

Configura las opciones si hace falta:

- **Modo automático** (recomendado): usa la búsqueda por fechas y, si no obtiene resultados, prueba el timeline de la lista.
- **Solo búsqueda**: más rápido y preciso para un día concreto.
- **Solo timeline**: recorre la lista desde el principio hasta llegar al rango. Útil como último recurso; puede ser lento en rangos largos.
- Incluir o excluir respuestas, reposts y citas.
- Máximo de posts.

Al empezar se abre una pestaña de X. **Mantén esa pestaña abierta** hasta que termine. Se recomienda no dejarla en segundo plano durante mucho tiempo: Chrome ralentiza los temporizadores de las pestañas ocultas.

Puedes pausar, reanudar o detener desde el panel. Los posts se guardan progresivamente.

### 5. Revisar y exportar

Al terminar, pulsa **Ver resultados** o **Abrir resultados**. El dashboard permite:

- Ver estadísticas y actividad por día.
- Buscar por texto, autor, hashtag o enlace.
- Filtrar por tipo de post o solo con media.
- Copiar el **digest para IA**.
- Descargar JSON, CSV (UTF-8 con BOM, compatible con Excel), Markdown o NDJSON.
- Eliminar la recolección.

Las exportaciones incluyen todos los posts de la recolección; los filtros del dashboard solo afectan a la vista.

---

## Cómo funciona

1. El panel inicia una «recolección» y guarda su configuración en IndexedDB.
2. El service worker crea una pestaña y la navega a la búsqueda de X para cada ventana diaria del rango:
   `https://x.com/search?q=list%3A<ID>%20since%3A<UTC>%20until%3A<UTC>&f=live`
3. Un content script en el mundo MAIN intercepta las respuestas GraphQL que x.com ya carga (búsqueda y timeline de listas) y las normaliza: autor, fecha real, texto, tipos, métricas, media, citas, reposts, hashtags, menciones y enlaces.
4. Otro content script filtra por la ventana temporal, deduplica, hace scroll con pausas aleatorias y envía los posts al service worker.
5. Si no se detectan respuestas GraphQL, se extraen los posts visibles del DOM.
6. El service worker valida de nuevo las fechas, guarda en IndexedDB y avanza a la siguiente ventana.
7. Al terminar, actualiza el seguimiento de la lista: avanza el cursor solo por los tramos completos y guarda el último post capturado.
8. Al terminar, el dashboard lee los datos locales y genera las exportaciones.

No se piden contraseñas ni se usan tokens propios: la extensión reutiliza la sesión que ya tienes abierta en x.com.

---

## Estructura del proyecto

```text
entrypoints/
  background.ts          # motor de recolección, estado, IndexedDB, mensajes
  x-main.content.ts      # hook de fetch/XHR en el mundo MAIN
  x.content.ts           # filtrado, scroll, DOM fallback, descubrimiento de listas
  sidepanel/             # panel de control (React)
  dashboard/             # dashboard de resultados (React)
lib/
  dates/parse.ts         # expresiones de fecha en español y conversión a UTC
  x/normalize.ts         # normalización de GraphQL de X
  x/urls.ts              # URLs de búsqueda y listas
  db.ts                  # IndexedDB con idb
  export/exporters.ts    # JSON, CSV, Markdown, NDJSON y digest
  runs.ts                # progreso, estadísticas y resúmenes
  tracking.ts            # cobertura, cursor y rango de continuación
  types.ts               # tipos compartidos
assets/styles.css        # estilos compartidos (claro/oscuro)
tests/                   # pruebas de fechas, normalización, URLs, exportadores y seguimiento
```

---

## Desarrollo

```bash
npm run dev       # WXT en modo desarrollo
npm run compile   # TypeScript sin emitir
npm test          # Vitest
npm run build     # build de producción
npm run zip       # empaqueta la extensión
```

---

## Límites y limitaciones conocidas

- **X puede cambiar su estructura interna** en cualquier momento. Si deja de recolectar, revisa el diagnóstico de la recolección y actualiza la extensión.
- La búsqueda de listas de X no garantiza cubrir el 100 % de los posts de un rango, especialmente en listas muy activas. El modo automático intenta complementarla con el timeline.
- El seguimiento garantiza **continuidad temporal**, no el 100 % absoluto de los posts: X puede omitir resultados en su propia búsqueda.
- Si cambias los filtros para incluir tipos de post que antes excluías (por ejemplo, respuestas), los posts antiguos de esos tipos pueden quedar fuera del seguimiento. Usa un rango personalizado para cubrirlos.
- El rango máximo es de **180 días** y el máximo por recolección es de **20 000 posts** (configurable hasta ese límite). Un periodo mayor desde el último análisis debe dividirse en varios rangos personalizados.
- La pestaña de recolección debe permanecer abierta. En segundo plano, Chrome puede espaciar los temporizadores.
- El timeline de la lista es secuencial: para rangos largos o listas muy activas puede tardar mucho y alcanzar el límite de scrolls.
- Los reposts se guardan como posts de tipo `repost`, conservando el autor original y el autor que reposteó.
- La extensión no analiza con IA por sí misma. El **digest para IA** está pensado para pegarse en otra herramienta (fase 2: análisis integrado).
- Si borras la extensión o sus datos, las recolecciones guardadas se pierden. Exporta lo que necesites conservar.

---

## Privacidad

- No hay backend ni telemetría.
- Los posts, listas, ajustes y el seguimiento por lista se guardan en IndexedDB y `chrome.storage.local` dentro del navegador.
- La extensión solo se ejecuta en `x.com` y `twitter.com`.
- Las exportaciones se generan localmente y se descargan como archivos.

---

## Aviso legal y uso responsable

Los Términos de Servicio de X restringen el acceso automatizado a su plataforma fuera de las interfaces publicadas. Xense funciona sobre la sesión y la interfaz normales de x.com, con pausas conservadoras, pero **puede entrar en conflicto con esos términos**. Úsala únicamente para análisis personal de listas a las que tengas acceso, no republiques datasets completos y asume el riesgo de limitaciones temporales o restricciones en tu cuenta.

No uses esta herramienta para acosar, vigilar personas, eludir límites de acceso ni redistribuir contenido masivamente.
