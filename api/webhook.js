const https = require('https');
const crypto = require('crypto');

const TOKOCRYPTO_API_KEY = process.env.TOKOCRYPTO_API_KEY;
const TOKOCRYPTO_API_SECRET = process.env.TOKOCRYPTO_API_SECRET;
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

async function sendTelegram(text) {
  await request(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    },
    { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'Markdown' }
  );
}

async function answerCallback(callbackQueryId, text = '') {
  await request(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    },
    { callback_query_id: callbackQueryId, text: text }
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
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Webhook endpoint ready' });
  }

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
};
