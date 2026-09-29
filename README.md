# Nugon SOS — PWA y backend Web Push

Backend mínimo y PWA de vinculación para recibir alertas emitidas por Nugon Android. No existe un sistema de cuentas y el servidor no guarda mensajes, coordenadas ni historial de alertas.

La instancia oficial utiliza un único origen:

- PWA: `https://nugon.prisma.com.py/`
- API: `https://nugon.prisma.com.py/api/v1`

## Arquitectura

```text
Android (deviceId + deviceSecret en Keystore)
    │ HTTPS + Bearer
    ▼
API Express ── lee vínculos ──▶ Web Push subscription
    │                                  │
    └─ descarta la alerta              ▼
                                PWA del familiar
```

El pairing usa un código Crockford Base32 aleatorio de 12 caracteres, válido durante 10 minutos, con cinco intentos y un solo uso. El código sólo se persiste como SHA-256.

## Requisitos

- Node.js 18 o superior.
- HTTPS en producción, normalmente terminado por un reverse proxy.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y un `RATE_LIMIT_SECRET` independiente, de al menos
  32 bytes, son obligatorios cuando `NODE_ENV=production`.
- En producción, `HOST` usa `127.0.0.1` por defecto para que Node sólo acepte conexiones locales.
  Puede definirse explícitamente; development/test conserva `0.0.0.0` cuando se omite.
- En producción se confía por defecto sólo en `loopback`, apropiado para Nginx en el mismo host.
  Si el proxy conecta desde otra red, `TRUST_PROXY` debe contener su IP/CIDR exacto. Los valores
  indiscriminados `1`, `true`, `*` y `all` son rechazados.
- Nginx debe establecer `X-Forwarded-Proto $scheme` y el puerto de Node no debe publicarse cuando
  pueda limitarse a loopback o a la red privada del proxy.

```bash
npm install
cp .env.example .env
npm start
```

Sólo con `NODE_ENV=development` o `NODE_ENV=test`, si no se configuran claves VAPID, se crea
`data/vapid-development.json` con permisos `0600`. En producción u otro entorno, la ausencia de
cualquiera de las dos claves detiene el arranque. El archivo está fuera de Git y el servidor no
utiliza el antiguo `data/vapid.json`.

## API v1

Disponible exclusivamente bajo `/api/v1` en el mismo origen que la PWA.

| Método | Ruta | Autenticación | Uso |
|---|---|---|---|
| `POST` | `/devices` | Ninguna; credencial en el body inicial | Registro idempotente de instalación |
| `PATCH` | `/devices/{deviceId}` | Bearer `deviceSecret` | Actualizar el alias visible del dispositivo |
| `POST` | `/devices/{deviceId}/pairings` | Bearer `deviceSecret` | Crear código temporal |
| `POST` | `/pairings/claim` | Código temporal | Vincular Web Push y emitir `linkSecret` |
| `POST` | `/devices/{deviceId}/alerts` | Bearer `deviceSecret` | Enviar alerta efímera |
| `GET` | `/devices/{deviceId}/links` | Bearer `deviceSecret` | Consultar vínculos y estado no secreto de códigos temporales |
| `DELETE` | `/devices/{deviceId}/links` | Bearer `deviceSecret` | Revocar todos los vínculos del dispositivo |
| `DELETE` | `/links/{linkId}` | Bearer `linkSecret` | Desvincular la PWA actual |
| `DELETE` | `/devices/{deviceId}` | Bearer `deviceSecret` | Eliminar dispositivo y vínculos |
| `GET` | `/vapid-public-key` | Ninguna | Obtener clave pública Web Push |

Los endpoints legacy `/alerts`, `/subscribers-count`, `/subscribe`, `/unsubscribe`, `/test-alert` y `/alerta` responden `404`.

## Persistencia

`data/state-v1.json`, con escritura serializada y reemplazo atómico, contiene exclusivamente:

- `deviceId`, hash SHA-256 de `deviceSecret`, `displayName` opcional y fechas técnicas;
- Web Push subscription, `linkId`, relación con `deviceId`, hash de `linkSecret` y fechas técnicas;
- hash temporal del código de pairing, expiración, intentos restantes y estado de uso/bloqueo.
- hash opaco de la clave de rate limit, contador y expiración.

El archivo se mantiene con permisos `0600`; si el directorio aún no existe, se crea como `0700`. Las
claves de rate limit se protegen con HMAC-SHA-256 antes de persistirse. En producción la clave HMAC
es un `RATE_LIMIT_SECRET` independiente; sólo en development/test puede usarse como fallback la
clave VAPID local. No se guardan IP ni identificadores en claro. En cada operación limitada se
purgan y persisten las entradas vencidas.

Nunca se persisten mensajes, coordenadas, URLs de Maps, números telefónicos, payloads de alerta ni datos de accesibilidad.
`displayName` es únicamente una etiqueta humana de hasta 40 caracteres: no participa en
autenticación, autorización, búsquedas de seguridad ni códigos de pairing.

## Migración desde Sender ID

No hay compatibilidad con el protocolo inseguro anterior. Las vinculaciones existentes deben realizarse nuevamente usando un código de pairing.

El origen anterior `https://prisma.com.py/nugon/` no se utiliza internamente. Como ambos sitios son
orígenes distintos, las Web Push subscriptions no pueden migrarse y deben volver a vincularse. El
administrador puede mantener únicamente una redirección HTTP desde la URL anterior al nuevo
subdominio para orientar a usuarios; esa redirección no migra permisos ni subscriptions Web Push.

Los archivos locales legacy `data/database.json` y `data/vapid.json` no se leen, migran ni eliminan automáticamente. Deben archivarse o eliminarse manualmente sólo después de verificar si contienen información que deba conservarse.

## Seguridad

- autenticación Bearer sobre HTTPS;
- secretos almacenados únicamente como hashes;
- comparación con `crypto.timingSafeEqual`;
- bodies limitados a 16 KiB y campos inesperados rechazados;
- validación estricta de tipos, mensaje y coordenadas;
- rate limiting en registro, pairing y operaciones autenticadas;
- CORS global deshabilitado porque PWA y API son del mismo origen;
- logs sin secretos, subscriptions, mensajes, coordenadas ni payloads.

## Tests

```bash
npm test
```

La suite cubre registro, idempotencia, autenticación, pairing expirado/usado/bloqueado, claim, alertas con y sin ubicación, validación de coordenadas, desvinculación, ausencia de endpoints legacy y ausencia de historial persistido.

## Despliegue oficial

El proceso Node sirve la PWA en `/` y la API en `/api/v1`. En el servidor deben configurarse los
tres secretos de producción, instalar dependencias y reiniciar el servicio:

```bash
npm ci --omit=dev
cp .env.example .env
chmod 600 .env
# completar HOST=127.0.0.1, PORT=3005, NODE_ENV=production,
# VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y RATE_LIMIT_SECRET
```

Nginx debe terminar TLS para `nugon.prisma.com.py`, enviar todo el subdominio al puerto local de
Node en `127.0.0.1:3005` y establecer `X-Forwarded-Proto $scheme`. Con Nginx en el mismo host se utiliza
`TRUST_PROXY=loopback`; para contenedores o redes separadas debe indicarse exclusivamente la IP o
CIDR del proxy. Después de editar su configuración, validar con `nginx -t` antes de recargarlo.
