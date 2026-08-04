// Telegram bot Cloudflare Worker
// Receives Telegram webhooks. Tries the user's local Claude bridge first (via cloudflared tunnel),
// falls back to Google Gemini (always-available free tier). Nothing system-specific hardcoded.

async function reactToMessage(botToken, chatId, messageId) {
  const url = `https://api.telegram.org/bot${botToken}/setMessageReaction`;
  const emojis = ['👍', '❤️', '🔥', '😂', '🎉', '👏', '🤝', '💪'];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    }),
  }).catch(() => null);
}

// In-memory map: replyId -> user question (resets on worker restart, acceptable)
const replyContext = new Map();

async function sendTelegram(botToken, chatId, text, userQuestion) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const replyId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (userQuestion) {
    replyContext.set(replyId, userQuestion);
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👍', callback_data: `fb:like:${replyId}` },
            { text: '👎', callback_data: `fb:dislike:${replyId}` },
            { text: '🚩 Report', callback_data: `fb:report:${replyId}` },
          ],
        ],
      },
    }),
  });
}

// Model fallback chain: tries each model until one works (quota/limit errors skip to next)
const MODEL_CHAIN = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-pro-latest',
];

// Backup API (OpenAI-compatible) used when all Gemini models fail
async function askBackupApi(apiKey, baseUrl, text, models) {
  const modelList = (models || 'llama-3.1-8b-instant')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let lastErr = null;
  for (const model of modelList) {
    try {
      const url = `${baseUrl}/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: text }],
          max_tokens: 500,
        }),
      });
      if (!resp.ok) {
        lastErr = new Error(`Backup ${model} failed (${resp.status})`);
        continue;
      }
      const data = await resp.json();
      let reply = (data.choices?.[0]?.message?.content || '').trim();
      if (reply) return reply;
      lastErr = new Error(`Backup ${model} empty`);
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('All backup models failed');
}

async function askGemini(apiKey, text, models) {
  const modelList = (models || MODEL_CHAIN.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let lastErr = null;
  for (const model of modelList) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
      });
      if (resp.status === 429 || resp.status === 404 || resp.status === 403) {
        lastErr = new Error(`Model ${model} unavailable (${resp.status})`);
        continue; // try next model
      }
      if (!resp.ok) {
        lastErr = new Error('Gemini error: ' + (await resp.text()).slice(0, 200));
        continue;
      }
      const data = await resp.json();
      const reply = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (reply) return reply;
      lastErr = new Error(`Model ${model} returned empty`);
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

async function askLocalBridge(bridgeUrl, chatId, text) {
  if (!bridgeUrl) return null;
  try {
    const health = await fetch(bridgeUrl + '/api/health', {
      signal: AbortSignal.timeout(2000),
    });
    if (!health.ok) return null;
    const h = await health.json();
    if (!h.ok) return null;
    const ask = await fetch(bridgeUrl + '/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text }),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);
    if (!ask) return null;
    const r = await ask.json();
    return r.ok && r.reply ? r.reply : null;
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }
    const body = await request.json().catch(() => null);

    // Handle callback_query (like / dislike / report buttons)
    if (body && body.callback_query) {
      const cq = body.callback_query;
      const data = cq.data || '';
      if (data.startsWith('fb:')) {
        const parts = data.split(':');
        const action = parts[1];
        const replyId = parts[2] || '';
        const user = cq.from || {};
        const qmsg = cq.message || {};
        if (action === 'report') {
          const userQuestion = replyContext.get(replyId) || '(unknown)';
          const reportText = `🚩 **New report**\n👤 From: ${user.first_name || ''} ${user.username ? '@' + user.username : ''} (ID: ${user.id})\n❓ User question: ${userQuestion}\n🤖 Bot reply: ${qmsg.text || ''}`;
          replyContext.delete(replyId);
          const adminId = env.ADMIN_ID;
          if (adminId) {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: adminId, text: reportText }),
            }).catch(() => null);
          }
        }
        const ackText = action === 'like' ? 'Thanks for the like!' : action === 'dislike' ? 'Sorry! Help me improve' : 'Report submitted. Thanks!';
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id, text: ackText }),
        }).catch(() => null);
      }
      return new Response('OK', { status: 200 });
    }

    const msg = body && body.message;
    if (!msg) return new Response('OK', { status: 200 });

    const chatId = msg.chat && msg.chat.id;
    const text = msg.text || msg.caption || '';

    if (msg.message_id) {
      // Fire-and-forget: reaction must reach Telegram even if the LLM call later times out
      ctx.waitUntil(reactToMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id));
    }

    // ===== PHOTO RECEIVED → describe it with Gemini vision =====
    if (msg.photo && msg.photo.length > 0 && env.GEMINI_API_KEY) {
      try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileInfo = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`).then((r) => r.json());
        const filePath = fileInfo.result && fileInfo.result.file_path;
        if (filePath) {
          const img = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`).then((r) => r.arrayBuffer());
          const base64 = btoa(String.fromCharCode(...new Uint8Array(img).slice(0, 500000)));
          const mime = filePath.endsWith('.jpg') || filePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
          const prompt = `The user sent this photo${text && text !== '[photo]' ? ` with caption: "${text}"` : ''}. Describe what you see in a short friendly way (1-3 sentences), in the same language as the caption if any. Use 1-2 emojis.`;
          let desc = '';
          // Try Gemini vision models first
          for (const vmodel of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
            try {
              const visionResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${vmodel}:generateContent?key=${env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }] }],
                }),
              });
              if (visionResp.status === 429 || visionResp.status === 404) continue;
              const vdata = await visionResp.json();
              desc = (vdata.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
              if (desc) break;
            } catch (e) {}
          }
          // Fallback: OpenRouter vision (qwen) when Gemini quota exhausted
          if (!desc && env.BACKUP_API_KEY && env.BACKUP_BASE_URL) {
            try {
              const orResp = await fetch(`${env.BACKUP_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${env.BACKUP_API_KEY}`,
                },
                body: JSON.stringify({
                  model: 'google/gemini-2.5-flash-lite',
                  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }] }],
                  max_tokens: 300,
                }),
              });
              const orData = await orResp.json();
              desc = (orData.choices?.[0]?.message?.content || '').trim();
            } catch (e) {
              console.log('OR_VISION_FAIL:', e.message);
            }
          }
          if (desc) {
            await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, desc, text || '[photo]');
          }
        }
      } catch (e) {
        console.log('VISION_ERROR:', e.message);
      }
      return new Response('OK', { status: 200 });
    }

    // ===== IMAGE GENERATION REQUEST =====
    const lower = text.toLowerCase();
    const imgTriggers = ['make a picture', 'make an image', 'generate an image', 'generate a picture', 'create an image', 'create a picture', 'draw ', 'تصویر', 'عکس بساز', 'عکس بکش', 'بساز', 'make a photo', 'generate a photo', 'create a photo', 'ساخت عکس', 'بساز عکس', 'یه عکس بساز', 'یک عکس بساز', 'میسازی', 'عکس درست کن', 'درست کن عکس'];
    const isImgReq = imgTriggers.some((t) => lower.includes(t));
    if (isImgReq) {
      // Try Gemini image model, then OpenRouter image model
      let imgData = null;
      if (env.GEMINI_API_KEY) {
        try {
          const genResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
          });
          if (genResp.status !== 429 && genResp.status !== 404) {
            const gdata = await genResp.json();
            const inline = gdata.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
            imgData = inline && (inline.inlineData || inline.inline_data);
          }
        } catch (e) {}
      }
      // Fallback: OpenRouter image gen
      if (!imgData && env.BACKUP_API_KEY && env.BACKUP_BASE_URL) {
        try {
          const orImgResp = await fetch(`${env.BACKUP_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.BACKUP_API_KEY}`,
            },
            body: JSON.stringify({
              model: 'google/gemini-3.1-flash-image',
              messages: [{ role: 'user', content: text }],
            }),
          });
          const orData = await orImgResp.json();
          const orInline = orData.choices?.[0]?.message?.content;
          // Some providers return base64 in content
          if (orData.choices?.[0]?.message?.images) {
            imgData = orData.choices[0].message.images[0];
          }
        } catch (e) {
          console.log('OR_IMG_FAIL:', e.message);
        }
      }
      if (imgData && imgData.data) {
        const imgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const byteChars = atob(imgData.data);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        await fetch(imgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: bytes, caption: 'Here you go! 🎨' }),
        });
        return new Response('OK', { status: 200 });
      } else {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, 'Sorry, could not generate the image. Try again later.', text);
        return new Response('OK', { status: 200 });
      }
    }

    if (!chatId || !text) return new Response('OK', { status: 200 });

    // Load chat history from KV (memory for offline mode)
    const historyKey = `hist:${chatId}`;
    let history = [];
    if (env.CHAT_HISTORY) {
      try {
        const stored = await env.CHAT_HISTORY.get(historyKey);
        if (stored) history = JSON.parse(stored);
      } catch (e) {}
    }
    const context = history.slice(-10).map((m) => `${m.role}: ${m.text}`).join('\n');
    const prompt = context ? `Previous conversation:\n${context}\n\nUser: ${text}` : text;

    let reply = null;
    if (env.BRIDGE_URL) {
      reply = await askLocalBridge(env.BRIDGE_URL, chatId, text);
      console.log('BRIDGE_REPLY:', reply ? reply.slice(0, 40) : 'null');
    }
    if (!reply) {
      // Try Gemini (multiple models)
      try {
        reply = await askGemini(env.GEMINI_API_KEY, prompt, env.GEMINI_MODELS);
        console.log('GEMINI_REPLY:', reply ? reply.slice(0, 40) : 'empty');
      } catch (e) {
        console.log('GEMINI_FAIL:', e.message);
        // Gemini failed → try backup API
        if (env.BACKUP_API_KEY && env.BACKUP_BASE_URL) {
          try {
            reply = await askBackupApi(env.BACKUP_API_KEY, env.BACKUP_BASE_URL, prompt, env.BACKUP_MODELS);
            console.log('BACKUP_REPLY:', reply ? reply.slice(0, 40) : 'empty');
          } catch (e2) {
            console.log('BACKUP_FAIL:', e2.message);
            reply = null;
          }
        } else {
          reply = null;
        }
      }
      // Final retry: Gemini once more (transient errors)
      if (!reply) {
        try {
          reply = await askGemini(env.GEMINI_API_KEY, prompt, env.GEMINI_MODELS);
          console.log('RETRY_REPLY:', reply ? reply.slice(0, 40) : 'empty');
        } catch (e3) {
          console.log('RETRY_FAIL:', e3.message);
          reply = null;
        }
      }
    }
    if (!reply) {
      console.log('ALL_FAILED');
      reply = 'Sorry, I could not get an answer right now. Please try again in a moment.';
    }

    // Save to KV history (user question + bot reply)
    if (env.CHAT_HISTORY) {
      history.push({ role: 'user', text: text.slice(0, 500) });
      history.push({ role: 'bot', text: reply.slice(0, 500) });
      history = history.slice(-40);
      ctx.waitUntil(env.CHAT_HISTORY.put(historyKey, JSON.stringify(history)));
    }

    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, reply, text);
    return new Response('OK', { status: 200 });
  },
};