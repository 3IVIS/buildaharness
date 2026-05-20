// pi-failover extension
// Automatic failover for pi when primary provider fails
// Reads configuration from pi's models.json file

import fs from "fs";
import path from "path";
import os from "os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Log helper - define first so it can be used during config loading
const log = (message: string) => {
  if (process.env.PI_FAILOVER_LOGGING !== "false") {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [pi-failover] ${message}`);
  }
};

// Read models.json at startup
let modelsConfig: any;
let configuredProviders: string[] = [];

function loadModelsConfig(): void {
  const modelsJsonPath = process.env.PI_MODELS_JSON_PATH || getPathToModelsJson();
  try {
    modelsConfig = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    log(`Loaded config from ${modelsJsonPath}`);
    configuredProviders = Object.keys(modelsConfig.providers || {});
  } catch (err) {
    log(`Warning: Could not load models.json: ${err}`);
    modelsConfig = { providers: {} };
  }
}

// Configuration - these can be overridden via environment variables
const config = {
  enabled: process.env.PI_FAILOVER_ENABLED !== "false",
  // Provider names
  primaryProvider: process.env.PI_FAILOVER_PRIMARY_PROVIDER || (configuredProviders[0] ?? "ollama"),
  backupProvider: process.env.PI_FAILOVER_BACKUP_PROVIDER || (configuredProviders[1] ?? "openai"),
  // Model IDs (optional - if not set, use all models from models.json)
  primaryModel: process.env.PI_FAILOVER_PRIMARY_MODEL,
  backupModel: process.env.PI_FAILOVER_BACKUP_MODEL,
  // Custom base URL for backup (to override what's in models.json)
  backupBaseUrl: process.env.PI_FAILOVER_BACKUP_BASE_URL,
};

loadModelsConfig();

// Extract model info from models.json for each provider
function getProviderModels(providerName: string, modelId?: string): Array<{ id: string; name?: string; reasoning?: boolean }> {
  const provider = modelsConfig.providers?.[providerName];
  if (!provider) return [];

  let models = (provider.models || []).map((m: { id: string; name?: string; reasoning?: boolean }) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
  }));

  // If specific model ID is requested, filter to only that model
  if (modelId) {
    models = models.filter((m: { id: string }) => m.id === modelId);
    if (models.length === 0) {
      log(`Warning: Model '${modelId}' not found in ${providerName} provider config`);
    }
  }

  return models;
}

// Get provider config from models.json
function getProviderConfigFromModelsJson(providerName: string): any | undefined {
  const provider = modelsConfig.providers?.[providerName];
  if (!provider) return undefined;

  const cfg: any = {};

  if (provider.baseUrl) cfg.baseUrl = provider.baseUrl;
  if (provider.api) cfg.api = provider.api;
  if (provider.apiKey) cfg.apiKey = provider.apiKey;
  if (provider.name) cfg.name = provider.name;
  if (provider.compat) cfg.compat = provider.compat;

  return cfg;
}

// Track current provider state
let currentProvider = config.primaryProvider;

/**
 * Get pi's models.json path
 */
function getPathToModelsJson(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".pi", "agent", "models.json"),
    path.join(home, ".pi", "models.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (fs.existsSync("models.json")) {
    return path.join(process.cwd(), "models.json");
  }

  return path.join(home, ".pi", "agent", "models.json");
}

/**
 * Check if provider configuration is valid (has baseUrl)
 */
function isProviderConfigured(provider: string): boolean {
  const cfg = getProviderConfigFromModelsJson(provider);
  return !!cfg?.baseUrl;
}

/**
 * The extension entry point
 */
export default async function (pi: ExtensionAPI) {
  log("pi-failover extension loaded");
  log(`Loaded providers from models.json: ${configuredProviders.join(", ") || "none"}`);
  log(`Primary: ${config.primaryProvider}`);
  if (config.primaryModel) {
    log(`Primary model: ${config.primaryModel}`);
  } else {
    log(`Primary model: (all models from models.json)`);
  }
  log(`Backup: ${config.backupProvider}`);
  if (config.backupModel) {
    log(`Backup model: ${config.backupModel}`);
  } else {
    log(`Backup model: (all models from models.json)`);
  }

  // Validate primary provider
  if (!isProviderConfigured(config.primaryProvider)) {
    log(`Warning: Primary provider ${config.primaryProvider} not configured (no baseUrl)`);
  }

  // Register the primary provider with models from models.json
  const primaryCfg = getProviderConfigFromModelsJson(config.primaryProvider);
  if (primaryCfg) {
    const models = getProviderModels(config.primaryProvider, config.primaryModel);
    if (models.length > 0) {
      primaryCfg.models = models;
      log(`Registering primary provider: ${config.primaryProvider} with ${models.length} models`);
    } else {
      log(`Registering primary provider: ${config.primaryProvider} (no models in models.json)`);
    }
    pi.registerProvider(config.primaryProvider, primaryCfg);
  }

  // Register backup provider
  if (config.backupProvider !== config.primaryProvider) {
    const backupCfg = getProviderConfigFromModelsJson(config.backupProvider);

    if (backupCfg) {
      if (config.backupBaseUrl) backupCfg.baseUrl = config.backupBaseUrl;
      const models = getProviderModels(config.backupProvider, config.backupModel);
      if (models.length > 0) {
        backupCfg.models = models;
        log(`Registering backup provider: ${config.backupProvider} with ${models.length} models`);
      }
      pi.registerProvider(config.backupProvider, backupCfg);
    } else {
      // Backup provider not in models.json
      log(`Warning: Backup provider ${config.backupProvider} not found in models.json`);
    }
  }

  // Listen for provider errors
  pi.on("after_provider_response", async (event) => {
    if (!config.enabled) return;

    if (event.status >= 400) {
      log(`Primary provider failed with status ${event.status}`);

      if (currentProvider === config.primaryProvider && isProviderConfigured(config.backupProvider)) {
        log("Attempting failover to backup provider");

        pi.unregisterProvider(config.primaryProvider);

        const backupCfg = getProviderConfigFromModelsJson(config.backupProvider);
        if (backupCfg) {
          if (config.backupBaseUrl) backupCfg.baseUrl = config.backupBaseUrl;
          const models = getProviderModels(config.backupProvider, config.backupModel);
          if (models.length > 0) {
            backupCfg.models = models;
          }
          pi.registerProvider(config.backupProvider, backupCfg);
        }

        currentProvider = config.backupProvider;

        console.log(`[pi-failover] Primary failed (${event.status}), switched to backup: ${config.backupProvider}`);
      }
    }
  });

  // Register a command to manually check providers
  pi.registerCommand("failover-status", {
    description: "Check failover provider status",
    handler: async (_args: string, ctx) => {
      const primaryOk = isProviderConfigured(config.primaryProvider);
      const backupOk = isProviderConfigured(config.backupProvider);

      const status = `
 Primary: ${config.primaryProvider} ${primaryOk ? "OK" : "MISSING"}
 ${config.primaryModel ? `Primary model: ${config.primaryModel}` : "Primary model: (all models)"}
 Backup: ${config.backupProvider} ${backupOk ? "OK" : "MISSING"}
 ${config.backupModel ? `Backup model: ${config.backupModel}` : "Backup model: (all models)"}
 Active: ${currentProvider}
 Models config: ${process.env.PI_MODELS_JSON_PATH || getPathToModelsJson()}
`;

      ctx.ui.notify(status, "info");
    },
  });

  log("pi-failover extension initialized");
}
