const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function request(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), raw: body });
        } catch {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function sendTelegram(text) {
  await request(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    },
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'Markdown'
    }
  );
}

module.exports = async function handler(req, res) {
  console.log('[NEWS 2H] Mengambil Ringkasan Berita & Kondisi Pasar Kripto...');

  try {
    // 1. Ambil Harga & Perubahan 24h Koin Utama dari Binance/Tokocrypto
    const [btcRes, ethRes, solRes] = await Promise.all([
      request('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
      request('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT'),
      request('https://api.binance.com/api/v3/ticker/24hr?symbol=SOLUSDT')
    ]);

    const btc = btcRes.data || { lastPrice: '0', priceChangePercent: '0' };
    const eth = ethRes.data || { lastPrice: '0', priceChangePercent: '0' };
    const sol = solRes.data || { lastPrice: '0', priceChangePercent: '0' };

    // Format harga IDR estimasi (kurs ~Rp16.200)
    const kursUsdIdr = 16200;
    const btcIdr = (parseFloat(btc.lastPrice) * kursUsdIdr).toLocaleString('id-ID');
    const ethIdr = (parseFloat(eth.lastPrice) * kursUsdIdr).toLocaleString('id-ID');
    const solIdr = (parseFloat(sol.lastPrice) * kursUsdIdr).toLocaleString('id-ID');

    // 2. Ambil Feed Berita Terkini Kripto
    let newsSnippets = 'Pergerakan pasar didorong oleh likuiditas makro dan arus masuk ETF kripto.';
    try {
      const cryptoPanic = await request('https://cryptopanic.com/api/free/v1/posts/?auth_token=free&public=true&filter=hot');
      const posts = cryptoPanic.data?.results || [];
      if (posts.length > 0) {
        newsSnippets = posts.slice(0, 4).map((p, idx) => `${idx + 1}. ${p.title}`).join('\n');
      }
    } catch (e) {
      console.log('Catatan feed:', e.message);
    }

    // 3. Rangkum dengan Google Gemini 3.6 Flash
    let aiSummary = 'Pasar kripto bergerak konsolidatif dengan volatilitas normal dalam 24 jam terakhir.';
    if (GEMINI_API_KEY) {
      const prompt = `Anda adalah analis pasar kripto profesional. Berikut data pasar terkini:
- BTC: $${parseFloat(btc.lastPrice).toLocaleString('en-US')} (${parseFloat(btc.priceChangePercent) >= 0 ? '+' : ''}${parseFloat(btc.priceChangePercent).toFixed(2)}%)
- ETH: $${parseFloat(eth.lastPrice).toLocaleString('en-US')} (${parseFloat(eth.priceChangePercent) >= 0 ? '+' : ''}${parseFloat(eth.priceChangePercent).toFixed(2)}%)
- SOL: $${parseFloat(sol.lastPrice).toLocaleString('en-US')} (${parseFloat(sol.priceChangePercent) >= 0 ? '+' : ''}${parseFloat(sol.priceChangePercent).toFixed(2)}%)
Berita terhangat:
${newsSnippets}

Tolong buatkan rangkuman berita dan sentimen pasar kripto dalam 3 poin singkat, padat, dan menarik dalam Bahasa Indonesia. Format HANYA teks poin 1, 2, 3 tanpa embel-embel markdown rumit.`;

      const aiRes = await request(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        {
          contents: [{ parts: [{ text: prompt }] }]
        }
      );

      const aiText = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (aiText) {
        aiSummary = aiText.trim();
      }
    }

    // 4. Susun Pesan Telegram Informatif (Murni Berita & Info Pasar)
    const now = new Date();
    const waktuWib = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

    const msg = `📰 *UPDATE PASAR & BERITA KRIPTO (Tiap 2 Jam)*\n` +
      `🕒 _Waktu: ${waktuWib} WIB_\n\n` +
      `📈 *Kondisi Harga Koin Utama:*\n` +
      `• *BTC*: $${parseFloat(btc.lastPrice).toLocaleString('en-US')} (~Rp${btcIdr}) [${parseFloat(btc.priceChangePercent) >= 0 ? '🟢 +' : '🔴 '}${parseFloat(btc.priceChangePercent).toFixed(2)}%]\n` +
      `• *ETH*: $${parseFloat(eth.lastPrice).toLocaleString('en-US')} (~Rp${ethIdr}) [${parseFloat(eth.priceChangePercent) >= 0 ? '🟢 +' : '🔴 '}${parseFloat(eth.priceChangePercent).toFixed(2)}%]\n` +
      `• *SOL*: $${parseFloat(sol.lastPrice).toLocaleString('en-US')} (~Rp${solIdr}) [${parseFloat(sol.priceChangePercent) >= 0 ? '🟢 +' : '🔴 '}${parseFloat(sol.priceChangePercent).toFixed(2)}%]\n\n` +
      `🤖 *Rangkuman Berita & Analisa AI:*\n` +
      `${aiSummary}\n\n` +
      `ℹ️ _Pesan ini bersifat informatif & edukatif berkala._`;

    await sendTelegram(msg);
    console.log('[NEWS 2H] Berita berhasil dikirim ke Telegram.');

    return res.status(200).json({
      success: true,
      service: 'Crypto News & Market Digest 2H',
      timestamp: now.toISOString()
    });
  } catch (err) {
    console.error('Error in news handler:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
