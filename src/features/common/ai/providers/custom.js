// Custom OpenAI-compatible API provider
const OpenAI = require('openai');

class CustomProvider {
    constructor() {
        this.client = null;
        this.baseURL = null;
    }

    async validateApiKey(apiKey, config = {}) {
        try {
            const baseURL = config.baseURL || 'https://api.openai.com/v1';
            const testModel = config.testModel || 'gpt-3.5-turbo';
            
            this.client = new OpenAI({
                apiKey: apiKey,
                baseURL: baseURL,
                timeout: 10000,
            });
            this.baseURL = baseURL;

            // Test the API key with a minimal request
            await this.client.chat.completions.create({
                model: testModel,
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 5,
            });

            return { success: true };
        } catch (error) {
            console.error('[CustomProvider] Validation error:', error);
            return {
                success: false,
                error: error.message || 'API key validation failed',
            };
        }
    }

    createLLM(model, apiKey, config = {}) {
        const baseURL = config.baseURL || this.baseURL || 'https://api.openai.com/v1';
        
        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL: baseURL,
        });

        return async prompts => {
            try {
                const response = await this.client.chat.completions.create({
                    model: model,
                    messages: prompts,
                    temperature: 0.7,
                    max_tokens: config.maxTokens || 8192,
                });

                return response.choices[0]?.message?.content || '';
            } catch (error) {
                console.error('[CustomProvider] LLM error:', error);
                throw error;
            }
        };
    }

    createStreamingLLM(model, apiKey, config = {}) {
        const baseURL = config.baseURL || this.baseURL || 'https://api.openai.com/v1';
        
        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL: baseURL,
        });

        return async (prompts, callbacks) => {
            try {
                const stream = await this.client.chat.completions.create({
                    model: model,
                    messages: prompts,
                    temperature: 0.7,
                    max_tokens: config.maxTokens || 8192,
                    stream: true,
                });

                for await (const chunk of stream) {
                    const content = chunk.choices[0]?.delta?.content;
                    if (content && callbacks?.onUpdate) {
                        callbacks.onUpdate(content);
                    }
                }

                if (callbacks?.onComplete) {
                    callbacks.onComplete();
                }
            } catch (error) {
                console.error('[CustomProvider] Streaming error:', error);
                if (callbacks?.onError) {
                    callbacks.onError(error);
                }
                throw error;
            }
        };
    }
}

module.exports = new CustomProvider();

