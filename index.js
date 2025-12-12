import makeWASocket, { 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import cors from 'cors';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Estado global
let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let lastError = null;

// Logger
const logger = pino({ 
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: false }
  }
});

// Asegurar directorio de sesión
const AUTH_DIR = './auth_session';
try {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    logger.info('📁 Directorio creado:', AUTH_DIR);
  }
} catch (err) {
  logger.error('❌ Error creando directorio:', err.message);
}

// Inicializar WhatsApp
async function connectToWhatsApp() {
  try {
    logger.info('🔄 Iniciando conexión...');
    
    // 1. Obtener versión de Baileys
    logger.info('📦 Obteniendo versión de Baileys...');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`✅ Baileys v${version.join('.')}, isLatest: ${isLatest}`);

    // 2. Cargar auth state
    logger.info('📂 Cargando auth state...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    logger.info('✅ Auth state cargado');

    // 3. Crear socket
    logger.info('🔌 Creando socket...');
    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      browser: ['Esika Bot', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      getMessage: async () => undefined
    });
    
    logger.info('✅ Socket creado');

    // 4. Event: Connection update
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      logger.info(`📡 Connection: ${connection}, QR: ${!!qr}`);

      if (qr) {
        logger.info('📱 ¡QR Code generado!');
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          logger.info('✅ QR convertido a imagen');
        } catch (err) {
          logger.error('❌ Error QR:', err.message);
          lastError = `Error generando QR: ${err.message}`;
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.error || 'unknown';
        
        logger.warn(`❌ Cerrado - Code: ${statusCode}, Reason: ${reason}`);
        lastError = `Conexión cerrada: ${reason} (${statusCode})`;
        isConnected = false;
        qrCodeData = null;
        
        if (shouldReconnect && connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
          connectionAttempts++;
          logger.info(`🔄 Reintento ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
          setTimeout(() => connectToWhatsApp(), 5000);
        } else if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
          logger.error('❌ Máximo de reintentos');
          lastError = 'Máximo de reintentos alcanzado';
          connectionAttempts = 0;
        }
      } else if (connection === 'open') {
        logger.info('✅ ¡CONECTADO A WHATSAPP!');
        isConnected = true;
        qrCodeData = null;
        connectionAttempts = 0;
        lastError = null;
      } else if (connection === 'connecting') {
        logger.info('🔄 Conectando...');
      }
    });

    // 5. Event: Credentials update
    sock.ev.on('creds.update', saveCreds);

    // 6. Event: Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      const msg = messages[0];
      if (!msg.key.fromMe && msg.message) {
        logger.info(`📨 Mensaje de ${msg.key.remoteJid}: ${msg.message.conversation || 'media'}`);
      }
    });

    logger.info('✅ Todo configurado correctamente');

  } catch (error) {
    // Captura detallada del error
    logger.error('❌ ERROR CAPTURADO EN CATCH:');
    logger.error(`   Tipo: ${typeof error}`);
    logger.error(`   Nombre: ${error?.name}`);
    logger.error(`   Mensaje: ${error?.message}`);
    logger.error(`   Code: ${error?.code}`);
    
    if (error?.stack) {
      logger.error('   Stack:', error.stack);
    }
    
    // Log del objeto completo
    console.error('\n========== ERROR COMPLETO ==========');
    console.error(error);
    console.error('====================================\n');
    
    lastError = error?.message || 'Error desconocido al conectar';
    
    connectionAttempts++;
    if (connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
      logger.info(`🔄 Reintentando en 5s (${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      setTimeout(() => connectToWhatsApp(), 5000);
    } else {
      logger.error('❌ No se pudo conectar después de múltiples intentos');
      lastError = 'Falló después de múltiples intentos';
      connectionAttempts = 0;
    }
  }
}

// ========== RUTAS API ==========

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Baileys WhatsApp API',
    version: '1.0.5',
    connected: isConnected,
    hasQR: !!qrCodeData,
    connectionAttempts,
    lastError,
    timestamp: new Date().toISOString()
  });
});

app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.json({
      status: 'connected',
      message: 'WhatsApp ya está conectado'
    });
  }

  if (!qrCodeData) {
    return res.json({
      status: 'waiting',
      message: 'Esperando QR Code...',
      hint: 'Recarga en 3-5 segundos',
      connectionAttempts,
      lastError
    });
  }

  res.json({
    status: 'qr_ready',
    qrcode: qrCodeData,
    message: 'Escanea con WhatsApp → Dispositivos vinculados'
  });
});

app.get('/qr-image', async (req, res) => {
  if (!qrCodeData) {
    return res.status(404).send('QR no disponible aún');
  }
  
  const base64Data = qrCodeData.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': imgBuffer.length
  });
  res.end(imgBuffer);
});

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData,
    connectionAttempts,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    lastError,
    timestamp: new Date().toISOString()
  });
});

app.post('/send-message', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      error: 'WhatsApp no conectado',
      hint: 'Escanea el QR en /qr'
    });
  }

  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({
      error: 'Faltan parámetros',
      required: { phone: '56912345678', message: 'Hola!' }
    });
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    
    logger.info(`✅ Mensaje enviado a ${phone}`);
    
    res.json({
      success: true,
      message: 'Enviado',
      to: phone,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Error enviando:', error.message);
    res.status(500).json({
      error: 'Error al enviar',
      details: error.message
    });
  }
});

app.post('/send-image', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({ error: 'WhatsApp no conectado' });
  }

  const { phone, imageUrl, caption } = req.body;

  if (!phone || !imageUrl) {
    return res.status(400).json({
      error: 'Faltan parámetros',
      required: { phone: '56912345678', imageUrl: 'https://...' }
    });
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || ''
    });
    
    logger.info(`✅ Imagen enviada a ${phone}`);
    
    res.json({ success: true, to: phone });
  } catch (error) {
    logger.error('❌ Error:', error.message);
    res.status(500).json({
      error: 'Error al enviar imagen',
      details: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    connected: isConnected
  });
});

// ========== INICIAR SERVIDOR ==========

app.listen(PORT, () => {
  logger.info(`🚀 Servidor en puerto ${PORT}`);
  logger.info(`📍 Endpoints:`);
  logger.info(`   GET  / - Estado`);
  logger.info(`   GET  /qr - QR JSON`);
  logger.info(`   GET  /qr-image - QR Imagen`);
  logger.info(`   GET  /status - Estado`);
  logger.info(`   POST /send-message`);
  logger.info(`   POST /send-image`);
  
  logger.info(`\n📱 Conectando a WhatsApp...`);
  connectToWhatsApp();
});

// Manejo de errores globales
process.on('unhandledRejection', (err) => {
  logger.error('❌ Unhandled Rejection:', err?.message);
  console.error('UNHANDLED:', err);
});

process.on('uncaughtException', (err) => {
  logger.error('❌ Uncaught Exception:', err?.message);
  console.error('UNCAUGHT:', err);
});