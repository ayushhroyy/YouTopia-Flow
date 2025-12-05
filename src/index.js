/**
 * YOU_TOPIA FLOW | VAPI ALTERNATIVE
 * Version: V12_FLUX_EDITION (FIXED)
 * - Input: Deepgram Flux (v2/listen) - Native Turn Detection
 * - Logic: Mistral Small (OpenRouter)
 * - Output: Murf Falcon (TTS)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // A. Serve UI
    if (url.pathname === "/") {
      const html = HTML_UI.replace(
        "{{PHONE_NUMBER}}",
        env.TWILIO_PHONE_NUMBER || "Not Configured",
      );
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // B. Generate Agent
    if (url.pathname === "/generate-agent" && request.method === "POST") {
      const body = await request.json();
      try {
        // 1. Call Mistral
        const mistralResponse = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.OPENROUTER_KEY.trim()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "mistralai/mistral-small-3.2-24b-instruct",
              messages: [
                {
                  role: "system",
                  content: "Write a highly immersive system prompt for a voice AI roleplay agent based on the user's description. The prompt should instruct the AI to fully embody the character, use their mannerisms, catchphrases, and personality. Crucially, instruct the AI to talk as human as possible, using natural language, fillers (like 'umm', 'uh'), and casual phrasing where appropriate. Return ONLY the system prompt.",
                },
                { role: "user", content: body.prompt },
              ],
            }),
          },
        );

        const mistralData = await mistralResponse.json();
        const systemPrompt =
          mistralData.choices?.[0]?.message?.content ||
          "You are a helpful assistant.";

        const cleanNumber = (env.TWILIO_PHONE_NUMBER || "").replace(/\D/g, "");
        if (cleanNumber) {
          await env.AGENTS.put(
            cleanNumber,
            JSON.stringify({
              systemPrompt: systemPrompt,
              voiceId: body.voiceId || "Ken",
              transcriber: body.transcriber || "flux",
              created: Date.now(),
            }),
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            systemPrompt,
            phoneNumber: env.TWILIO_PHONE_NUMBER,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
        });
      }
    }

    // B2. Save Agent (Manual Update)
    if (url.pathname === "/save-agent" && request.method === "POST") {
      const body = await request.json();
      const cleanNumber = (env.TWILIO_PHONE_NUMBER || "").replace(/\D/g, "");
      if (cleanNumber) {
        await env.AGENTS.put(
          cleanNumber,
          JSON.stringify({
            systemPrompt: body.systemPrompt,
            voiceId: body.voiceId || "Ken",
            transcriber: body.transcriber || "flux",
            created: Date.now(),
          }),
        );
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // C. Incoming Call
    if (url.pathname === "/incoming-call" && request.method === "POST") {
      const xml = `
            <Response>
                <Say>Connecting to Flux Agent.</Say>
                <Connect>
                    <Stream url="wss://${url.host}/websocket" />
                </Connect>
                <Pause length="3600" />
            </Response>`;
      return new Response(xml, { headers: { "Content-Type": "text/xml" } });
    }

    // D. WebSocket Handler
    if (url.pathname === "/websocket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const id = env.CALL_MANAGER.idFromName("global_manager");
      const stub = env.CALL_MANAGER.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ==========================================
// 3. DURABLE OBJECT (THE BRAIN)
// ==========================================
export class CallManager {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server).catch((e) => console.error(e));
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws) {
    ws.accept();
    console.log("=== [SESSION STARTED] ===");

    let dgWs = null;
    let murfWs = null;
    let streamSid = null;
    let systemPrompt = "You are a helpful assistant.";
    let voiceId = "Ken";
    let transcriber = "flux";

    let isAiSpeaking = false;
    let isFirstMurfChunk = true;

    // --- CRITICAL: Set up Twilio handler IMMEDIATELY ---
    // Must be done before ANY await calls (like KV get or fetch)
    // to ensure we capture the 'start' event.
    let audioChunkCount = 0;
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log(`[TWILIO] Stream Started - StreamSid: ${streamSid}`);
        console.log(`[TWILIO] Call SID: ${data.start.callSid}`);
        console.log(`[TWILIO] Media format: ${JSON.stringify(data.start.mediaFormat)}`);
      }

      if (data.event === "media") {
        audioChunkCount++;
        // Log every 50th chunk to avoid spam
        if (audioChunkCount % 50 === 1) {
          console.log(`[TWILIO] Audio chunk #${audioChunkCount}, payload size: ${data.media.payload.length}, streamSid: ${streamSid ? 'SET' : 'null'}`);
          console.log(`[TWILIO] Deepgram WS state: ${dgWs ? dgWs.readyState : 'null'} (1=OPEN)`);
        }

        // Send raw Twilio audio (mulaw) directly to Deepgram Flux
        if (dgWs && dgWs.readyState === 1) {
          const chunk = base64ToBuffer(data.media.payload);
          dgWs.send(chunk);
        } else {
          if (audioChunkCount <= 5) {
            console.warn(`[TWILIO] Cannot forward audio - Deepgram WS not ready (state: ${dgWs?.readyState})`);
          }
        }
      }

      if (data.event === "stop") {
        console.log(`[TWILIO] Call Ended - Total audio chunks received: ${audioChunkCount}`);
        if (dgWs) dgWs.close();
        if (murfWs) murfWs.close();
      }
    });

    // Load Config
    try {
      const cleanNumber = (this.env.TWILIO_PHONE_NUMBER || "").replace(
        /\D/g,
        "",
      );
      if (cleanNumber) {
        const agentConfig = await this.env.AGENTS.get(cleanNumber, {
          type: "json",
        });
        if (agentConfig) {
          systemPrompt = agentConfig.systemPrompt;
          if (agentConfig.voiceId) voiceId = agentConfig.voiceId;
          if (agentConfig.transcriber) transcriber = agentConfig.transcriber;
        }
      }
      console.log(`[CONFIG] Prompt Loaded`);
    } catch (e) {
      console.error("KV Error", e);
    }

    // --- 1. CONNECT DEEPGRAM FLUX ---
    try {
      // Use fetch-based WebSocket upgrade with Authorization header (works in CF Workers)
      let dgUrl = `https://api.deepgram.com/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000`;
      if (transcriber === "nova-3") {
        dgUrl = `https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true&encoding=mulaw&sample_rate=8000&endpointing=300`;
      }

      console.log(`[FLUX] Connecting via fetch upgrade to: ${dgUrl}`);
      console.log(`[FLUX] API Key (first 10 chars): ${this.env.DEEPGRAM_API_KEY?.substring(0, 10)}...`);

      // Cloudflare Workers: Use fetch with Upgrade header for WebSocket
      const dgResponse = await fetch(dgUrl, {
        headers: {
          "Upgrade": "websocket",
          "Authorization": `Token ${this.env.DEEPGRAM_API_KEY.trim()}`,
        },
      });

      if (dgResponse.status !== 101) {
        console.error(`[FLUX] Upgrade failed! Status: ${dgResponse.status}`);
        const errorText = await dgResponse.text();
        console.error(`[FLUX] Error response: ${errorText}`);
        throw new Error(`Deepgram upgrade failed: ${dgResponse.status}`);
      }

      dgWs = dgResponse.webSocket;
      if (!dgWs) {
        console.error(`[FLUX] No webSocket object in response!`);
        throw new Error("No WebSocket in Deepgram response");
      }

      dgWs.accept();
      console.log(`[FLUX] WebSocket accepted and ready ✅`);

      dgWs.addEventListener("open", () => {
        console.log("[FLUX] Connected ✅");

      });

      dgWs.addEventListener("message", async (msg) => {
        try {
          const res = JSON.parse(msg.data);

          // --- NOVA-3 LOGIC ---
          if (transcriber === "nova-3") {
            if (res.channel && res.channel.alternatives && res.channel.alternatives[0]) {
              const alt = res.channel.alternatives[0];
              // 1. End of Turn (speech_final)
              if (alt.transcript && res.speech_final) {
                const transcript = alt.transcript;
                if (transcript.trim() !== "") {
                  console.log(`[USER FINAL]: "${transcript}"`);
                  const llmResponse = await this.queryMistral(transcript, systemPrompt);
                  console.log(`[AI REPLY]: "${llmResponse}"`);
                  if (murfWs && murfWs.readyState === 1) {
                    isAiSpeaking = true;
                    isFirstMurfChunk = true;
                    const textMsg = { text: llmResponse, end: true };
                    murfWs.send(JSON.stringify(textMsg));
                  }
                }
              }
              // 2. Interruption (Interim results while AI is speaking)
              if (isAiSpeaking && res.is_final === false) {
                console.log(`[INTERRUPT] User started speaking`);
                isAiSpeaking = false;
                if (ws.readyState === 1 && streamSid) {
                  ws.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
                }
              }
            }
            return; // Exit Nova-3 logic
          }

          // --- FLUX TURN DETECTION LOGIC (Existing) ---

          // 1. Check for EndOfTurn (The User Finished Speaking)
          if (res.type === "TurnInfo" && res.event === "EndOfTurn") {
            const transcript = res.transcript;
            if (!transcript || transcript.trim() === "") return;

            console.log(`[USER FINAL]: "${transcript}"`);

            // Query LLM
            const llmResponse = await this.queryMistral(
              transcript,
              systemPrompt,
            );
            console.log(`[AI REPLY]: "${llmResponse}"`);

            // Send to Murf
            if (murfWs && murfWs.readyState === 1) {
              isAiSpeaking = true;
              isFirstMurfChunk = true;
              console.log(`[MURF] Sending text to TTS, murfWs.readyState: ${murfWs.readyState}`);
              // Per Murf WebSocket docs: text message needs "end: true" to signal end of turn
              const textMsg = { text: llmResponse, end: true };
              murfWs.send(JSON.stringify(textMsg));
              console.log(`[MURF] Text sent: ${JSON.stringify(textMsg).substring(0, 80)}...`);
            } else {
              console.error(`[MURF] Cannot send to TTS - WS state: ${murfWs?.readyState}, murfWs exists: ${!!murfWs}`);
            }
          }

          // 2. Check for StartOfTurn (User Started Speaking - Interrupt)
          if (res.type === "TurnInfo" && res.event === "StartOfTurn") {
            if (isAiSpeaking) {
              console.log(`[INTERRUPT] User started speaking`);
              isAiSpeaking = false;
              // Kill audio on phone
              if (ws.readyState === 1 && streamSid) {
                ws.send(
                  JSON.stringify({ event: "clear", streamSid: streamSid }),
                );
              }
            }
          }

          // 3. Log other events for debugging
          if (res.type === "TurnInfo") {
            console.log(`[FLUX EVENT] ${res.event}`);
          }
        } catch (e) {
          console.error("[FLUX] Message parse error:", e);
        }
      });

      dgWs.addEventListener("close", (e) =>
        console.log(`[FLUX] Closed: ${e.code}`),
      );

      dgWs.addEventListener("error", (e) =>
        console.error(`[FLUX] WebSocket Error:`, e),
      );
    } catch (e) {
      console.error("[FLUX] Connection Error:", e);
    }

    // --- 2. CONNECT MURF FALCON ---
    let murfAudioChunks = 0;
    try {
      const murfUrl = `https://global.api.murf.ai/v1/speech/stream-input?api-key=${this.env.MURF_API_KEY.trim()}&model=FALCON&sample_rate=24000&format=WAV`;
      console.log(`[MURF] Connecting via fetch upgrade...`);
      console.log(`[MURF] API Key (first 10 chars): ${this.env.MURF_API_KEY?.substring(0, 10)}...`);

      // Try fetch-based WebSocket for Cloudflare Workers
      const murfResponse = await fetch(murfUrl, {
        headers: {
          "Upgrade": "websocket",
        },
      });

      if (murfResponse.status !== 101) {
        console.error(`[MURF] Upgrade failed! Status: ${murfResponse.status}`);
        const errorText = await murfResponse.text();
        console.error(`[MURF] Error response: ${errorText}`);
        throw new Error(`Murf upgrade failed: ${murfResponse.status}`);
      }

      murfWs = murfResponse.webSocket;
      if (!murfWs) {
        console.error(`[MURF] No webSocket object in response!`);
        throw new Error("No WebSocket in Murf response");
      }

      murfWs.accept();
      console.log(`[MURF] WebSocket accepted and ready ✅`);

      // Send voice config immediately after accept (per Murf Falcon WebSocket docs)
      const voiceConfig = {
        voice_config: {
          voiceId: voiceId,
          multiNativeLocale: voiceId === "Aman" ? "hi-IN" : "en-US",
          style: "Conversation",
          rate: 0,
          pitch: 0,
          variation: 1
        }
      };
      murfWs.send(JSON.stringify(voiceConfig));
      console.log(`[MURF] Voice config sent: ${JSON.stringify(voiceConfig)}`);

      murfWs.addEventListener("message", async (msg) => {
        console.log(`[MURF] Message received, type: ${typeof msg.data}, isAiSpeaking: ${isAiSpeaking}`);

        if (!isAiSpeaking) {
          console.log(`[MURF] Ignoring audio - AI not speaking`);
          return;
        }

        try {
          const data = JSON.parse(msg.data);
          console.log(`[MURF] Parsed message keys: ${Object.keys(data).join(', ')}`);

          if (data.audio) {
            murfAudioChunks++;
            let pcmBuffer = base64ToBuffer(data.audio);
            console.log(`[MURF] Audio chunk #${murfAudioChunks}, raw size: ${pcmBuffer.byteLength}`);

            // Strip WAV Header on first chunk
            if (isFirstMurfChunk) {
              if (pcmBuffer.byteLength > 44) {
                pcmBuffer = pcmBuffer.slice(44);
                isFirstMurfChunk = false;
                console.log(`[MURF] Stripped WAV header, new size: ${pcmBuffer.byteLength}`);
              } else {
                console.log(`[MURF] Chunk too small for WAV header, skipping`);
                return;
              }
            }

            // Transcode 24k -> 8k
            const muLawBuffer = convert24kPcmTo8kMuLaw(pcmBuffer);
            const payload = bufferToBase64(muLawBuffer);
            console.log(`[MURF] Transcoded to mulaw, size: ${muLawBuffer.byteLength}`);

            if (ws.readyState === 1 && streamSid) {
              ws.send(
                JSON.stringify({
                  event: "media",
                  streamSid: streamSid,
                  media: { payload: payload },
                }),
              );
              console.log(`[MURF->TWILIO] Sent audio chunk #${murfAudioChunks} to phone`);
            } else {
              console.warn(`[MURF] Cannot send to Twilio - WS state: ${ws.readyState}, streamSid: ${streamSid}`);
            }
          } else if (data.error) {
            console.error(`[MURF] Error from API: ${JSON.stringify(data.error)}`);
          } else if (data.status) {
            console.log(`[MURF] Status: ${data.status}`);
          }
        } catch (parseError) {
          console.error(`[MURF] Failed to parse message: ${parseError.message}`);
          console.log(`[MURF] Raw message: ${msg.data?.substring?.(0, 100) || 'binary'}`);
        }
      });

      murfWs.addEventListener("close", (e) =>
        console.log(`[MURF] Closed: ${e.code}, total audio chunks: ${murfAudioChunks}`),
      );

      murfWs.addEventListener("error", (e) =>
        console.error(`[MURF] WebSocket Error:`, e),
      );
    } catch (e) {
      console.error("[MURF] Connect Error:", e);
    }
  }

  async queryMistral(input, system) {
    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.OPENROUTER_KEY.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "mistralai/mistral-small-3.2-24b-instruct",
            messages: [
              {
                role: "system",
                content:
                  system +
                  " You are roleplaying. Stay in character. Keep responses very short (max 1 sentence). Be conversational and ask follow-up questions.",
              },
              { role: "user", content: input },
            ],
          }),
        },
      );
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "I didn't catch that.";
    } catch (e) {
      console.error("[LLM] Error", e);
      return "Thinking...";
    }
  }
}

// ==========================================
// 4. AUDIO UTILITIES
// ==========================================
function base64ToBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function convert24kPcmTo8kMuLaw(inputBuffer) {
  const inputView = new DataView(inputBuffer);
  const outputSize = Math.floor(inputView.byteLength / 2 / 3);
  const output = new Uint8Array(outputSize);
  let outIndex = 0;
  // Downsample 3:1
  for (let i = 0; i < inputView.byteLength; i += 6) {
    if (outIndex >= outputSize) break;
    let sample = inputView.getInt16(i, true);
    output[outIndex++] = encodeMuLaw(sample);
  }
  return output.buffer;
}

function encodeMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = 0;
  if (sample > 0x7fff) exponent = 8;
  else if (sample >= 0x4000) exponent = 7;
  else if (sample >= 0x2000) exponent = 6;
  else if (sample >= 0x1000) exponent = 5;
  else if (sample >= 0x0800) exponent = 4;
  else if (sample >= 0x0400) exponent = 3;
  else if (sample >= 0x0200) exponent = 2;
  else if (sample >= 0x0100) exponent = 1;
  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  let mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xff;
}

// ==========================================
// 5. HTML UI
// ==========================================
const HTML_UI = `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YouTopia Flow | Agent Builder</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
    <style>
        :root { --bg-color: #050505; --glass-bg: rgba(255, 255, 255, 0.03); --glass-border: rgba(255, 255, 255, 0.08); --accent-glow: #7c3aed; --text-main: #ffffff; --text-muted: #a1a1aa; --btn-bg: #ffffff; --btn-text: #000000; --code-bg: #0f0f11; }
        * { box-sizing: border-box; margin: 0; padding: 0; outline: none; }
        body { background-color: var(--bg-color); color: var(--text-main); font-family: 'Inter', sans-serif; height: 100vh; display: flex; justify-content: center; align-items: center; overflow: hidden; }
        .ambient-glow { position: absolute; width: 600px; height: 600px; background: radial-gradient(circle, var(--accent-glow) 0%, rgba(0,0,0,0) 70%); opacity: 0.15; border-radius: 50%; pointer-events: none; z-index: 0; }
        .main-layout { display: flex; width: 100%; max-width: 1400px; height: 100vh; position: relative; z-index: 10; transition: all 0.6s ease; }
        .prompt-section { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 40px; transition: all 0.6s ease; }
        .config-section { flex: 0; width: 0; opacity: 0; background: var(--glass-bg); border-left: 1px solid var(--glass-border); padding: 0; overflow: hidden; transition: all 0.6s ease; display: flex; flex-direction: column; }
        body.split-view .prompt-section { flex: 0 0 40%; align-items: flex-start; justify-content: flex-start; padding-top: 80px; }
        body.split-view .config-section { flex: 1; width: auto; opacity: 1; padding: 40px; }
        h1 { font-size: 3rem; font-weight: 600; margin-bottom: 0.5rem; background: linear-gradient(135deg, #fff 30%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        body.split-view h1 { font-size: 2rem; }
        .input-wrapper { width: 100%; max-width: 700px; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 20px; padding: 12px 16px; display: flex; flex-direction: column; min-height: 80px; }
        .prompt-input { background: transparent; border: none; color: #fff; font-size: 1rem; resize: none; min-height: 40px; }
        .action-btn { background: var(--btn-bg); color: var(--btn-text); border: none; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; display: flex; justify-content: center; align-items: center; align-self: flex-end; margin-top: 6px; }
        .config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .form-select, .form-input { width: 100%; background: rgba(255,255,255,0.08); border: 1px solid var(--glass-border); color: #fff; padding: 10px; border-radius: 8px; }
        .system-prompt-editor { flex: 1; background: var(--code-bg); border: 1px solid var(--glass-border); border-radius: 12px; padding: 20px; color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 0.9rem; line-height: 1.6; resize: none; }
        .status-text { font-size: 0.85rem; color: var(--text-muted); margin-top: 1rem; }
    </style>
</head>
<body>
    <div class="ambient-glow"></div>
    <div class="main-layout">
        <section class="prompt-section">
            <h1 id="mainTitle">YouTopia Flow</h1>
            <div class="input-wrapper">
                <textarea class="prompt-input" id="agentInput" placeholder="Describe your agent..." autofocus rows="1"></textarea>
                <button class="action-btn" id="generateBtn">→</button>
            </div>
            <div class="status-text" id="statusText">AI AGENT BUILDER • READY</div>
        </section>
        <section class="config-section">
            <h2 style="margin-bottom: 20px; font-weight: 500;">Agent Configuration</h2>
            <div class="config-grid">
                <div><label style="display:block; font-size:0.85rem; color:#a1a1aa; margin-bottom:8px;">Voice Provider</label><select class="form-select" id="voiceSelect"><option value="Ken">Ken (English US)</option><option value="Zion">Zion (English/Hindi)</option><option value="Aman">Aman (Hindi)</option></select></div>
                <div><label style="display:block; font-size:0.85rem; color:#a1a1aa; margin-bottom:8px;">Phone Number</label><input type="text" class="form-input" value="{{PHONE_NUMBER}}" disabled></div>
                <div><label style="display:block; font-size:0.85rem; color:#a1a1aa; margin-bottom:8px;">Transcriber</label><select class="form-select" id="transcriberSelect"><option value="flux">Deepgram Flux (English Only)</option><option value="nova-3">Deepgram Nova-3 (Eng/Hindi)</option></select></div>
                <div><label style="display:block; font-size:0.85rem; color:#a1a1aa; margin-bottom:8px;">Model</label><select class="form-select"><option>Mistral Small 3.2 24B</option></select></div>
            </div>
            <div style="flex:1; display:flex; flex-direction:column;">
                <label style="display:flex; justify-content:space-between; font-size:0.85rem; color:#a1a1aa; margin-bottom:8px;">System Prompt</label>
                <textarea class="system-prompt-editor" id="systemPromptDisplay">Waiting for generation...</textarea>
                <button id="deployBtn" style="margin-top:20px; width:100%; padding:15px; background:#fff; color:#000; border:none; border-radius:10px; font-weight:600; cursor:pointer;">Deploy Agent</button>
            </div>
        </section>
    </div>
    <script>
        const input = document.getElementById('agentInput');
        const btn = document.getElementById('generateBtn');
        const body = document.body;
        const statusText = document.getElementById('statusText');
        const editor = document.getElementById('systemPromptDisplay');
        const deployBtn = document.getElementById('deployBtn');

        deployBtn.addEventListener('click', async () => {
            statusText.innerText = "SAVING...";
            statusText.style.color = "var(--accent-glow)";
            const voiceSelect = document.getElementById('voiceSelect');
            const transcriberSelect = document.getElementById('transcriberSelect');
            try {
                await fetch('/save-agent', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        systemPrompt: editor.value,
                        voiceId: voiceSelect.value,
                        transcriber: transcriberSelect.value
                    })
                });
                statusText.innerText = "AGENT DEPLOYED";
                statusText.style.color = "#22c55e";
            } catch(e) { console.error(e); statusText.innerText = "ERROR SAVING"; statusText.style.color = "#ef4444"; }
        });

        btn.addEventListener('click', runGeneration);
        input.addEventListener('keypress', (e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runGeneration(); }});

        async function runGeneration() {
            if(!input.value) return;
            statusText.innerText = "GENERATING SYSTEM PROMPT...";
            statusText.style.color = "var(--accent-glow)";
            try {
                const voiceSelect = document.getElementById('voiceSelect');
                const transcriberSelect = document.getElementById('transcriberSelect');
                const res = await fetch('/generate-agent', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ prompt: input.value, voiceId: voiceSelect.value, transcriber: transcriberSelect.value }) });
                const data = await res.json();
                body.classList.add('split-view');
                statusText.innerText = "AGENT CONFIGURED";
                statusText.style.color = "var(--text-muted)";
                editor.value = data.systemPrompt;
            } catch(e) { console.error(e); statusText.innerText = "ERROR"; statusText.style.color = "#ef4444"; }
        }
    </script>
</body>
</html>
`;
