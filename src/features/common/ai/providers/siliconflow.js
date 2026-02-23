const OpenAI = require('openai');

class SiliconFlowProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string') {
            return { success: false, error: 'Invalid SiliconFlow API key format.' };
        }

        try {
            // 使用硅基流动的API端点验证
            const response = await fetch('https://api.siliconflow.cn/v1/models', {
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (response.ok) {
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `Validation failed with status: ${response.status}`;
                return { success: false, error: message };
            }
        } catch (error) {
            console.error(`[SiliconFlowProvider] Network error during key validation:`, error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}


/**
 * Creates a SiliconFlow LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - SiliconFlow API key
 * @param {string} [opts.model='Qwen/Qwen2.5-7B-Instruct'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=8192] - Max tokens
 * @returns {object} LLM instance
 */
function createLLM({ apiKey, model = 'Qwen/Qwen2.5-7B-Instruct', temperature = 0.7, maxTokens = 8192, ...config }) {
  const client = new OpenAI({ 
    apiKey,
    baseURL: 'https://api.siliconflow.cn/v1'
  });
  
  const callApi = async (messages) => {
    const response = await client.chat.completions.create({
      model: model,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens
    });
    return {
      content: response.choices[0].message.content.trim(),
      raw: response
    };
  };

  return {
    generateContent: async (parts) => {
      const messages = [];
      let systemPrompt = '';
      let userContent = [];
      
      for (const part of parts) {
        if (typeof part === 'string') {
          if (systemPrompt === '' && part.includes('You are')) {
            systemPrompt = part;
          } else {
            userContent.push({ type: 'text', text: part });
          }
        } else if (part.inlineData) {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
          });
        }
      }
      
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      if (userContent.length > 0) messages.push({ role: 'user', content: userContent });
      
      const result = await callApi(messages);

      return {
        response: {
          text: () => result.content
        },
        raw: result.raw
      };
    },
    
    // For compatibility with chat-style interfaces
    chat: async (messages) => {
      return await callApi(messages);
    }
  };
}

/**
 * Creates a SiliconFlow streaming LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - SiliconFlow API key
 * @param {string} [opts.model='Qwen/Qwen2.5-7B-Instruct'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=8192] - Max tokens
 * @returns {object} Streaming LLM instance
 */
function createStreamingLLM({ apiKey, model = 'Qwen/Qwen2.5-7B-Instruct', temperature = 0.7, maxTokens = 8192, ...config }) {
  return {
    streamChat: async (messages) => {
      const fetchUrl = 'https://api.siliconflow.cn/v1/chat/completions';
      
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`SiliconFlow API error: ${response.status} ${response.statusText}`);
      }

      return response;
    }
  };
}

module.exports = {
    SiliconFlowProvider,
    createLLM,
    createStreamingLLM
};
