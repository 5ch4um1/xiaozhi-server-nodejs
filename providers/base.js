const EventEmitter = require('events');

class LLMProvider extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
    }

    /**
     * Connect to the LLM backend
     * @param {Array} tools - Array of MCP tool definitions
     */
    async connect(tools) {
        throw new Error('Not implemented');
    }

    /**
     * Send audio chunk (PCM 16000Hz)
     * @param {Buffer} pcmChunk 
     */
    sendAudio(pcmChunk) {
        throw new Error('Not implemented');
    }

    /**
     * Send tool response back to the LLM
     * @param {string} callId 
     * @param {string} name 
     * @param {string} resultText 
     */
    sendToolResponse(callId, name, resultText) {
        throw new Error('Not implemented');
    }

    /**
     * Close the connection
     */
    close() {
        throw new Error('Not implemented');
    }
}

module.exports = LLMProvider;
