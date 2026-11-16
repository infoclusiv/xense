# Xense

Extensión de Chrome/Edge que recolecta los posts de una **lista de X (Twitter)** dentro de un **rango de fechas** y los exporta para analizarlos después con una IA, una hoja de cálculo o tus propias herramientas.

La fecha de cada post se toma de los datos reales que carga x.com, no del texto relativo de la interfaz («hace 2 h»). Las expresiones como «ayer» se interpretan en tu zona horaria local y se convierten a UTC para delimitar la búsqueda.

> Herramienta de uso personal, sin servidor propio. Todos los datos se guardan en tu navegador.

---

## Funciones

- Selección de una lista de X (descubierta automáticamente o añadida por URL).
- Fechas en lenguaje natural en español: `ayer`, `hoy`, `anteayer`, `esta semana`, `mes pasado`, `últimos 7 días`, `1–10 nov 2026`, etc.
- Selector de calendario con fecha de inicio y fin.
- **Recorrido humano de la lista** para rangos recientes: abre `https://x.com/i/lists/<id>` y baja leyendo la fecha real de cada post hasta alcanzar el inicio del rango.
- **Búsqueda por días como respaldo**: si la lista no llega al inicio, solo se buscan los días pendientes más antiguos (`list:<id> since:… until:…`).
- **Humanización configurable**: pausas aleatorias, velocidad de scroll variable, pausas de lectura, movimiento del puntero y clics en zonas inertes.
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

- Con **Cargar mis listas**, Xense abre `x.com/i/lists`. Desplázate para cargar más listas si hace falta. La página se recarga una vez para inyectar el lector.
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
- Con el modo automático, las novedades se recogen recorriendo la lista como lo haría una persona. Si el recorrido no alcanza el inicio del rango, Xense busca por días solo el tramo antiguo que falte.

El punto de continuación **no es simplemente la hora del último post**. X devuelve los resultados del más nuevo al más viejo; si una recolección se corta a mitad de un tramo, continuar desde el último post guardado dejaría sin recoger la parte más antigua de ese tramo. Por eso:

- Si un tramo terminó completo, el cursor avanza hasta su final.
- Si un tramo quedó a medias (cancelación, límite de posts, error, rate limit o ventana omitida), el cursor se queda al inicio de ese tramo y la próxima recolección lo repite.
- En un recorrido de lista, los días que ya quedaron por debajo de la fecha confirmada se marcan cubiertos. Si el recorrido no alcanza el inicio, el cursor solo avanza por el tramo contiguo realmente cubierto.
- Puede haber posts repetidos entre recolecciones tras un corte, pero no huecos. Los duplicados se pueden deduplicar por ID en la fase de análisis.

La tarjeta **Seguimiento** muestra el último análisis, el último post capturado (con enlace a X, autor, fecha y extracto) y la fecha exacta desde la que continuará. **Reiniciar seguimiento** borra solo el cursor y sus metadatos; las recolecciones y los posts guardados se conservan. El siguiente rango personalizado establece un nuevo punto de partida.

Eliminar una recolección del historial **no hace retroceder** el cursor. Si han pasado más de 180 días desde el último análisis, Xense pide dividir el periodo con un rango personalizado.

La pestaña **Historial** muestra una tarjeta por lista en seguimiento, permite filtrar las recolecciones por lista y ofrece un acceso directo **Recolectar novedades** que preselecciona la lista y el modo.

### 4. Iniciar la recolección

Configura las opciones si hace falta:

- **Automático** (recomendado): si el rango es reciente (empieza en los últimos 30 días y termina como mucho 2 días antes de ahora), recorre la lista y, si no alcanza el inicio, busca solo los días pendientes más antiguos. Los demás rangos usan búsqueda por días.
- **Solo lista**: recorre el timeline de la lista y se detiene al confirmar la fecha de inicio. No usa búsqueda de respaldo; si no llega, la recolección queda parcial y el seguimiento no avanza.
- **Solo búsqueda**: ventanas diarias mediante `list:<id> since:… until:…`. Más preciso para un día concreto o para rangos antiguos.
- **Humanización**: `Desactivada`, `Ligera`, `Equilibrada` (predeterminada) o `Cuidadosa`.
- **Clics en zonas vacías**: activados por defecto; solo se hacen en áreas inertes y se desactivan con el desplazamiento manual.
- Con **Desplazamiento manual**, tú haces scroll en la pestaña de X y Xense guarda los posts que se cargan. La extensión abre la siguiente ventana de fechas cuando termina la actual.
- Incluir o excluir respuestas, reposts y citas.
- Máximo de posts.

Al empezar se abre una pestaña de X. **Mantén esa pestaña abierta** hasta que termine. Se recomienda no dejarla en segundo plano durante mucho tiempo: Chrome ralentiza los temporizadores de las pestañas ocultas. Si la pestaña queda oculta, Xense espera en lugar de consumir el tiempo de espera o el límite de scrolls.

Puedes detener la recolección desde el panel. Si el desplazamiento es automático, también puedes pausarlo y reanudarlo. Los posts se guardan progresivamente.

#### Humanización y navegación

Los niveles de humanización añaden variación al recorrido automático:

- Pausas aleatorias entre pasos y pausas de lectura más largas ocasionales.
- Avance de scroll variable: a veces pasos cortos, a veces más largos, con pequeños cambios de ritmo.
- Movimiento del puntero en varias etapas con una curva suave.
- Clics espaciados en zonas vacías, con un presupuesto limitado por recolección.

Los clics en zonas vacías son **fail-closed**: antes de hacer clic se comprueba el punto con `elementFromPoint` y `elementsFromPoint`. Se descartan enlaces, botones, formularios, posts, cabeceras, navegación, diálogos, selecciones de texto y cualquier elemento con cursor de puntero, posición fija o sticky. Si hay cualquier duda, no se hace clic. El evento se envía sobre `<body>`, nunca sobre el elemento validado, y no se ejecuta en desplazamiento manual.

La humanización reduce patrones obvios, pero **no garantiza evasión**: los eventos sintéticos tienen `isTrusted = false` y X puede detectarlos. No se usa `debugger` ni se añaden permisos adicionales.

### 5. Revisar y exportar

Al terminar, pulsa **Ver resultados** o **Abrir resultados**. El dashboard permite:

- Ver estadísticas y actividad por día.
- Buscar por texto, autor, hashtag o enlace.
- Filtrar por tipo de post o solo con media.
- Copiar el **digest para IA**.
- Generar una **infografía con IA** de las publicaciones de la recolección.
- Descargar JSON, CSV (UTF-8 con BOM, compatible con Excel), Markdown o NDJSON.
- Eliminar la recolección.

Las exportaciones incluyen todos los posts de la recolección; los filtros del dashboard solo afectan a la vista.

### 6. Generar una infografía

Configura el [puente local para IA](companion/README.md). En **Ver resultados → Analizar con IA**, elige el proveedor y el tipo de análisis, y pulsa **Generar infografía**. Xense procesa las publicaciones de esa recolección guardadas al iniciar el análisis, aunque tengas filtros de búsqueda activos. Deja el dashboard abierto si hay varios lotes en curso.

Con **ChatGPT (Codex CLI)**, Xense consulta los modelos al abrir los resultados y vuelve a consultar cada hora mientras el dashboard está visible. Puedes usar **Actualizar modelos** para consultar al momento. **Predeterminado del CLI** deja que Codex elija. Para recordar otro modelo en futuras recolecciones, selecciónalo y pulsa **Guardar como predeterminado**. Puedes volver a **Predeterminado del CLI** y pulsar **Restablecer al modelo del CLI**.

La infografía aparece en el dashboard con una conclusión principal, hallazgos enlazados a los posts originales y gráficos calculados a partir de la recolección. El resultado queda disponible en **Análisis guardados**. Con **Descargar HTML** puedes abrir el informe en un navegador sin conexión. Para guardar un PDF, abre ese archivo y elige **Imprimir → Guardar como PDF**.

---

## Cómo funciona

1. El panel inicia una «recolección» y guarda su configuración en IndexedDB.
2. El service worker elige la estrategia según el modo y la antigüedad del rango:
   - **Lista**: abre `https://x.com/i/lists/<ID>` y recorre el timeline desde lo más nuevo.
   - **Búsqueda**: abre una búsqueda por cada ventana diaria del rango:
     `https://x.com/search?q=list%3A<ID>%20since%3A<UTC>%20until%3A<UTC>&f=live`
3. En el recorrido de lista, el content script lee la fecha real de cada post, mantiene una cola de los últimos 24 posts únicos y confirma el inicio del rango cuando varias lecturas consecutivas lo superan con un margen de 30 a 120 minutos. Las ventanas diarias que ya quedaron atrás se marcan como cubiertas.
4. Si el recorrido termina antes de alcanzar el inicio (límite de scrolls, timeline agotado o error), se conservan los días recientes ya cubiertos. En modo automático se buscan solo las ventanas pendientes más antiguas; en modo solo lista la recolección queda parcial y el seguimiento no avanza.
5. Un content script en el mundo MAIN lee las respuestas a solicitudes GraphQL GET que X ya hace en búsquedas de listas y páginas de listas, y normaliza los resultados.
6. Otro content script filtra por el rango, deduplica y envía los posts al service worker. El desplazamiento puede ser automático o manual. Si X limita la carga, la recolección termina y conserva lo guardado.
7. Si no se detectan respuestas GraphQL, se extraen los posts visibles del DOM.
8. El service worker valida de nuevo las fechas, asigna cada post a su ventana diaria, guarda en IndexedDB y avanza a la siguiente ventana pendiente.
9. Al terminar, actualiza el seguimiento de la lista: avanza el cursor solo por los tramos completos y guarda el último post capturado.
10. Al terminar, el dashboard lee los datos locales y genera las exportaciones.

No se piden contraseñas ni se usan tokens propios: la extensión reutiliza la sesión que ya tienes abierta en x.com.

---

## Estructura del proyecto

```text
entrypoints/
  background.ts          # motor de recolección, estrategia, estado, IndexedDB, mensajes
  x-main.content.ts      # hook de fetch/XHR en el mundo MAIN
  x.content.ts           # filtrado, fechas, scroll humanizado, DOM fallback, listas
  sidepanel/             # panel de control (React)
  dashboard/             # dashboard de resultados (React)
lib/
  dates/parse.ts         # expresiones de fecha en español y conversión a UTC
  x/normalize.ts         # normalización de GraphQL de X
  x/strategy.ts          # elección lista/búsqueda, ventanas diarias y cobertura
  x/humanize.ts          # perfiles de humanización y planificación de gestos
  x/urls.ts              # URLs de búsqueda y listas
  db.ts                  # IndexedDB con idb
  export/exporters.ts    # JSON, CSV, Markdown, NDJSON y digest
  runs.ts                # progreso, estadísticas y resúmenes
  tracking.ts            # cobertura, cursor y rango de continuación
  types.ts               # tipos compartidos
assets/styles.css        # estilos compartidos (claro/oscuro)
tests/                   # fechas, normalización, URLs, exportadores, estrategia, humanización y seguimiento
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
- Ni la búsqueda de listas ni el recorrido del timeline de X garantizan cubrir el 100 % de los posts de un rango, especialmente en listas muy activas.
- El recorrido de lista es secuencial, de lo más nuevo a lo más antiguo. Para rangos largos o listas muy activas puede tardar mucho y alcanzar el límite de scrolls. En modo automático se buscan entonces los días pendientes; en modo solo lista la recolección queda parcial.
- El modo automático usa el recorrido de lista cuando el rango es reciente: empieza en los últimos **30 días** y termina como mucho **2 días** antes de ahora. Los demás rangos usan búsqueda por días.
- La humanización no garantiza pasar desapercibido: los eventos sintéticos tienen `isTrusted = false` y X puede detectarlos. Las pausas y los clics inertes reducen patrones, no los eliminan.
- El seguimiento garantiza **continuidad temporal**, no el 100 % absoluto de los posts: X puede omitir resultados en su propia búsqueda o timeline.
- Si cambias los filtros para incluir tipos de post que antes excluías (por ejemplo, respuestas), los posts antiguos de esos tipos pueden quedar fuera del seguimiento. Usa un rango personalizado para cubrirlos.
- El rango máximo es de **180 días** y el máximo por recolección es de **20 000 posts** (configurable hasta ese límite). Un periodo mayor desde el último análisis debe dividirse en varios rangos personalizados.
- La pestaña de recolección debe permanecer abierta. En segundo plano, Chrome puede espaciar los temporizadores; Xense espera sin consumir el límite de scrolls.
- Los reposts se guardan como posts de tipo `repost`, conservando el autor original y el autor que reposteó.
- El análisis integrado requiere el puente local y una sesión activa en Codex CLI u OpenCode CLI. Las recolecciones grandes requieren más consultas y pueden tardar más o alcanzar la cuota del proveedor.
- Si borras la extensión o sus datos, las recolecciones guardadas se pierden. Exporta lo que necesites conservar.

---

## Privacidad

- No hay backend ni telemetría.
- Los posts, listas, ajustes y el seguimiento por lista se guardan en IndexedDB y `chrome.storage.local` dentro del navegador.
- La extensión solo se ejecuta en `x.com` y `twitter.com`.
- Las exportaciones se generan localmente y se descargan como archivos.
- Al generar una infografía, los textos de los posts se envían al proveedor de IA seleccionado.

---

## Aviso legal y uso responsable

Los Términos de Servicio de X restringen el acceso automatizado a su plataforma fuera de las interfaces publicadas. Xense funciona sobre la sesión y la interfaz normales de x.com, con pausas conservadoras, pero **puede entrar en conflicto con esos términos**. Úsala únicamente para análisis personal de listas a las que tengas acceso, no republiques datasets completos y asume el riesgo de limitaciones temporales o restricciones en tu cuenta.

No uses esta herramienta para acosar, vigilar personas, eludir límites de acceso ni redistribuir contenido masivamente.
