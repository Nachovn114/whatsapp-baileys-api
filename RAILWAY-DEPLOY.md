# 🚀 Deploy en Railway con PostgreSQL

## Paso 1: Agregar PostgreSQL en Railway

1. Ve a tu proyecto en Railway.app
2. Click en **"New"** → **"Database"** → **"Add PostgreSQL"**
3. Railway creará automáticamente la base de datos y la variable `DATABASE_URL`

## Paso 2: Vincular la Base de Datos

Railway automáticamente vinculará `DATABASE_URL` a tu servicio `whatsapp-baileys-api`.

## Paso 3: Redeploy

Railway detectará los cambios en GitHub y hará redeploy automáticamente.

## Paso 4: Obtener QR Code

Una vez que el deployment termine:

```
https://whatsapp-baileys-api-production.up.railway.app/qr
```

## ✅ Ventajas de PostgreSQL

- ✅ **Sesión persistente** - No se pierde al reiniciar
- ✅ **Escalable** - Funciona en múltiples instancias
- ✅ **Gratis** en Railway (500MB)
- ✅ **Automático** - postgres-baileys maneja todo

## 📱 Endpoints

- `GET /` - Estado del servidor
- `GET /qr` - Obtener QR Code
- `GET /status` - Estado de conexión
- `POST /send-message` - Enviar mensaje
- `POST /send-image` - Enviar imagen

## 🔧 Variables de Entorno

Railway configura automáticamente:

- `DATABASE_URL` - Conexión a PostgreSQL
- `PORT` - Puerto del servidor

No necesitas configurar nada manualmente.
