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

    setTimeout(() => {
      if (mcpCallbacks.has(id)) {
        mcpCallbacks.delete(id);
        reject(new Error("Timeout waiting for MCP response after 30s"));
      }
    }, 30000);
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
      // Register as pending
      devices[macAddress] = {
        uuid,
        name: `Device ${macAddress}`,
        status: 'pending',
        prompt: "You are a helpful assistant. Keep responses short.",
        input_transcription: true,
        output_transcription: true,
        enabled_mcp_devices: []
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
          token: CLIENT_AUTH_TOKEN
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
      if (data.id && mcpCallbacks.has(data.id)) {
        mcpCallbacks.get(data.id)(data);
        mcpCallbacks.delete(data.id);
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

  setupMcpClient(ws, clientId);
});

// Xiaozhi Voice Session Logic
wssXiaozhi.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  logger.info(`[${sessionId}] New Xiaozhi connection attempt...`);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const authHeader = req.headers['authorization'];
  let token = url.searchParams.get('token');

  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);

  if (token !== CLIENT_AUTH_TOKEN) {
    logger.warn(`[${sessionId}] Authentication failed. Expected '${CLIENT_AUTH_TOKEN}'`);
    ws.close(1008, 'Unauthorized');
    return;
  }

  const macAddress = req.headers['device-id'] || 'unknown';
  const deviceConfig = devices[macAddress] || {
    prompt: "You are a helpful assistant. Keep responses short.",
    input_transcription: true,
    output_transcription: true,
    enabled_mcp_devices: []
  };

  logger.info(`[${sessionId}] Authenticated successfully. Device: ${macAddress}`);

  let geminiSession = null;
  let qwenSession = null;
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
    if (geminiSession) {
      geminiSession.sendRealtimeInput({
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: pcmChunk.toString('base64')
        }
      });
    } else if (qwenSession && qwenSession.readyState === WebSocket.OPEN) {
      qwenSession.send(JSON.stringify({
        event_id: crypto.randomUUID(),
        type: 'input_audio_buffer.append',
        audio: pcmChunk.toString('base64')
      }));
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

  async function startGeminiSession() {
    try {
      // Gather tools from approved and enabled MCP clients
      const toolsMap = new Map(); // Use Map to deduplicate by name
      const enabledMcpSet = new Set(deviceConfig.enabled_mcp_devices || []);

      for (const [mcpWs, info] of mcpClients.entries()) {
        const mcpStatus = mcpDevices[info.id]?.status;

        if (mcpStatus === 'approved' && enabledMcpSet.has(info.id)) {
          for (const t of info.tools) {
            const toolDef = {
              name: t.name,
              description: t.description || 'No description provided.'
            };

            if (t.inputSchema && t.inputSchema.properties && Object.keys(t.inputSchema.properties).length > 0) {
              toolDef.parameters = JSON.parse(JSON.stringify(t.inputSchema)); // Deep copy
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

      const geminiTools = Array.from(toolsMap.values());

      const sessionConfig = {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: deviceConfig.gemini_voice || GEMINI_VOICE
            }
          }
        },
        systemInstruction: {
          parts: [{ text: deviceConfig.prompt }]
        }
      };

      if (geminiTools.length > 0) {
        sessionConfig.tools = [{ functionDeclarations: geminiTools }];
        sessionConfig.toolConfig = {
          functionCallingConfig: {
            mode: "AUTO"
          }
        };
      }

      if (deviceConfig.input_transcription) sessionConfig.inputAudioTranscription = {};
      if (deviceConfig.output_transcription) sessionConfig.outputAudioTranscription = {};

      logger.info(`[${sessionId}] Starting Gemini session with ${geminiTools.length} tools.`);
      logger.debug(`[${sessionId}] Gemini session config: ${JSON.stringify(sessionConfig)}`);

      geminiSession = await ai.live.connect({
        model: deviceConfig.gemini_model || GEMINI_MODEL,
        config: sessionConfig,
        callbacks: {
          onopen: () => {
            logger.info(`[${sessionId}] Connected to Gemini Live API`);
            if (ws.readyState === WebSocket.OPEN) {
              const payload = { type: 'listen', state: 'start', session_id: sessionId };
              logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
              ws.send(JSON.stringify(payload));
            }
            // Use nextTick to ensure geminiSession is assigned before processing buffer
            process.nextTick(() => {
              if (geminiSession && audioBuffer.length > 0) {
                logger.info(`[${sessionId}] Sending ${audioBuffer.length} buffered audio chunks to Gemini`);
                audioBuffer.forEach(chunk => {
                  try {
                    geminiSession.sendRealtimeInput({
                      audio: {
                        mimeType: 'audio/pcm;rate=16000',
                        data: chunk.toString('base64')
                      }
                    });
                  } catch (e) {
                    logger.error(`[${sessionId}] Error sending buffered audio: ${e.message}`);
                  }
                });
                audioBuffer.length = 0;
              }
            });
          },
          onmessage: async (response) => {
            if (!geminiSession) return;
            if (response.serverContent) {
              const content = response.serverContent;
              const sanitizedContent = JSON.parse(JSON.stringify(content)); // Deep copy
              if (sanitizedContent.modelTurn && sanitizedContent.modelTurn.parts) {
                const audioOnlyParts = sanitizedContent.modelTurn.parts.every(part => part.inlineData);
                if (audioOnlyParts) {
                  // If all parts are audio, remove the entire modelTurn to not log any audio related info
                  delete sanitizedContent.modelTurn;
                } else {
                  // If there are non-audio parts, redact only the audio data
                  sanitizedContent.modelTurn.parts = sanitizedContent.modelTurn.parts.map(part => {
                    if (part.inlineData) {
                      return { ...part, inlineData: '[AUDIO_DATA_REDACTED]' };
                    }
                    return part;
                  });
                }
              }
              logger.debug(`[${sessionId}] Gemini sent serverContent: ${JSON.stringify(sanitizedContent)}`);

              // Audio Handle
              if (content.modelTurn?.parts) {
                if (!isSpeaking) {
                  isSpeaking = true;
                  ws.send(JSON.stringify({ type: 'tts', state: 'start', session_id: sessionId }));
                }
                for (const part of content.modelTurn.parts) {
                  if (part.inlineData) {
                    encoder.write(Buffer.from(part.inlineData.data, 'base64'));
                  }
                }
              }

              if (content.inputTranscription && deviceConfig.input_transcription) {
                const payload = { type: 'stt', session_id: sessionId, text: content.inputTranscription.text };
                logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
                ws.send(JSON.stringify(payload));
              }
              if (content.outputTranscription && deviceConfig.output_transcription) {
                outputTranscriptionBuffer += content.outputTranscription.text;
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
              }
              if (content.turnComplete) {
                if (outputTranscriptionBuffer.length > 0 && deviceConfig.output_transcription) {
                  queueTtsText(outputTranscriptionBuffer);
                  outputTranscriptionBuffer = '';
                }
                modelDone = true;
              }
              if (content.interrupted) {
                const payload = { type: 'abort', session_id: sessionId, reason: 'interrupted' };
                logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
                ws.send(JSON.stringify(payload));
                isSpeaking = false;
                modelDone = false;
                audioOutputQueue = [];
                ttsTextQueue = [];
              }
            }

            // Function Call Handle (Live API puts toolCall as a top-level field)
            if (response.toolCall?.functionCalls) {
              const toolCall = response.toolCall;
              logger.debug(`[${sessionId}] Gemini sent toolCall: ${JSON.stringify(toolCall)}`);
              for (const call of toolCall.functionCalls) {
                logger.info(`[${sessionId}] Gemini requested tool call: ${call.name}`);

                // Find which MCP client has this tool (and is approved/enabled)
                let targetWs = null;
                for (const [mcpWs, info] of mcpClients.entries()) {
                  const mcpStatus = mcpDevices[info.id]?.status;
                  if (mcpStatus === 'approved' && enabledMcpSet.has(info.id)) {
                    if (info.tools.find(t => t.name === call.name)) {
                      targetWs = mcpWs;
                      break;
                    }
                  }
                }

                if (targetWs) {
                  try {
                    const mcpArgs = call.args || {};
                    logger.info(`[${sessionId}] Routing tool call ${call.name} to MCP client. Args: ${JSON.stringify(mcpArgs)}`);
                    sendMcpRequest(targetWs, 'tools/call', { name: call.name, arguments: mcpArgs })
                      .then(mcpRes => {
                        if (!geminiSession) return;
                        const resultText = mcpRes.result?.content?.[0]?.text || JSON.stringify(mcpRes.result || { success: true });
                        logger.info(`[${sessionId}] Tool call ${call.name} succeeded. Returning result to Gemini: ${resultText}`);
                        geminiSession.sendToolResponse({
                          functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { result: resultText }
                          }]
                        });
                      })
                      .catch(e => {
                        if (!geminiSession) return;
                        logger.error(`[${sessionId}] Tool call failed: ${e.message}`);
                        geminiSession.sendToolResponse({
                          functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { error: e.message }
                          }]
                        });
                      });
                  } catch (e) {}
                } else {
                  logger.warn(`[${sessionId}] Tool ${call.name} requested but no valid MCP client has it.`);
                  if (geminiSession) {
                    geminiSession.sendToolResponse({
                      functionResponses: [{
                        id: call.id,
                        name: call.name,
                        response: { error: "Tool not available." }
                      }]
                    });
                  }
                }
              }
            }
          },
          onerror: (error) => {
            logger.error(`[${sessionId}] Gemini error:`, error);
            if (ws.readyState === WebSocket.OPEN) {
              const payload = { type: 'error', session_id: sessionId, data: error.message };
              logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
              ws.send(JSON.stringify(payload));
            }
          },
          onclose: () => {
            logger.info(`[${sessionId}] Gemini session closed`);
            geminiSession = null;
          }
        }
      });
    } catch (err) {
      logger.error(`[${sessionId}] Failed to connect to Gemini:`, err);
      ws.close();
    }
  }

  function startQwenSession() {
    try {
      logger.info(`[${sessionId}] Starting Qwen3 session.`);

      const modelToUse = deviceConfig.qwen_model || QWEN_MODEL;
      const qwenUrl = `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${modelToUse}`;
      qwenSession = new WebSocket(qwenUrl, {
        headers: {
          'Authorization': `Bearer ${DASHSCOPE_API_KEY}`
        }
      });

      qwenSession.on('open', () => {
        logger.info(`[${sessionId}] Connected to Qwen3 Realtime API`);
        if (ws.readyState === WebSocket.OPEN) {
          const payload = { type: 'listen', state: 'start', session_id: sessionId };
          logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
          ws.send(JSON.stringify(payload));
        }

        process.nextTick(() => {
          if (qwenSession && qwenSession.readyState === WebSocket.OPEN && audioBuffer.length > 0) {
            logger.info(`[${sessionId}] Sending ${audioBuffer.length} buffered audio chunks to Qwen`);
            audioBuffer.forEach(chunk => {
              try {
                qwenSession.send(JSON.stringify({
                  event_id: crypto.randomUUID(),
                  type: 'input_audio_buffer.append',
                  audio: chunk.toString('base64')
                }));
              } catch (e) {
                logger.error(`[${sessionId}] Error sending buffered audio: ${e.message}`);
              }
            });
            audioBuffer.length = 0;
          }
        });
      });

      qwenSession.on('message', async (message) => {
        try {
          const response = JSON.parse(message.toString());
          if (!['response.audio.delta', 'response.audio_transcript.delta'].includes(response.type)) {
            logger.debug(`[${sessionId}] Qwen Event: ${response.type} ${response.item?.type || ''}`);
          }

          if (response.type === 'session.created') {
            const sessionUpdate = {
              type: "session.update",
              session: {
                modalities: ["text", "audio"],
                voice: deviceConfig.qwen_voice || QWEN_VOICE,
                input_audio_format: "pcm16",
                output_audio_format: "pcm24",
                instructions: `${deviceConfig.prompt}`,
                input_audio_transcription: { model: "gummy-realtime-v1" },
                turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
              }
            };
            logger.info(`[${sessionId}] Sending session.update for Qwen3 session.`);
            qwenSession.send(JSON.stringify(sessionUpdate));
          }

          if (response.type === 'response.audio.delta') {
            if (!isSpeaking) {
              isSpeaking = true;
              ws.send(JSON.stringify({ type: 'tts', state: 'start', session_id: sessionId }));
            }
            if (response.delta) {
              encoder.write(Buffer.from(response.delta, 'base64'));
            }
          } else if (response.type === 'response.audio.done') {
            modelDone = true;
          } else if (response.type === 'response.done') {
            modelDone = true;
          } else if (response.type === 'response.audio_transcript.delta') {
            if (deviceConfig.output_transcription && response.delta) {
              outputTranscriptionBuffer += response.delta;
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
            }
          } else if (response.type === 'response.audio_transcript.done') {
            if (deviceConfig.output_transcription) {
              if (outputTranscriptionBuffer.length > 0) {
                  queueTtsText(outputTranscriptionBuffer);
                  outputTranscriptionBuffer = '';
              }
            }
          } else if (response.type === 'input_audio_buffer.cleared') {
            isSpeaking = false;
            modelDone = false;
            audioOutputQueue = [];
            ttsTextQueue = [];
            const payload = { type: 'abort', session_id: sessionId, reason: 'interrupted' };
            logger.debug(`[${sessionId}] Sending to Xiaozhi: ${JSON.stringify(payload)}`);
            ws.send(JSON.stringify(payload));
          } else if (response.type === 'session.error' || response.type === 'error') {
            logger.error(`[${sessionId}] Qwen API error: ${JSON.stringify(response)}`);
            ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: response.error?.message || 'Qwen Error' }));
          }
        } catch (e) {
          logger.error(`[${sessionId}] Failed to parse Qwen message: ${e.message}`);
        }
      });

      qwenSession.on('close', () => {
        logger.info(`[${sessionId}] Qwen session closed`);
        qwenSession = null;
      });

      qwenSession.on('error', (error) => {
        logger.error(`[${sessionId}] Qwen error:`, error);
        ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: error.message }));
      });
    } catch (err) {
      logger.error(`[${sessionId}] Failed to connect to Qwen:`, err);
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
        if (possibleMcpData.id && mcpCallbacks.has(possibleMcpData.id)) {
          logger.debug(`[${sessionId}] Found matching MCP callback for ID ${possibleMcpData.id}`);
          mcpCallbacks.get(possibleMcpData.id)(possibleMcpData);
          mcpCallbacks.delete(possibleMcpData.id);
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
                  setupMcpClient(ws, macAddress, true).finally(innerResolve);
                }, 1000);
              });

              const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
              if (activeBackend === 'qwen') {
                // Skip tool wait timeout if we're using qwen since it doesn't support them right now
                logger.info(`[${sessionId}] Skipping tool discovery wait for Qwen backend.`);
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
              if (!geminiSession && !qwenSession) {
                logger.info(`[${sessionId}] Proceeding to start LLM session.`);
                const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
                activeBackend === 'qwen' ? startQwenSession() : startGeminiSession();
              }
            });
          } else {
            if (!geminiSession && !qwenSession) {
              const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
              activeBackend === 'qwen' ? startQwenSession() : startGeminiSession();
            }
          }
        } else if (data.type === 'listen' && data.state === 'start' && !geminiSession && !qwenSession) {
          // You can also start gemini session strictly when client sends listen: start
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
