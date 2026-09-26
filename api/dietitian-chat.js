// api/dietitian-chat.js
//
// The "Dietitian" tab's AI first line. This runs on Vercel's server, same as
// api/insights.js — the Claude API key never reaches the browser.
//
// The actual system prompt and Anthropic call now live in
// lib/dietitian-agent.js, shared with api/telegram-webhook.js's Telegram AI
// agent, so the website chat and the Telegram chat are always working from
// the exact same rules and personality rather than two copies that could
// quietly drift apart.

const { callDietitianModel } = require('../lib/dietitian-agent');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing its ANTHROPIC_API_KEY environment variable.' });
    return;
  }

  const { messages, context } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Missing or empty required field: messages.' });
    return;
  }
  const validRoles = new Set(['user', 'assistant']);
  const cleanMessages = messages.filter(m =>
    m && validRoles.has(m.role) && typeof m.content === 'string' && m.content.trim().length > 0
  );
  if (cleanMessages.length === 0) {
    res.status(400).json({ error: 'No valid messages (each needs role "user" or "assistant" and non-empty content).' });
    return;
  }
  // Cap how much history gets sent up, as a cost/latency backstop -- the
  // frontend already stores the full thread, this just bounds one request.
  const recentMessages = cleanMessages.slice(-30);
  // Anthropic's API requires the message list to start with a "user" turn.
  while (recentMessages.length && recentMessages[0].role !== 'user') recentMessages.shift();
  if (recentMessages.length === 0) {
    res.status(400).json({ error: 'Message history must contain at least one user message.' });
    return;
  }

  const anthropicMessages = recentMessages.map(m => ({ role: m.role, content: m.content }));

  try {
    const result = await callDietitianModel({
      apiKey,
      messages: anthropicMessages,
      context,
      channel: 'web',
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(e.userMessage ? 502 : 500).json({ error: e.userMessage || e.message });
  }
};
