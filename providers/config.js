module.exports = [
    {
        id: 'gemini',
        name: 'Google Gemini',
        models: [
            { id: 'gemini-2.5-flash-native-audio-preview-12-2025', name: 'Gemini 2.5 Flash Native Audio' },
            { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Exp' },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
        ],
        voices: [
            'Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir'
        ],
        supportsMcp: true,
        envVars: ['GEMINI_API_KEY']
    },
    {
        id: 'qwen_realtime',
        name: 'Alibaba Qwen (Realtime)',
        models: [
            { id: 'qwen3-omni-flash-realtime', name: 'Qwen 3 Omni Flash Realtime' }
        ],
        voices: [
            'Cherry', 'Serena', 'Ethan', 'Chelsie', 'Momo', 'Vivian', 'Moon', 'Maia', 'Kai', 'Nofish', 'Bella', 'Jennifer', 'Ryan', 'Katerina', 'Aiden', 'Eldric Sage', 'Mia', 'Mochi', 'Bellona', 'Vincent', 'Bunny', 'Neil', 'Elias', 'Arthur', 'Nini', 'Ebona', 'Seren', 'Pip', 'Stella', 'Bodega', 'Sonrisa', 'Alek', 'Dolce', 'Sohee', 'Ono Anna', 'Lenn', 'Emilien', 'Andre', 'Radio Gol', 'Shanghai - Jada', 'Beijing - Dylan', 'Nanjing - Li', 'Shaanxi - Marcus', 'Southern Min - Roy', 'Tianjin - Peter', 'Sichuan - Sunny', 'Sichuan - Eric', 'Cantonese - Rocky', 'Cantonese - Kiki'
        ],
        supportsMcp: false,
        envVars: ['DASHSCOPE_API_KEY']
    },
    {
        id: 'qwen_omni',
        name: 'Alibaba Qwen (Omni/Tools)',
        models: [
            { id: 'qwen3-omni-flash', name: 'Qwen 3 Omni Flash (Tool Calling Supported)' },
            { id: 'qwen-omni-turbo', name: 'Qwen Omni Turbo' }
        ],
        voices: [
            'Cherry', 'Serena', 'Ethan', 'Chelsie'
        ],
        supportsMcp: true,
        envVars: ['DASHSCOPE_API_KEY']
    },
    {
        id: 'llama_liquid_audio_server',
        name: 'Llama Liquid Audio Server',
        models: [
            { id: 'llama-liquid-tts', name: 'Llama Liquid TTS (Sequential)' }
        ],
        voices: ['US male', 'US female', 'UK male', 'UK female'],
        supportsMcp: false,
        envVars: ['LIQUID_SERVER_URL']
    },
    {
        id: 'llama_liquid_interleaved',
        name: 'Llama Liquid Interleaved',
        models: [
            { id: 'llama-liquid-interleaved', name: 'Llama Liquid Interleaved (Native Audio)' }
        ],
        voices: ['UK female', 'UK male', 'US female', 'US male'],
        supportsMcp: false,
        envVars: ['LIQUID_SERVER_URL']
    }
];
