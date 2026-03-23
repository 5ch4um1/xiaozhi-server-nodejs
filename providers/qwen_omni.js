const LLMProvider = require('./base');

class QwenOmniProvider extends LLMProvider {
    constructor(config) {
        super(config);

        this.audioBuffer = [];
        this.isSpeaking = false;
        this.silenceFrames = 0;

        // Voice Activity Detection (VAD) Config
        this.energyThreshold = 250; // RMS threshold to detect speaking
        this.silenceDurationMs = 1500; // Time in silence before submitting audio
        this.frameDurationMs = 60; // Approximate Opus frame time
        this.maxSilenceFrames = Math.ceil(this.silenceDurationMs / this.frameDurationMs);

        console.log(`[Qwen Omni] CONSTRUCTOR: Initialized VAD: threshold=${this.energyThreshold}, silenceDurationMs=${this.silenceDurationMs}, maxSilenceFrames=${this.maxSilenceFrames}`);

        this.messages = [
            { role: "system", content: [{ type: "text", text: this.config.prompt }] }
        ];
        console.log(`[Qwen Omni] CONSTRUCTOR: Initial System Message:`, this.messages[0]);
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
            console.log(`[Qwen Omni] CONNECT: Formatted tools:`, this.tools);

            const toolNames = this.tools.map(t => t.function.name).join(', ');
            this.messages[0].content[0].text += `

CRITICAL INSTRUCTION: You have access to tools: [${toolNames}]. Respond briefly and naturally. Don't read tool names. Emit tool JSON when performing an action. Do NOT emit a tool call if the action has already been completed successfully in the current conversation history.`;
            console.log(`[Qwen Omni] CONNECT: Injected tool instructions. New system prompt length:`, this.messages[0].content[0].text.length);
        }

        process.nextTick(() => {
            console.log(`[Qwen Omni] CONNECT: Emitting 'connected' event.`);
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
        if (this.processing) return;

        const rms = this.calculateRMS(pcmChunk);

        if (rms > this.energyThreshold) {
            if (!this.isSpeaking) {
                console.log(`[Qwen Omni] SENDAUDIO: Voice detected! RMS: ${Math.round(rms)}`);
            }
            this.isSpeaking = true;
            this.silenceFrames = 0;
            this.audioBuffer.push(pcmChunk);
        } else {
            if (this.isSpeaking) {
                this.audioBuffer.push(pcmChunk);
                this.silenceFrames++;

                if (this.silenceFrames >= this.maxSilenceFrames) {
                    console.log(`[Qwen Omni] SENDAUDIO: Silence duration exceeded (${this.silenceFrames} frames >= ${this.maxSilenceFrames}). Triggering audio processing...`);
                    this.isSpeaking = false;
                    this.silenceFrames = 0;
                    this.processAudioBuffer();
                }
            }
        }
    }
    async processAudioBuffer() {
        //console.log(`[Qwen Omni] PROCESSAUDIOBUFFER: Called. Buffer length: ${this.audioBuffer.length}`);
        if (this.audioBuffer.length === 0) return;

        //console.log(`[Qwen Omni] PROCESSAUDIOBUFFER: History BEFORE adding user audio:`, this.messages);
        const fullAudio = Buffer.concat(this.audioBuffer);
        //console.log(`[Qwen Omni] PROCESSAUDIOBUFFER: Concatenated audio size: ${fullAudio.length} bytes`);
        this.audioBuffer = [];
        this.processing = true;

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
        //console.log(`[Qwen Omni] PROCESSAUDIOBUFFER: Generated WAV buffer size: ${wavBuffer.length}, Base64 audio length: ${base64Audio.length}`);

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
        //console.log(`[Qwen Omni] PROCESSAUDIOBUFFER: History AFTER adding user audio:`, this.messages);

        await this.sendChatCompletion();    }

    async sendChatCompletion() {
        //console.log(`[Qwen Omni] ================== REQUEST START ==================`);
        //console.log(`[Qwen Omni] SENDCHATCOMPLETION: History:`, this.messages);
        try {
            const nativeMessages = this.messages.map((msg, idx) => {
                //console.log(`[Qwen Omni] SENDCHATCOMPLETION: Mapping message #${idx}:`, msg);
                const newMsg = { role: msg.role };
                if (msg.role === "tool") {
                    newMsg.name = msg.name || "tool";
                    newMsg.tool_call_id = msg.tool_call_id;
                    // Explicitly ensure 'type: "text"' for tool content
                    newMsg.content = [{ type: "text", text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }];
                } else {
                    let contentArray = [];
                    if (Array.isArray(msg.content)) {
                        for (const part of msg.content) {
                            //console.log(`[Qwen Omni] SENDCHATCOMPLETION: Mapping message #${idx} content part:`, part);
                            // Ensure type is always set and not empty
                            let contentType = part.type;
                            if (!contentType || contentType === '') {
                                if (part.text) contentType = "text";
                                else if (part.input_audio) contentType = "input_audio"; // Corrected to input_audio
                                else contentType = "text"; // Default fallback
                            }

                            if (contentType === "text") contentArray.push({ type: "text", text: part.text });
                            else if (contentType === "input_audio" && part.input_audio) contentArray.push({ type: "audio", audio: part.input_audio.data }); // Use type: "audio" for payload
                        }
                    } else if (typeof msg.content === 'string') {
                        // Ensure plain string content always gets 'type: "text"'
                        contentArray.push({ type: "text", text: msg.content });
                    }
                    newMsg.content = contentArray;
                }
                if (msg.tool_calls) {
                    newMsg.tool_calls = msg.tool_calls.map(tc => ({
                        id: tc.id,
                        type: tc.type || "function",
                        function: {
                            name: tc.function?.name || tc.name,
                            arguments: tc.function?.arguments || tc.arguments
                        }
                    }));
                    //console.log(`[Qwen Omni] SENDCHATCOMPLETION: Mapped tool_calls for message #${idx}:`, newMsg.tool_calls);
                }
                //console.log(`[Qwen Omni] SENDCHATCOMPLETION: Mapped native message #${idx}:`, newMsg);
                return newMsg;
            });

            //console.log(`[Qwen Omni] SENDCHATCOMPLETION: All native messages (before payload assembly):`, nativeMessages);

            const payload = {
                model: "qwen3-omni-flash",
                input: { messages: nativeMessages },
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
               // console.log(`[Qwen Omni] SENDCHATCOMPLETION: Added tools to payload:`, payload.parameters.tools);
            }

            const payloadForLogging = JSON.parse(JSON.stringify(payload)); // Deep copy
            payloadForLogging.input.messages.forEach(msg => {
                if (msg.role === "user" && Array.isArray(msg.content)) {
                    msg.content.forEach(part => {
                        if (part.type === "audio" && part.audio && part.audio.data) {
                            delete part.audio.data; // Completely remove audio data for logging
                        }
                    });
                }
            });

            const url = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
            const headers = {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
                'X-DashScope-SSE': 'enable'
            };

            //console.log(`[Qwen Omni] SENDCHATCOMPLETION: Sending POST to URL: ${url}`);
           // console.log(`[Qwen Omni] SENDCHATCOMPLETION: Request Headers (Auth Redacted):`, { ...headers, 'Authorization': 'Bearer [REDACTED]' });

            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            //console.log(`[Qwen Omni] SENDCHATCOMPLETION: Response Status: ${response.status} ${response.statusText}`);

            const respHeaders = {};
            response.headers.forEach((v, k) => respHeaders[k] = v);
            //console.log(`[Qwen Omni] SENDCHATCOMPLETION: Response Headers:`, respHeaders);

            if (!response.ok) {
                const errText = await response.text();
                //console.error(`[Qwen Omni] SENDCHATCOMPLETION: API Error Body: ${errText}`);
                throw new Error(`API Error ${response.status}: ${errText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            let fullText = '';
            let toolCallsMap = new Map();
            let chunkCount = 0;

            //console.log(`[Qwen Omni] ------------------ STREAM START ------------------`);
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  //  console.log(`[Qwen Omni] STREAM: Reader reported DONE.`);
                    break;
                }

                chunkCount++;
                let hex = '';
                const text = decoder.decode(value, { stream: true });
                //console.log(`[Qwen Omni] STREAM: Received chunk #${chunkCount} (size: ${value.length}). Decoded text snippet: ${JSON.stringify(text.substring(0, 100))}...`);

                buffer += text;
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (let line of lines) {
                    const trimmed = line.trim();

                    if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') {
                     //   console.log(`[Qwen Omni] STREAM: Skipping empty, comment, or DONE line.`);
                        continue;
                    }

                    if (trimmed.startsWith('data:')) {
                        try {
                            const data = JSON.parse(trimmed.slice(5).trim());
                           // console.log(`[Qwen Omni] STREAM: PARSED SSE DATA:`, data);

                            const choice = data.output?.choices?.[0];
                            if (!choice || !choice.message) {
                                console.log(`[Qwen Omni] STREAM: No choice or message in parsed data. Skipping.`);
                                continue;
                            }

                            const msg = choice.message;
                           // console.log(`[Qwen Omni] STREAM: Message content:`, msg.content);

                            if (msg.content && Array.isArray(msg.content)) {
                                for (const part of msg.content) {
                                    //console.log(`[Qwen Omni] STREAM: Processing message part:`, part);
                                    if (part.text) {
                                        fullText += part.text;
                                        //console.log(`[Qwen Omni] STREAM: Appended text. Current fullText length: ${fullText.length}. Emitting output_transcription:`, part.text);
                                        if (this.config.output_transcription) {
                                            this.emit('output_transcription', part.text);
                                        }
                                    }
                                    if (part.audio && part.audio.data) {
                                      //  console.log(`[Qwen Omni] STREAM: Received audio part. Size: ${part.audio.data.length} chars. Emitting audio_output.`);
                                        this.emit('audio_output', Buffer.from(part.audio.data, 'base64'));
                                    }
                                }
                            }

                            if (msg.tool_calls) {
                                //console.log(`[Qwen Omni] STREAM: Received tool_calls:`, msg.tool_calls);
                                for (const tc of msg.tool_calls) {
                                    //console.log(`[Qwen Omni] STREAM: Processing tool call delta:`, tc);
                                    if (!toolCallsMap.has(tc.index)) {
                                        toolCallsMap.set(tc.index, { id: tc.id || "", name: tc.function?.name || "", arguments: "" });
                                        console.log(`[Qwen Omni] STREAM: New tool call indexed:`, toolCallsMap.get(tc.index));
                                    }
                                    const t = toolCallsMap.get(tc.index);
                                    if (tc.id && !t.id) t.id = tc.id;
                                    if (tc.function?.name && !t.name) t.name = tc.function.name;
                                    if (tc.function?.arguments) t.arguments += tc.function.arguments;
                                   // console.log(`[Qwen Omni] STREAM: Updated tool call in map:`, t);
                                }
                            }
                        } catch (e) {
                           // console.error(`[Qwen Omni] STREAM: SSE PARSE ERROR: ${e.message} at line:`, trimmed);
                        }
                    }
                }
            }

            //console.log(`[Qwen Omni] ------------------ STREAM END --------------------`);
           // console.log(`[Qwen Omni] SENDCHATCOMPLETION: Summary: Chunks=${chunkCount}, TextLen=${fullText.length}, Tools=${toolCallsMap.size}`);

            const assistantMessage = { role: "assistant", content: fullText };
           // console.log(`[Qwen Omni] SENDCHATCOMPLETION: Final assistant message constructed:`, assistantMessage);

            if (toolCallsMap.size > 0) {
                assistantMessage.tool_calls = [];
                for (const tc of toolCallsMap.values()) {
                  //  console.log(`[Qwen Omni] SENDCHATCOMPLETION: Finalizing and emitting tool_call:`, tc);
                    assistantMessage.tool_calls.push({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: tc.arguments }
                    });

                    let args = {};
                    try { args = JSON.parse(tc.arguments); } catch(e) { console.error(`[Qwen Omni] SENDCHATCOMPLETION: Tool Args JSON Parse Error: ${e.message} for arguments:`, tc.arguments); }
                   // console.log(`[Qwen Omni] SENDCHATCOMPLETION: Emitting 'tool_call' with args:`, args);
                    this.emit('tool_call', tc.id, tc.name, args);
                }
                this.messages.push(assistantMessage);
                console.log(`[Qwen Omni] SENDCHATCOMPLETION: Pushed assistant tool-call message to history. New history length: ${this.messages.length}. Processing remains TRUE, waiting for tool results.`);
            } else {
                this.messages.push(assistantMessage);
                this.processing = false; // Turn is complete when no tool calls are present
                console.log(`[Qwen Omni] SENDCHATCOMPLETION: Pushed regular assistant message to history. New history length: ${this.messages.length}. Processing set to FALSE.`);
                console.log(`[Qwen Omni] SENDCHATCOMPLETION: Turn complete. Emitting 'turn_complete' event.`);
                this.emit('turn_complete');
            }

        } catch (e) {
           // console.error(`[Qwen Omni] SENDCHATCOMPLETION: CRITICAL ERROR:`, e);
            this.emit('error', new Error(`Qwen Omni Error: ${e.message}`));
            this.processing = false;
           // console.log(`[Qwen Omni] SENDCHATCOMPLETION: Error caught. Resetting processing and emitting 'turn_complete'.`);
            this.emit('turn_complete');
        }
        //console.log(`[Qwen Omni] ================== REQUEST END ====================`);
    }

    sendToolResponse(callId, name, resultText) {
        console.log(`[Qwen Omni] SENDTOOLRESPONSE: Called for ID: ${callId}, Name: ${name}, ResultText length: ${resultText?.length}`);
        const toolMsg = {
            role: "tool",
            tool_call_id: callId,
            name: name,
            content: [{ type: "text", text: resultText }]
        };
        console.log(`[Qwen Omni] SENDTOOLRESPONSE: Tool message created:`, toolMsg);
        this.messages.push(toolMsg);
        console.log(`[Qwen Omni] SENDTOOLRESPONSE: Pushed tool response to history. New history length: ${this.messages.length}`);

        const successSummary = `Tool ${name} (ID: ${callId}) executed successfully. Result: ${resultText.substring(0, 100)}...`;
        const assistantSummaryMsg = { role: "assistant", content: [{ type: "text", text: successSummary }]};
        this.messages.push(assistantSummaryMsg);
        console.log(`[Qwen Omni] SENDTOOLRESPONSE: Added assistant summary to history:`, assistantSummaryMsg);
        console.log(`[Qwen Omni] SENDTOOLRESPONSE: New history length after summary: ${this.messages.length}`);

        this.sendChatCompletion();
    }

    close() {
        console.log(`[Qwen Omni] CLOSE: Closing session.`);
        this.audioBuffer = [];
        this.isSpeaking = false;
        this.processing = false;
    }
}

module.exports = QwenOmniProvider;
