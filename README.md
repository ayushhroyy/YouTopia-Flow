# YouTopia Flow

YouTopia Flow is a powerful AI-powered voice agent platform built on Cloudflare Workers - a VAPI alternative that runs on the edge.

## Features

- 🎙️ **Real-time Voice AI**: Deepgram Flux & Nova-3 for multilingual transcription (English/Hindi)
- 🤖 **Intelligent Responses**: Mistral Small 3.2 via OpenRouter for natural conversations
- 🗣️ **Natural TTS**: Murf Falcon for high-quality voice synthesis
- ⚡ **Edge Computing**: Cloudflare Workers + Durable Objects for global low-latency
- 📞 **Telephony Integration**: Twilio for phone call handling
- 🔄 **Turn Detection**: Native interruption handling for natural conversations
- 🌐 **Multi-language**: Support for English and Hindi

## Tech Stack

- **Transcription**: Deepgram Flux (v2/listen) & Nova-3
- **LLM**: Mistral Small 3.2 24B (via OpenRouter)
- **TTS**: Murf Falcon
- **Infrastructure**: Cloudflare Workers, Durable Objects, KV
- **Telephony**: Twilio

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/ayushhroyy/YouTopia-Flow.git
cd YouTopia-Flow
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create `wrangler.toml`

Create a `wrangler.toml` file in the root directory with the following configuration:

```toml
name = "youtopia-flow"
main = "src/index.js"
compatibility_date = "2024-01-01"

[env.production]
name = "youtopia-flow"

[[durable_objects.bindings]]
name = "CALL_MANAGER"
class_name = "CallManager"

[[migrations]]
tag = "v1"
new_classes = ["CallManager"]

[[kv_namespaces]]
binding = "AGENTS"
id = "YOUR_KV_NAMESPACE_ID"

[vars]
TWILIO_PHONE_NUMBER = "+1234567890"

# Add these as secrets using: wrangler secret put SECRET_NAME
# DEEPGRAM_API_KEY = "your-deepgram-api-key"
# MURF_API_KEY = "your-murf-api-key"
# OPENROUTER_KEY = "your-openrouter-api-key"
```

### 4. Set up API Keys

You'll need to obtain API keys from:

- **Deepgram**: [https://deepgram.com](https://deepgram.com) - For speech-to-text
- **Murf AI**: [https://murf.ai](https://murf.ai) - For text-to-speech
- **OpenRouter**: [https://openrouter.ai](https://openrouter.ai) - For LLM access
- **Twilio**: [https://twilio.com](https://twilio.com) - For phone integration

### 5. Create KV Namespace

```bash
npx wrangler kv:namespace create "AGENTS"
```

Copy the generated namespace ID and update it in your `wrangler.toml`.

### 6. Add Secrets

```bash
npx wrangler secret put DEEPGRAM_API_KEY
npx wrangler secret put MURF_API_KEY
npx wrangler secret put OPENROUTER_KEY
```

### 7. Deploy

```bash
npx wrangler deploy
```

## Configuration

### Voice Options

- **Ken**: English (US) - Default
- **Zion**: English/Hindi - Bilingual
- **Aman**: Hindi - Native

### Transcriber Options

- **Flux**: Deepgram Flux (English only, native turn detection)
- **Nova-3**: Deepgram Nova-3 (English/Hindi multilingual)

## Usage

1. Visit your deployed worker URL
2. Describe your AI agent (e.g., "Create a friendly customer support agent")
3. Select voice and transcriber options
4. Click generate to create the system prompt
5. Deploy the agent to your Twilio phone number
6. Call the number to interact with your AI agent!

## Architecture

The system orchestrates three simultaneous WebSocket connections:

1. **Twilio** ↔️ **Worker**: Handles phone audio (μ-law, 8kHz)
2. **Worker** ↔️ **Deepgram**: Transcribes speech to text
3. **Worker** ↔️ **Murf**: Converts AI responses to speech

Audio processing includes real-time transcoding (24kHz PCM → 8kHz μ-law) and WAV header stripping.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
