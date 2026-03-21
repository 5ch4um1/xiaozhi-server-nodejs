# Xiaozhi Relay - Gemini Live Bridge

A specialized Node.js relay that implements the **Xiaozhi Protocol**, bridging hardware devices (like ESP32 smartwatches and AI assistants) with the **Google Gemini 2.5 Live API**.

## Features
- **Xiaozhi Protocol Support**: Fully compatible with Xiaozhi "hello" handshakes, state management (stt, tts, abort), and binary audio transport.
- **Real-time Transcoding**: Converts 16kHz Opus from devices to PCM for Gemini, and 24kHz PCM from Gemini to 60ms Opus frames for devices.
- **Low Latency**: Direct WebSocket-to-WebSocket piping for minimal delay.
- **Secure**: Token-based authentication and manual MAC-based device approval.
- **Deployment Ready**: Easy deployment on standard Node.js hosting environments.

## How it Works
1.  **Handshake**: The Xiaozhi device connects and sends a `{"type": "hello", ...}` JSON message.
2.  **Session Initiation**: The relay validates the token and opens a persistent connection to Gemini Live.
3.  **Voice Interaction**: 
    - Device sends 16kHz Opus -> Relay decodes to PCM -> Gemini processes.
    - Gemini speaks PCM -> Relay encodes to 24kHz Opus (60ms frames) -> Device plays.
4.  **Feedback**: Relay sends STT and TTS text updates back to the device for display.

## Authentication
Currently, the server uses a single, global `CLIENT_AUTH_TOKEN` (defined in your `.env`) for all approved devices. When a device is manually approved via the discovery process, the server provides this shared token to the device for its WebSocket sessions.

**Note:** Support for dynamic, unique per-device tokens is planned for a future update to further enhance security and management.

## Setup Instructions

### 1. Prerequisites
- A **Google Gemini API Key** (supporting Live API).
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
3.  **Update OTA URL**: Locate the field labeled **OTA URL** and enter your custom server URL (e.g., `https://your-domain.com/xiaozhi/ota`).

**Option B: Firmware Configuration**
If you are building the firmware yourself, adjust the OTA URL in `idf.py menuconfig` before flashing.

## Technical Details
- **Audio Input**: 16kHz, Mono, Opus.
- **Audio Output**: 24kHz, Mono, Opus (60ms frames).
- **Supported Models**: Optimized for `gemini-2.5-flash-native-audio-preview-12-2025`.

## Logs
Logs are automatically rotated and stored in the application root directory as `connection-YYYY-MM-DD.log`. These files contain detailed information about:
- OTA Discovery/Activation requests.
- WebSocket handshakes and authentication.
- Gemini Live API session lifecycle.
- Tool/MCP routing events.

In development, you can tail the current log:
```bash
tail -f connection-$(date +%Y-%m-%d).log
```

## Limitations
Only implements the websocket protocol, the mqtt endpoint is only a placeholder for now.
Limited to the Gemini-live LLM backend for now, others are planned for future releases.
