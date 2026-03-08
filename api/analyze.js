// api/analyze.js — Vercel Serverless Function
// Your ANTHROPIC_API_KEY lives in Vercel Environment Variables — never exposed to the browser.
// Rate limit: 3 requests per IP per day.

const DAILY_LIMIT = 3;

// In-memory store: { "ip::date": count }
// Persists within a warm function instance. Good enough for a portfolio.
const rateLimitStore = new Map();

function getKey(ip) {
  const today = new Date().toISOString().slice(0, 10); // "2026-03-08"
  return `${ip}::${today}`;
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    'unknown'
  );
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS — allow your domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // --- Rate Limiting ---
  const ip = getClientIP(req);
  const key = getKey(ip);
  const count = rateLimitStore.get(key) || 0;

  if (count >= DAILY_LIMIT) {
    return res.status(429).json({
      error: `Daily limit reached. You get ${DAILY_LIMIT} free analyses per day. Come back tomorrow!`,
      limit: DAILY_LIMIT,
      used: count,
    });
  }

  // --- Validate request body ---
  const { gameName, gameGenre, d7, winRate, sessionLen, sessionsPerDau, dropOff, problem } = req.body || {};

  if (!gameName || !d7 || !winRate) {
    return res.status(400).json({ error: 'Missing required game parameters.' });
  }

  // --- Build prompt ---
  const prompt = `You are a senior game product manager with expertise in difficulty tuning and player engagement optimization, similar to work done at MPL (Mobile Premier League).

Analyze this game's engagement metrics and provide specific, actionable difficulty tuning recommendations.

GAME DATA:
- Name: ${gameName}
- Genre: ${gameGenre || 'Casual Arcade'}
- D7 Retention: ${d7}%
- Win Rate (player vs game): ${winRate}%
- Avg Session Length: ${sessionLen} minutes
- Sessions per DAU: ${sessionsPerDau}
- Primary Drop-off Stage: ${dropOff}
${problem ? `- Additional Context: ${problem}` : ''}

Respond ONLY in this exact JSON format (no markdown, no extra text):
{
  "overall_health": "Good|Needs Work|Critical",
  "health_score": <number 0-100>,
  "summary": "<2 sentence diagnosis>",
  "recommendations": [
    {
      "title": "<short title>",
      "priority": "High|Medium|Low",
      "action": "<specific concrete action>",
      "expected_impact": "<metric + expected change>"
    },
    {
      "title": "<short title>",
      "priority": "High|Medium|Low",
      "action": "<specific concrete action>",
      "expected_impact": "<metric + expected change>"
    },
    {
      "title": "<short title>",
      "priority": "Medium|Low",
      "action": "<specific concrete action>",
      "expected_impact": "<metric + expected change>"
    }
  ],
  "json_config": {
    "difficulty_curve": "<gentle_ramp|steep|flat|oscillating>",
    "early_game_win_rate_target": <number>,
    "mid_game_win_rate_target": <number>,
    "late_game_win_rate_target": <number>,
    "session_length_target_mins": <number>,
    "retry_prompt_on_loss": <true|false>,
    "reward_on_close_loss": <true|false>,
    "difficulty_adjustment_frequency": "<per_level|per_3_levels|per_session>",
    "recommended_d7_target": <number>
  }
}`;

  // --- Call Anthropic API (key from env, never exposed) ---
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errData = await anthropicRes.json();
      throw new Error(errData.error?.message || `Anthropic API error ${anthropicRes.status}`);
    }

    const data = await anthropicRes.json();
    const raw = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // Increment rate limit counter only on success
    rateLimitStore.set(key, count + 1);

    return res.status(200).json({
      result,
      usage: { used: count + 1, limit: DAILY_LIMIT, remaining: DAILY_LIMIT - count - 1 },
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
}
