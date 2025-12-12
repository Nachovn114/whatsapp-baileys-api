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

// Función para crear auth state personalizado con PostgreSQL
async function useCustomPostgresAuthState(sessionId) {
  const DATABASE_URL = process.env.DATABASE_URL || process.env.PGURL;
  
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL no configurada');
  }

  const { default: pg } = await import('pg');
  const { Client } = pg;
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  // Leer datos de la sesión
  const readData = async (key) => {
    try {
      const result = await client.query(
        'SELECT data_value FROM auth_data WHERE session_id = $1 AND data_key = $2',
        [sessionId, key]
      );
      if (result.rows.length > 0) {
        return JSON.parse(result.rows[0].data_value);
      }
      return null;
    } catch (error) {
      logger.error(`Error leyendo ${key}:`, error.message);
      return null;
    }
  };

  // Escribir datos de la sesión
  const writeData = async (key, data) => {
    try {
      await client.query(
        `INSERT INTO auth_data (session_id, data_key, data_value) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (session_id, data_key) 
         DO UPDATE SET data_value = $3`,
        [sessionId, key, JSON.stringify(data)]
      );
    } catch (error) {
      logger.error(`Error escribiendo ${key}:`, error.message);
    }
  };

  // Leer credenciales
  let creds = await readData('creds');
  
  if (!creds) {
    // Importar initAuthCreds de Baileys
    const { initAuthCreds } = await import('@whiskeysockets/baileys/lib/Utils/auth-utils.js');
    creds = initAuthCreds();
    await writeData('creds', creds);
    logger.info('🆕 Credenciales iniciales creadas');
  } else {
    logger.info('📂 Credenciales existentes cargadas');
  }

  // Leer keys
  const keys = await readData('keys') || {};

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          const key = `${type}-${id}`;
          const value = keys[key];
          if (value) {
            data[id] = value;
          }
        }
        return data;
      },
      set: async (data) => {
        for (const category in data) {
          for (const id in data[category]) {
            const key = `${category}-${id}`;
            keys[key] = data[category][id];
          }
        }
        await writeData('keys', keys);
      }
    }
  };

  const saveCreds = async () => {
    await writeData('creds', state.creds);
  };

  return { state, saveCreds, client };
}

// Inicializar WhatsApp
async function connectToWhatsApp() {
  let dbClient = null;
  
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    logger.info(`Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

    const DATABASE_URL = process.env.DATABASE_URL || process.env.PGURL;
    
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL no está configurada. Agrega una base de datos PostgreSQL en Railway.');
    }

    const { state, saveCreds, client } = await useCustomPostgresAuthState('lorena-whatsapp');
    dbClient = client;

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
      
      // Log completo para debugging
      logger.info(`📡 Connection Update: ${JSON.stringify({ connection, hasQR: !!qr, hasError: !!lastDisconnect?.error })}`);

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
        const errorMessage = lastDisconnect?.error?.message;
        
        logger.warn(`❌ Conexión cerrada. StatusCode: ${statusCode}, Error: ${errorMessage}, Reconectar: ${shouldReconnect}`);
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

