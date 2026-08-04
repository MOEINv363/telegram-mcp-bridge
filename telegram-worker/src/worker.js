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

async function sendTelegram(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👍', callback_data: 'fb:like:0' },
            { text: '👎', callback_data: 'fb:dislike:0' },
            { text: '🚩 Report', callback_data: 'fb:report:0' },
          ],
        ],
      },
    }),
  });
}

async function askGemini(apiKey, model, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Gemini error: ' + err.slice(0, 200));
  }
  const data = await resp.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

async function askLocalBridge(bridgeUrl, chatId, text) {
  if (!bridgeUrl) return null;
  try {
    const health = await fetch(bridgeUrl + '/api/health', {
      signal: AbortSignal.timeout(4000),
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
        const [, action] = data.split(':');
        const user = cq.from || {};
        const qmsg = cq.message || {};
        if (action === 'report') {
          const reportText = `🚩 **New report**\n👤 From: ${user.first_name || ''} ${user.username ? '@' + user.username : ''} (ID: ${user.id})\n🤖 Bot reply: ${qmsg.text || ''}`;
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
    if (!chatId || !text) return new Response('OK', { status: 200 });

    if (msg.message_id) {
      await reactToMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
    }

    let reply = null;
    if (env.BRIDGE_URL) {
      reply = await askLocalBridge(env.BRIDGE_URL, chatId, text);
    }
    if (!reply) {
      try {
        reply = await askGemini(env.GEMINI_API_KEY, env.GEMINI_MODEL || 'gemini-flash-latest', text);
      } catch (e) {
        reply = 'Sorry, an error occurred.';
      }
    }
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, reply);
    return new Response('OK', { status: 200 });
  },
};