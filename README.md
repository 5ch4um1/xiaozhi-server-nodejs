# Xiaozhi Universal Relay - Multi-LLM Bridge

A modular Node.js relay that implements the **[Xiaozhi Protocol](https://github.com/78/xiaozhi-esp32)**, bridging hardware devices (like ESP32 smartwatches and AI assistants) with various LLM backends including **Google Gemini**, **Alibaba Qwen**, and local **LFM3-Audio (Liquid Foundation Models)** via the **[llama.cpp `/v1/realtime` API](https://github.com/ggml-org/llama.cpp)**.

## Features
- **Xiaozhi Protocol Support**: Fully compatible with Xiaozhi "hello" handshakes, state management (stt, tts, abort), and binary audio transport.
- **Universal Modular Architecture**: Built on a highly modular `LLMProvider` adapter pattern. The server starts even if no providers are configured, allowing you to manage everything via the web dashboard.
- **Supported Backends**:
  - **Google Gemini Live**: Full real-time streaming with MCP Tool calling support.
  - **Alibaba Qwen (Omni & Realtime)**: Support for `qwen3-omni-flash` with full **MCP Tool calling** and `qwen3-omni-flash-realtime` for ultra-low latency.
  - **Local LFM3-Audio**: Native interleaved speech and text through llama.cpp's OpenAI-compatible `/v1/realtime` WebSocket API, including **MCP tool calling**.
- **Dynamic Configuration Dashboard**: Choose between backends, models, and custom voices per-device. The UI automatically labels and disables providers that are missing required API keys or environment variables.
- **Built-in Dashboard MCP**: Control the server itself by talking to the AI! Approve new devices and change configurations via voice commands.
- **Real-time Transcoding**: Converts 16kHz Opus from devices to PCM, and transcodes LLM PCM responses back to 60ms Opus frames.
- **Low Latency**: Direct WebSocket piping for minimal delay.
- **Secure**: Features per-device dynamic tokens and max-pending rate limits for anti-spam.

## How it Works
1.  **Handshake**: The Xiaozhi device connects and sends a `{"type": "hello", ...}` JSON message.
2.  **Session Initiation**: The relay validates the token and instantiates the configured `LLMProvider`. If a provider is selected but not configured (e.g., missing API key), the device receives a graceful error message.
3.  **Voice Interaction**: 
    - Device sends 16kHz Opus -> Relay decodes to PCM -> LLM Provider processes (using Server VAD or custom Energy VAD).
    - LLM speaks PCM -> Relay encodes to 24kHz Opus -> Device plays.
    - If supported by the model, the Relay routes **MCP (Model Context Protocol)** tool calls to connected devices.
4.  **Feedback**: Relay sends STT and TTS text updates back to the device for display.

## Authentication & Security

The server features a multi-layered authentication system:
- **Xiaozhi Devices**: Automatically assigned unique tokens upon first discovery via the OTA endpoint.
- **MCP Devices**: Support for "Bring Your Own Token" to lock specific device IDs.
- **Anti-Spam**: Strict limits on pending unapproved devices to prevent DOS attacks.

## Setup Instructions

### 1. Installation
```bash
cd xiaozhi-server-nodejs
npm install
```

### 2. Configuration
Copy the `.env.example` file and fill in your keys:
```bash
cp .env.example .env
```
Available providers will depend on which environment variables (e.g., `GEMINI_API_KEY`, `DASHSCOPE_API_KEY`, `LIQUID_SERVER_URL`) are populated.

#### Local LFM3-Audio with tool calling

The `llama_liquid_interleaved` backend uses the LFM3 realtime provider in `providers/llama-liquid-lfm3.js`. It connects to llama.cpp's `/v1/realtime` WebSocket, streams interleaved text and speech, and supports **MCP tool calling**: tool definitions are sent with the realtime session, the model emits `<tool_call>` requests, and the relay executes them through the connected Xiaozhi device (or the built-in dashboard MCP) before sending the result back to the model.

Start llama.cpp with an LFM3-Audio GGUF, its audio projector, and Jinja templates enabled:

```bash
llama-server \
  -m /path/to/LFM3-Audio-2B-Q4_K_M.gguf \
  --mmproj /path/to/mmproj-LFM3-Audio-2B-Q8_0.gguf \
  -c 32768 --host 127.0.0.1 --port 8080 --jinja -ngl 99
```

`--jinja` is required for tool calling, and `--mmproj` is required for audio input/output. You can also let llama.cpp download the model:

```bash
llama-server -hf LiquidAI/LFM3-Audio-2B-GGUF
```

Then configure the relay:

```dotenv
LIQUID_SERVER_URL=http://127.0.0.1:8080
LLM_BACKEND=llama_liquid_interleaved
```

The relay appends `/v1/realtime` automatically, so `LIQUID_SERVER_URL` should be the llama.cpp base URL without `/v1/chat/completions`. When tools are available, the provider leaves the output modality unset so the model starts in text/tool-call mode; forcing `text,audio` makes llama.cpp prefill `<|mixed_start|>`, which encourages spoken narration instead of a tool call.

> **Device shows "Check for new version failed"?** The device's OTA URL comes from its firmware build (`CONFIG_OTA_URL`, usually `http://<server-ip>:3000/xiaozhi/ota/`). Make sure the relay listens on a LAN-reachable address (`HOST=0.0.0.0` or the machine's LAN IP, not `127.0.0.1`) and that `WEBSOCKET_URL_FOR_ALLOWED_DEVICE` uses the same LAN IP/hostname. `HOST=127.0.0.1` only works behind a local reverse proxy.

### 3. Local Development
For local testing (Ubuntu, Raspberry Pi, etc.), use the `.env.example.local` template and ensure you use your machine's local IP address instead of `localhost`.

### 4. Running the Server
```bash
node app.js
```
Access the dashboard at `http://YOUR_IP:3000`.

## Technical Details
- **Audio Input**: 16kHz, Mono, Opus.
- **Audio Output**: 24kHz, Mono, Opus (60ms frames).

## Logs
Logs are automatically rotated and stored as `connection-YYYY-MM-DD.log`, tracking OTA requests, WebSocket handshakes, and LLM session lifecycles.

## Limitations
- Only implements the WebSocket protocol; the MQTT endpoint is a placeholder.
- Tool calling (MCP) is supported for Gemini, Qwen Omni, and LFM3-Audio.
