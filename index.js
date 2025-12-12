import pkg from '@whiskeysockets/baileys';
const { 
  default: makeWASocket,
  DisconnectReason, 
  fetchLatestBaileysVersion
} = pkg;
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import cors from 'cors';
import { Boom } from '@hapi/boom';
import postgresBaileys from 'postgres-baileys';
const { usePostgreSQLAuthState } = postgresBaileys;

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

// Logger simplificado para producción
const logger = pino({ 
  level: process.env.LOG_LEVEL || 'info'
});

// Función para inicializar la base de datos
async function initDatabase() {
  const DATABASE_URL = process.env.DATABASE_URL || process.env.PGURL;
  
  if (!DATABASE_URL) {
    logger.error('DATABASE_URL no configurada');
    return false;
  }

  try {
    const { default: pg } = await import('pg');
    const { Client } = pg;
    const client = new Client({ connectionString: DATABASE_URL });
    
    await client.connect();
    logger.info('🔌 Conectado a PostgreSQL');
    
    // Eliminar tabla incorrecta si existe
    await client.query('DROP TABLE IF EXISTS auth_data CASCADE');
    logger.info('🗑️ Tabla anterior eliminada');
    
    // Crear tabla correcta
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_data (
        session_id VARCHAR(255) NOT NULL,
        data_key VARCHAR(255) NOT NULL,
        data_value TEXT,
        PRIMARY KEY (session_id, data_key)
      )
    `);
    logger.info('✅ Tabla auth_data creada correctamente');
    
    // Crear índice
    await client.query('CREATE INDEX IF NOT EXISTS idx_session_id ON auth_data(session_id)');
    logger.info('✅ Índice creado');
    
    await client.end();
    return true;
  } catch (error) {
    logger.error('❌ Error inicializando base de datos:', error);
    return false;
  }
}

// Inicializar WhatsApp
async function connectToWhatsApp() {
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    logger.info(`Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

    // Usar PostgreSQL para almacenar la sesión
    const DATABASE_URL = process.env.DATABASE_URL || process.env.PGURL;
    
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL no está configurada. Agrega una base de datos PostgreSQL en Railway.');
    }

    const { state, saveCreds } = await usePostgreSQLAuthState({
      connectionString: DATABASE_URL,
      sessionId: 'lorena-whatsapp'
    });

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      getMessage: async () => ({ conversation: 'Hello' }),
      browser: ['Esika Lorena', 'Chrome', '10.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('📱 QR Code generado');
        
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          logger.info('✅ QR Code convertido a imagen');
        } catch (err) {
          logger.error('❌ Error generando QR imagen:', err);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        
        logger.warn(`❌ Conexión cerrada. StatusCode: ${statusCode}, Reconectar: ${shouldReconnect}`);
        isConnected = false;
        
        if (shouldReconnect && connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
          connectionAttempts++;
          logger.info(`🔄 Reintentando conexión (${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
          logger.error('❌ Máximo de reintentos alcanzado. Reinicia el servidor.');
          connectionAttempts = 0;
        }
      } else if (connection === 'open') {
        logger.info('✅ WhatsApp conectado exitosamente!');
        isConnected = true;
        qrCodeData = null;
        connectionAttempts = 0;
      } else if (connection === 'connecting') {
        logger.info('🔄 Conectando a WhatsApp...');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.info(`📨 Nuevo mensaje recibido (${type})`);
    });

  } catch (error) {
    logger.error('❌ Error en connectToWhatsApp:');
    logger.error(error);
    console.error('Error completo:', error);
    connectionAttempts++;
    if (connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
      setTimeout(() => connectToWhatsApp(), 5000);
    }
  }
}

// Rutas API
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Baileys WhatsApp API',
    version: '1.0.1',
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.json({
      status: 'connected',
      message: 'WhatsApp ya está conectado. No se necesita QR.'
    });
  }

  if (!qrCodeData) {
    return res.json({
      status: 'waiting',
      message: 'Esperando QR Code... Intenta de nuevo en 2-3 segundos',
      hint: 'El servidor está generando el QR. Recarga esta página.'
    });
  }

  res.json({
    status: 'qr_ready',
    qrcode: qrCodeData,
    message: 'Escanea este QR con WhatsApp → Dispositivos vinculados → Vincular dispositivo'
  });
});

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData,
    connectionAttempts,
    timestamp: new Date().toISOString()
  });
});

app.post('/send-message', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      error: 'WhatsApp no está conectado',
      hint: 'Escanea el QR Code primero en /qr'
    });
  }

  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({
      error: 'Se requiere phone y message',
      example: { phone: '56912345678', message: 'Hola!' }
    });
  }

  try {
    const formattedPhone = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    
    await sock.sendMessage(formattedPhone, { text: message });
    
    logger.info(`✅ Mensaje enviado a ${phone}`);
    
    res.json({
      success: true,
      message: 'Mensaje enviado correctamente',
      to: phone,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Error enviando mensaje:', error);
    res.status(500).json({
      error: 'Error al enviar mensaje',
      details: error.message
    });
  }
});

app.post('/send-image', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      error: 'WhatsApp no está conectado'
    });
  }

  const { phone, imageUrl, caption } = req.body;

  if (!phone || !imageUrl) {
    return res.status(400).json({
      error: 'Se requiere phone y imageUrl'
    });
  }

  try {
    const formattedPhone = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    
    await sock.sendMessage(formattedPhone, {
      image: { url: imageUrl },
      caption: caption || ''
    });
    
    logger.info(`✅ Imagen enviada a ${phone}`);
    
    res.json({
      success: true,
      message: 'Imagen enviada correctamente',
      to: phone
    });
  } catch (error) {
    logger.error('❌ Error enviando imagen:', error);
    res.status(500).json({
      error: 'Error al enviar imagen',
      details: error.message
    });
  }
});

// Health check para Railway
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    uptime: process.uptime(),
    connected: isConnected
  });
});

// Iniciar servidor
app.listen(PORT, async () => {
  logger.info(`🚀 Servidor corriendo en puerto ${PORT}`);
  logger.info(`🌐 Endpoints disponibles:`);
  logger.info(`   GET  / - Estado del servidor`);
  logger.info(`   GET  /qr - Obtener QR Code`);
  logger.info(`   GET  /status - Estado de conexión`);
  logger.info(`   POST /send-message - Enviar mensaje`);
  logger.info(`   POST /send-image - Enviar imagen`);
  
  // Inicializar base de datos primero
  logger.info(`🔧 Inicializando base de datos...`);
  const dbReady = await initDatabase();
  
  if (dbReady) {
    logger.info(`📱 Conectando a WhatsApp...`);
    connectToWhatsApp();
  } else {
    logger.error(`❌ No se pudo inicializar la base de datos. Verifica DATABASE_URL.`);
  }
});

// Manejo de errores no capturados
process.on('unhandledRejection', (err) => {
  logger.error('❌ Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  logger.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

