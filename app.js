const express = require('express');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKOCRYPTO_API_KEY = process.env.TOKOCRYPTO_API_KEY;
const TOKOCRYPTO_API_SECRET = process.env.TOKOCRYPTO_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MODAL_MAX_IDR = Number(process.env.MODAL_MAX_IDR || 87000);

// Helper HTTP Request
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

// 1. Send Telegram Message
async function sendTelegram(text, replyMarkup = null) {
  try {
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'Markdown'
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    await request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      payload
    );
  } catch (err) {
    console.error('Error sendTelegram:', err.message);
  }
}

// 2. Answer Telegram Callback Query
async function answerCallback(callbackQueryId, text = '') {
  try {
    await request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      { callback_query_id: callbackQueryId, text: text }
    );
  } catch (err) {
    console.error('Error answerCallback:', err.message);
  }
}

// 3. Tokocrypto Private Signed Request
async function tokoSignedRequest(endpoint, queryParams = {}, method = 'GET') {
  const timestamp = Date.now();
  const recvWindow = 5000;
  queryParams.timestamp = timestamp;
  queryParams.recvWindow = recvWindow;

  const queryString = Object.keys(queryParams)
    .map(k => `${k}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const signature = crypto
    .createHmac('sha256', TOKOCRYPTO_API_SECRET)
    .update(queryString)
    .digest('hex');

  const url = `https://www.tokocrypto.com${endpoint}?${queryString}&signature=${signature}`;
  return await request(url, {
    method: method,
    headers: { 'X-MBX-APIKEY': TOKOCRYPTO_API_KEY }
  });
}

// ==========================================
// ROUTE 1: ANALISA PASAR (TIAP 5 MENIT)
// ==========================================
async function handleMarketAnalysis(req, res) {
  console.log('[CRON 5M] Menjalankan Analisa Pasar AI (Filter Anti-Spam)...');
  try {
    const spot = await tokoSignedRequest('/open/v1/account/spot');
    const assets = spot.data?.data?.accountAssets || [];
    const idrAsset = assets.find(a => a.asset === 'BIDR' || a.asset === 'IDR');
    const idrFree = idrAsset ? parseFloat(idrAsset.free) : 0;
    const availableBuy = Math.min(idrFree > 0 ? idrFree : MODAL_MAX_IDR, MODAL_MAX_IDR);

    const heldCoin = assets.find(a => a.asset !== 'BIDR' && a.asset !== 'IDR' && a.asset !== 'USDT' && parseFloat(a.free) > 0);
    let mode = 'CARI_PELUANG_BARU';
    let symbol = 'BTC_IDR';
    let binanceSymbol = 'BTCUSDT';
    let coinQty = 0;

    if (heldCoin) {
      mode = 'EVALUASI_KOIN_DIPEGANG';
      symbol = `${heldCoin.asset}_IDR`;
      binanceSymbol = `${heldCoin.asset}USDT`;
      coinQty = parseFloat(heldCoin.free);
    }

    const depth = await request(`https://www.tokocrypto.com/open/v1/market/depth?symbol=${symbol}&limit=5`);
    const lastPrice = depth.data?.data?.bids?.[0]?.[0] || '1400000000';
    const numPrice = Number(lastPrice);

    const klinesRes = await request(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1h&limit=100`);
    const klines = Array.isArray(klinesRes.data) ? klinesRes.data : [];
    const closes = klines.map(k => parseFloat(k[4]));

    const sma7 = (closes.slice(-7).reduce((a, b) => a + b, 0) / 7) || 0;
    const sma25 = (closes.slice(-25).reduce((a, b) => a + b, 0) / 25) || 0;
    const isGoldenCross = sma7 > sma25;
    const trend = isGoldenCross ? 'BULLISH' : 'BEARISH';

    let action = 'HOLD';
    let reason = 'Pasar dalam konsolidasi netral.';

    if (mode === 'CARI_PELUANG_BARU') {
      if (isGoldenCross) {
        action = 'BUY';
        reason = `Golden Cross SMA7 (${sma7.toFixed(2)}) > SMA25 (${sma25.toFixed(2)}). Peluang cuan Bullish.`;
      } else {
        action = 'HOLD';
        reason = `SMA masih Bearish (${sma7.toFixed(2)} < ${sma25.toFixed(2)}). Menunggu titik konfirmasi.`;
      }
    } else {
      if (!isGoldenCross) {
        action = 'SELL';
        reason = `Momentum berbalik Bearish (Death Cross). Jual untuk mengamankan profit/modal.`;
      } else {
        action = 'HOLD';
        reason = `Tren Bullish kuat. Tetap HOLD untuk memaksimalkan cuan.`;
      }
    }

    if (GEMINI_API_KEY) {
      const prompt = `Data teknikal: symbol=${symbol}, harga terakhir=Rp${numPrice.toLocaleString('id-ID')}, SMA7=${sma7.toFixed(2)}, SMA25=${sma25.toFixed(2)}, trend=${trend}. Status posisi: ${mode}. Modal: Rp${availableBuy.toLocaleString('id-ID')}. Berikan rekomendasi (${mode === 'CARI_PELUANG_BARU' ? 'BUY atau HOLD' : 'SELL atau HOLD'}) dan alasan ringkas maks 2 kalimat. Format HANYA JSON: {"action":"BUY|SELL|HOLD","reason":"alasan"}`;
      const aiRes = await request(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }
      );
      try {
        const rawAi = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const parsed = JSON.parse(rawAi.replace(/```json|```/g, '').trim());
        if (parsed.action) action = parsed.action;
        if (parsed.reason) reason = parsed.reason;
      } catch (e) {}
    }

    if (action === 'HOLD') {
      console.log('[ANTI-SPAM] HOLD - Tidak kirim Telegram.');
      return res.status(200).json({ success: true, notified: false, action: 'HOLD' });
    }

    let buttons;
    let titleHeader;
    if (action === 'BUY') {
      titleHeader = `🚀 *PELUANG CUAN DETECTED (BUY SIGNAL)*`;
      buttons = [
        [
          { text: `✅ EKSEKUSI BUY (Rp${availableBuy.toLocaleString('id-ID')})`, callback_data: `BUY_${symbol}_${availableBuy}` },
          { text: `⏸ ABAIKAN / HOLD`, callback_data: `HOLD_${symbol}_0` }
        ]
      ];
    } else if (action === 'SELL') {
      titleHeader = `💰 *SINYAL AMANKAN CUAN (SELL SIGNAL)*`;
      buttons = [
        [
          { text: `❌ EKSEKUSI SELL SEMUA (${coinQty} ${heldCoin.asset})`, callback_data: `SELL_${symbol}_ALL` },
          { text: `⏸ LANJUTKAN HOLD`, callback_data: `HOLD_${symbol}_0` }
        ]
      ];
    }

    const msg = `${titleHeader}\n\n` +
      `Aset: *${symbol}*\n` +
      `Harga: *Rp${numPrice.toLocaleString('id-ID')}*\n` +
      `Indikator: *${trend}* (SMA7: ${sma7.toFixed(2)} | SMA25: ${sma25.toFixed(2)})\n` +
      `Analisa AI: _${reason}_\n\n` +
      (action === 'BUY' ? `💰 Rekomendasi Modal: *Rp${availableBuy.toLocaleString('id-ID')}*\n\n` : `📦 Jumlah Koin: *${coinQty} ${heldCoin?.asset}*\n\n`) +
      `_Klik tombol di bawah untuk eksekusi langsung:_`;

    await sendTelegram(msg, { inline_keyboard: buttons });
    return res.status(200).json({ success: true, notified: true, symbol, action });
  } catch (err) {
    console.error('Error in market analysis:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ==========================================
// ROUTE 2: BERITA PASAR KRIPTO (TIAP 2 JAM)
// ==========================================
async function handleNewsDigest(req, res) {
  console.log('[NEWS 2H] Mengambil Ringkasan Berita & Kondisi Pasar Kripto...');
  try {
    const [btcRes, ethRes, solRes] = await Promise.all([
      request('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
      request('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT'),
      request('https://api.binance.com/api/v3/ticker/24hr?symbol=SOLUSDT')
    ]);

    const btc = btcRes.data || { lastPrice: '0', priceChangePercent: '0' };
    const eth = ethRes.data || { lastPrice: '0', priceChangePercent: '0' };
    const sol = solRes.data || { lastPrice: '0', priceChangePercent: '0' };

    const kursUsdIdr = 16200;
    const btcIdr = (parseFloat(btc.lastPrice) * kursUsdIdr).toLocaleString('id-ID');
    const ethIdr = (parseFloat(eth.lastPrice) * kursUsdIdr).toLocaleString('id-ID');
    const solIdr = (parseFloat(sol.lastPrice) * kursUsdIdr).toLocaleString('id-ID');

    let newsSnippets = 'Pergerakan pasar didorong oleh likuiditas makro dan arus masuk ETF kripto.';
    try {
      const cryptoPanic = await request('https://cryptopanic.com/api/free/v1/posts/?auth_token=free&public=true&filter=hot');
      const posts = cryptoPanic.data?.results || [];
      if (posts.length > 0) {
        newsSnippets = posts.slice(0, 4).map((p, idx) => `${idx + 1}. ${p.title}`).join('\n');
      }
    } catch (e) {}

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
        { contents: [{ parts: [{ text: prompt }] }] }
      );
      const aiText = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (aiText) aiSummary = aiText.trim();
    }

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
    return res.status(200).json({ success: true, service: 'Crypto News Digest 2H', timestamp: now.toISOString() });
  } catch (err) {
    console.error('Error in news handler:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ==========================================
// ROUTE 3: WEBHOOK TELEGRAM (TOMBOL ORDER)
// ==========================================
async function handleWebhook(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ status: 'Webhook endpoint ready' });

  const cb = req.body?.callback_query;
  if (!cb) return res.status(200).send('OK');

  const callbackData = cb.data;
  const callbackId = cb.id;

  try {
    const parts = callbackData.split('_');
    const side = parts[0];
    const symbol = `${parts[1]}_${parts[2]}`;
    const amount = parts[3];

    if (side === 'HOLD') {
      await answerCallback(callbackId, 'Posisi HOLD dikonfirmasi.');
      await sendTelegram(`⏸ *HOLD Dikonfirmasi*\n\nTidak ada order baru untuk *${symbol}*.`);
      return res.status(200).send('OK');
    }

    if (side === 'BUY') {
      await answerCallback(callbackId, 'Memproses BUY Tokocrypto...');
      const buyParams = {
        symbol: symbol,
        side: 0,
        type: 2,
        quoteOrderQty: Math.min(Number(amount || MODAL_MAX_IDR), MODAL_MAX_IDR)
      };

      const orderRes = await tokoSignedRequest('/open/v1/orders', buyParams, 'POST');
      if (orderRes.data?.code === 0) {
        await sendTelegram(`✅ *ORDER BUY BERHASIL!*\n\nPair: *${symbol}*\nNominal: *Rp${buyParams.quoteOrderQty.toLocaleString('id-ID')}*\nStatus: *Terisi di Tokocrypto* 🚀`);
      } else {
        await sendTelegram(`⚠️ *ORDER BUY GAGAL*\n\nDetail: ${orderRes.data?.msg || orderRes.raw}`);
      }
      return res.status(200).send('OK');
    }

    if (side === 'SELL') {
      await answerCallback(callbackId, 'Memproses SELL Tokocrypto...');
      const spot = await tokoSignedRequest('/open/v1/account/spot');
      const baseAsset = parts[1];
      const coin = (spot.data?.data?.accountAssets || []).find(a => a.asset === baseAsset);
      const qty = coin ? parseFloat(coin.free) : 0;

      if (qty <= 0) {
        await sendTelegram(`⚠️ *SELL Dibatalkan*: Tidak ada saldo ${baseAsset} di akun.`);
        return res.status(200).send('OK');
      }

      const sellParams = {
        symbol: symbol,
        side: 1,
        type: 2,
        quantity: qty
      };

      const orderRes = await tokoSignedRequest('/open/v1/orders', sellParams, 'POST');
      if (orderRes.data?.code === 0) {
        await sendTelegram(`✅ *ORDER SELL BERHASIL!*\n\nPair: *${symbol}*\nJumlah: *${qty} ${baseAsset}*\nStatus: *Terjual di Tokocrypto* 💰`);
      } else {
        await sendTelegram(`⚠️ *ORDER SELL GAGAL*\n\nDetail: ${orderRes.data?.msg || orderRes.raw}`);
      }
      return res.status(200).send('OK');
    }
  } catch (err) {
    console.error('Error handling webhook:', err.message);
    await answerCallback(callbackId, 'Error memproses order.');
  }

  return res.status(200).send('OK');
}

// Routes Register
app.get('/', (req, res) => res.json({ status: 'ONLINE', service: 'Tokocrypto AI Trader 24/7 Cloud Bot' }));
app.all('/api/cron', handleMarketAnalysis);
app.all('/cron', handleMarketAnalysis);
app.all('/api/news', handleNewsDigest);
app.all('/news', handleNewsDigest);
app.all('/api/webhook', handleWebhook);
app.all('/webhook', handleWebhook);

// Export for Vercel Serverless & Local
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
}
