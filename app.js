require('dotenv').config();
const { GoogleGenAI, Behavior } = require('@google/genai');
const WebSocket = require('ws');
const prism = require('prism-media');
const http = require('http');
const crypto = require('crypto');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const chokidar = require('chokidar');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');

// Providers
const GeminiProvider = require('./providers/gemini');
const QwenRealtimeProvider = require('./providers/qwen_realtime');
const QwenOmniProvider = require('./providers/qwen_omni');
const providersConfig = require('./providers/config');

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const LLM_BACKEND = process.env.LLM_BACKEND || 'gemini'; // 'gemini' or 'qwen'
const CLIENT_AUTH_TOKEN = process.env.CLIENT_AUTH_TOKEN || 'default_token';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-omni-flash-realtime';
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Aoede';
const QWEN_VOICE = process.env.QWEN_VOICE || 'Cherry';
const MQTT_ENDPOINT = process.env.MQTT_ENDPOINT || 'mqtt://localhost:1883';
const WEBSOCKET_URL_FOR_ALLOWED_DEVICE = process.env.WEBSOCKET_URL_FOR_ALLOWED_DEVICE || `ws://localhost:${PORT}/xiaozhi/v1/`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const INVALID_TEST_TOKEN = process.env.INVALID_TEST_TOKEN || 'invalid_token';

// Paths
const RESTART_FILE_PATH = path.join(__dirname, 'tmp', 'restart.txt');
const DEVICES_FILE_PATH = path.join(__dirname, 'devices.json');
const MCP_DEVICES_FILE_PATH = path.join(__dirname, 'mcp_devices.json');

// Configure Winston Logger
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: path.join(__dirname, 'connection-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      dirname: path.join(__dirname),
    })
  ],
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Give logger time to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

if (LLM_BACKEND === 'gemini' && !GEMINI_API_KEY) {
  logger.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
} else if (LLM_BACKEND === 'qwen' && !DASHSCOPE_API_KEY) {
  logger.error('Missing DASHSCOPE_API_KEY in .env');
  process.exit(1);
}

// Watcher for restart.txt
const watcher = chokidar.watch(RESTART_FILE_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
});

watcher.on('add', (path) => { logger.info(`Restart file detected: ${path}. Shutting down.`); process.exit(0); });
watcher.on('change', (path) => { logger.info(`Restart file modified: ${path}. Shutting down.`); process.exit(0); });

// Device Management
let devices = {};
let mcpDevices = {};

try {
  if (fs.existsSync(DEVICES_FILE_PATH)) {
    devices = JSON.parse(fs.readFileSync(DEVICES_FILE_PATH, 'utf8'));
    let modified = false;
    for (const mac in devices) {
      if (!devices[mac].enabled_mcp_devices) devices[mac].enabled_mcp_devices = [];
      if (!devices[mac].enabled_mcp_devices.includes(BUILTIN_MCP_ID)) {
        devices[mac].enabled_mcp_devices.push(BUILTIN_MCP_ID);
        modified = true;
      }
    }
    if (modified) saveDevices();
  } else {
    fs.writeFileSync(DEVICES_FILE_PATH, JSON.stringify({}));
  }
} catch (e) {
  logger.error(`Failed to load devices.json: ${e.message}`);
}

try {
  if (fs.existsSync(MCP_DEVICES_FILE_PATH)) {
    mcpDevices = JSON.parse(fs.readFileSync(MCP_DEVICES_FILE_PATH, 'utf8'));
  } else {
    fs.writeFileSync(MCP_DEVICES_FILE_PATH, JSON.stringify({}));
  }
} catch (e) {
  logger.error(`Failed to load mcp_devices.json: ${e.message}`);
}

function saveDevices() {
  fs.writeFileSync(DEVICES_FILE_PATH, JSON.stringify(devices, null, 2));
}

function saveMcpDevices() {
  fs.writeFileSync(MCP_DEVICES_FILE_PATH, JSON.stringify(mcpDevices, null, 2));
}

const BUILTIN_MCP_ID = 'parrot-dashboard';
const builtinTools = [
  {
    name: "server.get_pending_devices",
    description: "Get a list of Xiaozhi or MCP devices that are waiting for approval on this server.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "server.approve_device",
    description: "Approve a pending Xiaozhi or MCP device by its ID so it can be used.",
    parameters: { 
      type: "object", 
      properties: { 
        id: { type: "string", description: "The ID of the device to approve." },
        type: { type: "string", enum: ["xiaozhi", "mcp"], description: "The type of device." }
      }, 
      required: ["id", "type"],
      additionalProperties: false 
    }
  },
  {
    name: "server.update_config",
    description: "Update the AI configuration (backend, model, voice, system prompt) for the currently connected device. Note: Changes take effect on the next session connection.",
    parameters: {
      type: "object",
      properties: {
        llm_backend: { type: "string", enum: ["gemini", "qwen", "qwen_realtime", "qwen_omni"], description: "The AI backend to use." },
        gemini_model: { type: "string", enum: (providersConfig.find(p => p.id === 'gemini')?.models.map(m => m.id) || []), description: "Valid Gemini models." },
        qwen_model: { type: "string", enum: [...new Set([...(providersConfig.find(p => p.id === 'qwen_realtime')?.models.map(m => m.id) || []), ...(providersConfig.find(p => p.id === 'qwen_omni')?.models.map(m => m.id) || [])])], description: "Valid Qwen models." },
        gemini_voice: { type: "string", enum: (providersConfig.find(p => p.id === 'gemini')?.voices || []), description: "Valid Gemini voices." },
        qwen_voice: { type: "string", enum: [...new Set([...(providersConfig.find(p => p.id === 'qwen_realtime')?.voices || []), ...(providersConfig.find(p => p.id === 'qwen_omni')?.voices || [])])], description: "Valid Qwen voices." },
        prompt: { type: "string", description: "The system prompt for the AI." }
      },
      additionalProperties: false
    }
  }
];

// MCP Server State
const mcpClients = new Map(); // ws -> { id: string, tools: array }
let mcpMessageId = 1;
const mcpCallbacks = new Map(); // id -> resolve function

function sendMcpRequest(ws, method, params) {
  return new Promise((resolve, reject) => {
    const info = mcpClients.get(ws);
    const id = mcpMessageId++;
    mcpCallbacks.set(id, resolve);

    let requestPayload = { jsonrpc: "2.0", id, method, params };
    if (info && info.isXiaozhi) {
      requestPayload = { type: 'mcp', payload: requestPayload };
    }

    logger.debug(`[MCP] Sending to ${info?.id || 'unknown'}: ${JSON.stringify(requestPayload)}`);
    ws.send(JSON.stringify(requestPayload));

    const timeoutMs = method === 'tools/call' ? 5000 : 30000;
    setTimeout(() => {
      if (mcpCallbacks.has(id)) {
        mcpCallbacks.delete(id);
        if (method === 'tools/call') {
          logger.warn(`[MCP] Timeout for ${method} on ${info?.id || 'unknown'}, assuming success.`);
          resolve({ result: { success: true, note: "Action dispatched, but no confirmation received (timeout)." } });
        } else {
          reject(new Error(`Timeout waiting for MCP response after ${timeoutMs/1000}s`));
        }
      }
    }, timeoutMs);
  });
}

function setupMcpClient(ws, clientId, isXiaozhi = false) {
  if (mcpClients.has(ws)) return Promise.resolve();

  mcpClients.set(ws, { id: clientId, tools: [], isXiaozhi });
  logger.info(`[MCP] Registering ${isXiaozhi ? 'Xiaozhi' : 'External'} device: ${clientId}`);

  // Register in mcp_devices if new
  if (!mcpDevices[clientId]) {
    mcpDevices[clientId] = { status: 'pending', name: clientId };
    saveMcpDevices();
  }

  // Initialize MCP Connection
  logger.debug(`[MCP] Sending initialize to ${clientId}`);
  return sendMcpRequest(ws, 'initialize', {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ParrotServer", version: "1.0.0" }
  }).then(() => {
    // MCP Protocol requires sending an initialized notification before making further requests
    let initNotification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    };
    if (isXiaozhi) initNotification = { type: 'mcp', payload: initNotification };
    ws.send(JSON.stringify(initNotification));

    logger.info(`[MCP] Device ${clientId} initialized. Requesting tools...`);
    return sendMcpRequest(ws, 'tools/list', {});
  }).then((res) => {
    const info = mcpClients.get(ws);
    if (info && res.result && res.result.tools) {
      info.tools = res.result.tools;
      logger.info(`[MCP] Device ${clientId} registered ${res.result.tools.length} tools.`);
    }
    return info;
  }).catch(e => {
    logger.error(`[MCP] Error initializing client ${clientId}: ${e.message}`);
    throw e;
  });
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const app = express();

app.use(bodyParser.json());
app.use(session({
  store: new FileStore({ path: path.join(__dirname, 'sessions'), logFn: () => {} }),
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve static files for web UI
app.use(express.static(path.join(__dirname, 'public')));

// Admin Authentication Middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Web UI API Routes
app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.save((err) => {
      res.json({ success: true });
    });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    res.json({ success: true });
  });
});

app.get('/api/auth/status', requireAuth, (req, res) => {
  res.json({ authenticated: true });
});

app.get('/api/providers', requireAuth, (req, res) => {
  res.json({ default_backend: LLM_BACKEND, providers: providersConfig });
});

app.get('/api/devices', requireAuth, (req, res) => {
  res.json(devices);
});

app.post('/api/devices/:mac/approve', requireAuth, (req, res) => {
  const mac = req.params.mac;
  if (devices[mac]) {
    devices[mac].status = 'approved';
    saveDevices();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

app.delete('/api/devices/:mac', requireAuth, (req, res) => {
  const mac = req.params.mac;
  if (devices[mac]) {
    delete devices[mac];
    saveDevices();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

app.post('/api/devices/:mac/config', requireAuth, (req, res) => {
  const mac = req.params.mac;
  if (devices[mac]) {
    devices[mac].prompt = req.body.prompt !== undefined ? req.body.prompt : devices[mac].prompt;
    devices[mac].llm_backend = req.body.llm_backend !== undefined ? req.body.llm_backend : devices[mac].llm_backend;
    devices[mac].gemini_model = req.body.gemini_model !== undefined ? req.body.gemini_model : devices[mac].gemini_model;
    devices[mac].qwen_model = req.body.qwen_model !== undefined ? req.body.qwen_model : devices[mac].qwen_model;
    devices[mac].gemini_voice = req.body.gemini_voice !== undefined ? req.body.gemini_voice : devices[mac].gemini_voice;
    devices[mac].qwen_voice = req.body.qwen_voice !== undefined ? req.body.qwen_voice : devices[mac].qwen_voice;
    devices[mac].input_transcription = req.body.input_transcription !== undefined ? req.body.input_transcription : devices[mac].input_transcription;
    devices[mac].output_transcription = req.body.output_transcription !== undefined ? req.body.output_transcription : devices[mac].output_transcription;
    devices[mac].enabled_mcp_devices = req.body.enabled_mcp_devices !== undefined ? req.body.enabled_mcp_devices : (devices[mac].enabled_mcp_devices || []);
    saveDevices();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

app.get('/api/mcp_devices', requireAuth, (req, res) => {
  // Merge live connected state with persisted state
  const response = {};
  
  // Inject the built-in dashboard pseudo-device
  response[BUILTIN_MCP_ID] = {
    status: 'approved',
    name: 'Parrot Dashboard (Built-in)',
    connected: true,
    tools: builtinTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters
    }))
  };

  for (const [id, data] of Object.entries(mcpDevices)) {
    response[id] = { ...data, connected: false, tools: [] };
  }
  for (const [ws, info] of mcpClients.entries()) {
    if (!response[info.id]) response[info.id] = { status: 'pending', name: info.id };
    response[info.id].connected = true;
    response[info.id].tools = info.tools;
  }
  res.json(response);
});

app.post('/api/mcp_devices/:id/approve', requireAuth, (req, res) => {
  const id = req.params.id;
  if (!mcpDevices[id]) mcpDevices[id] = { name: id };
  mcpDevices[id].status = 'approved';
  saveMcpDevices();

  // Trigger tool discovery for the approved device if connected
  for (const [ws, info] of mcpClients.entries()) {
    if (info.id === id) {
      logger.info(`[MCP] Device ${id} approved. Requesting tools...`);
      sendMcpRequest(ws, 'tools/list', {}).then(res => {
        if (res.result && res.result.tools) {
          info.tools = res.result.tools;
          logger.info(`[MCP] Device ${id} registered ${res.result.tools.length} tools after approval.`);
        }
      }).catch(e => logger.error(`[MCP] Error requesting tools for ${id}: ${e.message}`));
    }
  }

  res.json({ success: true });
});

app.delete('/api/mcp_devices/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  if (mcpDevices[id]) {
    delete mcpDevices[id];
    saveMcpDevices();
    // Disconnect if currently connected
    for (const [ws, info] of mcpClients.entries()) {
      if (info.id === id) ws.close();
    }
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'MCP Device not found' });
  }
});

// Xiaozhi OTA / Discovery Endpoint
app.all(/^\/xiaozhi\/ota/, (req, res) => {
  handleOta(req, res);
});

function handleOta(req, res) {
  logger.info(`[OTA] ${req.method} request from ${req.headers['device-id'] || 'unknown'}`);
  logger.debug(`[OTA] Request Headers: ${JSON.stringify(req.headers)}`);

  if (req.method === 'POST') {
    logger.debug(`[OTA] Request Body: ${JSON.stringify(req.body)}`);
    const macAddress = req.body.mac_address || req.headers['device-id'] || '00:00:00:00:00:00';
    const uuid = req.body.uuid || 'unknown_uuid';
    const clientId = req.headers['client-id'] || crypto.randomUUID();
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

    // Check device registration
    let isAllowed = false;
    if (devices[macAddress]) {
      if (devices[macAddress].status === 'approved' && devices[macAddress].uuid === uuid) {
        isAllowed = true;
      }
    } else {
      const pendingCount = Object.values(devices).filter(d => d.status === 'pending').length;
      if (pendingCount >= 10) {
        logger.warn(`[OTA] Max pending Xiaozhi devices reached. Rejecting ${macAddress}.`);
        return res.status(403).json({ status: "error", message: "Max pending devices reached" });
      }

      // Register as pending
      devices[macAddress] = {
        uuid,
        name: `Device ${macAddress}`,
        status: 'pending',
        token: crypto.randomBytes(16).toString('hex'),
        prompt: "You are a helpful assistant. Keep responses short.",
        input_transcription: true,
        output_transcription: true,
        enabled_mcp_devices: [BUILTIN_MCP_ID]
      };
      saveDevices();
      logger.info(`[OTA] New device ${macAddress} registered as pending.`);
    }

    let response;
    if (isAllowed) {
      logger.info(`[OTA] Allowed device ${macAddress} requested OTA. Returning valid token.`);
      response = {
        timestamp: new Date().toISOString(),
        websocket: {
          url: WEBSOCKET_URL_FOR_ALLOWED_DEVICE,
          token: devices[macAddress].token || CLIENT_AUTH_TOKEN
        },
        server_time: { timestamp: Date.now(), timezone_offset: 28800 }
      };
    } else {
      logger.warn(`[OTA] Pending/Unapproved device ${macAddress} requested OTA.`);
      response = {
        timestamp: new Date().toISOString(),
        mqtt: {
          endpoint: MQTT_ENDPOINT,
          client_id: `GID_parrot@@@${macAddress.replace(/:/g, '_')}@@@${clientId}`,
          username: Buffer.from(JSON.stringify({ ip: req.socket.remoteAddress })).toString('base64'),
          password: crypto.randomBytes(32).toString('base64'),
          publish_topic: "device-server",
          subscribe_topic: "null"
        },
        websocket: {
          url: `${wsProtocol}://${req.headers.host}/`,
          token: INVALID_TEST_TOKEN
        },
        server_time: { timestamp: Date.now(), timezone_offset: 3600 },
        firmware: { version: "1.0.0", url: "" },
        activation: { code: "123456", message: "Parrot Relay\nWaiting for Approval", challenge: crypto.randomUUID() }
      };
    }
    logger.debug(`[OTA] Response Payload: ${JSON.stringify(response)}`);
    res.json(response);
  } else {
    const responsePayload = { status: "ok", message: "Parrot Relay OTA endpoint", timestamp: new Date().toISOString() };
    logger.debug(`[OTA] Response Payload: ${JSON.stringify(responsePayload)}`);
    res.json(responsePayload);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', passenger: true, pid: process.pid });
});

// Create HTTP Server
const server = http.createServer(app);

// WebSockets
const wssXiaozhi = new WebSocket.Server({ noServer: true });
const wssMcp = new WebSocket.Server({ noServer: true });

// Handle Upgrades
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/xiaozhi/v1' || pathname === '/xiaozhi/v1/') {
    wssXiaozhi.handleUpgrade(request, socket, head, (ws) => {
      wssXiaozhi.emit('connection', ws, request);
    });
  } else if (pathname === '/mcp' || pathname === '/mcp/') {
    wssMcp.handleUpgrade(request, socket, head, (ws) => {
      wssMcp.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// MCP Server Logic
wssMcp.on('connection', (ws, req) => {
  const mcpUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientId = mcpUrl.searchParams.get('device_id') || crypto.randomUUID();
  const token = mcpUrl.searchParams.get('token');

  let mcpDevice = mcpDevices[clientId];

  if (!mcpDevice) {
    const pendingCount = Object.values(mcpDevices).filter(d => d.status === 'pending').length;
    if (pendingCount >= 10) {
      logger.warn(`[MCP] Max pending MCP devices reached. Rejecting ${clientId}.`);
      ws.close(1008, 'Max pending devices reached');
      return;
    }
    
    mcpDevice = {
      name: clientId,
      status: 'pending'
    };
    if (token) mcpDevice.token = token;
    mcpDevices[clientId] = mcpDevice;
    saveMcpDevices();
  } else if (mcpDevice.token && token !== mcpDevice.token) {
    logger.warn(`[MCP] Authentication failed for ${clientId}. Invalid token.`);
    ws.close(1008, 'Unauthorized');
    return;
  } else if (!mcpDevice.token && token) {
    // Legacy MCP device or previously unauthenticated device, lock it to the new token
    mcpDevice.token = token;
    saveMcpDevices();
  }

  logger.info(`[MCP] New client connected: ${clientId} from ${req.socket.remoteAddress}`);

  // Keep-alive ping to prevent aggressive idle timeouts from Nginx/Node
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 3000);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      logger.debug(`[MCP] Received from ${clientId}: ${JSON.stringify(data)}`); // Added debug log

      let mcpId = data.id;
      if (mcpId !== undefined && typeof mcpId === 'string' && !isNaN(Number(mcpId))) {
          mcpId = Number(mcpId);
      }

      if (mcpId !== undefined && mcpCallbacks.has(mcpId)) {
        mcpCallbacks.get(mcpId)(data);
        mcpCallbacks.delete(mcpId);
      } else if (data.method) {
        logger.info(`[MCP] Received unhandled method ${data.method} from ${clientId}`);
      }
    } catch (e) {
      logger.error(`[MCP] Failed to parse message from ${clientId}`);
    }
  });

  ws.on('close', () => {
    logger.info(`[MCP] Client disconnected: ${clientId}`);
    mcpClients.delete(ws);
    clearInterval(pingInterval);
  });

  setupMcpClient(ws, clientId).catch(e => logger.error(`[MCP] Setup failed for ${clientId}: ${e.message}`));
});

// Xiaozhi Voice Session Logic
wssXiaozhi.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  logger.info(`[${sessionId}] New Xiaozhi connection attempt...`);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const authHeader = req.headers['authorization'];
  let token = url.searchParams.get('token');

  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);

  const macAddress = req.headers['device-id'] || 'unknown';
  let deviceConfig = devices[macAddress];
  
  if (!deviceConfig) {
    logger.warn(`[${sessionId}] Authentication failed. Device ${macAddress} not registered.`);
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  const expectedToken = deviceConfig.token || CLIENT_AUTH_TOKEN;

  if (token !== expectedToken) {
    logger.warn(`[${sessionId}] Authentication failed. Expected '${expectedToken}'`);
    ws.close(1008, 'Unauthorized');
    return;
  }

  // Ensure default config fallback
  deviceConfig = deviceConfig || {
    prompt: "You are a helpful assistant. Keep responses short.",
    input_transcription: true,
    output_transcription: true,
    enabled_mcp_devices: []
  };

  logger.info(`[${sessionId}] Authenticated successfully. Device: ${macAddress}`);

  let provider = null;
  let isSpeaking = false;
  let modelDone = false;
  let audioBuffer = [];
  let audioOutputQueue = [];
  let audioSendInterval = null;
  const FRAME_DURATION_MS = 60;
  let outputTranscriptionBuffer = '';
  let ttsTextQueue = [];
  let lastTtsTime = 0;
  let currentTtsDelay = 0;

  function queueTtsText(text) {
    if (!text) return;
    text = text.trim();
    if (text.length === 0) return;
    
    while (text.length > 120) {
        ttsTextQueue.push(text.substring(0, 120));
        text = text.substring(120);
    }
    if (text.length > 0) ttsTextQueue.push(text);
    
    scheduleAudioSend();
  }

  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 16000 });
  const encoder = new prism.opus.Encoder({ frameSize: 1440, channels: 1, rate: 24000 });

  decoder.on('data', (pcmChunk) => {
    if (provider) {
      provider.sendAudio(pcmChunk);
    } else {
      audioBuffer.push(pcmChunk);
    }
  });

  decoder.on('error', (err) => logger.error(`[${sessionId}] Decoder error:`, err));

  encoder.on('data', (opusChunk) => {
    audioOutputQueue.push(opusChunk);
    scheduleAudioSend();
  });

  encoder.on('error', (err) => logger.error(`[${sessionId}] Encoder error:`, err));

  function scheduleAudioSend() {
    if (!audioSendInterval) {
      audioSendInterval = setInterval(() => {
        const now = Date.now();
        
        if (ttsTextQueue.length > 0 && now - lastTtsTime >= currentTtsDelay) {
          const textToSend = ttsTextQueue.shift();
          const payload = { type: 'tts', state: 'sentence_start', session_id: sessionId, text: textToSend };
          logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
          lastTtsTime = now;

          // Calculate delay for this message based on its length to give the user time to read.
          // We use a base of 2000ms minimum, scaling up linearly with the character count.
          currentTtsDelay = Math.max(2000, textToSend.length * 80);

          // If the text queue is backing up, dynamically reduce the delay to catch up with audio
          if (ttsTextQueue.length > 2) currentTtsDelay = Math.max(1000, textToSend.length * 50);
          if (ttsTextQueue.length > 4) currentTtsDelay = Math.max(500, textToSend.length * 30);
        }

        if (audioOutputQueue.length > 0) {
          const chunkToSend = audioOutputQueue.shift();
          if (ws.readyState === WebSocket.OPEN) ws.send(chunkToSend);
        } else if ((modelDone || !isSpeaking) && ttsTextQueue.length === 0) {
          if (isSpeaking) {
            isSpeaking = false;
            const payload = { type: 'tts', state: 'stop', session_id: sessionId };
            logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
          }
          clearInterval(audioSendInterval);
          audioSendInterval = null;
          modelDone = false;
        }
      }, FRAME_DURATION_MS);
    }
  }

  async function startSession() {
    try {
      // Gather tools from approved and enabled MCP clients
      const toolsMap = new Map();
      const enabledMcpSet = new Set(deviceConfig.enabled_mcp_devices || []);

      if (enabledMcpSet.has(BUILTIN_MCP_ID)) {
        for (const bt of builtinTools) toolsMap.set(bt.name, bt);
      }

      for (const [mcpWs, info] of mcpClients.entries()) {
        const mcpStatus = mcpDevices[info.id]?.status;

        if (mcpStatus === 'approved' && enabledMcpSet.has(info.id)) {
          for (const t of info.tools) {
            const toolDef = {
              name: t.name,
              description: t.description || 'No description provided.'
            };
            if (t.inputSchema && t.inputSchema.properties && Object.keys(t.inputSchema.properties).length > 0) {
              toolDef.parameters = JSON.parse(JSON.stringify(t.inputSchema));
              if (toolDef.parameters.type && typeof toolDef.parameters.type === 'string') {
                toolDef.parameters.type = toolDef.parameters.type.toLowerCase();
              }
              if (toolDef.parameters.additionalProperties === undefined) {
                toolDef.parameters.additionalProperties = false;
              }
            } else {
               toolDef.parameters = { type: "object", properties: {}, additionalProperties: false };
            }
            toolsMap.set(toolDef.name, toolDef);
          }
        }
      }

      const mcpTools = Array.from(toolsMap.values());
      const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
      
      let config = { ...deviceConfig };
      config.prompt = deviceConfig.prompt;
      config.input_transcription = deviceConfig.input_transcription;
      config.output_transcription = deviceConfig.output_transcription;

      let newProvider;
      if (activeBackend === 'gemini') {
          config.apiKey = GEMINI_API_KEY;
          config.model = deviceConfig.gemini_model || GEMINI_MODEL;
          config.voice = deviceConfig.gemini_voice || GEMINI_VOICE;
          newProvider = new GeminiProvider(config);
      } else if (activeBackend === 'qwen' || activeBackend === 'qwen_realtime' || activeBackend === 'qwen_omni') {
          config.apiKey = DASHSCOPE_API_KEY;
          config.model = deviceConfig.qwen_model || QWEN_MODEL;
          config.voice = deviceConfig.qwen_voice || QWEN_VOICE;

          if (activeBackend === 'qwen_omni') {
              config.input_transcription = false; // Disable input transcription for Qwen Omni
          }

          if (activeBackend === 'qwen_realtime' || (activeBackend === 'qwen' && config.model.includes('realtime'))) {
              newProvider = new QwenRealtimeProvider(config);
          } else {
              newProvider = new QwenOmniProvider(config);
          }
      }
      newProvider.on('connected', () => {
          logger.info(`[${sessionId}] Connected to ${activeBackend} API`);
          if (ws.readyState === WebSocket.OPEN) {
              const payload = { type: 'listen', state: 'start', session_id: sessionId };
              ws.send(JSON.stringify(payload));
          }
          
          provider = newProvider;
          
          process.nextTick(() => {
              if (provider && audioBuffer.length > 0) {
                  audioBuffer.forEach(chunk => provider.sendAudio(chunk));
                  audioBuffer.length = 0;
              }
          });
      });

      newProvider.on('audio_output', (audioBuf) => {
          if (!isSpeaking) {
              isSpeaking = true;
              ws.send(JSON.stringify({ type: 'tts', state: 'start', session_id: sessionId }));
          }
          encoder.write(audioBuf);
      });

      newProvider.on('input_transcription', (text) => {
          ws.send(JSON.stringify({ type: 'stt', session_id: sessionId, text }));
      });

      newProvider.on('output_transcription', (text) => {
          outputTranscriptionBuffer += text;
          let match;
          while ((match = outputTranscriptionBuffer.match(/.*?([。！？.!?\n]+)/))) {
              const textToSend = match[0];
              outputTranscriptionBuffer = outputTranscriptionBuffer.substring(textToSend.length);
              queueTtsText(textToSend);
          }
          if (outputTranscriptionBuffer.length >= 120) {
              queueTtsText(outputTranscriptionBuffer);
              outputTranscriptionBuffer = '';
          }
      });

      newProvider.on('turn_complete', () => {
          if (outputTranscriptionBuffer.length > 0 && deviceConfig.output_transcription) {
              queueTtsText(outputTranscriptionBuffer);
              outputTranscriptionBuffer = '';
          }
          modelDone = true;
      });

      newProvider.on('interrupted', () => {
          if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'abort', session_id: sessionId, reason: 'interrupted' }));
              if (isSpeaking) {
                  ws.send(JSON.stringify({ type: 'tts', state: 'stop', session_id: sessionId }));
              }
          }
          isSpeaking = false;
          modelDone = false;
          audioOutputQueue = [];
          ttsTextQueue = [];
      });

      newProvider.on('tool_call', (callId, name, args) => {
          logger.info(`[${sessionId}] Provider requested tool call: ${name}`);

          if (name === 'server.get_pending_devices') {
              const pendingDevices = [];
              for (const [mac, data] of Object.entries(devices)) {
                  if (data.status === 'pending') pendingDevices.push({ id: mac, type: 'xiaozhi', name: data.name || mac });
              }
              for (const [id, data] of Object.entries(mcpDevices)) {
                  if (data.status === 'pending') pendingDevices.push({ id, type: 'mcp', name: data.name || id });
              }
              if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ pending_devices: pendingDevices }));
              return;
          }

          if (name === 'server.approve_device') {
              if (args.type === 'xiaozhi' && devices[args.id]) {
                  devices[args.id].status = 'approved';
                  saveDevices();
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ success: true, note: `Xiaozhi device ${args.id} approved.` }));
              } else if (args.type === 'mcp' && mcpDevices[args.id]) {
                  mcpDevices[args.id].status = 'approved';
                  saveMcpDevices();

                  // Trigger tool discovery for the newly approved MCP device if it's currently connected
                  for (const [ws, info] of mcpClients.entries()) {
                      if (info.id === args.id) {
                          sendMcpRequest(ws, 'tools/list', {}).then(res => {
                              if (res.result && res.result.tools) info.tools = res.result.tools;
                          }).catch(() => {});
                      }
                  }

                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ success: true, note: `MCP device ${args.id} approved.` }));
              } else {
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ error: `Device ${args.id} of type ${args.type} not found or not pending.` }));
              }
              return;
          }

          if (name === 'server.update_config') {
              let updated = false;
              const toolDef = builtinTools.find(t => t.name === 'server.update_config');
              
              const validate = (param, value) => {
                  const allowed = toolDef.parameters.properties[param]?.enum;
                  if (allowed && !allowed.includes(value)) {
                      return `Invalid value for ${param}: ${value}. Allowed: ${allowed.join(', ')}`;
                  }
                  return null;
              };

              let error;
              if (args.llm_backend && (error = validate('llm_backend', args.llm_backend))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.gemini_model && (error = validate('gemini_model', args.gemini_model))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.qwen_model && (error = validate('qwen_model', args.qwen_model))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.gemini_voice && (error = validate('gemini_voice', args.gemini_voice))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.qwen_voice && (error = validate('qwen_voice', args.qwen_voice))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));

              if (args.llm_backend && args.llm_backend !== devices[macAddress].llm_backend) {
                  devices[macAddress].llm_backend = args.llm_backend;
                  delete devices[macAddress].gemini_model;
                  delete devices[macAddress].qwen_model;
                  delete devices[macAddress].gemini_voice;
                  delete devices[macAddress].qwen_voice;
                  updated = true;
              }
              
              if (args.gemini_model) { devices[macAddress].gemini_model = args.gemini_model; updated = true; }
              if (args.qwen_model) { devices[macAddress].qwen_model = args.qwen_model; updated = true; }
              if (args.gemini_voice) { devices[macAddress].gemini_voice = args.gemini_voice; updated = true; }
              if (args.qwen_voice) { devices[macAddress].qwen_voice = args.qwen_voice; updated = true; }
              if (args.prompt) { devices[macAddress].prompt = args.prompt; updated = true; }

              if (updated) {
                  saveDevices();
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ success: true, note: "Configuration updated successfully. The changes will take effect the next time a session is started." }));
              } else {
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ note: "No changes provided." }));
              }
              return;
          }

          let targetWs = null;
          for (const [mcpWs, info] of mcpClients.entries()) {              const mcpStatus = mcpDevices[info.id]?.status;
              if (mcpStatus === 'approved' && enabledMcpSet.has(info.id)) {
                  if (info.tools.find(t => t.name === name)) {
                      targetWs = mcpWs;
                      break;
                  }
              }
          }

          if (targetWs) {
              sendMcpRequest(targetWs, 'tools/call', { name, arguments: args })
                  .then(mcpRes => {
                      if (!provider) return;
                      const resultText = mcpRes.result?.content?.[0]?.text || JSON.stringify(mcpRes.result || { success: true });
                      logger.info(`[${sessionId}] Tool call ${name} succeeded.`);
                      provider.sendToolResponse(callId, name, resultText);
                  })
                  .catch(e => {
                      if (!provider) return;
                      logger.error(`[${sessionId}] Tool call failed: ${e.message}`);
                      provider.sendToolResponse(callId, name, JSON.stringify({ error: e.message }));
                  });
          } else {
              logger.warn(`[${sessionId}] Tool ${name} requested but no valid MCP client has it.`);
              if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ error: "Tool not available." }));
          }
      });

      newProvider.on('error', (err) => {
          logger.error(`[${sessionId}] Provider error:`, err);
          ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: err.message }));
      });

      newProvider.on('close', () => {
          logger.info(`[${sessionId}] Provider session closed`);
          provider = null;
      });

      logger.info(`[${sessionId}] Starting ${activeBackend} session with ${mcpTools.length} tools.`);
      await newProvider.connect(mcpTools);
      
    } catch (err) {
      logger.error(`[${sessionId}] Failed to connect:`, err);
      ws.close();
    }
  }

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      decoder.write(message);
    } else {
      try {
        const data = JSON.parse(message.toString());
        logger.debug(`[${sessionId}] Received from Xiaozhi: ${JSON.stringify(data)}`);

        // Handle MCP JSON-RPC responses (can be top-level or wrapped in a Xiaozhi message)
        const possibleMcpData = data.payload || data;
        let mcpId = possibleMcpData.id;
        if (mcpId !== undefined && typeof mcpId === 'string' && !isNaN(Number(mcpId))) {
            mcpId = Number(mcpId);
        }

        if (mcpId !== undefined && mcpCallbacks.has(mcpId)) {
          logger.debug(`[${sessionId}] Found matching MCP callback for ID ${mcpId}`);
          mcpCallbacks.get(mcpId)(possibleMcpData);
          mcpCallbacks.delete(mcpId);
          return;
        }

        if (data.type === 'hello') {
          const payload = {
            type: 'hello',
            transport: 'websocket',
            session_id: sessionId,
            audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60 }
          };
          logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
          ws.send(JSON.stringify(payload));

          if (data.features && data.features.mcp) {
            logger.info(`[${sessionId}] MCP features detected. Waiting for tools...`);

            const mcpWaitPromise = new Promise((resolve) => {
              const setupPromise = new Promise((innerResolve) => {
                setTimeout(() => {
                  logger.info(`[${sessionId}] Initializing MCP for device ${macAddress}`);
                  setupMcpClient(ws, macAddress, true).catch(e => logger.error(`[MCP] Setup failed for ${macAddress}: ${e.message}`)).finally(innerResolve);
                }, 1000);
              });

              const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
              const qwenModel = deviceConfig.qwen_model || QWEN_MODEL;
              if (activeBackend === 'qwen_realtime' || (activeBackend === 'qwen' && qwenModel.includes('realtime'))) {
                // Skip tool wait timeout if we're using qwen realtime since it doesn't support them right now
                logger.info(`[${sessionId}] Skipping tool discovery wait for Qwen Realtime backend.`);
                resolve();
              } else {
                const timeoutPromise = new Promise((innerResolve) => {
                  setTimeout(() => {
                    logger.warn(`[${sessionId}] MCP tool discovery timed out after 5s`);
                    innerResolve();
                  }, 5000);
                });
  
                Promise.race([setupPromise, timeoutPromise]).finally(resolve);
              }
            });

            mcpWaitPromise.finally(() => {
              if (!provider) {
                logger.info(`[${sessionId}] Proceeding to start LLM session.`);
                const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
                startSession();
              }
            });
          } else {
            if (!provider) {
              const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
              startSession();
            }
          }
        } else if (data.type === 'listen' && data.state === 'start' && !provider) {
          // You can also start gemini session strictly when client sends listen: start
        } else if (data.type === 'abort') {
          logger.info(`[${sessionId}] Received abort from device. Clearing queues.`);
          if (provider && typeof provider.interrupt === 'function') {
            provider.interrupt();
          }
          if (isSpeaking) {
            isSpeaking = false;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tts', state: 'stop', session_id: sessionId }));
            }
          }
          modelDone = false;
          audioOutputQueue = [];
          ttsTextQueue = [];
        }
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    logger.info(`[${sessionId}] Client disconnected`);
    mcpClients.delete(ws);
    decoder.destroy();
    encoder.destroy();
    if (audioSendInterval) clearInterval(audioSendInterval);
  });

  // startGeminiSession(); // Removed immediate start
});

server.listen(PORT, HOST, () => {
  logger.info(`Parrot Server listening on ${HOST}:${PORT}`);
  logger.info(`Web UI: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  logger.info(`MCP Endpoint: ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/mcp`);
});
