const express = require('express');
const https = require('https');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKOCRYPTO_API_KEY = process.env.TOKOCRYPTO_API_KEY;
const TOKOCRYPTO_API_SECRET = process.env.TOKOCRYPTO_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MODAL_MAX_IDR = Number(process.env.MODAL_MAX_IDR || 87000);
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;

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

// 4. Analisa Pasar & Kirim Sinyal (Jalan Tiap 15 Menit)
async function runMarketAnalysis() {
  console.log('[CRON 15M] Menjalankan Analisa Pasar AI...');
  try {
    // A. Cek Saldo
    const spot = await tokoSignedRequest('/open/v1/account/spot');
    const assets = spot.data?.data?.accountAssets || [];
    const idrAsset = assets.find(a => a.asset === 'BIDR' || a.asset === 'IDR');
    const idrFree = idrAsset ? parseFloat(idrAsset.free) : 0;
    const availableBuy = Math.min(idrFree > 0 ? idrFree : MODAL_MAX_IDR, MODAL_MAX_IDR);

    // Cek Koin yang Dipegang
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

    // B. Ambil Harga Live Tokocrypto
    const depth = await request(`https://www.tokocrypto.com/open/v1/market/depth?symbol=${symbol}&limit=5`);
    const lastPrice = depth.data?.data?.bids?.[0]?.[0] || '1400000000';

    // C. Ambil 100 Candlestick & Hitung SMA
    const klinesRes = await request(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1h&limit=100`);
    const klines = Array.isArray(klinesRes.data) ? klinesRes.data : [];
    const closes = klines.map(k => parseFloat(k[4]));

    const sma7 = (closes.slice(-7).reduce((a, b) => a + b, 0) / 7) || 0;
    const sma25 = (closes.slice(-25).reduce((a, b) => a + b, 0) / 25) || 0;
    const trend = sma7 > sma25 ? 'BULLISH' : 'BEARISH';

    // D. Analisa Gemini AI
    let action = trend === 'BULLISH' ? (mode === 'EVALUASI_KOIN_DIPEGANG' ? 'HOLD' : 'BUY') : (mode === 'EVALUASI_KOIN_DIPEGANG' ? 'SELL' : 'HOLD');
    let reason = `Indikator SMA7 (${sma7.toFixed(2)}) vs SMA25 (${sma25.toFixed(2)}) mendeteksi momentum ${trend}.`;

    if (GEMINI_API_KEY) {
      const prompt = `Data teknikal: symbol=${symbol}, harga terakhir=Rp${Number(lastPrice).toLocaleString('id-ID')}, SMA7=${sma7.toFixed(2)}, SMA25=${sma25.toFixed(2)}, trend=${trend}. Status akun: ${mode}. Modal trading: Rp${availableBuy.toLocaleString('id-ID')}. Berikan rekomendasi (${mode === 'CARI_PELUANG_BARU' ? 'BUY atau HOLD' : 'SELL atau HOLD'}) dan alasan profesional maks 2 kalimat. Balas HANYA JSON: {"action":"BUY|SELL|HOLD","reason":"alasan"}`;
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

    // E. Susun Tombol & Kirim Telegram
    let buttons;
    let statusLabel;
    if (mode === 'EVALUASI_KOIN_DIPEGANG') {
      statusLabel = `Sedang memegang ${coinQty} ${heldCoin.asset}`;
      buttons = [
        [
          { text: '❌ SELL SEMUA', callback_data: `SELL_${symbol}_ALL` },
          { text: '⏸ HOLD', callback_data: `HOLD_${symbol}_0` }
        ]
      ];
    } else {
      statusLabel = 'Kandidat beli baru (belum ada posisi)';
      buttons = [
        [
          { text: `✅ BUY (${action === 'BUY' ? 'Rekomendasi AI' : 'Manual'})`, callback_data: `BUY_${symbol}_${availableBuy}` },
          { text: '⏸ HOLD', callback_data: `HOLD_${symbol}_0` }
        ]
      ];
    }

    const msg = `📊 *Sinyal Trading AI Tokocrypto (24/7 Cloud)*\n\n` +
      `Aset: *${symbol}*\n` +
      `Status: ${statusLabel}\n` +
      `Harga: *Rp${Number(lastPrice).toLocaleString('id-ID')}*\n` +
      `Rekomendasi: *${action}*\n` +
      `Alasan: _${reason}_\n\n` +
      (mode !== 'EVALUASI_KOIN_DIPEGANG' ? `💰 Alokasi Modal: Rp${availableBuy.toLocaleString('id-ID')}\n\n` : '') +
      `_Klik tombol di bawah untuk eksekusi:_`;

    await sendTelegram(msg, { inline_keyboard: buttons });
    console.log(`[CRON 15M] Sinyal ${symbol} [${action}] berhasil dikirim ke Telegram.`);
  } catch (err) {
    console.error('[CRON 15M] Error:', err.message);
  }
}

// 5. Eksekusi Order saat Tombol Ditekan (Webhook Callback)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const cb = req.body?.callback_query;
  if (!cb) return;

  const callbackData = cb.data;
  const callbackId = cb.id;
  console.log('[WEBHOOK TELEGRAM] Tombol ditekan:', callbackData);

  try {
    const parts = callbackData.split('_');
    const side = parts[0]; // BUY / SELL / HOLD
    const symbol = `${parts[1]}_${parts[2]}`; // e.g. BTC_IDR
    const amount = parts[3];

    if (side === 'HOLD') {
      await answerCallback(callbackId, 'Posisi HOLD dikonfirmasi.');
      await sendTelegram(`⏸ *HOLD Dikonfirmasi*\n\nTidak ada order baru untuk *${symbol}*. Posisi aman.`);
      return;
    }

    if (side === 'BUY') {
      await answerCallback(callbackId, 'Memproses BUY Tokocrypto...');
      // Eksekusi Order Market BUY ke Tokocrypto
      const buyParams = {
        symbol: symbol,
        side: 0, // 0 = BUY
        type: 2, // 2 = MARKET
        quoteOrderQty: Math.min(Number(amount || MODAL_MAX_IDR), MODAL_MAX_IDR)
      };

      const orderRes = await tokoSignedRequest('/open/v1/orders', buyParams, 'POST');
      if (orderRes.data?.code === 0) {
        await sendTelegram(`✅ *ORDER BUY BERHASIL!*\n\nPair: *${symbol}*\nNominal: *Rp${buyParams.quoteOrderQty.toLocaleString('id-ID')}*\nStatus: *Terisi di Tokocrypto* 🚀`);
      } else {
        await sendTelegram(`⚠️ *ORDER BUY GAGAL*\n\nDetail: ${orderRes.data?.msg || orderRes.raw}`);
      }
      return;
    }

    if (side === 'SELL') {
      await answerCallback(callbackId, 'Memproses SELL Tokocrypto...');
      // Ambil saldo koin terkini
      const spot = await tokoSignedRequest('/open/v1/account/spot');
      const baseAsset = parts[1];
      const coin = (spot.data?.data?.accountAssets || []).find(a => a.asset === baseAsset);
      const qty = coin ? parseFloat(coin.free) : 0;

      if (qty <= 0) {
        await sendTelegram(`⚠️ *SELL Dibatalkan*: Tidak ada saldo ${baseAsset} di akun.`);
        return;
      }

      const sellParams = {
        symbol: symbol,
        side: 1, // 1 = SELL
        type: 2, // 2 = MARKET
        quantity: qty
      };

      const orderRes = await tokoSignedRequest('/open/v1/orders', sellParams, 'POST');
      if (orderRes.data?.code === 0) {
        await sendTelegram(`✅ *ORDER SELL BERHASIL!*\n\nPair: *${symbol}*\nJumlah: *${qty} ${baseAsset}*\nStatus: *Terjual di Tokocrypto* 💰`);
      } else {
        await sendTelegram(`⚠️ *ORDER SELL GAGAL*\n\nDetail: ${orderRes.data?.msg || orderRes.raw}`);
      }
    }
  } catch (err) {
    console.error('Error handling callback:', err.message);
    await answerCallback(callbackId, 'Error memproses order.');
  }
});

// Health check endpoint (Keep-Alive)
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Tokocrypto AI Trader 24/7 Cloud Bot',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => res.send('OK'));

// Jadwal Cron
// 1. Analisa Pasar Tiap 15 Menit
cron.schedule('*/15 * * * *', () => {
  runMarketAnalysis();
});

// 2. Monitoring Saldo Harian Tiap Jam 08:00
cron.schedule('0 8 * * *', async () => {
  try {
    const spot = await tokoSignedRequest('/open/v1/account/spot');
    const assets = (spot.data?.data?.accountAssets || []).filter(a => parseFloat(a.free) > 0 || parseFloat(a.locked) > 0);
    let text = `🛡️ *Laporan Saldo Portofolio Harian*\n\n`;
    assets.forEach(a => {
      text += `• *${a.asset}*: ${parseFloat(a.free).toFixed(4)} (Terkunci: ${parseFloat(a.locked).toFixed(4)})\n`;
    });
    await sendTelegram(text);
  } catch (e) {}
});

// Start Server & Register Telegram Webhook
app.listen(PORT, async () => {
  console.log(`AI Trader 24/7 Cloud Bot running on port ${PORT}`);

  if (APP_URL && TELEGRAM_BOT_TOKEN) {
    const webhookUrl = `${APP_URL.replace(/\/$/, '')}/webhook`;
    console.log('Registering Telegram Webhook to:', webhookUrl);
    await request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      { url: webhookUrl }
    );
  }

  // Kirim notifikasi bot baru aktif
  await sendTelegram(`🚀 *Bot AI Trader Tokocrypto Telah Aktif di Cloud (24/7)*\n\nSistem siap memantau pasar dan menerima tombol trading.`);
});
