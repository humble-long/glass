const { BrowserWindow } = require('electron');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.conversationHistory = [];
        this.currentSessionId = null;
        this.lastQuestionTriggerAt = 0;
        this.lastTriggeredQuestion = '';
        this.quickAnswerCooldownMs = 4000;
        
        // Callbacks
        this.onAnalysisComplete = null;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    addConversationTurn(speaker, text) {
        const trimmedText = text.trim();
        const conversationText = `${speaker.toLowerCase()}: ${trimmedText}`;
        this.conversationHistory.push(conversationText);
        console.log(`💬 Added conversation text: ${conversationText}`);
        console.log(`📈 Total conversation history: ${this.conversationHistory.length} texts`);

        if (speaker === 'Them') {
            this.triggerQuickAnswerIfNeeded(trimmedText).catch(error => {
                console.error('❌ Quick answer trigger failed:', error?.message || error);
            });
        }

        // Trigger analysis if needed
        this.triggerAnalysisIfNeeded();
    }

    isLikelyQuestion(text) {
        if (!text || typeof text !== 'string') return false;
        const normalized = text.trim().toLowerCase();
        if (!normalized) return false;

        if (/[?？]$/.test(normalized)) return true;

        const zhQuestionHints = ['怎么', '如何', '为什么', '为啥', '能不能', '是否', '可否', '你会', '你如何', '请你', '介绍下', '讲讲'];
        const enQuestionHints = ['what', 'why', 'how', 'could you', 'can you', 'would you', 'tell me', 'explain'];

        return zhQuestionHints.some(keyword => normalized.includes(keyword)) ||
            enQuestionHints.some(keyword => normalized.includes(keyword));
    }

    buildQuickAnswerData(question, answer) {
        return {
            summary: [
                `面试官问题：${question}`,
                '已生成 30 秒口语版回答，可直接说。',
            ],
            topic: {
                header: '🎤 30秒口语回答',
                bullets: [answer],
            },
            actions: [
                '✨ 优化为更简洁版本',
                '💬 生成 STAR 结构版本',
                '🔁 生成追问备选一句',
            ],
            followUps: ['继续监听下一题'],
        };
    }

    async generateQuickInterviewAnswer(question) {
        const modelInfo = await modelStateService.getCurrentModelInfo('llm');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }

        const recentConversation = this.formatConversationForPrompt(this.conversationHistory, 12);
        const messages = [
            {
                role: 'system',
                content: [
                    '你是面试实时回答助手。',
                    '请基于上下文，给出“可直接说出口”的中文回答。',
                    '输出要求：',
                    '1) 只输出最终回答，不要解释。',
                    '2) 时长约 20-30 秒。',
                    '3) 语气自然、口语化、专业。',
                    '4) 如信息不足，给出合理且稳妥的通用表达。',
                ].join('\n'),
            },
            {
                role: 'user',
                content: `对话上下文：\n${recentConversation}\n\n面试官最新问题：${question}\n\n请给我一段现在就能说的回答。`,
            },
        ];

        const llm = createLLM(modelInfo.provider, {
            apiKey: modelInfo.apiKey,
            model: modelInfo.model,
            temperature: 0.5,
            maxTokens: 512,
            usePortkey: modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
        });

        const completion = await llm.chat(messages);
        return (completion.content || '').trim();
    }

    async triggerQuickAnswerIfNeeded(questionText) {
        if (!this.isLikelyQuestion(questionText)) return;

        const now = Date.now();
        if (now - this.lastQuestionTriggerAt < this.quickAnswerCooldownMs) return;
        if (questionText === this.lastTriggeredQuestion) return;

        this.lastQuestionTriggerAt = now;
        this.lastTriggeredQuestion = questionText;

        if (this.onStatusUpdate) {
            this.onStatusUpdate('Generating interview answer...');
        }

        const answer = await this.generateQuickInterviewAnswer(questionText);
        if (!answer) return;

        const quickData = this.buildQuickAnswerData(questionText, answer);
        this.sendToRenderer('summary-update', quickData);

        if (this.onAnalysisComplete) {
            this.onAnalysisComplete(quickData);
        }

        if (this.onStatusUpdate) {
            this.onStatusUpdate('Listening...');
        }
    }

    async generateAnswerFromSelectedSentence(selectedSentence) {
        const sentence = (selectedSentence || '').trim();
        if (!sentence) {
            return { success: false, error: 'Empty sentence' };
        }

        try {
            if (this.onStatusUpdate) {
                this.onStatusUpdate('Generating answer from selected sentence...');
            }

            this.sendToRenderer('summary-update', {
                summary: [`已选中句子：${sentence}`],
                topic: { header: '🎤 正在生成回答', bullets: ['请稍候...'] },
                actions: [],
                followUps: [],
            });

            const answer = await this.generateQuickInterviewAnswer(sentence);
            if (!answer) {
                const failData = {
                    summary: [`已选中句子：${sentence}`],
                    topic: { header: '⚠️ 生成失败', bullets: ['模型未返回内容，请重试一次。'] },
                    actions: ['🔁 点击该句重试'],
                    followUps: [],
                };
                this.sendToRenderer('summary-update', failData);
                return { success: false, error: 'No answer generated' };
            }

            const quickData = this.buildQuickAnswerData(sentence, answer);
            this.sendToRenderer('summary-update', quickData);

            if (this.onAnalysisComplete) {
                this.onAnalysisComplete(quickData);
            }

            if (this.onStatusUpdate) {
                this.onStatusUpdate('Listening...');
            }

            return { success: true, data: quickData };
        } catch (error) {
            console.error('❌ Failed to generate answer from selected sentence:', error);
            const failData = {
                summary: [`已选中句子：${sentence}`],
                topic: { header: '⚠️ 生成失败', bullets: [error?.message || '未知错误'] },
                actions: ['🔁 点击该句重试'],
                followUps: [],
            };
            this.sendToRenderer('summary-update', failData);
            return { success: false, error: error.message };
        }
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        console.log('🔄 Conversation history and analysis state reset');
    }

    /**
     * Converts conversation history into text to include in the prompt.
     * @param {Array<string>} conversationTexts - Array of conversation texts ["me: ~~~", "them: ~~~", ...]
     * @param {number} maxTurns - Maximum number of recent turns to include
     * @returns {string} - Formatted conversation string for the prompt
     */
    formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) return '';
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    async makeOutlineAndRequests(conversationTexts, maxTurns = 30) {
        console.log(`🔍 makeOutlineAndRequests called - conversationTexts: ${conversationTexts.length}`);

        if (conversationTexts.length === 0) {
            console.log('⚠️ No conversation texts available for analysis');
            return null;
        }

        const recentConversation = this.formatConversationForPrompt(conversationTexts, maxTurns);

        // 이전 분석 결과를 프롬프트에 포함
        let contextualPrompt = '';
        if (this.previousAnalysisResult) {
            contextualPrompt = `
Previous Analysis Context:
- Main Topic: ${this.previousAnalysisResult.topic.header}
- Key Points: ${this.previousAnalysisResult.summary.slice(0, 3).join(', ')}
- Last Actions: ${this.previousAnalysisResult.actions.slice(0, 2).join(', ')}

Please build upon this context while analyzing the new conversation segments.
`;
        }

        const basePrompt = getSystemPrompt('pickle_glass_analysis', '', false);
        const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', recentConversation);

        try {
            if (this.currentSessionId) {
                await sessionRepository.touch(this.currentSessionId);
            }

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key is not configured.');
            }
            console.log(`🤖 Sending analysis request to ${modelInfo.provider} using model ${modelInfo.model}`);
            
            const messages = [
                {
                    role: 'system',
                    content: systemPrompt,
                },
                {
                    role: 'user',
                    content: `${contextualPrompt}

Analyze the conversation and provide a structured summary. Format your response as follows:

**Summary Overview**
- Main discussion point with context

**Key Topic: [Topic Name]**
- First key insight
- Second key insight
- Third key insight

**Extended Explanation**
Provide 2-3 sentences explaining the context and implications.

**Suggested Questions**
1. First follow-up question?
2. Second follow-up question?
3. Third follow-up question?

Keep all points concise and build upon previous analysis if provided.`,
                },
            ];

            console.log('🤖 Sending analysis request to AI...');

            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 4096,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const completion = await llm.chat(messages);

            const responseText = completion.content;
            console.log(`✅ Analysis response received: ${responseText}`);
            const structuredData = this.parseResponseText(responseText, this.previousAnalysisResult);

            if (this.currentSessionId) {
                try {
                    summaryRepository.saveSummary({
                        sessionId: this.currentSessionId,
                        text: responseText,
                        tldr: structuredData.summary.join('\n'),
                        bullet_json: JSON.stringify(structuredData.topic.bullets),
                        action_json: JSON.stringify(structuredData.actions),
                        model: modelInfo.model
                    });
                } catch (err) {
                    console.error('[DB] Failed to save summary:', err);
                }
            }

            // 분석 결과 저장
            this.previousAnalysisResult = structuredData;
            this.analysisHistory.push({
                timestamp: Date.now(),
                data: structuredData,
                conversationLength: conversationTexts.length,
            });

            if (this.analysisHistory.length > 10) {
                this.analysisHistory.shift();
            }

            return structuredData;
        } catch (error) {
            console.error('❌ Error during analysis generation:', error.message);
            return this.previousAnalysisResult; // 에러 시 이전 결과 반환
        }
    }

    parseResponseText(responseText, previousResult) {
        const structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
        };

        // 이전 결과가 있으면 기본값으로 사용
        if (previousResult) {
            structuredData.topic.header = previousResult.topic.header;
            structuredData.summary = [...previousResult.summary];
        }

        try {
            const lines = responseText.split('\n');
            let currentSection = '';
            let isCapturingTopic = false;
            let topicName = '';

            for (const line of lines) {
                const trimmedLine = line.trim();

                // 섹션 헤더 감지
                if (trimmedLine.startsWith('**Summary Overview**')) {
                    currentSection = 'summary-overview';
                    continue;
                } else if (trimmedLine.startsWith('**Key Topic:')) {
                    currentSection = 'topic';
                    isCapturingTopic = true;
                    topicName = trimmedLine.match(/\*\*Key Topic: (.+?)\*\*/)?.[1] || '';
                    if (topicName) {
                        structuredData.topic.header = topicName + ':';
                    }
                    continue;
                } else if (trimmedLine.startsWith('**Extended Explanation**')) {
                    currentSection = 'explanation';
                    continue;
                } else if (trimmedLine.startsWith('**Suggested Questions**')) {
                    currentSection = 'questions';
                    continue;
                }

                // 컨텐츠 파싱
                if (trimmedLine.startsWith('-') && currentSection === 'summary-overview') {
                    const summaryPoint = trimmedLine.substring(1).trim();
                    if (summaryPoint && !structuredData.summary.includes(summaryPoint)) {
                        // 기존 summary 업데이트 (최대 5개 유지)
                        structuredData.summary.unshift(summaryPoint);
                        if (structuredData.summary.length > 5) {
                            structuredData.summary.pop();
                        }
                    }
                } else if (trimmedLine.startsWith('-') && currentSection === 'topic') {
                    const bullet = trimmedLine.substring(1).trim();
                    if (bullet && structuredData.topic.bullets.length < 3) {
                        structuredData.topic.bullets.push(bullet);
                    }
                } else if (currentSection === 'explanation' && trimmedLine) {
                    // explanation을 topic bullets에 추가 (문장 단위로)
                    const sentences = trimmedLine
                        .split(/\.\s+/)
                        .filter(s => s.trim().length > 0)
                        .map(s => s.trim() + (s.endsWith('.') ? '' : '.'));

                    sentences.forEach(sentence => {
                        if (structuredData.topic.bullets.length < 3 && !structuredData.topic.bullets.includes(sentence)) {
                            structuredData.topic.bullets.push(sentence);
                        }
                    });
                } else if (trimmedLine.match(/^\d+\./) && currentSection === 'questions') {
                    const question = trimmedLine.replace(/^\d+\.\s*/, '').trim();
                    if (question && question.includes('?')) {
                        structuredData.actions.push(`❓ ${question}`);
                    }
                }
            }

            // 기본 액션 추가
            const defaultActions = ['✨ What should I say next?', '💬 Suggest follow-up questions'];
            defaultActions.forEach(action => {
                if (!structuredData.actions.includes(action)) {
                    structuredData.actions.push(action);
                }
            });

            // 액션 개수 제한
            structuredData.actions = structuredData.actions.slice(0, 5);

            // 유효성 검증 및 이전 데이터 병합
            if (structuredData.summary.length === 0 && previousResult) {
                structuredData.summary = previousResult.summary;
            }
            if (structuredData.topic.bullets.length === 0 && previousResult) {
                structuredData.topic.bullets = previousResult.topic.bullets;
            }
        } catch (error) {
            console.error('❌ Error parsing response text:', error);
            // 에러 시 이전 결과 반환
            return (
                previousResult || {
                    summary: [],
                    topic: { header: 'Analysis in progress', bullets: [] },
                    actions: ['✨ What should I say next?', '💬 Suggest follow-up questions'],
                    followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
                }
            );
        }

        console.log('📊 Final structured data:', JSON.stringify(structuredData, null, 2));
        return structuredData;
    }

    /**
     * Triggers analysis when conversation history reaches 5 texts.
     */
    async triggerAnalysisIfNeeded() {
        if (this.conversationHistory.length >= 5 && this.conversationHistory.length % 5 === 0) {
            console.log(`Triggering analysis - ${this.conversationHistory.length} conversation texts accumulated`);

            const data = await this.makeOutlineAndRequests(this.conversationHistory);
            if (data) {
                console.log('Sending structured data to renderer');
                this.sendToRenderer('summary-update', data);
                
                // Notify callback
                if (this.onAnalysisComplete) {
                    this.onAnalysisComplete(data);
                }
            } else {
                console.log('No analysis data returned');
            }
        }
    }

    getCurrentAnalysisData() {
        return {
            previousResult: this.previousAnalysisResult,
            history: this.analysisHistory,
            conversationLength: this.conversationHistory.length,
        };
    }
}

module.exports = SummaryService; 