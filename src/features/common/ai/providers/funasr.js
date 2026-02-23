const WebSocket = require('ws');
const crypto = require('crypto');

class FunASRProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string' || !key.trim()) {
            return { success: false, error: 'DASHSCOPE_API_KEY is required.' };
        }
        if (!key.trim().startsWith('sk-')) {
            return { success: false, error: 'Invalid DashScope API key format.' };
        }
        return { success: true };
    }
}

function normalizeLanguage(language) {
    if (!language) return 'zh';
    const normalized = String(language).trim().toLowerCase();
    if (!normalized) return 'zh';

    if (normalized.startsWith('zh')) return 'zh';
    if (normalized.startsWith('en')) return 'en';
    if (normalized.startsWith('ja')) return 'ja';
    if (normalized.startsWith('ko')) return 'ko';
    return normalized.split('-')[0] || 'zh';
}

async function createSTT({
    apiKey,
    model = 'fun-asr-realtime',
    language = 'zh',
    callbacks = {},
    sessionType = 'unknown',
    sampleRate = 16000,
}) {
    if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('DashScope API key is required for FunASR.');
    }

    const normalizedLanguage = normalizeLanguage(language);
    const baseWsUrl = process.env.DASHSCOPE_BASE_WS_URL || process.env.FUNASR_DASHSCOPE_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
    const ws = new WebSocket(baseWsUrl, {
        headers: {
            Authorization: `bearer ${apiKey}`,
        },
    });

    let closed = false;
    let isReady = false;
    let settled = false;
    let taskId = '';
    let finishing = false;

    const settleResolveRef = { fn: null };
    const settleRejectRef = { fn: null };

    const closeSocket = () => {
        if (closed) return;
        closed = true;
        try {
            if (ws.readyState === WebSocket.OPEN && taskId && !finishing) {
                finishing = true;
                ws.send(JSON.stringify({
                    header: {
                        task_id: taskId,
                        action: 'finish-task',
                    },
                    payload: { input: {} },
                }));
            }

            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close(1000, 'client');
            }
        } catch (error) {}
    };

    const safeWriteAudio = (buffer) => {
        if (closed || !isReady || ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(buffer);
        } catch (error) {
            callbacks.onerror?.(error);
        }
    };

    ws.on('open', () => {
        taskId = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : crypto.randomBytes(16).toString('hex');

        const startPayload = {
            model,
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            parameters: {
                sample_rate: Number(sampleRate) || 16000,
                format: 'pcm',
                semantic_punctuation_enabled: false,
            },
            input: {},
        };

        const startMessage = {
            header: {
                streaming: 'duplex',
                task_id: taskId,
                action: 'run-task',
            },
            payload: startPayload,
        };

        ws.send(JSON.stringify(startMessage));
    });

    ws.on('message', (raw, isBinary) => {
        if (isBinary) return;

        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch (error) {
            return;
        }

        const eventType = message?.header?.event;
        const payload = message?.payload || {};

        if (eventType === 'task-started') {
            isReady = true;
            console.log(`[FunASR] DashScope handshake OK (model=${model}, taskId=${taskId}, lang=${normalizedLanguage}, session=${sessionType})`);
            if (!settled && settleResolveRef.fn) {
                settled = true;
                settleResolveRef.fn({
                    sendRealtimeInput: (audioData) => {
                        if (typeof audioData === 'string') {
                            try {
                                safeWriteAudio(Buffer.from(audioData, 'base64'));
                            } catch (error) {
                                callbacks.onerror?.(error);
                            }
                            return;
                        }

                        if (audioData instanceof ArrayBuffer) {
                            safeWriteAudio(Buffer.from(audioData));
                            return;
                        }

                        if (Buffer.isBuffer(audioData) || audioData instanceof Uint8Array) {
                            safeWriteAudio(audioData);
                        }
                    },
                    close: closeSocket,
                });
            }
            return;
        }

        if (eventType === 'result-generated') {
            const sentence = payload?.output?.sentence;
            const text = (sentence?.text || '').trim();
            if (!text) return;

            callbacks.onmessage?.({
                provider: 'funasr',
                text,
                isFinal: sentence?.end_time !== null && sentence?.end_time !== undefined,
                raw: payload,
            });
            return;
        }

        if (eventType === 'task-failed') {
            const err = new Error(message?.header?.error_message || 'FunASR task failed');
            callbacks.onerror?.(err);
            if (!settled && settleRejectRef.fn) {
                settled = true;
                settleRejectRef.fn(err);
            }
            return;
        }

        if (eventType === 'task-finished') {
            callbacks.onclose?.({ code: 1000, reason: 'task-finished' });
        }
    });

    ws.on('close', (code, reasonBuffer) => {
        closed = true;
        const reason = typeof reasonBuffer === 'string' ? reasonBuffer : (reasonBuffer?.toString?.() || '');
        callbacks.onclose?.({ code, reason });
        if (!settled && settleRejectRef.fn) {
            settled = true;
            settleRejectRef.fn(new Error(`FunASR websocket closed with code ${code}${reason ? `: ${reason}` : ''}`));
        }
    });

    ws.on('error', (error) => {
        callbacks.onerror?.(error);
        if (!settled && settleRejectRef.fn) {
            settled = true;
            settleRejectRef.fn(error);
        }
    });

    return new Promise((resolve, reject) => {
        const openTimeout = setTimeout(() => {
            closeSocket();
            reject(new Error('FunASR websocket open timeout (task-started not received).'));
        }, 10000);

        settleResolveRef.fn = (session) => {
            clearTimeout(openTimeout);
            resolve(session);
        };

        settleRejectRef.fn = (error) => {
            clearTimeout(openTimeout);
            reject(error);
        };
    });
}

function createLLM() {
    return {
        generateContent: async () => {
            throw new Error('FunASR does not support LLM functionality.');
        }
    };
}

function createStreamingLLM() {
    return {
        streamChat: async () => {
            throw new Error('FunASR does not support streaming LLM functionality.');
        }
    };
}

module.exports = {
    FunASRProvider,
    createSTT,
    createLLM,
    createStreamingLLM,
};
