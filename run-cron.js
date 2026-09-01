const https = require('https');
const crypto = require('crypto');

const TOKOCRYPTO_API_KEY = process.env.TOKOCRYPTO_API_KEY;
const TOKOCRYPTO_API_SECRET = process.env.TOKOCRYPTO_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MODAL_MAX_IDR = Number(process.env.MODAL_MAX_IDR || 87000);

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

async function sendTelegram(text, replyMarkup = null) {
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
}

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

async function run() {
  console.log('[GITHUB ACTIONS] Menjalankan Analisa Pasar AI Tokocrypto...');

  try {
    // 1. Ambil Saldo Tokocrypto
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

    // 2. Ambil Harga Live Tokocrypto
    const depth = await request(`https://www.tokocrypto.com/open/v1/market/depth?symbol=${symbol}&limit=5`);
    const lastPrice = depth.data?.data?.bids?.[0]?.[0] || '1400000000';

    // 3. Ambil 100 Candlestick & Hitung SMA Golden Cross
    const klinesRes = await request(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1h&limit=100`);
    const klines = Array.isArray(klinesRes.data) ? klinesRes.data : [];
    const closes = klines.map(k => parseFloat(k[4]));

    const sma7 = (closes.slice(-7).reduce((a, b) => a + b, 0) / 7) || 0;
    const sma25 = (closes.slice(-25).reduce((a, b) => a + b, 0) / 25) || 0;
    const trend = sma7 > sma25 ? 'BULLISH' : 'BEARISH';

    // 4. Analisa Google Gemini 3.6 Flash
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

    // 5. Kirim Sinyal ke Telegram
    let statusLabel = mode === 'EVALUASI_KOIN_DIPEGANG' ? `Sedang memegang ${coinQty} ${heldCoin.asset}` : 'Kandidat beli baru (belum ada posisi)';
    const msg = `📊 *Sinyal Trading AI Tokocrypto (24/7 Cloud)*\n\n` +
      `Aset: *${symbol}*\n` +
      `Status: ${statusLabel}\n` +
      `Harga: *Rp${Number(lastPrice).toLocaleString('id-ID')}*\n` +
      `Rekomendasi AI: *${action}*\n` +
      `Alasan: _${reason}_\n\n` +
      (mode !== 'EVALUASI_KOIN_DIPEGANG' ? `💰 Alokasi Modal: Rp${availableBuy.toLocaleString('id-ID')}\n\n` : '') +
      `_Otomatis diproses 24 jam oleh Cloud GitHub Actions._`;

    await sendTelegram(msg);
    console.log(`[SUKSES] Sinyal ${symbol} [${action}] terkirim ke Telegram!`);
  } catch (err) {
    console.error('[ERROR]', err.message);
  }
}

run();
