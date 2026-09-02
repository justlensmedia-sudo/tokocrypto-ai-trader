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

module.exports = async function handler(req, res) {
  console.log('[CRON 5M] Menjalankan Cek Pasar Berkala (Anti-Spam Filter Aktif)...');

  try {
    // 1. Cek Saldo Dompet Tokocrypto
    const spot = await tokoSignedRequest('/open/v1/account/spot');
    const assets = spot.data?.data?.accountAssets || [];
    const idrAsset = assets.find(a => a.asset === 'BIDR' || a.asset === 'IDR');
    const idrFree = idrAsset ? parseFloat(idrAsset.free) : 0;
    const availableBuy = Math.min(idrFree > 0 ? idrFree : MODAL_MAX_IDR, MODAL_MAX_IDR);

    // Cek apakah sedang memegang koin kripto selain IDR & USDT
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
    const numPrice = Number(lastPrice);

    // 3. Ambil 100 Candlestick & Hitung Indikator SMA (7 & 25)
    const klinesRes = await request(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1h&limit=100`);
    const klines = Array.isArray(klinesRes.data) ? klinesRes.data : [];
    const closes = klines.map(k => parseFloat(k[4]));

    const sma7 = (closes.slice(-7).reduce((a, b) => a + b, 0) / 7) || 0;
    const sma25 = (closes.slice(-25).reduce((a, b) => a + b, 0) / 25) || 0;
    const isGoldenCross = sma7 > sma25;
    const trend = isGoldenCross ? 'BULLISH' : 'BEARISH';

    // 4. Analisa Keputusan AI
    let action = 'HOLD';
    let reason = 'Pasar dalam kondisi netral/konsolidasi.';

    if (mode === 'CARI_PELUANG_BARU') {
      if (isGoldenCross) {
        action = 'BUY';
        reason = `Terjadi Golden Cross SMA7 (${sma7.toFixed(2)}) menembus ke atas SMA25 (${sma25.toFixed(2)}). Momentum Bullish potensial cuan.`;
      } else {
        action = 'HOLD';
        reason = `Indikator SMA masih Bearish (${sma7.toFixed(2)} < ${sma25.toFixed(2)}). Menunggu titik masuk terbaik.`;
      }
    } else {
      // Sedang memegang koin: Evaluasi potensi Take Profit / Stop
      if (!isGoldenCross) {
        action = 'SELL';
        reason = `Momentum berbalik Bearish (Death Cross SMA7 < SMA25). Rekomendasi jual untuk amankan modal/profit.`;
      } else {
        action = 'HOLD';
        reason = `Tren masih Bullish kuat. Tetap HOLD untuk memaksimalkan cuan.`;
      }
    }

    // Konsultasi Tambahan ke Gemini 3.6 Flash
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

    console.log(`[HASIL ANALISA] Mode: ${mode} | Simbol: ${symbol} | Aksi: ${action} | Tren: ${trend}`);

    // =========================================================================
    // 🛡️ ANTI-SPAM FILTER: HANYA KIRIM CHAT JIKA ADA SINYAL CUAN (BUY / SELL)
    // =========================================================================
    if (action === 'HOLD') {
      console.log('[ANTI-SPAM] Rekomendasi HOLD. Tidak mengirim notifikasi ke Telegram agar chat tidak banjir.');
      return res.status(200).json({
        success: true,
        notified: false,
        action: 'HOLD',
        message: 'Kondisi pasar HOLD (Silent Mode - Tidak kirim spam Telegram)'
      });
    }

    // Jika Aksi adalah BUY atau SELL, baru kirim konfirmasi lengkap ke Telegram!
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
      titleHeader = `💰 *SINYAL AMANKAN CUAN / PROFIT (SELL SIGNAL)*`;
      buttons = [
        [
          { text: `❌ EKSEKUSI SELL SEMUA (${coinQty} ${heldCoin.asset})`, callback_data: `SELL_${symbol}_ALL` },
          { text: `⏸ LANJUTKAN HOLD`, callback_data: `HOLD_${symbol}_0` }
        ]
      ];
    }

    const msg = `${titleHeader}\n\n` +
      `Aset: *${symbol}*\n` +
      `Harga Terkini: *Rp${numPrice.toLocaleString('id-ID')}*\n` +
      `Indikator: *${trend}* (SMA7: ${sma7.toFixed(2)} | SMA25: ${sma25.toFixed(2)})\n` +
      `Analisa AI: _${reason}_\n\n` +
      (action === 'BUY' ? `💰 Rekomendasi Modal: *Rp${availableBuy.toLocaleString('id-ID')}*\n\n` : `📦 Jumlah Koin: *${coinQty} ${heldCoin?.asset}*\n\n`) +
      `_Klik tombol di bawah untuk eksekusi langsung ke Tokocrypto:_`;

    await sendTelegram(msg, { inline_keyboard: buttons });
    console.log(`[TELEGRAM TERKIRIM] Notifikasi ${action} berhasil dikirim ke pengguna.`);

    return res.status(200).json({
      success: true,
      notified: true,
      symbol,
      action,
      trend
    });
  } catch (err) {
    console.error('Error in cron handler:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
