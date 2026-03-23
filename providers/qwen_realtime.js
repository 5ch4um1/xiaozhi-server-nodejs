const LLMProvider = require('./base');
const WebSocket = require('ws');
const crypto = require('crypto');

class QwenRealtimeProvider extends LLMProvider {
    constructor(config) {
        super(config);
        this.session = null;
    }

    async connect(tools) {
        return new Promise((resolve, reject) => {
            try {
                const qwenUrl = `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${this.config.model}`;
                this.session = new WebSocket(qwenUrl, {
                    headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
                });

                this.session.on('open', () => {
                    this.emit('connected');
                    resolve();
                });
                
                this.session.on('message', (message) => {
                    try {
                        const response = JSON.parse(message.toString());
                        console.log('[Qwen Event]', response.type);
                        
                        if (response.type === 'session.created') {
                            const sessionUpdate = {
                                type: "session.update",
                                session: {
                                    modalities: ["text", "audio"],
                                    voice: this.config.voice,
                                    input_audio_format: "pcm16",
                                    output_audio_format: "pcm24",
                                    instructions: this.config.prompt,
                                    input_audio_transcription: { model: "gummy-realtime-v1" },
                                    turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
                                }
                            };
                            this.session.send(JSON.stringify(sessionUpdate));
                        }
                        
                        if (response.type === 'response.audio.delta' && response.delta) {
                            this.emit('audio_output', Buffer.from(response.delta, 'base64'));
                        } else if (response.type === 'response.audio.done' || response.type === 'response.done') {
                            this.emit('turn_complete');
                        } else if (response.type === 'response.audio_transcript.delta' && this.config.output_transcription && response.delta) {
                            this.emit('output_transcription', response.delta);
                        } else if (response.type === 'input_audio_buffer.cleared') {
                            this.emit('interrupted');
                        } else if (response.type === 'session.error' || response.type === 'error') {
                            this.emit('error', new Error(response.error?.message || 'Qwen Error'));
                        }
                    } catch (e) {
                        this.emit('error', new Error(`Failed to parse Qwen message: ${e.message}`));
                    }
                });

                this.session.on('close', () => this.emit('close'));
                this.session.on('error', (err) => {
                    this.emit('error', err);
                    reject(err);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    sendAudio(pcmChunk) {
        if (this.session && this.session.readyState === WebSocket.OPEN) {
            this.session.send(JSON.stringify({
                event_id: crypto.randomUUID(),
                type: 'input_audio_buffer.append',
                audio: pcmChunk.toString('base64')
            }));
        }
    }

    sendToolResponse(callId, name, resultText) {
        // Qwen realtime currently doesn't support tools natively via this exact ws protocol in Dashscope
        // No-op for now.
    }

    close() {
        if (this.session) {
            this.session.close();
            this.session = null;
        }
    }
}

module.exports = QwenRealtimeProvider;
