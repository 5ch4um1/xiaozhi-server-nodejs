const LLMProvider = require('./base');
const crypto = require('crypto');

class QwenOmniProvider extends LLMProvider {
    constructor(config) {
        super(config);
        this.audioBuffer = [];
        this.isSpeaking = false;
        this.silenceFrames = 0;
        
        // VAD Config
        this.energyThreshold = 150; // Lowered to be much more sensitive
        this.silenceDurationMs = 2000; // 2 seconds of silence triggers end of speech
        this.frameDurationMs = 60; // 60ms frames from Opus decoder
        this.maxSilenceFrames = Math.ceil(this.silenceDurationMs / this.frameDurationMs);
        
        this.messages = [
            { role: "system", content: [{ type: "text", text: this.config.prompt }] }
        ];
        this.tools = [];
        this.processing = false;
    }

    async connect(tools) {
        if (tools && tools.length > 0) {
            this.tools = tools.map(t => ({
                type: "function",
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
            }));

            // Enforce tool calling behavior for Qwen Omni to prevent action hallucination
            if (this.messages.length > 0 && this.messages[0].role === 'system') {
                const toolNames = this.tools.map(t => t.function.name).join(', ');
                this.messages[0].content[0].text += "\\n\\nCRITICAL INSTRUCTIONS FOR ACTIONS:\\n1. You have access to tools: [" + toolNames + "].\\n2. When asked to perform an action, you must emit the JSON tool call to fulfill it. However, DO NOT emit the tool call if the action has already been completed successfully in the current conversation history.\\n3. Keep your text/audio response extremely brief and natural (e.g., 'Okay', 'Done', 'Turning it on'). Do not read the function name or JSON arguments out loud.\\n4. Never pretend to do an action without emitting the actual tool call (unless it's already done).\\n5. If a tool call fails or times out, inform the user briefly and do not retry it.";
            }
        }
        
        // We simulate a connection since it's a stateless REST API
        process.nextTick(() => {
            this.emit('connected');
        });
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

    sendAudio(pcmChunk) {
        if (this.processing) return; // Drop audio if we are currently processing a request

        const rms = this.calculateRMS(pcmChunk);
        
        if (rms > this.energyThreshold) {
            if (!this.isSpeaking) {
                console.log('[Qwen Omni] Voice detected! RMS:', Math.round(rms));
            }
            this.isSpeaking = true;
            this.silenceFrames = 0;
            this.audioBuffer.push(pcmChunk);
        } else {
            if (this.isSpeaking) {
                this.audioBuffer.push(pcmChunk);
                this.silenceFrames++;
                
                if (this.silenceFrames >= this.maxSilenceFrames) {
                    console.log('[Qwen Omni] Silence detected, processing audio...');
                    this.isSpeaking = false;
                    this.silenceFrames = 0;
                    this.processAudioBuffer();
                }
            }
        }
    }

    async processAudioBuffer() {
        if (this.audioBuffer.length === 0) return;
        
        const fullAudio = Buffer.concat(this.audioBuffer);
        this.audioBuffer = []; // Clear buffer
        this.processing = true;

        // Prepend WAV Header
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
        
        this.messages.push({
            role: "user",
            content: [
                {
                    type: "input_audio",
                    input_audio: {
                        data: "data:audio/wav;base64," + base64Audio,
                        format: "wav"
                    }
                }
            ]
        });

        await this.sendChatCompletion();
    }

    async sendChatCompletion() {
        console.log('[Qwen Omni] Sending chat completion request...');
        try {
            // Map messages to native DashScope format
            const nativeMessages = this.messages.map(msg => {
                let content = [];
                if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === "text" || part.text) content.push({ text: part.text });
                        else if (part.type === "input_audio" && part.input_audio) content.push({ audio: part.input_audio.data });
                        else if (part.audio) content.push({ audio: part.audio });
                    }
                } else if (typeof msg.content === 'string') {
                    content.push({ text: msg.content });
                }

                const newMsg = { role: msg.role };
                if (msg.tool_calls) {
                    newMsg.tool_calls = msg.tool_calls.map(tc => ({
                        id: tc.id,
                        type: tc.type || "function",
                        function: {
                            name: tc.function?.name || tc.name,
                            arguments: tc.function?.arguments || tc.arguments
                        }
                    }));
                }
                if (msg.role === "tool") {
                    newMsg.name = msg.name || "tool";
                    newMsg.tool_call_id = msg.tool_call_id;
                    newMsg.content = [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }];
                } else {
                    newMsg.content = content;
                }
                return newMsg;
            });

            const payload = {
                model: this.config.model || "qwen3-omni-flash",
                input: {
                    messages: nativeMessages
                },
                parameters: {
                    stream: true,
                    incremental_output: true,
                    result_format: "message",
                    modalities: ["text", "audio"],
                    audio: { voice: this.config.voice || "Cherry", format: "pcm16" }
                }
            };

            if (this.tools.length > 0) {
                payload.parameters.tools = this.tools;
                payload.parameters.tool_choice = "auto";
            }

            const response = await fetch('https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json',
                    'X-DashScope-SSE': 'enable'
                },
                body: JSON.stringify(payload)
            });

            console.log(`[Qwen Omni] Response status: ${response.status}`);

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`API Error ${response.status}: ${errorData}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            
            let fullText = '';
            let toolCallsMap = new Map();
            let chunkCount = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunkCount++;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line
                
                for (let line of lines) {
                    line = line.trim();
                    if (!line || line.startsWith(':')) continue;
                    if (line === 'data: [DONE]') continue;
                    
                    if (line.startsWith('data:')) {
                        let jsonStr = line.slice(5).trim();
                        if (!jsonStr) continue;

                        try {
                            const data = JSON.parse(jsonStr);
                            const choice = data.output?.choices?.[0];
                            if (!choice) continue;

                            const msg = choice.message;
                            if (!msg) continue;
                            
                            // Handle Text Output
                            if (msg.content && Array.isArray(msg.content)) {
                                for (const part of msg.content) {
                                    if (part.text) {
                                        fullText += part.text;
                                        if (this.config.output_transcription) {
                                            this.emit('output_transcription', part.text);
                                        }
                                    }
                                    if (part.audio && part.audio.data) {
                                        const audioBuf = Buffer.from(part.audio.data, 'base64');
                                        this.emit('audio_output', audioBuf);
                                    }
                                }
                            }
                            
                            // Handle Tool Calls
                            if (msg.tool_calls) {
                                for (const tc of msg.tool_calls) {
                                    if (!toolCallsMap.has(tc.index)) {
                                        toolCallsMap.set(tc.index, { id: tc.id || "", name: tc.function?.name || "", arguments: "" });
                                    }
                                    const t = toolCallsMap.get(tc.index);
                                    if (tc.id && !t.id) t.id = tc.id;
                                    if (tc.function?.name && !t.name) t.name = tc.function.name;
                                    if (tc.function?.arguments) t.arguments += tc.function.arguments;
                                }
                            }
                            
                        } catch(e) {
                            console.error("[Qwen Omni] Failed to parse SSE line:", line, e.message);
                        }
                    }
                }
            }

            console.log(`[Qwen Omni] Stream finished after ${chunkCount} chunks. Text length: ${fullText.length}, Tools: ${toolCallsMap.size}`);

            // After stream finishes, reconstruct message and append to history
            const assistantMessage = { role: "assistant", content: fullText };
            
            if (toolCallsMap.size > 0) {
                assistantMessage.tool_calls = [];
                for (const [index, tc] of toolCallsMap.entries()) {
                    assistantMessage.tool_calls.push({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: tc.arguments }
                    });
                    
                    let args = {};
                    try {
                        args = JSON.parse(tc.arguments);
                    } catch(e) {
                        console.error(`[Qwen Omni] Failed to parse tool arguments for ${tc.name}:`, tc.arguments);
                    }
                    console.log(`[Qwen Omni] Emitting tool_call event for ${tc.name} with args:`, args);
                    this.emit('tool_call', tc.id, tc.name, args);
                }
                this.messages.push(assistantMessage);
                // We stay in "processing" state until tools return
            } else {
                this.messages.push(assistantMessage);
                this.processing = false;
                this.emit('turn_complete');
            }

        } catch (e) {
            this.emit('error', new Error(`Qwen Omni Error: ${e.message}`));
            this.processing = false;
            this.emit('turn_complete'); // Reset state on error
        }
    }

    sendToolResponse(callId, name, resultText) {
        this.messages.push({
            role: "tool",
            tool_call_id: callId,
            name: name,
            content: resultText
        });

        // Trigger the next chat completion with the tool results
        this.sendChatCompletion();
    }

    close() {
        this.audioBuffer = [];
        this.isSpeaking = false;
        this.processing = false;
    }
}

module.exports = QwenOmniProvider;