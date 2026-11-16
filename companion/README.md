# Xense — Puente local para análisis con IA

Primera fase: la extensión se conecta a un proceso Node.js local mediante **Chrome Native Messaging**. El proceso usa las sesiones ya autorizadas de **Codex CLI** (ChatGPT) y **OpenCode CLI**. No copia tokens de ChatGPT y NO implementa todavía OAuth directo con Responses API.

## Instalación en Windows

1. Instala Node.js 22+ y al menos uno de los CLI. Inicia sesión en cada CLI usando sus instrucciones oficiales.
2. Compila Xense e instala la extensión desde chrome://extensions (cargar descomprimida).
3. Copia el ID de 32 letras de la extensión.
4. En PowerShell desde la raíz del repositorio ejecuta:

       .\companion\install-windows.ps1 -ExtensionId "ID_REAL_DE_LA_EXTENSION"

   Si PowerShell encuentra una versión antigua de Codex desde pnpm, selecciona exclusivamente para Xense la versión instalada con npm:

       $codexNuevo = Join-Path (npm prefix -g) "codex.cmd"
       & $codexNuevo --version
       .\companion\install-windows.ps1 -ExtensionId "ID_REAL_DE_LA_EXTENSION" -CodexPath $codexNuevo

   Este parámetro guarda la ruta explícita dentro del lanzador local de Xense. **No cambia el PATH del sistema ni actualiza o desinstala otras versiones de Codex.** Agrega -Edge si usas Edge. No requiere permisos de administrador: registra el host solo en HKCU.
5. Cierra y abre el dashboard y comprueba la conexión desde «Análisis con IA».

El botón de comprobación solo verifica si se puede invocar el CLI; no prueba si el usuario conserva sesiones activas o cuotas. El análisis real realiza la prueba completa.

El desplegable de ChatGPT consulta `model/list` en el servidor local del mismo Codex CLI que ejecuta los análisis. Codex puede devolver su propio catálogo en caché. Si falla la consulta, Xense conserva la última lista que recibió y mantiene disponible **Predeterminado del CLI**.

## Seguridad

Los prompts nunca se pasan como parámetros del shell: Codex los recibe mediante stdin y OpenCode lee un archivo temporal. Los CLI se ejecutan en carpetas temporales; Codex usa sandbox read-only y la configuración de OpenCode deniega herramientas. Los datos temporales se borran al finalizar. No se guardan tokens ni contraseñas en IndexedDB.

Los posts se envían al proveedor de IA elegido al pulsar **Generar infografía**. Xense procesa la recolección en lotes y consolida los hallazgos por etapas. Mantén abierto el dashboard mientras dure el análisis. El botón **Detener** interrumpe el proceso después de la consulta en curso.

El CLI devuelve los hallazgos en texto estructurado. Xense genera los gráficos con los datos guardados, muestra la infografía en el dashboard y la guarda por recolección en IndexedDB. Puedes descargarla como un HTML autónomo desde **Análisis guardados**.

## Contexto y adjuntos

- El modo de recuperación abre en segundo plano hasta 12 detalles de posts o Artículos de X por análisis. Si X indica un límite de carga, se suspenden las aperturas restantes. Con la opción desactivada se usa el contexto que ya está guardado.
- El puente lee hasta 12 páginas públicas HTML o de texto, sin cookies ni sesión del navegador. Los adjuntos del artículo se asocian con la sección, el pie de figura y el párrafo cercano cuando están disponibles. Los reproductores incrustados sin un archivo accesible se conservan como enlaces. Las páginas que requieren iniciar sesión, dependen de JavaScript para mostrar el texto o exceden el límite de descarga pueden quedar como vista previa o sin contenido.
- El puente intenta leer hasta 8 archivos multimedia por análisis. Prioriza posts con poco texto y reutiliza los recursos repetidos durante el mismo análisis. Las imágenes se procesan con el modelo seleccionado si admite visión.
- Para videos y GIF, instala FFmpeg con FFprobe y déjalos en el PATH del navegador, o configura `XENSE_FFMPEG_PATH` y `XENSE_FFPROBE_PATH` con sus rutas. El puente combina fotogramas a intervalos con cambios de escena. Analiza un ciclo de los GIF y hasta dos minutos de los videos descargables. Si el modelo pide ampliar un momento, el puente extrae hasta tres fotogramas adicionales de ese tramo. El informe conserva las observaciones por segundo, los subtítulos disponibles y el alcance de la muestra.

## Transcripción local y YouTube

- **WhisperX.** Xense busca `whisperx.exe` en el PATH que ve el navegador. Si WhisperX vive en un entorno de Python, registra el puente pasando `-WhisperXPath` o `-WhisperXPython` al instalador. Conserva tu opción `-CodexPath` si usas una ruta personalizada. También puedes definir `XENSE_WHISPERX_PATH` o `XENSE_WHISPERX_PYTHON` y reiniciar el navegador.

      .\companion\install-windows.ps1 -ExtensionId "ID_REAL_DE_LA_EXTENSION" -WhisperXPath "C:\ruta\al\entorno\Scripts\whisperx.exe"

- El valor predeterminado es `small` en CPU con `int8`. Configura `XENSE_WHISPERX_MODEL` para usar otro modelo y `XENSE_WHISPERX_DEVICE=cuda` si el entorno local ya admite CUDA. WhisperX puede descargar los modelos al primer uso. `XENSE_WHISPER_PATH` y `XENSE_WHISPER_MODEL` permiten usar una instalación existente de [whisper.cpp](https://github.com/ggml-org/whisper.cpp) como respaldo.
- **Videos de X y archivos accesibles.** FFprobe comprueba si hay una pista y Xense vuelve a intentar con la variante original cuando la ligera carece de audio. Xense transcribe todo el audio localmente en tramos de aproximadamente cinco minutos y conserva los tiempos originales del video. El muestreo visual cubre los primeros dos minutos. El proveedor de IA recibe extractos de texto con sus tiempos. Si falla un tramo, la infografía indica hasta dónde se procesó el audio.
- **YouTube.** Xense solicita únicamente subtítulos con `yt-dlp`, prioriza los publicados por el canal y usa subtítulos automáticos cuando están disponibles. Admite enlaces directos, Shorts y videos incrustados. `XENSE_YTDLP_PATH` permite seleccionar un ejecutable instalado. Si YouTube limita la consulta o ya tienes un archivo exportado, usa **Importar subtítulos de YouTube** en el dashboard. Para audio de YouTube que tengas autorizado localmente, puedes producir el SRT con WhisperX e importarlo de la misma forma.
- **Comprobar conexión** indica si el puente encuentra WhisperX y `yt-dlp`. Las transcripciones recuperadas se reutilizan dentro de la misma recolección. Xense vuelve a intentar las transcripciones locales parciales cuando recuperas el contexto de nuevo. Al eliminar la recolección se borran sus transcripciones guardadas.

La ruta ChatGPT OAuth directo con el SDK oficial Sign in with ChatGPT será una etapa posterior, independiente de este adaptador Codex CLI.
