const { EventEmitter } = require('events');
const Store = require('electron-store');
const { PROVIDERS, getProviderClass } = require('../ai/factory');
const encryptionService = require('./encryptionService');
const providerSettingsRepository = require('../repositories/providerSettings');
const authService = require('./authService');
const ollamaModelRepository = require('../repositories/ollamaModel');

class ModelStateService extends EventEmitter {
    constructor() {
        super();
        this.authService = authService;
        // electron-store는 오직 레거시 데이터 마이그레이션 용도로만 사용됩니다.
        this.store = new Store({ name: 'pickle-glass-model-state' });
    }

    async initialize() {
        console.log('[ModelStateService] Initializing one-time setup...');
        await this._initializeEncryption();
        await this._runMigrations();
        this.setupLocalAIStateSync();
        await this._autoSelectAvailableModels([], true);
        console.log('[ModelStateService] One-time setup complete.');
    }

    async _initializeEncryption() {
        try {
            const rows = await providerSettingsRepository.getRawApiKeys();
            if (rows.some(r => r.api_key && encryptionService.looksEncrypted(r.api_key))) {
                console.log('[ModelStateService] Encrypted keys detected, initializing encryption...');
                const userIdForMigration = this.authService.getCurrentUserId();
                await encryptionService.initializeKey(userIdForMigration);
            } else {
                console.log('[ModelStateService] No encrypted keys detected, skipping encryption initialization.');
            }
        } catch (err) {
            console.warn('[ModelStateService] Error while checking encrypted keys:', err.message);
        }
    }

    async _runMigrations() {
        console.log('[ModelStateService] Checking for data migrations...');
        const userId = this.authService.getCurrentUserId();
        
        try {
            const sqliteClient = require('./sqliteClient');
            const db = sqliteClient.getDb();
            const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_selections'").get();
            
            if (tableExists) {
                const selections = db.prepare('SELECT * FROM user_model_selections WHERE uid = ?').get(userId);
                if (selections) {
                    console.log('[ModelStateService] Migrating from user_model_selections table...');
                    if (selections.llm_model) {
                        const llmProvider = this.getProviderForModel(selections.llm_model, 'llm');
                        if (llmProvider) {
                            await this.setSelectedModel('llm', selections.llm_model);
                        }
                    }
                    if (selections.stt_model) {
                        const sttProvider = this.getProviderForModel(selections.stt_model, 'stt');
                        if (sttProvider) {
                            await this.setSelectedModel('stt', selections.stt_model);
                        }
                    }
                    db.prepare('DROP TABLE user_model_selections').run();
                    console.log('[ModelStateService] user_model_selections migration complete.');
                }
            }
        } catch (error) {
            console.error('[ModelStateService] user_model_selections migration failed:', error);
        }

        try {
            const legacyData = this.store.get(`users.${userId}`);
            if (legacyData && legacyData.apiKeys) {
                console.log('[ModelStateService] Migrating from electron-store...');
                for (const [provider, apiKey] of Object.entries(legacyData.apiKeys)) {
                    if (apiKey && PROVIDERS[provider]) {
                        await this.setApiKey(provider, apiKey);
                    }
                }
                if (legacyData.selectedModels?.llm) {
                    await this.setSelectedModel('llm', legacyData.selectedModels.llm);
                }
                if (legacyData.selectedModels?.stt) {
                    await this.setSelectedModel('stt', legacyData.selectedModels.stt);
                }
                this.store.delete(`users.${userId}`);
                console.log('[ModelStateService] electron-store migration complete.');
            }
        } catch (error) {
            console.error('[ModelStateService] electron-store migration failed:', error);
        }
    }
    
    setupLocalAIStateSync() {
        const localAIManager = require('./localAIManager');
        localAIManager.on('state-changed', (service, status) => {
            this.handleLocalAIStateChange(service, status);
        });
    }

    async handleLocalAIStateChange(service, state) {
        console.log(`[ModelStateService] LocalAI state changed: ${service}`, state);
        if (!state.installed || !state.running) {
            const selected = await this.getSelectedModels();
            const types = [];

            if (service === 'ollama') {
                const llmProvider = selected.llm ? await this._resolveProviderForModel('llm', selected.llm) : null;
                if (llmProvider === 'ollama') {
                    types.push('llm');
                }
            }

            if (service === 'whisper') {
                const sttProvider = selected.stt ? this.getProviderForModel(selected.stt, 'stt') : null;
                if (sttProvider === 'whisper') {
                    types.push('stt');
                }
            }

            if (types.length > 0) {
                await this._autoSelectAvailableModels(types);
            }
        }
        this.emit('state-updated', await this.getLiveState());
    }

    async getLiveState() {
        const providerSettings = await providerSettingsRepository.getAll();
        const apiKeys = {};
        Object.keys(PROVIDERS).forEach(provider => {
            const setting = providerSettings.find(s => s.provider === provider);
            apiKeys[provider] = setting?.api_key || null;
        });

        const activeSettings = await providerSettingsRepository.getActiveSettings();
        const selectedModels = {
            llm: activeSettings.llm?.selected_llm_model || null,
            stt: activeSettings.stt?.selected_stt_model || null
        };
        
        return { apiKeys, selectedModels };
    }

    async _autoSelectAvailableModels(forceReselectionForTypes = [], isInitialBoot = false) {
        console.log(`[ModelStateService] Running auto-selection. Force re-selection for: [${forceReselectionForTypes.join(', ')}]`);
        const { apiKeys, selectedModels } = await this.getLiveState();
        const types = ['llm', 'stt'];

        for (const type of types) {
            const currentModelId = selectedModels[type];
            let isCurrentModelValid = false;
            const forceReselection = forceReselectionForTypes.includes(type);

            if (currentModelId && !forceReselection) {
                const provider = await this._resolveProviderForModel(type, currentModelId);
                const apiKey = apiKeys[provider];
                if (provider && apiKey) {
                    isCurrentModelValid = true;
                }
            }

            if (!isCurrentModelValid) {
                console.log(`[ModelStateService] No valid ${type.toUpperCase()} model selected or selection forced. Finding an alternative...`);
                const availableModels = await this.getAvailableModels(type);
                if (availableModels.length > 0) {
                    let apiModel = null;
                    for (const model of availableModels) {
                        const provider = await this._resolveProviderForModel(type, model.id);
                        if (provider && provider !== 'ollama' && provider !== 'whisper') {
                            apiModel = model;
                            break;
                        }
                    }
                    const newModel = apiModel || availableModels[0];
                    await this.setSelectedModel(type, newModel.id);
                    console.log(`[ModelStateService] Auto-selected ${type.toUpperCase()} model: ${newModel.id}`);
                } else {
                    await providerSettingsRepository.setActiveProvider(null, type);
                    if (!isInitialBoot) {
                       this.emit('state-updated', await this.getLiveState());
                    }
                }
            }
        }
    }
    
    async setFirebaseVirtualKey(virtualKey) {
        console.log(`[ModelStateService] Setting Firebase virtual key.`);

        // 키를 설정하기 전에, 이전에 openai-glass 키가 있었는지 확인합니다.
        const previousSettings = await providerSettingsRepository.getByProvider('openai-glass');
        const wasPreviouslyConfigured = !!previousSettings?.api_key;

        // 항상 새로운 가상 키로 업데이트합니다.
        await this.setApiKey('openai-glass', virtualKey);

        if (virtualKey) {
            // 이전에 설정된 적이 없는 경우 (최초 로그인)에만 모델을 강제로 변경합니다.
            if (!wasPreviouslyConfigured) {
                console.log('[ModelStateService] First-time setup for openai-glass, setting default models.');
                const llmModel = PROVIDERS['openai-glass']?.llmModels[0];
                const sttModel = PROVIDERS['openai-glass']?.sttModels[0];
                if (llmModel) await this.setSelectedModel('llm', llmModel.id);
                if (sttModel) await this.setSelectedModel('stt', sttModel.id);
            } else {
                console.log('[ModelStateService] openai-glass key updated, but respecting user\'s existing model selection.');
            }
        } else {
            // 로그아웃 시, 현재 활성화된 모델이 openai-glass인 경우에만 다른 모델로 전환합니다.
            const selected = await this.getSelectedModels();
            const llmProvider = this.getProviderForModel(selected.llm, 'llm');
            const sttProvider = this.getProviderForModel(selected.stt, 'stt');
            
            const typesToReselect = [];
            if (llmProvider === 'openai-glass') typesToReselect.push('llm');
            if (sttProvider === 'openai-glass') typesToReselect.push('stt');

            if (typesToReselect.length > 0) {
                console.log('[ModelStateService] Logged out, re-selecting models for:', typesToReselect.join(', '));
                await this._autoSelectAvailableModels(typesToReselect);
            }
        }
    }

    async setApiKey(provider, key, config = {}) {
        console.log(`[ModelStateService] setApiKey for ${provider}`);
        if (!provider) {
            throw new Error('Provider is required');
        }

        // 'openai-glass'는 자체 인증 키를 사용하므로 유효성 검사를 건너뜁니다.
        if (provider !== 'openai-glass') {
            const validationResult = await this.validateApiKey(provider, key, config);
            if (!validationResult.success) {
                console.warn(`[ModelStateService] API key validation failed for ${provider}: ${validationResult.error}`);
                return validationResult;
            }
        }

        const finalKey = (provider === 'ollama' || provider === 'whisper') ? 'local' : key;
        const existingSettings = await providerSettingsRepository.getByProvider(provider) || {};
        const newSettings = { ...existingSettings, api_key: finalKey };
        
        // Store custom config for custom provider
        if (provider === 'custom' && config) {
            if (config.baseURL) newSettings.base_url = config.baseURL;
            if (config.customModels) newSettings.custom_models_json = config.customModels;
        }
        
        await providerSettingsRepository.upsert(provider, newSettings);
        
        // 키가 추가/변경되었으므로, 해당 provider의 모델을 자동 선택할 수 있는지 확인
        await this._autoSelectAvailableModels([]);
        
        this.emit('state-updated', await this.getLiveState());
        this.emit('settings-updated');
        return { success: true };
    }

    async getAllApiKeys() {
        const allSettings = await providerSettingsRepository.getAll();
        const apiKeys = {};
        allSettings.forEach(s => {
            if (s.provider !== 'openai-glass') {
                apiKeys[s.provider] = s.api_key;
            }
        });
        return apiKeys;
    }

    async removeApiKey(provider) {
        const setting = await providerSettingsRepository.getByProvider(provider);
        if (setting && setting.api_key) {
            await providerSettingsRepository.upsert(provider, { ...setting, api_key: null });
            await this._autoSelectAvailableModels(['llm', 'stt']);
            this.emit('state-updated', await this.getLiveState());
            this.emit('settings-updated');
            return true;
        }
        return false;
    }

    /**
     * 사용자가 Firebase에 로그인했는지 확인합니다.
     */
    isLoggedInWithFirebase() {
        return this.authService.getCurrentUser().isLoggedIn;
    }

    /**
     * 유효한 API 키가 하나라도 설정되어 있는지 확인합니다.
     */
    async hasValidApiKey() {
        if (this.isLoggedInWithFirebase()) return true;
        
        const allSettings = await providerSettingsRepository.getAll();
        return allSettings.some(s => s.api_key && s.api_key.trim().length > 0);
    }

    getProviderForModel(arg1, arg2) {
        // Compatibility: support both (type, modelId) old order and (modelId, type) new order
        let type, modelId;
        if (arg1 === 'llm' || arg1 === 'stt') {
            type = arg1;
            modelId = arg2;
        } else {
            modelId = arg1;
            type = arg2;
        }
        if (!modelId || !type) return null;
        for (const providerId in PROVIDERS) {
            const models = type === 'llm' ? PROVIDERS[providerId].llmModels : PROVIDERS[providerId].sttModels;
            if (models && models.some(m => m.id === modelId)) {
                return providerId;
            }
        }
        if (type === 'llm') {
            const installedModels = ollamaModelRepository.getInstalledModels();
            if (installedModels.some(m => m.name === modelId)) return 'ollama';
        }
        return null;
    }

    async getSelectedModels() {
        const active = await providerSettingsRepository.getActiveSettings();
        return {
            llm: active.llm?.selected_llm_model || null,
            stt: active.stt?.selected_stt_model || null,
        };
    }
    
    async setSelectedModel(type, modelId) {
        const provider = await this._resolveProviderForModel(type, modelId);
        if (!provider) {
            console.warn(`[ModelStateService] No provider found for model ${modelId}`);
            return false;
        }

        const existingSettings = await providerSettingsRepository.getByProvider(provider) || {};
        const newSettings = { ...existingSettings };

        if (type === 'llm') {
            newSettings.selected_llm_model = modelId;
        } else {
            newSettings.selected_stt_model = modelId;
        }
        
        await providerSettingsRepository.upsert(provider, newSettings);
        await providerSettingsRepository.setActiveProvider(provider, type);
        
        console.log(`[ModelStateService] Selected ${type} model: ${modelId} (provider: ${provider})`);
        
        if (type === 'llm' && provider === 'ollama') {
            require('./localAIManager').warmUpModel(modelId).catch(err => console.warn(err));
        }
        
        this.emit('state-updated', await this.getLiveState());
        this.emit('settings-updated');
        return true;
    }

    async _resolveProviderForModel(type, modelId) {
        let provider = this.getProviderForModel(modelId, type);
        if (!provider && type === 'llm') {
            provider = await this._findCustomModelProvider(modelId);
        }
        return provider;
    }

    async _findCustomModelProvider(modelId) {
        if (!modelId) return null;

        const allSettings = await providerSettingsRepository.getAll();
        for (const setting of allSettings) {
            if (!setting.api_key || !setting.custom_models_json) continue;

            try {
                const parsed = JSON.parse(setting.custom_models_json);
                const customModels = Array.isArray(parsed)
                    ? parsed
                    : (typeof parsed === 'string' && parsed.trim() ? [parsed.trim()] : []);
                if (customModels.includes(modelId)) {
                    return setting.provider;
                }
            } catch (error) {
                if (typeof setting.custom_models_json === 'string' && setting.custom_models_json.trim() === modelId) {
                    return setting.provider;
                }
                console.warn(`[ModelStateService] Failed parsing custom_models_json for ${setting.provider}:`, error?.message || error);
            }
        }

        return null;
    }

    async getAvailableModels(type) {
        const allSettings = await providerSettingsRepository.getAll();
        const available = [];
        const modelListKey = type === 'llm' ? 'llmModels' : 'sttModels';

        for (const setting of allSettings) {
            if (!setting.api_key) continue;

            const providerId = setting.provider;
            if (providerId === 'ollama' && type === 'llm') {
                const installed = ollamaModelRepository.getInstalledModels();
                available.push(...installed.map(m => ({ id: m.name, name: m.name })));
            } else if (PROVIDERS[providerId]?.[modelListKey]) {
                available.push(...PROVIDERS[providerId][modelListKey]);

                if (type === 'llm' && setting.custom_models_json) {
                    try {
                        const parsed = JSON.parse(setting.custom_models_json);
                        const customModels = Array.isArray(parsed)
                            ? parsed
                            : (typeof parsed === 'string' && parsed.trim() ? [parsed.trim()] : []);
                        if (customModels.length > 0) {
                            available.push(...customModels
                                .filter(modelName => typeof modelName === 'string' && modelName.trim())
                                .map(modelName => ({ id: modelName, name: modelName })));
                        }
                    } catch (error) {
                        if (typeof setting.custom_models_json === 'string' && setting.custom_models_json.trim()) {
                            const modelName = setting.custom_models_json.trim();
                            available.push({ id: modelName, name: modelName });
                        }
                        console.warn(`[ModelStateService] Failed to parse custom_models_json for ${providerId}:`, error?.message || error);
                    }
                }
            }
        }
        return [...new Map(available.map(item => [item.id, item])).values()];
    }

    async getCurrentModelInfo(type) {
        const activeSetting = await providerSettingsRepository.getActiveProvider(type);
        if (!activeSetting) return null;
        
        const model = type === 'llm' ? activeSetting.selected_llm_model : activeSetting.selected_stt_model;
        if (!model) return null;

        return {
            provider: activeSetting.provider,
            model: model,
            apiKey: activeSetting.api_key,
        };
    }

    // --- 핸들러 및 유틸리티 메서드 ---

    async validateApiKey(provider, key, config = {}) {
        if (!key || (key.trim() === '' && provider !== 'ollama' && provider !== 'whisper')) {
            return { success: false, error: 'API key cannot be empty.' };
        }
        const ProviderClass = getProviderClass(provider);
        if (!ProviderClass || typeof ProviderClass.validateApiKey !== 'function') {
            return { success: true };
        }
        try {
            return await ProviderClass.validateApiKey(key, config);
        } catch (error) {
            return { success: false, error: 'An unexpected error occurred during validation.' };
        }
    }

    getProviderConfig() {
        const config = {};
        for (const key in PROVIDERS) {
            const { handler, ...rest } = PROVIDERS[key];
            config[key] = rest;
        }
        return config;
    }
    
    async handleRemoveApiKey(provider) {
        const success = await this.removeApiKey(provider);
        if (success) {
            const selectedModels = await this.getSelectedModels();
            if (!selectedModels.llm && !selectedModels.stt) {
                this.emit('force-show-apikey-header');
            }
        }
        return success;
    }

    /*-------------- Compatibility Helpers --------------*/
    async handleValidateKey(provider, key, config = {}) {
        return await this.setApiKey(provider, key, config);
    }

    async handleSetSelectedModel(type, modelId) {
        return await this.setSelectedModel(type, modelId);
    }

    async areProvidersConfigured() {
        if (this.isLoggedInWithFirebase()) return true;
        const allSettings = await providerSettingsRepository.getAll();
        const apiKeyMap = {};
        allSettings.forEach(s => apiKeyMap[s.provider] = s.api_key);
        // LLM
        const hasLlmKey = Object.entries(apiKeyMap).some(([provider, key]) => {
            if (!key) return false;
            if (provider === 'whisper') return false; // whisper는 LLM 없음
            return PROVIDERS[provider]?.llmModels?.length > 0;
        });
        // STT
        const hasSttKey = Object.entries(apiKeyMap).some(([provider, key]) => {
            if (!key) return false;
            if (provider === 'ollama') return false; // ollama는 STT 없음
            return PROVIDERS[provider]?.sttModels?.length > 0 || provider === 'whisper';
        });
        return hasLlmKey && hasSttKey;
    }
}

const modelStateService = new ModelStateService();
module.exports = modelStateService;