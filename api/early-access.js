// Early access list for Emberhold: stores X username, wallet and XP in Upstash Redis (Vercel KV).
// Needs the Upstash env vars that end in KV_REST_API_URL and KV_REST_API_TOKEN (any prefix) on the Vercel project.
// the Vercel integration may add a custom prefix (e.g. STORAGE_KV_REST_API_URL), so match on the suffix
const envEnding = suffix => process.env[Object.keys(process.env).find(k => k.endsWith(suffix) && process.env[k])];
const URL_ = envEnding('KV_REST_API_URL') || envEnding('REDIS_REST_URL');
const TOKEN = envEnding('KV_REST_API_TOKEN') || envEnding('REDIS_REST_TOKEN');
const TASKS = { follow: 100, like: 100, repost: 100, reply: 100 };
const BASE_XP = 50, GAME_MAX = 600, TOP = 100;

async function redis(...cmds){
  const r = await fetch(`${URL_}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'The list is not open yet. Try again soon.' });
  try {
    if (req.method === 'GET') {
      const [flat, total] = await redis(['ZREVRANGE', 'ea:xp', 0, TOP - 1, 'WITHSCORES'], ['ZCARD', 'ea:xp']);
      const top = [];
      for (let i = 0; i < flat.length; i += 2) top.push({ handle: flat[i], xp: +flat[i + 1] });
      return res.status(200).json({ total, top });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use GET or POST.' });

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const [hits] = await redis(['INCR', `ea:ip:${ip}`], ['EXPIRE', `ea:ip:${ip}`, 3600, 'NX']);
    if (hits > 30) return res.status(429).json({ error: 'Too many tries. Wait a while and try again.' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const handle = String(b.handle || '').trim().replace(/^@/, '');
    const wallet = String(b.wallet || '').trim().toLowerCase();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return res.status(400).json({ error: 'Enter your X username, like @yourname.' });
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) return res.status(400).json({ error: 'Enter a valid wallet address.' });
    const key = handle.toLowerCase();
    const tasks = [...new Set((Array.isArray(b.tasks) ? b.tasks : []).filter(t => t in TASKS))];
    const game = Math.max(0, Math.min(GAME_MAX, Math.floor(+b.game || 0)));
    const xp = BASE_XP + tasks.reduce((s, t) => s + TASKS[t], 0) + game;

    // one wallet per username and one username per wallet
    const [owner, prev] = await redis(['HGET', 'ea:wallet', wallet], ['HGET', `ea:u:${key}`, 'wallet']);
    if (owner && owner !== key) return res.status(409).json({ error: 'That wallet is already on the list with another username.' });
    const cmds = [];
    if (prev && prev !== wallet) cmds.push(['HDEL', 'ea:wallet', prev]);
    cmds.push(['HSET', 'ea:wallet', wallet, key],
      ['HSET', `ea:u:${key}`, 'handle', handle, 'wallet', wallet, 'tasks', tasks.join(','), 'game', game, 'at', Date.now()],
      ['ZADD', 'ea:xp', 'GT', xp, key], ['ZREVRANK', 'ea:xp', key], ['ZSCORE', 'ea:xp', key]);
    const out = await redis(...cmds);
    const rank = out[out.length - 2], score = +out[out.length - 1];
    return res.status(200).json({ rank: rank + 1, xp: score });
  } catch (e) {
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
