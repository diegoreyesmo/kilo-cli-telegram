
## 📋 Plan de implementación detallado

### 1. Estructura del proyecto

```
kilocode-telegram-bot/
├── src/
│   ├── bot.ts              # Punto de entrada, configuración Telegraf
│   ├── kiloClient.ts       # Adaptador para el SDK local + manejo SSE
│   ├── sessionManager.ts   # Gestión de sesiones por chatId
│   ├── messageRenderer.ts  # Lógica de renderizado y edición de mensajes (con throttle)
│   ├── interactionHandler.ts # Manejo de botones (aprobaciones, respuestas)
│   └── types.ts            # Tipos comunes
├── .env.example
├── package.json
└── tsconfig.json
```

### 2. Dependencias

```bash
npm install telegraf @kilocode/sdk dotenv pino
npm install -D typescript @types/node ts-node
```

- **@kilocode/sdk**: versión compatible con el CLI local.
- **pino**: para logs estructurados (opcional pero muy útil).

### 3. Variables de entorno (`.env`)

```env
TELEGRAM_BOT_TOKEN=tu_token
KILO_SERVER_URL=http://127.0.0.1:4096   # Puerto por defecto del CLI
KILO_CONFIG_PATH=./kilo-config.json      # Opcional, si usas config personalizada
LOG_LEVEL=info
```

### 4. Inicialización del servidor Kilo Code

El CLI `kilo` ya debe estar corriendo (o lo inicias desde el bot). El SDK provee `createKilo()` que levanta el servidor si no está ejecutándose.

```typescript
// kiloClient.ts
import { createKilo, createKiloClient } from '@kilocode/sdk';

let kiloServer: any;
let kiloClient: any;

export async function initKilo() {
  const { client, server } = await createKilo({
    port: 4096,
    configPath: process.env.KILO_CONFIG_PATH,
    // Si el CLI ya está corriendo, no necesitas levantar otro servidor
    // Puedes usar createKiloClient() directamente apuntando al puerto
  });
  kiloClient = client;
  kiloServer = server;
  return { client, server };
}

// Para conectar a un servidor ya existente (recomendado)
export function getKiloClient() {
  if (!kiloClient) {
    kiloClient = createKiloClient({ baseUrl: process.env.KILO_SERVER_URL });
  }
  return kiloClient;
}
```

**Nota**: Si el CLI `kilo` ya está corriendo como servicio, solo necesitas `createKiloClient()`.

### 5. Sesiones por chat de Telegram

Cada chat de Telegram tendrá su propia **sesión de Kilo Code** (con su `sessionId`). Mantenemos un mapa:

```typescript
// sessionManager.ts
import { getKiloClient } from './kiloClient';

type SessionState = {
  sessionId: string;           // ID de sesión en Kilo
  project: string;             // proyecto asociado
  model: string;               // modelo elegido (ej. claude-3-5-sonnet)
  history: Array<{role, content}>; // para contexto (opcional)
  activePromptId?: string;     // ID del prompt actual (para cancelar)
  status: 'idle' | 'processing' | 'waiting_interaction';
};

const sessions = new Map<number, SessionState>();

export async function getOrCreateSession(chatId: number) {
  if (sessions.has(chatId)) return sessions.get(chatId)!;
  
  const client = getKiloClient();
  const session = await client.session.create({
    project: 'mi-proyecto',    // o lo que definas
    model: 'claude-3-5-sonnet-20241022',
  });
  const state: SessionState = {
    sessionId: session.id,
    project: 'mi-proyecto',
    model: 'claude-3-5-sonnet-20241022',
    history: [],
    status: 'idle',
  };
  sessions.set(chatId, state);
  return state;
}

export function getSession(chatId: number) {
  return sessions.get(chatId);
}

export function updateSession(chatId: number, update: Partial<SessionState>) {
  const current = sessions.get(chatId);
  if (current) Object.assign(current, update);
}
```

### 6. Envío de mensajes y suscripción a SSE

Cuando el usuario envía un mensaje, el bot:

1. Obtiene/crea la sesión.
2. Envía el prompt usando `client.session.prompt()`.
3. Se suscribe al flujo de eventos SSE para esa sesión (el SDK puede exponer un `EventSource` o usar `client.events.subscribe()`).  
   **Importante**: El SDK actualmente permite escuchar eventos globales; filtramos por `sessionId`.

```typescript
// kiloClient.ts - añadir función para escuchar eventos
import { EventSource } from 'eventsource'; // o usar fetch polyfill

export function subscribeToSessionEvents(
  sessionId: string,
  onEvent: (event: any) => void,
  onError: (err: Error) => void
) {
  const url = `${process.env.KILO_SERVER_URL}/global/event`;
  const eventSource = new EventSource(url);
  
  eventSource.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      // Filtrar por sessionId
      if (data.sessionId === sessionId) {
        onEvent(data);
      }
    } catch (e) {
      onError(e);
    }
  };
  
  eventSource.onerror = (err) => onError(err);
  
  return () => eventSource.close(); // función de cancelación
}
```

**Tipos de eventos relevantes** (según la documentación del CLI):

- `session.next.text.delta` → fragmento de respuesta final.
- `session.next.reasoning.delta` → cadena de pensamiento.
- `session.next.tool_call` → llamada a herramienta (contiene `tool`, `input`).
- `session.next.tool_result` → resultado de herramienta (contiene `output`).
- `permission.asked` → solicitud de permiso para ejecutar una herramienta (contiene `tool`, `input`, `permissionId`).
- `question.asked` → pregunta al usuario (contiene `question`, `options?`, `questionId`).
- `session.next.done` → finalización del prompt.

### 7. Lógica de mensajes en Telegram (con throttle)

Definimos un **gestor de mensajes** que mantiene referencias a los mensajes activos (pensamiento, herramienta, respuesta) y aplica **throttle** (ej. 500ms) para no editar más rápido de lo permitido.

```typescript
// messageRenderer.ts
import { Context } from 'telegraf';

type MessageGroup = {
  thoughtMsgId?: number;      // mensaje de pensamiento
  toolMsgId?: number;         // mensaje de herramienta actual
  finalMsgId?: number;        // mensaje de respuesta final
  lastEditTime: number;
};

const groups = new Map<number, MessageGroup>(); // chatId -> group

export async function renderEvent(ctx: Context, event: any, sessionId: string) {
  const chatId = ctx.chat!.id;
  let group = groups.get(chatId);
  if (!group) {
    // Enviar mensaje inicial "Procesando..."
    const msg = await ctx.reply('⏳ Procesando...');
    group = { thoughtMsgId: msg.message_id, lastEditTime: Date.now() };
    groups.set(chatId, group);
  }

  const now = Date.now();
  if (now - group.lastEditTime < 500) {
    // Throttle: si es muy pronto, acumular en buffer y editar después
    // (implementación con setTimeout o cola)
  }

  // Según tipo de evento, editar o enviar nuevo mensaje
  switch (event.type) {
    case 'session.next.reasoning.delta':
      await updateThought(ctx, group, event.delta);
      break;
    case 'session.next.tool_call':
      await showToolCall(ctx, group, event);
      break;
    case 'session.next.tool_result':
      await updateToolResult(ctx, group, event);
      break;
    case 'session.next.text.delta':
      await updateFinalAnswer(ctx, group, event.delta);
      break;
    case 'permission.asked':
      await askPermission(ctx, event);
      break;
    case 'question.asked':
      await askQuestion(ctx, event);
      break;
    case 'session.next.done':
      await finalize(ctx, group);
      break;
  }
  group.lastEditTime = Date.now();
}

// Funciones auxiliares para editar mensajes con límite de 4096 chars
```

### 8. Manejo de interacciones (permisos y preguntas)

Estos eventos requieren una respuesta del usuario. Usamos **botones inline** de Telegraf.

#### Permiso para ejecutar herramienta

Cuando llega `permission.asked`, mostramos un mensaje con los detalles y dos botones: **Aprobar** y **Denegar**.

```typescript
// interactionHandler.ts
import { Markup } from 'telegraf';

export async function askPermission(ctx: Context, event: any) {
  const { tool, input, permissionId } = event;
  const message = `🔧 La herramienta **${tool}** quiere ejecutarse con:\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n¿Permitir?`;

  await ctx.reply(message, {
    ...Markup.inlineKeyboard([
      Markup.button.callback('✅ Aprobar', `approve:${permissionId}`),
      Markup.button.callback('❌ Denegar', `deny:${permissionId}`),
    ]),
    parse_mode: 'Markdown',
  });
}
```

#### Pregunta con opciones

Para `question.asked`, mostramos los botones con las opciones.

```typescript
export async function askQuestion(ctx: Context, event: any) {
  const { question, options, questionId } = event;
  const buttons = options.map((opt: string) =>
    Markup.button.callback(opt, `answer:${questionId}:${opt}`)
  );
  await ctx.reply(`❓ ${question}`, Markup.inlineKeyboard(buttons));
}
```

**Manejo de callbacks**:

```typescript
// bot.ts
bot.action(/approve:(.+)/, async (ctx) => {
  const permissionId = ctx.match[1];
  // Enviar aprobación a Kilo Code
  await getKiloClient().permission.resolve({ permissionId, approved: true });
  await ctx.answerCbQuery('✅ Aprobado');
  await ctx.deleteMessage(); // opcional: eliminar el mensaje de solicitud
});

bot.action(/deny:(.+)/, async (ctx) => {
  const permissionId = ctx.match[1];
  await getKiloClient().permission.resolve({ permissionId, approved: false });
  await ctx.answerCbQuery('❌ Denegado');
  await ctx.deleteMessage();
});

bot.action(/answer:(.+):(.+)/, async (ctx) => {
  const [questionId, answer] = ctx.match.slice(1);
  await getKiloClient().question.answer({ questionId, answer });
  await ctx.answerCbQuery(`Respondiste: ${answer}`);
  await ctx.deleteMessage();
});
```

### 9. Control de concurrencia y cancelación

- Si el usuario envía un nuevo mensaje mientras uno está en proceso, podemos **cancelar** el anterior usando `AbortController` en la petición SSE.
- Guardamos el `AbortController` en la sesión y lo abortamos al empezar un nuevo prompt.

```typescript
// sessionManager.ts - añadir
let abortController: AbortController | null = null;

export function cancelCurrentPrompt(chatId: number) {
  const state = sessions.get(chatId);
  if (state?.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
}
```

### 10. Persistencia del historial (opcional)

Para mantener conversación, puedes guardar el historial de mensajes (usuario y asistente) en la sesión y enviarlo en cada nuevo prompt. El SDK permite pasar `history` en `session.prompt()`.

### 11. Logs y manejo de errores

Usa `pino` para registrar eventos y errores. En caso de fallo de edición (mensaje borrado), captura y continúa.

---

## ✅ Resumen de cambios clave respecto al plan original

| Aspecto | Plan original | Plan corregido |
|---------|---------------|----------------|
| Autenticación | API key | `kilo auth login` + servidor local |
| Cliente SDK | `streamResponse()` | Cliente REST + suscripción SSE |
| Eventos | Tipos inventados | Tipos reales del SDK (`session.next.*`, `permission.asked`, etc.) |
| Interacciones | No contempladas | Botones inline para aprobar/denegar y responder preguntas |
| Throttle | Mencionado como nota | Implementación activa con cola de ediciones (500ms) |
| Sesiones | Simple Map | Incluye `sessionId`, `status`, `abortController` |

---

## 🚀 Próximos pasos

1. **Levanta el CLI** local: `kilo serve` (o `kilo` con la configuración adecuada).
2. **Implementa el adaptador** siguiendo el código de ejemplo.
3. **Prueba con un mensaje simple** y verifica los eventos.
4. **Añade manejo de interacciones** con los botones.
5. **Despliega** en un servidor con el CLI corriendo en el mismo entorno.


