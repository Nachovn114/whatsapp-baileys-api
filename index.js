import pkg from '@whiskeysockets/baileys';
const { 
  default: makeWASocket,
  DisconnectReason, 
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = pkg;
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import cors from 'cors';
import pg from 'pg';

const { Client } = pg;
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

// Logger simplificado
const logger = pino({ 
  level: process.env.LOG_LEVEL || 'info'
});

// Función para inicializar la base de datos
async function initDatabase() {
  const DATABASE_URL = process.env.DATABASE_URL || process.env.PGURL;
  
  if (!DATABASE_URL) {
    logger.error('❌ DATABASE_URL no configurada');
    return false;
  }

  try {
    const client = new Client({ connectionString: DATABASE_URL });
    
    await client.connect();
    logger.info('🔌 Conectado a PostgreSQL');
    
    // Eliminar tabla anterior si existe
    await client.query('DROP TABLE IF EXISTS auth_state CASCADE');
    logger.info('🗑️ Tabla anterior eliminada');
    
    // Crear tabla correcta
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_state (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    logger.info('✅ Tabla auth_state creada correctamente');
    
    await client.end();
    return true;
  } catch (error) {
    logger.error('❌ Error inicializando base de datos:', error.message);
    return false;
  }
}

// Custom Auth State usando PostgreSQL
async function usePostgresAuthState() {
  const DATABASE_URL = process.env.DATABASE_URL || process.env.PGURL;
  
  if (!DATABASE_URL) {
    logger.warn('⚠️ DATABASE_URL no configurada, usando filesystem temporal');
    return await useMultiFileAuthState('./auth_session');
  }

  const readData = async (key) => {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      const result = await client.query(
        'SELECT value FROM auth_state WHERE key = $1',
        [key]
      );
      await client.end();
      
      if (result.rows.length > 0) {
        return JSON.parse(result.rows[0].value);
      }
      return null;
    } catch (error) {
      logger.error(`❌ Error leyendo ${key}:`, error.message);
      try { await client.end(); } catch (e) {}
      return null;
    }
  };

  const writeData = async (key, data) => {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      await client.query(
        `INSERT INTO auth_state (key, value, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (key) 
         DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(data)]
      );
      await client.end();
    } catch (error) {
      logger.error(`❌ Error escribiendo ${key}:`, error.message);
      try { await client.end(); } catch (e) {}
    }
  };

  const removeData = async (key) => {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      await client.query('DELETE FROM auth_state WHERE key = $1', [key]);
      await client.end();
    } catch (error) {
      logger.error(`❌ Error eliminando ${key}:`, error.message);
      try { await client.end(); } catch (e) {}
    }
  };

  const creds = await readData('creds') || undefined;
  
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const key = `${type}-${id}`;
            const value = await readData(key);
            if (value) {
              data[id] = value;
            }
          }
          return data;
        },
        set: async (data) => {
          const promises = [];
          for (const category in data) {
            for (const id in data[category]) {
              const key = `${category}-${id}`;
              const value = data[category][id];
              if (value === null) {
                promises.push(removeData(key));
              } else {
                promises.push(writeData(key, value));
              }
            }
          }
          await Promise.all(promises);
        }
      }
    },
    saveCreds: async () => {
      if (sock && sock.authState && sock.authState.creds) {
        await writeData('creds', sock.authState.creds);
      }
    }
  };
}

// Inicializar WhatsApp
async function connectToWhatsApp() {
  try {
    logger.info('🔄 Iniciando conexión a WhatsApp...');
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`📦 Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

    // Usar auth state de PostgreSQL o filesystem
    logger.info('📂 Cargando auth state...');
    const { state, saveCreds } = await usePostgresAuthState();
    logger.info('✅ Auth state cargado');

    logger.info('🔌 Creando socket de WhatsApp...');
    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Esika Lorena Bot', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      getMessage: async () => undefined
    });
    
    logger.info('✅ Socket de WhatsApp creado');

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      logger.info(`📡 Connection Update: ${JSON.stringify({ 
        connection, 
        hasQR: !!qr, 
        hasError: !!lastDisconnect?.error 
      })}`);

      if (qr) {
        logger.info('📱 QR Code generado');
        
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          logger.info('✅ QR Code convertido a imagen exitosamente');
        } catch (err) {
          logger.error('❌ Error generando QR imagen:', err.message);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
        
        logger.warn(`❌ Conexión cerrada. StatusCode: ${statusCode}, Error: ${errorMessage}, Reconectar: ${shouldReconnect}`);
        isConnected = false;
        qrCodeData = null;
        
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

    logger.info('✅ Conexión a WhatsApp iniciada correctamente');

  } catch (error) {
    logger.error('❌ Error en connectToWhatsApp:', error.message);
    logger.error('📋 Error completo:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    logger.error('🔍 Stack trace:', error.stack);
    
    connectionAttempts++;
    if (connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
      logger.info(`🔄 Reintentando en 5 segundos... (${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(() => connectToWhatsApp(), 5000);
    } else {
      logger.error('❌ Máximo de reintentos alcanzado. No se pudo conectar a WhatsApp.');
      connectionAttempts = 0;
    }
  }
}

// Rutas API
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Baileys WhatsApp API',
    version: '1.0.3',
    connected: isConnected,
    hasQR: !!qrCodeData,
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
      hint: 'El servidor está generando el QR. Recarga esta página.',
      connectionAttempts
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
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
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
  await initDatabase();
  
  logger.info(`📱 Conectando a WhatsApp...`);
  connectToWhatsApp();
});

// Manejo de errores no capturados
process.on('unhandledRejection', (err) => {
  logger.error('❌ Unhandled Rejection:', err.message);
  logger.error('📋 Stack:', err.stack);
});

process.on('uncaughtException', (err) => {
  logger.error('❌ Uncaught Exception:', err.message);
  logger.error('📋 Stack:', err.stack);
  // No salir inmediatamente en Railway
});