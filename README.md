# kilo-cli-telegram

Bot de Telegram que actúa como frontend interactivo para [Kilo Code](https://kilocode.ai). Recibe mensajes del usuario, los envía al servidor local de Kilo Code y retransmite en **tiempo real** vía SSE:

- La **cadena de pensamiento** (razonamiento interno del modelo)
- Las **llamadas a herramientas** y sus resultados
- La **respuesta final** del asistente

También soporta flujos interactivos con **botones inline** para aprobar/denegar ejecución de herramientas y responder preguntas del modelo.

## Features

| Funcionalidad | Descripción |
|---|---|
| Streaming en tiempo real | Conexión SSE que transmite reasoning, tool calls, tool results y respuesta final sin esperar a que termine el prompt |
| Edición progresiva de mensajes | Los mensajes de Telegram se editan en vivo mientras el modelo genera — no necesitás esperar al final |
| Control de sesiones | Cada chat de Telegram mantiene su propia sesión de Kilo Code (`/start`, `/new`, `/stop`) |
| Aprobación de herramientas | Cuando Kilo Code necesita ejecutar una herramienta, el bot muestra un mensaje con botones Aprobar/Denegar |
| Preguntas interactivas | Si el modelo hace una pregunta, el bot renderiza opciones como botones inline |
| Throttle inteligente | Mínimo 500ms entre ediciones de mensaje para respetar los rate limits de Telegram |
| Truncado automático | Mensajes que exceden los 4096 caracteres de Telegram se truncan con indicador visual |
| Graceful shutdown | Cierra conexiones SSE y detiene el bot limpiamente en `SIGINT`/`SIGTERM` |

## Prerrequisitos

- **Node.js** ≥ 18
- **npm** ≥ 9
- Un bot de Telegram creado con [@BotFather](https://t.me/BotFather) (necesitás el token)
- **Kilo Code CLI** corriendo localmente en modo servidor (`kilo serve` o `kilo` con el puerto 4096 expuesto)

## Instalación

```bash
git clone <repo-url> kilo-cli-telegram
cd kilo-cli-telegram
npm install
```

## Configuración

Copiá el archivo de ejemplo y completalo con tus valores:

```bash
cp .env.example .env
```

Variables requeridas:

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Sí | — | Token del bot obtenido de @BotFather |
| `KILO_SERVER_URL` | No | `http://127.0.0.1:4096` | URL del servidor Kilo Code (REST + SSE) |
| `KILO_CONFIG_PATH` | No | — | Ruta a un archivo de configuración de Kilo Code |
| `LOG_LEVEL` | No | `info` | Nivel de log (trace, debug, info, warn, error, fatal) |

## Uso

### Desarrollo (con hot reload vía ts-node)

```bash
npm run dev
```

### Producción

```bash
npm run build   # compila TypeScript → dist/
npm start       # ejecuta dist/bot.js
```

### Comandos del bot en Telegram

| Comando | Descripción |
|---|---|
| `/start` | Crea o reutiliza una sesión de Kilo Code y muestra datos de la sesión |
| `/new` | Cancela el prompt actual y crea una sesión nueva desde cero |
| `/stop` | Cancela el prompt en ejecución sin destruir la sesión |
| Cualquier texto | Envía el mensaje como prompt a Kilo Code y muestra el streaming de respuesta |

### Flujo de una interacción típica

1. Abrís el chat con el bot y ejecutás `/start`
2. Escribís un mensaje (ej: _"Refactorizá el módulo de autenticación para usar JWT"_)
3. El bot muestra `⏳ Procesando…` y empieza a editar los mensajes en vivo:
   - **Mensaje de pensamiento**: se actualiza con cada `reasoning.delta` que emite el modelo
   - **Mensaje de herramienta**: aparece cuando el modelo invoca una herramienta (ej: leer archivos, ejecutar comandos)
   - **Mensaje de resultado**: muestra el output de la herramienta ejecutada
   - **Mensaje final**: se construye incrementalmente con cada `text.delta`
4. Si Kilo Code necesita aprobación para ejecutar una herramienta, el bot muestra botones **Aprobar** / **Denegar**
5. Si el modelo hace una pregunta con opciones, el bot muestra botones inline con cada opción
6. Cuando el prompt termina, los mensajes quedan con su contenido final

## Arquitectura

```
src/
├── bot.ts                 # Entry point — wiring de Telegraf, comandos, handlers
├── types.ts               # Tipos compartidos (SessionState, SSEEvent, MessageGroup)
├── kiloClient.ts          # Adaptador HTTP + SSE hacia el servidor Kilo Code
├── sessionManager.ts      # Gestión in-memory de sesiones por chatId
├── messageRenderer.ts     # Renderizado progresivo con throttle (500ms)
└── interactionHandler.ts  # Flujos de botones inline (permissions + questions)
```

### Stack tecnológico

- **[Telegraf](https://telegraf.js.org/)** — framework para la API de Telegram Bots
- **[EventSource](https://github.com/EventSource/eventsource)** — cliente SSE para el streaming de eventos
- **[Pino](https://getpino.io/)** — logging estructurado de alto rendimiento
- **[dotenv](https://github.com/motdotla/dotenv)** — carga de variables de entorno desde `.env`
- **TypeScript** — tipado estático con target ES2022 y módulos ESM

### Modos de conexión a Kilo Code

El adaptador `kiloClient.ts` soporta dos modos, resueltos en tiempo de ejecución:

1. **SDK mode**: si `@kilocode/sdk` está instalado, usa `createKilo()` para levantar el servidor y obtener el cliente
2. **Raw HTTP mode** (fallback): si el SDK no está disponible, construye un cliente HTTP contra la REST API de Kilo Code

El modo por defecto es HTTP contra `KILO_SERVER_URL`. Esto permite que el bot y el servidor Kilo Code corran en procesos separados.

### Ciclo de vida de una sesión

```
idle → processing → (waiting_interaction) → idle
```

- **idle**: sin prompt activo, listo para recibir mensajes
- **processing**: prompt en ejecución, recibiendo eventos SSE
- **waiting_interaction**: prompt pausado esperando que el usuario apruebe/deniegue una herramienta o responda una pregunta

## Limitaciones

- **Sin persistencia**: las sesiones viven en memoria. Si el bot se reinicia, se pierden todas las sesiones activas
- **Sin historial real**: aunque la estructura `history` existe en `SessionState`, actualmente no se acumula automáticamente — se envía vacío en cada prompt
- **Un solo prompt a la vez por chat**: si enviás un mensaje mientras otro está procesándose, el anterior se cancela automáticamente
- **Truncado a 4096 caracteres**: mensajes más largos que el límite de Telegram se cortan con `… (truncated)`

## Licencia

MIT
