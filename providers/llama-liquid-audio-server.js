const LLMProvider = require('./base');
const fs = require('fs');

class MockSession extends (require('events')) {
    constructor() { super(); }
    sendRealtimeInput(data) {}
    sendToolResponse(call) {}
    send(data) {}
}

class LlamaLiquidAudioServerProvider extends LLMProvider {
    constructor(config) {
        super(config);
        this.serverUrl = config.url || 'http://127.0.0.1:8080/v1/chat/completions';
        this.audioBuffer = []; 
        this.preSpeechBuffer = []; // Keeps audio history to not lose the beginning of words
        this.isSpeaking = false;
        this.silenceFrames = 0;
        this.speechFrames = 0;
        this.processing = false; 

        // Advanced VAD Config
        this.energyThreshold = 300; // Increased base threshold (was 250)
        this.noiseFloor = 100; // Dynamic noise floor tracker
        this.silenceDurationMs = 1500; 
        this.frameDurationMs = 60; 
        this.maxSilenceFrames = Math.ceil(this.silenceDurationMs / this.frameDurationMs);
        this.minSpeechFrames = 3; // Require 3 consecutive frames (~180ms) above threshold to trigger (debounce)
        this.maxPreSpeechFrames = 10; // Keep up to 600ms of audio prior to speech detection
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
        this.session = new MockSession();
        this.emit('connected');
    }

    async sendAudio(pcmChunk) {
        if (this.processing) return; 

        const rms = this.calculateRMS(pcmChunk);

        // Slowly adapt noise floor to current background noise if it's relatively quiet
        if (rms < this.energyThreshold) {
            this.noiseFloor = (this.noiseFloor * 0.95) + (rms * 0.05);
        }

        // Dynamic threshold: strictly higher than noise floor and absolute minimum
        const dynamicThreshold = Math.max(this.energyThreshold, this.noiseFloor * 2.5);

        if (rms > dynamicThreshold) {
            if (!this.isSpeaking) {
                this.speechFrames++;
                this.preSpeechBuffer.push(pcmChunk);
                if (this.preSpeechBuffer.length > this.maxPreSpeechFrames) {
                    this.preSpeechBuffer.shift();
                }

                // If we've had enough consecutive loud frames, trigger speech state!
                if (this.speechFrames >= this.minSpeechFrames) {
                    this.isSpeaking = true;
                    // Move the pre-speech buffer to the main buffer so we don't lose the start of the word
                    this.audioBuffer = [...this.preSpeechBuffer];
                    this.preSpeechBuffer = [];
                    // console.log(`[LlamaLiquidAudioServer] Speech detected! RMS: ${Math.round(rms)} > Threshold: ${Math.round(dynamicThreshold)}`);
                }
            } else {
                this.silenceFrames = 0;
                this.audioBuffer.push(pcmChunk); 
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

    async fetchAudioAndText(messages, emitText = false) {
        const response = await fetch(this.serverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.config.model || 'llama-liquid-tts',
                messages,
                stream: true
            })
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let audioBuffers = [];
        let fullText = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let lines = buffer.split('\n');
            buffer = lines.pop(); 
            for (let line of lines) {
                line = line.trim();
                if (line.startsWith('data:')) {
                    const dataStr = line.substring(5).trim();
                    if (dataStr === '[DONE]') continue;
                    try {
                        const json = JSON.parse(dataStr);
                        if (json.choices && json.choices.length > 0) {
                            const delta = json.choices[0].delta;
                            
                            // Audio
                            const audioObj = delta.audio_chunk || delta.audio;
                            if (audioObj && audioObj.data) {
                                audioBuffers.push(Buffer.from(audioObj.data, 'base64'));
                            }

                            // Text
                            if (delta.content) {
                                let newText = '';
                                if (typeof delta.content === 'string') newText = delta.content;
                                else if (Array.isArray(delta.content)) {
                                    for (const item of delta.content) {
                                        if (item.type === 'text') newText += item.text;
                                        if (item.type === 'audio' && item.audio && item.audio.data) {
                                            audioBuffers.push(Buffer.from(item.audio.data, 'base64'));
                                        }
                                    }
                                }
                                if (newText) {
                                    fullText += newText;
                                    if (emitText) this.emit('output_transcription', newText);
                                }
                            }
                        }
                    } catch(e) {}
                }
            }
        }
        return { text: fullText.trim(), audio: Buffer.concat(audioBuffers) };
    }

    async processAudioBuffer() {
        if (this.audioBuffer.length === 0) {
            this.processing = false;
            return;
        }

        const fullAudio = Buffer.concat(this.audioBuffer);
        this.audioBuffer = []; 
        this.processing = true;
        this.emit('listen_stop'); // Tell Xiaozhi to stop listening animation

        const payloadLength = fullAudio.length;
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

        const wavBuffer = Buffer.concat([wavHeader, fullAudio]);
        const base64Audio = wavBuffer.toString('base64');

        console.log(`[LlamaLiquidAudioServer] Processing user audio (${payloadLength / 32000} seconds)`);

        try {
            // STEP 1: ASR
            console.log(`[LlamaLiquidAudioServer] Step 1: Extracting text from user audio (ASR)`);
            const asrMessages = [
                { 
                  "role": "user", 
                  "content": [
                      { "type": "input_audio", "input_audio": { "data": base64Audio, "format": "wav" } }
                  ]
                }
            ];
            const asrResult = await this.fetchAudioAndText(asrMessages, false);
            const userText = asrResult.text || "[Inaudible]";
            console.log(`[LlamaLiquidAudioServer] User said: ${userText}`);
            this.emit('input_transcription', userText);

            // STEP 2: Chat LLM + TTS
            console.log(`[LlamaLiquidAudioServer] Step 2: Generating chat response and TTS audio`);
            const ttsInstruction = `Perform TTS. Use the ${this.config.voice || 'US male'} voice.`;
            const chatMessages = [
                { "role": "system", "content": ttsInstruction },
                { "role": "user", "content": userText }
            ];
            
            // Emit text dynamically as it streams, but gather audio fully
            const chatResult = await this.fetchAudioAndText(chatMessages, false); // false = wait to emit text
            console.log(`[LlamaLiquidAudioServer] Assistant replied: ${chatResult.text}`);
            console.log(`[LlamaLiquidAudioServer] TTS finished, generated ${chatResult.audio.length} bytes of audio.`);

            // Now that audio is fully ready, emit the full text so the screen doesn't time out while waiting
            this.emit('output_transcription', chatResult.text);

            if (chatResult.audio.length > 0) {
                // Save to temporary file as requested
                const tempFile = `/tmp/xiaozhi_tts_${Date.now()}.pcm`;
                require('fs').writeFileSync(tempFile, chatResult.audio);
                console.log(`[LlamaLiquidAudioServer] Saved resulting audio to ${tempFile}`);

                // Read the temporary file and emit the audio back to Xiaozhi
                const savedAudio = require('fs').readFileSync(tempFile);
                let offset = 0;
                while (offset < savedAudio.length) {
                    const end = Math.min(offset + 2880, savedAudio.length);
                    let chunk = savedAudio.subarray(offset, end);
                    if (chunk.length < 2880) {
                        const padded = Buffer.alloc(2880);
                        chunk.copy(padded);
                        chunk = padded;
                    }
                    this.emit('audio_output', chunk);
                    offset += 2880;
                    
                    // Yield to the event loop and drip-feed the encoder. 
                    // This is crucial: it prevents `turn_complete` from firing synchronously
                    // before the encoder has a chance to populate app.js's audioOutputQueue.
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                
                // Clean up temp file
                require('fs').unlinkSync(tempFile);
            } else {
                console.warn(`[LlamaLiquidAudioServer] No audio generated in response.`);
            }

        } catch (e) {
            console.error(`[LlamaLiquidAudioServer] Error during pipeline:`, e);
            this.emit('error', new Error(`Error connecting to Llama Liquid Audio Server: ${e.message}`));
        } finally {
            this.processing = false;
            console.log(`[LlamaLiquidAudioServer] Emitting turn_complete.`);
            this.emit('turn_complete');
        }
    }

    sendToolResponse(callId, name, resultText) {
        console.warn('LlamaLiquidAudioServerProvider does not support sending tool responses.');
    }

    interrupt() {
        this.emit('turn_complete'); 
    }

    close() {
        this.emit('close');
    }
}

module.exports = LlamaLiquidAudioServerProvider;
