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
- Node.js 18+ environment.

### 2. Installation
```bash
cd Xiaozhi-server-NodeJs-simple
npm install
```

### 3. Configuration
Copy the `.env.example` file to `.env` and fill in your values:
```bash
cp .env.example .env
```

#### Production Deployment (Reverse Proxy)
For production environments, it is recommended to run the app behind a reverse proxy like **Nginx**. This handles SSL termination and provides a stable interface for WebSocket connections. 

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

### 4. Connecting a Xiaozhi Watch
Most Xiaozhi-compatible devices (like those from the "Xiaozhi-ESP32" project) can be configured to point to your relay:

**Option A: Web Interface (Recommended)**
1.  **Connect to Device**: Use a mobile phone or computer to connect to the WiFi network named `Xiaozhi-xxxxxx` or `Zoe`.
2.  **Access Web Panel**: Open a browser and visit `http://192.168.4.1`.
3.  **Update OTA URL**: Locate the field labeled **OTA URL** and enter your custom server URL (e.g., `https://your-domain.com/xiaozhi/ota`).
4.  **Auth Token**: Ensure the `CLIENT_AUTH_TOKEN` in your `.env` matches the token expected by the device.

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
