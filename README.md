# Nugon SOS - PWA & Web Push Server 🚨

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)

**Nugon SOS (PWA)** es la plataforma web y servidor de notificaciones Web Push de código abierto diseñada para recibir alertas de emergencia inmediatas emitidas desde la aplicación móvil **Nugon SOS (Android)**.

El sistema fue creado pensando en personas con ventanas de tiempo extremadamente reducidas (3 a 4 segundos previa a una convulsión o pérdida de motricidad), permitiendo que la alerta emitida por presión sostenida de botones físicos en Android se propague por internet en milisegundos hacia los celulares de todos los familiares suscritos.

---

## 🌟 Características Clave

- **Recepción Instantánea en Paralelo:** Notificaciones push de alta prioridad con Web Push Protocol (VAPID).
- **Alerta Sonora y Vibración Intensa:** Reproducción de sirena de emergencia con Web Audio API y patrón de vibración acelerado `[500, 110, 500, 110, 500, 110, 500]`.
- **Enlace Directo a Google Maps:** Acceso en un toque a las coordenadas GPS exactas del emisor.
- **Soporte Multi-Emisor (Sender ID):** Permite filtrar y suscribir familiares a emisores específicos (ej: "Prima Maria").
- **Compatibilidad Universal:** Funciona en Android (Chrome, Edge, Brave) e iOS 16.4+ (Safari "Añadir a pantalla de inicio").
- **Soporte de Ruta Base `/nugon`:** Diseñado para coexistir bajo subdirectorios/rutas sin interferir con otros servicios bajo el mismo dominio (ej. `https://prisma.com.py/nugon/`).

---

## 🚀 Arquitectura del Sistema

```
[ Nugon SOS Android App ] 
         │ 
         │ HTTP POST /nugon/api/alerta
         ▼
[ Express Server (nugon-pwa) ] ──▶ (Almacenamiento persistente data/database.json)
         │
         │ Web Push VAPID Protocol
         ▼
[ Service Worker (sw.js) ] ──▶ Sirena Dual Tono + Vibración + Google Maps URL
```

---

## ⚙️ Requisitos

- **Node.js**: v18.0.0 o superior
- **npm**: v9.0.0 o superior

---

## 🛠️ Instalación y Configuración

### 1. Clonar e Instalar Dependencias

```bash
cd nugon-pwa
npm install
```

### 2. Variables de Entorno (`.env`)

Copia la plantilla `.env.example` a `.env`:

```bash
cp .env.example .env
```

Contenido por defecto recomendatorio:

```env
PORT=3005
BASE_PATH=/nugon
VAPID_SUBJECT=mailto:soporte@prisma.com.py
```

> **Nota:** Si `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` se dejan en blanco, el servidor generará automáticamente las llaves en el primer inicio y las guardará de forma segura en `data/vapid.json`.

### 3. Iniciar el Servidor

#### Modo Producción
```bash
npm start
```

#### Modo Desarrollo
```bash
npm run dev
```

---

## 🌐 Configuración con NGINX Reverse Proxy (ej. `prisma.com.py`)

Para montar esta PWA bajo `https://prisma.com.py/nugon/` sin interferir con tus otros servicios:

```nginx
location /nugon/ {
    proxy_pass http://127.0.0.1:3005/nugon/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

---

## 📡 Especificación de la API

### 1. Recibir Alerta (Llamado por App Android)
- **Ruta:** `POST /nugon/api/alerta` (o `/api/alerta`)
- **Headers:** `Content-Type: application/json`
- **Body JSON:**
```json
{
  "sender_id": "Prima Maria",
  "message": "¡ALERTA DE CONVULSION! https://maps.google.com/?q=-25.38,-57.12",
  "latitude": -25.38,
  "longitude": -57.12
}
```
- **Respuesta (200 OK):**
```json
{
  "success": true,
  "message": "Alerta procesada y notificaciones enviadas.",
  "notified_count": 2
}
```

### 2. Suscribir Familiar
- **Ruta:** `POST /nugon/api/subscribe`
- **Body JSON:**
```json
{
  "sender_id": "Prima Maria",
  "subscription": { ... Objeto WebPushSubscription ... }
}
```

### 3. Obtener Clave Pública VAPID
- **Ruta:** `GET /nugon/api/vapid-public-key`
- **Respuesta:** `{ "publicKey": "B..." }`

---

## 📲 Guía para Familiares

### En Android:
1. Abre `https://prisma.com.py/nugon/` en Chrome/Brave/Edge.
2. Ingresa el **Identificador de Emisor (Sender ID)** configurado en la app Android (ej. `Prima Maria`).
3. Toca **Activar Notificaciones en este Celular** y concede los permisos.

### En iPhone / iPad (iOS 16.4+):
1. Abre `https://prisma.com.py/nugon/` en **Safari**.
2. Toca el botón **Compartir** (icono cuadrado con flecha).
3. Selecciona **Agregar a la pantalla de inicio**.
4. Abre la app desde tu pantalla de inicio y presiona **Activar Notificaciones**.

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT**. Libre para ser utilizado, modificado y distribuido sin restricciones.
