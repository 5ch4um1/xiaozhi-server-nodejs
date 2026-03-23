# Xiaozhi Relay - Gemini Live & Qwen Realtime Bridge

A specialized Node.js relay that implements the **Xiaozhi Protocol**, bridging hardware devices (like ESP32 smartwatches and AI assistants) with the **Google Gemini 2.5 Live API** and **Alibaba Qwen APIs**.

## Features
- **Xiaozhi Protocol Support**: Fully compatible with Xiaozhi "hello" handshakes, state management (stt, tts, abort), and binary audio transport.
- **Multi-Model Architecture**: Built on a highly modular `LLMProvider` adapter pattern, making it easy to plug in new LLM backends.
  - **Google Gemini Live**: Full streaming support with MCP Tool calling.
  - **Alibaba Qwen Omni**: Support for `qwen3-omni-flash` using the native DashScope multimodal generation streaming API with full **MCP Tool calling support**. Uses a custom energy-based Voice Activity Detection (VAD) to handle non-realtime endpoints efficiently.
  - **Alibaba Qwen Realtime**: Direct WebSocket-based interactions for `qwen3-omni-flash-realtime` for extremely low-latency voice (no tools).
- **Dynamic Configuration UI**: Choose between backends, models, and custom voices directly from the device configuration dashboard. The UI dynamically loads available capabilities (e.g., Cherry, Serena voices for Qwen) from a central `providers/config.js` registry.
- **Built-in Dashboard MCP**: Control the server itself by talking to the AI! The server exposes a built-in virtual MCP device that lets the AI approve new devices and change its own configuration (models, backends, voices).
- **Real-time Transcoding**: Converts 16kHz Opus from devices to PCM, and transcodes the LLM's PCM responses back to 60ms Opus frames for the devices.
- **Low Latency**: Direct WebSocket-to-WebSocket piping and SSE streams for minimal delay.
- **Secure**: Features per-device dynamic tokens, optional Bring-Your-Own-Token for MCP clients, and max-pending rate limits for anti-spam.
- **Deployment Ready**: Easy deployment on standard Node.js hosting environments.

## How it Works
1.  **Handshake**: The Xiaozhi device connects and sends a `{"type": "hello", ...}` JSON message.
2.  **Session Initiation**: The relay validates the token, instantiates the selected `LLMProvider` (Gemini, Qwen Omni, or Qwen Realtime), and initiates the backend connection.
3.  **Voice Interaction**: 
    - Device sends 16kHz Opus -> Relay decodes to PCM -> LLM Provider processes (using Server VAD or custom Energy VAD).
    - LLM speaks PCM -> Relay encodes to 24kHz Opus (60ms frames) -> Device plays.
    - If the LLM issues a tool call, the Relay queries the appropriate connected MCP (Model Context Protocol) device and feeds the result back to the LLM.
4.  **Feedback**: Relay sends STT and TTS text updates back to the device for display, synchronized with the spoken audio.

## Authentication & Security

The server is protected by a multi-layered authentication and anti-spam system:

### 1. Xiaozhi Devices (Per-Device Tokens)
When a brand new Xiaozhi screen connects to the OTA endpoint for the very first time, the server generates a cryptographically secure, unique token for that specific MAC address. This token is saved in `devices.json` and passed back to the device. The device uses this token for all future voice WebSocket connections, ensuring each physical device is isolated and secure.

### 2. MCP Devices (Bring Your Own Token)
External MCP servers (like local file searchers or calculators) connect to the public `ws://10.0.0.101:3000/mcp` endpoint. 
- **Optional Tokens:** On the very first connection, you can provide a custom token: `ws://10.0.0.101:3000/mcp?device_id=my_pc_calculator&token=my_secret_password`. 
- **Locking:** The server saves this token to `mcp_devices.json` and permanently locks `my_pc_calculator` to that password. 
- **No Token:** If you connect without a token, the connection is allowed, but remains open for future reconnections.

### 3. Anti-Spam (Max Pending Limits)
To protect your server from being flooded or DOS'd by random connections from the public internet, the server enforces a strict limit of **10 pending unapproved devices** (for both Xiaozhi and MCP endpoints separately). If this limit is reached, the server will aggressively reject new connections with HTTP 403 or WebSocket 1008 errors, allowing system utilities like `fail2ban` to easily trap malicious IPs.

## Voice-Controlled Dashboard (Built-in MCP)

The server automatically injects a virtual MCP device called **"Parrot Dashboard (Built-in)"** into the AI's context. This device is permanently approved and enabled by default for all your Xiaozhi screens.

This means you can **control your server by simply talking to the AI**.

**Supported Voice Commands:**
- *"Are there any pending devices waiting for approval?"* -> The AI will check the server for new connections.
- *"Approve the new MCP device please."* -> The AI can instantly authorize a pending device so you don't have to open the web UI.
- *"Change your backend to Gemini and use the Aoede voice from now on."* -> The AI will securely update your `devices.json` configuration. (Note: config changes take effect on the *next* session).
- *"Update your system prompt to act like a pirate."*

## Setup Instructions

### 1. Prerequisites
- A **Google Gemini API Key** (supporting Live API) and/or an **Alibaba DashScope API Key**.
- Node.js 20+ environment.

### 2. Installation
```bash
cd xiaozhi-server-nodejs
npm install
```

### 3. Configuration
Copy the `.env.example` file to `.env` and fill in your values:
```bash
cp .env.example .env
```
If you are deploying locally, see [Local Linux Box Deployment](#4-local-linux-box-deployment) and use the `.env.example.local` template.

#### Production Deployment (Reverse Proxy)
For production environments, you should run the app behind a reverse proxy like **Nginx**. This handles SSL termination and provides a stable interface for WebSocket connections. 

Add the following to your Nginx site configuration:

```nginx
location / {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_pass http://127.0.0.1:3000;
    proxy_connect_timeout 5s;
    proxy_send_timeout 5s;
    proxy_read_timeout 5s;
}
```
You may want to consider creating a systemd service that runs the app.

### 4. Local Linux Box Deployment
For local testing on your Linux machine (e.g., Ubuntu, Raspberry Pi), you need to ensure your Xiaozhi device can reach the server over your local network (WiFi).

#### 1. Find Your Local IP
Run the following command to find your machine's IP address on the local network:
```bash
ip a
```
or:
```bash
hostname -I | awk '{print $1}'
```
Example output: `192.168.1.42` or `10.0.0.101`.

#### 2. Configure for Local Network
Copy the `.env.example.local` template and update it with your IP:
```bash
cp .env.example.local .env
```
Edit `.env` and replace `10.0.0.101` with your actual local IP in both `HOST`, `MQTT_ENDPOINT`, and `WEBSOCKET_URL_FOR_ALLOWED_DEVICE`. 

**Crucial:** Use `ws://` (WebSocket) instead of `wss://` (WebSocket Secure) for local connections, as local development servers typically don't have SSL certificates.

#### 3. Run the Server
```bash
node app.js
```
The server will now be listening on your local IP at port 3000:
```bash
:~/xiaozhi-server-nodejs$ node app.js
[dotenv@17.3.1] injecting env (10) from .env -- tip: 🔐 prevent building .env in docker: https://dotenvx.com/prebuild
[2026-03-21T13:04:09.945Z] INFO: Server listening on 10.0.0.101:3000
[2026-03-21T13:04:09.947Z] INFO: Web UI: http://10.0.0.101:3000/
[2026-03-21T13:04:09.947Z] INFO: MCP Endpoint: ws://10.0.0.101:3000/mcp
[2026-03-21T13:04:40.087Z] INFO: [OTA] POST request from fc:01:02:03:04:05
```

### 5. Connecting a Xiaozhi Device
Most Xiaozhi-compatible devices (like those from the https://github.com/78/xiaozhi-esp32 project) can probably be configured to point to your relay:

**Option A: Web Interface (Recommended)**
1.  **Connect to Device**: Use a mobile phone or computer to connect to the WiFi network named `Xiaozhi-xxxxxx` or `Zoe`.
2.  **Access Web Panel**: Open a browser and visit `http://192.168.4.1`.
3.  **Update OTA URL**: Locate the field labeled **OTA URL** and enter your custom server URL (e.g., `https://your-domain.com/xiaozhi/ota` or `http://10.0.0.101:3000/xiaozhi/ota`).

**Option B: Firmware Configuration**
If you are building the firmware yourself, adjust the OTA URL in `idf.py menuconfig` before flashing.

## Technical Details
- **Audio Input**: 16kHz, Mono, Opus.
- **Audio Output**: 24kHz, Mono, Opus (60ms frames).
- **Supported Models**: 
  - `gemini` backend: Optimized for `gemini-2.5-flash-native-audio-preview-12-2025` with full MCP Tool calling support.
  - `qwen_omni` backend: Optimized for `qwen3-omni-flash` with full MCP Tool calling via DashScope SSE streaming.
  - `qwen_realtime` backend: Optimized for `qwen3-omni-flash-realtime` for ultra-low latency voice (no tool support).

## Logs
Logs are automatically rotated and stored in the application root directory as `connection-YYYY-MM-DD.log`. These files contain detailed information about:
- OTA Discovery/Activation requests.
- WebSocket handshakes and authentication.
- LLM API session lifecycle and VAD state.
- Tool/MCP routing events.

In development, you can tail the current log:
```bash
tail -f connection-$(date +%Y-%m-%d).log
```

## Limitations
Only implements the websocket protocol, the mqtt endpoint is only a placeholder for now.