# 📱 Baileys WhatsApp API

API de WhatsApp usando Baileys para automatización de mensajes.

## 🚀 Deploy en Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

## 📋 Endpoints

### GET /

Estado del servidor

### GET /qr

Obtener QR Code para conectar WhatsApp

### GET /status

Estado de la conexión

### POST /send-message

Enviar mensaje de texto

```json
{
  "phone": "56912345678",
  "message": "Hola desde Baileys!"
}
```

### POST /send-image

Enviar imagen

```json
{
  "phone": "56912345678",
  "imageUrl": "https://example.com/image.jpg",
  "caption": "Mira esta imagen"
}
```

## 🔧 Variables de Entorno

No requiere variables de entorno. Todo funciona out-of-the-box.

## 📱 Conectar WhatsApp

1. Accede a `https://tu-app.railway.app/qr`
2. Escanea el QR Code con WhatsApp
3. ¡Listo! Ya puedes enviar mensajes

## 🛠️ Desarrollo Local

```bash
npm install
npm start
```

## 📝 Licencia

MIT
