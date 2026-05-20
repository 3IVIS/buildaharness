# pi-failover

Automatic failover extension for pi coding assistant.

## Installation

```bash
pi install ./pi-failover -l
# or
pi install npm:pi-failover -l
```

## Configuration

Set these environment variables to configure failover. The model settings accept the same format as defined in pi's `models.json` (model `id` from the provider's `models` array).

| Variable | Default | Description |
|--------|---------|---------|
| `PI_FAILOVER_ENABLED` | `true` | Enable/disable failover |
| `PI_FAILOVER_LOGGING` | `true` | Enable verbose logging |
| `PI_FAILOVER_PRIMARY_PROVIDER` | First provider in models.json | Primary provider name |
| `PI_FAILOVER_PRIMARY_MODEL` | (all models) | Primary model ID (optional, filters to single model) |
| `PI_FAILOVER_BACKUP_PROVIDER` | Second provider in models.json | Backup provider name |
| `PI_FAILOVER_BACKUP_MODEL` | (all models) | Backup model ID (optional, filters to single model) |
| `PI_FAILOVER_BACKUP_BASE_URL` | (from models.json) | Override backup provider's baseUrl |
| `PI_MODELS_JSON_PATH` | Auto-detected | Path to pi's models.json file |

### Supported Providers

- `ollama` (no API key required)
- `openai`
- `anthropic`
- `google` (Gemini)
- `groq`
- `azure_openai`
- `deepseek`
- `cerebras`
- `xai`
- `fireworks`
- `together`
- `openrouter`
- `ai_gateway`
- `zai`
- `mistral`
- `minimax`

## Usage

After installation, set your environment variables and use pi normally:

```bash
# Set backup API key
export OPENAI_API_KEY="sk-..."

# Use pi - basic example
pi "What is 2+2?"

# Check failover status
pi /failover-status
```

## How It Works

1. On startup, pi registers your primary provider (with optional model filter)
2. If the primary provider returns an error status (>=400), the extension:
   - Logs the error
   - Checks if backup provider is configured and has valid API key
   - Unregisters the primary provider
   - Registers the backup provider with its configuration (and model filter)
   - Logs that switch occurred

## Model Configuration

The extension reads provider configuration from pi's `models.json` file. You can optionally specify a single model for each provider using environment variables:

- `PI_FAILOVER_PRIMARY_MODEL` - Filter primary provider to a single model ID
- `PI_FAILOVER_BACKUP_MODEL` - Filter backup provider to a single model ID

Example `models.json` format:
```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://192.168.178.56:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {"id": "qwen3-coder-next"}
      ]
    },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai",
      "apiKey": "sk-...",
      "models": [
        {"id": "gpt-4o"}
      ]
    }
  }
}
```

Then use environment variables:
```bash
export PI_FAILOVER_PRIMARY_MODEL="qwen3-coder-next"
export PI_FAILOVER_BACKUP_MODEL="gpt-4o"
```

## Limitations

- Current implementation only switches providers after an error occurs
- Does not automatically retry the original request with backup (you need to re-send)
- Ollama requires `OLLAMA_BASE_URL` to be set if using a custom endpoint

## Future Enhancements

- [ ] Automatic retry of failed request with backup provider
- [ ] Circuit breaker pattern to prevent repeated failures
- [ ] Multiple backup providers with priority
- [ ] Provider health checks before making requests
- [ ] Custom failure detection rules
