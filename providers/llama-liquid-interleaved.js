const LLMProvider = require('./base');

class LlamaLiquidInterleavedProvider extends LLMProvider {
    constructor(config) {
        super(config);
        this.serverUrl = config.url || 'http://127.0.0.1:8080/v1/chat/completions';
        this.audioBuffer = [];
        this.preSpeechBuffer = [];
        this.isSpeaking = false;
        this.silenceFrames = 0;
        this.speechFrames = 0;
        this.processing = false;

        // VAD Config
        this.energyThreshold = 300;
        this.noiseFloor = 100;
        this.silenceDurationMs = 1500;
        this.frameDurationMs = 60;
        this.maxSilenceFrames = Math.ceil(this.silenceDurationMs / this.frameDurationMs);
        this.minSpeechFrames = 3;
        this.maxPreSpeechFrames = 10;
    }

    calculateRMS(pcmBuffer) {
        let sumSquares = 0;
        const numSamples = pcmBuffer.length / 2;
        for (let i = 0; i < pcmBuffer.length; i += 2) {
            const sample = pcmBuffer.readInt16LE(i);
            sumSquares += sample * sample;
        }
        return Math.sqrt(sumSquares / numSamples);
    }

    async connect(tools) {
        // We completely ignore tools for LlamaLiquidInterleavedProvider as it causes
        // prompt bloat and crashes the LFM server.
        this.emit('connected');
    }

    sendAudio(pcmChunk) {
        if (this.processing) return;
        const rms = this.calculateRMS(pcmChunk);

        if (rms < this.energyThreshold) {
            this.noiseFloor = (this.noiseFloor * 0.95) + (rms * 0.05);
        }

        const dynamicThreshold = Math.max(this.energyThreshold, this.noiseFloor * 2.5);

        if (rms > dynamicThreshold) {
            if (!this.isSpeaking) {
                this.speechFrames++;
                if (this.speechFrames >= this.minSpeechFrames) {
                    this.isSpeaking = true;
                    this.audioBuffer.push(...this.preSpeechBuffer);
                    this.preSpeechBuffer = [];
                }
            }
            if (this.isSpeaking) {
                this.silenceFrames = 0;
                this.audioBuffer.push(pcmChunk);
            } else {
                this.preSpeechBuffer.push(pcmChunk);
                if (this.preSpeechBuffer.length > this.maxPreSpeechFrames) {
                    this.preSpeechBuffer.shift();
                }
            }
        } else {
            if (this.isSpeaking) {
                this.audioBuffer.push(pcmChunk);
                this.silenceFrames++;
                if (this.silenceFrames >= this.maxSilenceFrames) {
                    this.isSpeaking = false;
                    this.silenceFrames = 0;
                    this.speechFrames = 0;
                    this.processAudioBuffer();
                }
            } else {
                this.speechFrames = 0;
                 this.preSpeechBuffer.push(pcmChunk);
                if (this.preSpeechBuffer.length > this.maxPreSpeechFrames) {
                    this.preSpeechBuffer.shift();
                }
            }
        }
    }

    async processAudioBuffer() {
        if (this.audioBuffer.length === 0 || this.processing) {
            return;
        }
        this.processing = true;
        this.emit('listen_stop');

        const fullAudio = Buffer.concat(this.audioBuffer);
        this.audioBuffer = [];

        const wavBuffer = this.createWav(fullAudio);
        const base64Audio = wavBuffer.toString('base64');

        const userContent = [{
            type: 'input_audio',
            input_audio: { data: base64Audio, format: 'wav' }
        }];

        await this.sendInteraction(userContent);
    }

    async sendInteraction(userContent) {
        // Exactly mirroring the lfmlab system prompt and message structure.
        // No extra config, no tools, no history.
        const messages = [
            {
                role: 'system',
                content: 'Respond with interleaved text and audio. Use the UK female voice'
            },
            {
                role: 'user',
                content: userContent
            }
        ];

        try {
            await this.streamInterleavedResponse(messages);
        } catch (e) {
            this.emit('error', new Error(`Error during interleaved stream: ${e.message}`));
        } finally {
            this.processing = false;
            this.emit('turn_complete');
        }
    }

    async streamInterleavedResponse(messages) {
        const abortController = new AbortController();
        
        const requestBody = {
            model: this.config.model || 'llama-liquid-interleaved',
            messages,
            modalities: ['text', 'audio'],
            stream: true,
            max_tokens: 2048,
            reset_context: false,
        };

        const response = await fetch(this.serverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let completed = false;

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                if (!completed) {
                    completed = true;
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6).trim();

                    if (dataStr === '[DONE]') {
                        if (!completed) {
                            completed = true;
                        }
                        break;
                    }

                    try {
                        const json = JSON.parse(dataStr);
                        const delta = json.choices?.[0]?.delta;

                        if (delta) {
                            if (delta.content) {
                                if (typeof delta.content === 'string') {
                                    this.emit('output_transcription', delta.content);
                                }
                            }

                            if (delta.audio && delta.audio.data) {
                                const pcmChunk = Buffer.from(delta.audio.data, 'base64');
                                this.emit('audio_output', pcmChunk);
                            }
                        }
                    } catch (e) {
                        // ignore parse errors
                    }
                }
            }
            if (completed) break;
        }
    }

    createWav(pcmBuffer) {
        const payloadLength = pcmBuffer.length;
        const wavHeader = Buffer.alloc(44);
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(36 + payloadLength, 4);
        wavHeader.write('WAVE', 8);
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16);
        wavHeader.writeUInt16LE(1, 20);
        wavHeader.writeUInt16LE(1, 22);
        wavHeader.writeUInt32LE(16000, 24);
        wavHeader.writeUInt32LE(16000 * 2, 28);
        wavHeader.writeUInt16LE(2, 32);
        wavHeader.writeUInt16LE(16, 34);
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(payloadLength, 40);
        return Buffer.concat([wavHeader, pcmBuffer]);
    }

    interrupt() {
        this.processing = false;
        this.audioBuffer = [];
        this.preSpeechBuffer = [];
        this.emit('turn_complete');
    }

    close() {
        this.emit('close');
    }
}

module.exports = LlamaLiquidInterleavedProvider;
