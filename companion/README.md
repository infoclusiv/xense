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

La ruta ChatGPT OAuth directo con el SDK oficial Sign in with ChatGPT será una etapa posterior, independiente de este adaptador Codex CLI.
