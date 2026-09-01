# 🤖 Tokocrypto AI Trader Bot (24/7 Cloud)

Bot trading otomatis untuk Tokocrypto yang terintegrasi dengan Google Gemini 3.6 Flash AI dan Telegram Bot.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/justlensmedia-sudo/tokocrypto-ai-trader)

## 🚀 Fitur Utama
1. **Analisa Pasar AI (Gemini 3.6 Flash)** tiap 15 menit menggunakan indikator teknikal (SMA Golden Cross).
2. **Kirim Kartu Sinyal ke Telegram** lengkap dengan tombol interaktif (**BUY**, **SELL**, **HOLD**).
3. **Eksekusi Order Real-time** ke Tokocrypto API dengan otentikasi HMAC SHA256 saat tombol di Telegram ditekan.
4. **Proteksi Drawdown & Limit Modal** (Maks Rp87.000).
5. **Ringan & Hemat Resource** (Hanya ~15MB RAM).

## ⚙️ Environment Variables yang Dibutuhkan di Render:
- `TOKOCRYPTO_API_KEY`
- `TOKOCRYPTO_API_SECRET`
- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `MODAL_MAX_IDR` (default: 87000)
