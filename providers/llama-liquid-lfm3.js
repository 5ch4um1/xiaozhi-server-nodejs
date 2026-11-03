const LLMProvider = require('./base');
const WebSocket = require('ws');

// Prompt from the LFM3-Audio model card for interleaved speech and text.
const INTERLEAVED_INSTRUCTIONS = 'Respond with interleaved text and audio.';
// Prompt from the LFM3-Audio model card when tools are available.
const TOOLS_INSTRUCTIONS = 'Respond with function calls, and interleaved text and audio.\n\nList of tools:';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080';
const TOOL_TIMEOUT_MS = 30000;
const SESSION_TIMEOUT_MS = 15000;

class LlamaLiquidLfm3Provider extends LLMProvider {
    constructor(config) {
        super(config);
        this.serverUrl = config.url || DEFAULT_SERVER_URL;
        this.realtimeUrl = this.buildRealtimeUrl(this.serverUrl);

        // VAD state
        this.audioBuffer = [];
        this.preSpeechBuffer = [];
        this.isSpeaking = false;
        this.silenceFrames = 0;
        this.speechFrames = 0;

        // Realtime session state
        this.session = null;
        this.sessionReady = false;
        this.processing = false;
        this.turnId = 0;
        this.responseTurnId = null;
        this.pendingToolCalls = new Map();
        this.inputRate = 16000;
        this.outputRate = 24000;
        this.tools = [];
        this.closed = false;

        // Function calls can be streamed as output items or only appear in
        // response.done, depending on the llama.cpp build. Track both.
        this.functionCalls = new Map();
        this.completedCallKeys = new Set();
        this.responseText = '';
        this.callIdCounter = 0;
        this.interruptEpoch = 0;
        this.cancelRequested = false;

        // VAD config
        this.energyThreshold = 300;
        this.noiseFloor = 100;
        this.silenceDurationMs = 1500;
        this.frameDurationMs = 60;
        this.maxSilenceFrames = Math.ceil(this.silenceDurationMs / this.frameDurationMs);
        this.minSpeechFrames = 3;
        this.maxPreSpeechFrames = 10;
    }

    buildRealtimeUrl(serverUrl) {
        let base = String(serverUrl || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');

        // Accept the old /v1/chat/completions setting as well as a bare server URL.
        base = base.replace(/\/v1\/chat\/completions$/, '');
        base = base.replace(/\/v1\/realtime$/, '');
        base = base.replace(/\/v1$/, '');

        if (base.startsWith('https://')) {
            base = 'wss://' + base.slice(8);
        } else if (base.startsWith('http://')) {
            base = 'ws://' + base.slice(7);
        } else if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
            base = 'ws://' + base;
        }

        return `${base}/v1/realtime`;
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

    resamplePCM16(pcmBuffer, fromRate, toRate) {
        if (!pcmBuffer || pcmBuffer.length < 4 || fromRate === toRate) return pcmBuffer;

        const inSamples = Math.floor(pcmBuffer.length / 2);
        const outSamples = Math.max(1, Math.round(inSamples * toRate / fromRate));
        const out = Buffer.alloc(outSamples * 2);

        for (let i = 0; i < outSamples; i++) {
            const pos = i * fromRate / toRate;
            const i0 = Math.floor(pos);
            const i1 = Math.min(i0 + 1, inSamples - 1);
            const frac = pos - i0;
            const s0 = pcmBuffer.readInt16LE(Math.min(i0, inSamples - 1) * 2);
            const s1 = pcmBuffer.readInt16LE(i1 * 2);
            const sample = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
            out.writeInt16LE(sample, i * 2);
        }

        return out;
    }

    async connect(tools) {
        this.tools = Array.isArray(tools) ? tools : [];
        this.closed = false;

        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (err) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve();
            };

            try {
                this.session = new WebSocket(this.realtimeUrl);
            } catch (err) {
                settle(err);
                return;
            }

            const sessionTimer = setTimeout(() => {
                if (!this.sessionReady) {
                    const err = new Error(`Timed out waiting for LFM3 realtime session at ${this.realtimeUrl}`);
                    this.emit('error', err);
                    settle(err);
                }
            }, SESSION_TIMEOUT_MS);

            this.session.on('open', () => {
                settle();
            });

            this.session.on('message', (message) => {
                this.handleServerEvent(message.toString());
            });

            this.session.on('error', (err) => {
                clearTimeout(sessionTimer);
                this.emit('error', err);
                settle(err);
            });

            this.session.on('close', () => {
                clearTimeout(sessionTimer);
                this.session = null;
                this.sessionReady = false;
                this.processing = false;
                this.responseTurnId = null;
                this.clearPendingToolCalls();
                this.emit('close');
            });
        });
    }

    handleServerEvent(rawMessage) {
        let event;
        try {
            event = JSON.parse(rawMessage);
        } catch (e) {
            this.emit('error', new Error(`Failed to parse LFM3 realtime event: ${e.message}`));
            return;
        }

        switch (event.type) {
            case 'session.created':
                this.handleSessionCreated(event);
                break;

            case 'session.updated':
                if (!this.sessionReady) {
                    this.sessionReady = true;
                    this.emit('connected');
                }
                break;

            case 'response.created':
                this.handleResponseCreated(event);
                break;

            case 'response.output_text.delta':
                if (event.delta) {
                    this.responseText += event.delta;
                    this.emit('output_transcription', event.delta);
                }
                break;

            case 'response.output_text.done':
                if (typeof event.text === 'string' && !this.responseText) {
                    this.responseText = event.text;
                }
                break;

            case 'response.output_item.added':
            case 'response.output_item.done':
                if (event.item && event.item.type === 'function_call') {
                    this.upsertFunctionCall(event.item);
                }
                break;

            case 'response.function_call_arguments.delta':
                this.upsertFunctionCall({
                    id: event.item_id,
                    call_id: event.call_id
                }, { argumentsDelta: event.delta });
                break;

            case 'response.function_call_arguments.done':
                this.upsertFunctionCall({
                    id: event.item_id,
                    call_id: event.call_id,
                    name: event.name,
                    arguments: event.arguments
                });
                break;

            case 'response.output_audio.delta':
            case 'response.audio.delta':
                if (event.delta) {
                    const pcm = Buffer.from(event.delta, 'base64');
                    this.emit('audio_output', this.resamplePCM16(pcm, this.outputRate, 24000));
                }
                break;

            case 'conversation.item.input_audio_transcription.delta':
                if (event.delta) this.emit('input_transcription', event.delta);
                break;

            case 'conversation.item.input_audio_transcription.completed':
                if (event.transcript) this.emit('input_transcription', event.transcript);
                break;

            case 'response.done':
                this.handleResponseDone(event.response || {});
                break;

            case 'error':
                this.emit('error', new Error(event.error?.message || 'LFM3 realtime error'));
                break;
        }
    }

    handleSessionCreated(event) {
        const audio = event.session?.audio || {};
        this.inputRate = audio.input?.format?.rate || 16000;
        this.outputRate = audio.output?.format?.rate || 24000;

        const update = {
            type: 'session.update',
            session: {
                type: 'realtime',
                instructions: this.buildInstructions()
            }
        };

        // Forcing text+audio makes llama.cpp prefill <|mixed_start|>, which
        // puts the model into spoken/interleaved mode. In that mode it narrates
        // actions instead of emitting <tool_call>. With tools, leave the
        // modality unset so the server starts in text mode; the model can still
        // switch to speech itself when no tool is needed.
        if (this.tools.length === 0) {
            update.session.output_modalities = ['text', 'audio'];
        }

        if (this.tools.length > 0) {
            update.session.tools = this.tools.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description || 'No description provided.',
                parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false }
            }));
        }

        this.send(update);
    }

    buildInstructions() {
        // LFM3-Audio is trained with this exact system prompt when tools are
        // available. Prefixing the device prompt makes the model answer
        // conversationally ("Let's set the theme to dark") instead of emitting
        // a <tool_call>, so use the model-card prompt verbatim in tool mode.
        if (this.tools.length > 0) return TOOLS_INSTRUCTIONS;

        const prompt = (this.config.prompt || '').trim();
        return prompt ? `${prompt}\n\n${INTERLEAVED_INSTRUCTIONS}` : INTERLEAVED_INSTRUCTIONS;
    }

    send(event) {
        if (this.session && this.session.readyState === WebSocket.OPEN) {
            this.session.send(JSON.stringify(event));
            return true;
        }
        return false;
    }

    sendAudio(pcmChunk) {
        if (this.processing || this.closed) return;
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

    processAudioBuffer() {
        if (this.audioBuffer.length === 0 || this.processing || this.closed) return;

        this.processing = true;
        this.turnId++;
        this.responseTurnId = this.turnId;
        this.functionCalls.clear();
        this.completedCallKeys.clear();
        this.responseText = '';
        this.emit('listen_stop');

        const fullAudio = Buffer.concat(this.audioBuffer);
        this.audioBuffer = [];

        const pcm = this.resamplePCM16(fullAudio, 16000, this.inputRate);
        const chunkBytes = Math.max(2, Math.round(this.inputRate * 0.1) * 2);

        for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
            const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
            this.send({
                type: 'input_audio_buffer.append',
                audio: chunk.toString('base64')
            });
        }

        // In a realtime conversation response.create ends the user turn.
        this.send({ type: 'response.create' });
    }

    handleResponseCreated(event) {
        this.functionCalls.clear();
        this.completedCallKeys.clear();
        this.responseText = '';

        // A response can be created without a local audio turn. Give it an id
        // so the tool-result continuation still belongs to this response.
        if (this.responseTurnId === null) {
            this.turnId++;
            this.responseTurnId = this.turnId;
        }
    }

    upsertFunctionCall(item, patch = {}) {
        if (!item) return null;

        const key = item.id || item.item_id || item.call_id || `fn_${this.functionCalls.size}`;
        let call = this.functionCalls.get(key);

        if (!call) {
            call = {
                key,
                id: item.id || item.item_id || '',
                serverCallId: item.call_id || '',
                name: '',
                arguments: '',
                outputIndex: item.output_index
            };
            this.functionCalls.set(key, call);
        }

        if (item.id) call.id = item.id;
        if (item.item_id) call.id = item.item_id;
        if (item.call_id) call.serverCallId = item.call_id;
        if (item.name) call.name = item.name;
        if (item.output_index !== undefined) call.outputIndex = item.output_index;

        if (patch.argumentsDelta) call.arguments += patch.argumentsDelta;
        if (typeof patch.arguments === 'string') call.arguments = patch.arguments;
        if (typeof item.arguments === 'string') call.arguments = item.arguments;

        return call;
    }

    collectFunctionCalls(response) {
        const calls = [];
        const seen = new Set();

        const add = (call) => {
            const name = String(call.name || '').trim();
            if (!name) return;

            const key = call.key || call.id || call.serverCallId ||
                `${name}\u0000${typeof call.arguments === 'string' ? call.arguments : ''}`;
            if (seen.has(key)) return;
            seen.add(key);

            let args = call.arguments;
            if (typeof args !== 'string') {
                try {
                    args = JSON.stringify(args || {});
                } catch (e) {
                    args = '{}';
                }
            }

            calls.push({
                key,
                serverCallId: call.serverCallId || call.call_id || '',
                name,
                arguments: args || '{}'
            });
        };

        for (const call of this.functionCalls.values()) add(call);

        // Some llama.cpp builds only put complete calls in response.done.
        // Merge those in as well, deduplicating by output item id.
        const output = Array.isArray(response.output) ? response.output : [];
        for (const item of output) {
            if (!item || item.type !== 'function_call') continue;
            add({
                key: item.id || item.item_id,
                serverCallId: item.call_id || '',
                name: item.name,
                arguments: item.arguments
            });
        }

        return calls;
    }

    collectResponseText(response) {
        let text = this.responseText || '';
        const output = Array.isArray(response.output) ? response.output : [];

        for (const item of output) {
            if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
            for (const part of item.content) {
                if (!part || part.type !== 'output_text' || typeof part.text !== 'string') continue;
                if (!text.includes(part.text)) text += part.text;
            }
        }

        return text;
    }

    coerceToolArgument(value) {
        const text = String(value == null ? '' : value).trim();
        if (text === 'true') return true;
        if (text === 'false') return false;
        if (text === 'null') return null;
        if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);

        if ((text.startsWith('{') && text.endsWith('}')) ||
            (text.startsWith('[') && text.endsWith(']'))) {
            try {
                return JSON.parse(text);
            } catch (e) {
                // keep the raw string
            }
        }

        return text;
    }

    // Fallback for builds/templates that stream the LFM3 tool-call markup as
    // ordinary text instead of parsing it into response function_call items.
    parseTextToolCalls(text) {
        if (!text || typeof text !== 'string') return [];

        const calls = [];

        const addCall = (name, args) => {
            const trimmedName = String(name || '').trim();
            if (!trimmedName) return;
            calls.push({
                key: `text_${++this.callIdCounter}`,
                serverCallId: '',
                name: trimmedName,
                arguments: JSON.stringify(args || {})
            });
        };

        const parseFunction = (name, body) => {
            const args = {};
            const parameterPattern = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
            let parameterMatch;

            while ((parameterMatch = parameterPattern.exec(body)) !== null) {
                const key = parameterMatch[1].trim();
                if (key) args[key] = this.coerceToolArgument(parameterMatch[2]);
            }

            // Also accept a JSON object inside <function>...</function>.
            if (Object.keys(args).length === 0) {
                const raw = body.trim();
                if (raw.startsWith('{') && raw.endsWith('}')) {
                    try {
                        const parsed = JSON.parse(raw);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            Object.assign(args, parsed);
                        }
                    } catch (e) {
                        // keep empty arguments
                    }
                }
            }

            addCall(name, args);
        };

        const parseBody = (body) => {
            let found = false;
            const functionPattern = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
            let functionMatch;

            while ((functionMatch = functionPattern.exec(body)) !== null) {
                found = true;
                parseFunction(functionMatch[1], functionMatch[2]);
            }
            if (found) return;

            // Common alternative shape:
            // <tool_call>{"name": "...", "arguments": {...}}</tool_call>
            const raw = body.trim();
            if (!raw.startsWith('{') || !raw.endsWith('}')) return;

            try {
                const parsed = JSON.parse(raw);
                const name = parsed && (parsed.name || parsed.function?.name);
                let args = parsed && (parsed.arguments || parsed.parameters || parsed.function?.arguments);
                if (!name) return;

                if (typeof args === 'string') {
                    try {
                        args = JSON.parse(args);
                    } catch (e) {
                        args = {};
                    }
                }

                addCall(name, args);
            } catch (e) {
                // not JSON
            }
        };

        const callPattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
        let callMatch;

        while ((callMatch = callPattern.exec(text)) !== null) {
            parseBody(callMatch[1]);
        }

        // Some model outputs omit the <tool_call> wrapper entirely.
        if (calls.length === 0) {
            parseBody(text);
        }

        return calls;
    }

    handleResponseDone(response) {
        const turnId = this.responseTurnId !== null ? this.responseTurnId : this.turnId;
        const epoch = this.interruptEpoch;

        const ownsTurn = () => this.interruptEpoch === epoch &&
            (this.responseTurnId === null || this.responseTurnId === turnId);

        const finishTurn = () => {
            if (!ownsTurn()) return;
            this.functionCalls.clear();
            this.responseText = '';
            this.processing = false;
            this.responseTurnId = null;
            this.emit('turn_complete');
        };

        let calls = this.collectFunctionCalls(response);
        if (calls.length === 0) {
            calls = this.parseTextToolCalls(this.collectResponseText(response));
        }

        // A cancellation we requested should not execute tool calls from the
        // partially generated response we just interrupted.
        if (response.status === 'cancelled' && this.cancelRequested) {
            this.cancelRequested = false;
            this.functionCalls.clear();
            this.responseText = '';
            return;
        }

        // Do not process the same item twice if response.done is repeated or
        // the call appeared both in the stream and in response.done.
        calls = calls.filter((call) => !this.completedCallKeys.has(call.key));
        for (const call of calls) this.completedCallKeys.add(call.key);

        if (response.status === 'failed') {
            finishTurn();
            this.emit('error', new Error(response.status_details?.error?.message || 'LFM3 response failed'));
            return;
        }

        if (calls.length === 0) {
            if (response.status !== 'cancelled') finishTurn();
            else {
                this.functionCalls.clear();
                this.responseText = '';
            }
            return;
        }

        const usedIds = new Set(this.pendingToolCalls.keys());
        const pending = calls.map((call) => new Promise((resolve) => {
            // LFM3/llama.cpp can leave call_id empty or reuse it for parallel
            // calls. Keep an internal unique id for the app, but remember the
            // server id for the function_call_output item.
            let internalId = call.serverCallId;
            if (!internalId || usedIds.has(internalId)) {
                internalId = `lfm3_call_${turnId}_${++this.callIdCounter}`;
            }
            usedIds.add(internalId);

            const entry = {
                resolve,
                timer: null,
                serverCallId: call.serverCallId || internalId
            };

            entry.timer = setTimeout(() => {
                this.pendingToolCalls.delete(internalId);
                this.sendToolResult(entry.serverCallId, JSON.stringify({ error: 'Tool execution timed out.' }));
                resolve();
            }, TOOL_TIMEOUT_MS);

            this.pendingToolCalls.set(internalId, entry);
            call.internalId = internalId;
        }));

        for (const call of calls) {
            let args = {};
            try {
                args = call.arguments ? JSON.parse(call.arguments) : {};
            } catch (e) {
                args = {};
            }
            this.emit('tool_call', call.internalId, call.name, args);
        }

        Promise.all(pending).then(() => {
            if (this.closed || !ownsTurn()) return;
            this.send({ type: 'response.create' });
        });
    }

    sendToolResponse(callId, name, resultText) {
        const result = typeof resultText === 'string' ? resultText : JSON.stringify(resultText);
        const pending = this.pendingToolCalls.get(callId);
        const serverCallId = pending ? pending.serverCallId : callId;
        this.sendToolResult(serverCallId, result);
        this.resolveToolCall(callId);
    }

    sendToolResult(callId, output) {
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output
            }
        });
    }

    resolveToolCall(callId) {
        const pending = this.pendingToolCalls.get(callId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingToolCalls.delete(callId);
            pending.resolve();
        }
    }

    clearPendingToolCalls() {
        for (const [callId, pending] of this.pendingToolCalls.entries()) {
            clearTimeout(pending.timer);
            pending.resolve();
            this.pendingToolCalls.delete(callId);
        }
    }

    interrupt() {
        const wasProcessing = this.processing;
        this.interruptEpoch++;
        this.processing = false;
        this.responseTurnId = null;
        this.audioBuffer = [];
        this.preSpeechBuffer = [];
        this.isSpeaking = false;
        this.silenceFrames = 0;
        this.speechFrames = 0;
        this.functionCalls.clear();
        this.completedCallKeys.clear();
        this.responseText = '';
        this.clearPendingToolCalls();

        if (wasProcessing && this.session && this.session.readyState === WebSocket.OPEN) {
            if (this.send({ type: 'response.cancel' })) {
                this.cancelRequested = true;
            }
        }

        this.emit('interrupted');
    }

    close() {
        this.closed = true;
        this.interruptEpoch++;
        this.cancelRequested = false;
        this.processing = false;
        this.responseTurnId = null;
        this.functionCalls.clear();
        this.completedCallKeys.clear();
        this.responseText = '';
        this.clearPendingToolCalls();

        if (this.session) {
            try {
                this.session.close();
            } catch (e) {
                // ignore
            }
            this.session = null;
        }
    }
}

module.exports = LlamaLiquidLfm3Provider;
