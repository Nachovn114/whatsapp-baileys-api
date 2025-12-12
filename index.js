import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Estado global
let sock = null;
let qrCodeData = null;
let isConnected = false;

// Logger
const logger = pino({ level: 'silent' });

// Inicializar WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: state,
    getMessage: async () => ({ conversation: 'Hello' })
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code generado');
      qrCodeData = await QRCode.toDataURL(qr);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Conexión cerrada. Reconectando:', shouldReconnect);
      isConnected = false;
      
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp conectado!');
      isConnected = true;
      qrCodeData = null;
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// Rutas API
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Baileys WhatsApp API',
    version: '1.0.0',
    connected: isConnected
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
      message: 'Esperando QR Code... Intenta de nuevo en 2 segundos'
    });
  }

  res.json({
    status: 'qr_ready',
    qrcode: qrCodeData
  });
});

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData
  });
});

app.post('/send-message', async (req, res) => {
  if (!isConnected) {
    return res.status(400).json({
      error: 'WhatsApp no está conectado'
    });
  }

  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({
      error: 'Se requiere phone y message'
    });
  }

  try {
    // Formatear número (agregar @s.whatsapp.net)
    const formattedPhone = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    
    await sock.sendMessage(formattedPhone, { text: message });
    
    res.json({
      success: true,
      message: 'Mensaje enviado correctamente',
      to: phone
    });
  } catch (error) {
    console.error('Error enviando mensaje:', error);
    res.status(500).json({
      error: 'Error al enviar mensaje',
      details: error.message
    });
  }
});

app.post('/send-image', async (req, res) => {
  if (!isConnected) {
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
    
    res.json({
      success: true,
      message: 'Imagen enviada correctamente',
      to: phone
    });
  } catch (error) {
    console.error('Error enviando imagen:', error);
    res.status(500).json({
      error: 'Error al enviar imagen',
      details: error.message
    });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 Conectando a WhatsApp...`);
  connectToWhatsApp();
});
