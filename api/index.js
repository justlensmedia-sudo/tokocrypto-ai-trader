module.exports = (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Tokocrypto AI Trader 24/7 Cloud Bot',
    platform: 'Vercel Serverless',
    timestamp: new Date().toISOString()
  });
};
