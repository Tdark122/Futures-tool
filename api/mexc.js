// /api/mexc.js
// Serverless function (runs on Vercel, not in the browser).
// Fetches Binance Futures' public ticker + kline data server-side.
// (Route/filename kept as "mexc" so index.html doesn't need any changes —
// this now actually queries Binance under the hood.)
// No API key required — Binance's market data endpoints are public.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const { symbol: rawSymbol } = req.query;
  if (!rawSymbol || typeof rawSymbol !== 'string') {
    return res.status(400).json({ error: 'Missing "symbol" query parameter, e.g. ?symbol=BTC_USDT' });
  }

  // Our app uses BTC_USDT style symbols; Binance wants BTCUSDT (no underscore).
  const binanceSymbol = rawSymbol.replace('_', '').toUpperCase();

  try {
    const [tickerRes, fundingRes, klineRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${binanceSymbol}`),
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`),
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=15m&limit=24`)
    ]);

    if (!tickerRes.ok) {
      const detail = await tickerRes.text();
      return res.status(502).json({
        ok: false,
        error: `Binance ticker unavailable for ${rawSymbol}`,
        detail: detail.slice(0, 300)
      });
    }
    const ticker = await tickerRes.json();

    let fundingRate = null;
    try {
      if (fundingRes.ok) {
        const f = await fundingRes.json();
        fundingRate = f.lastFundingRate ?? null;
      }
    } catch (e) {
      // funding rate is a nice-to-have; proceed without it if this fails
    }

    let recentCloses = [];
    try {
      if (klineRes.ok) {
        const klines = await klineRes.json();
        recentCloses = klines.map(k => k[4]); // index 4 = close price
      }
    } catch (e) {
      // klines are a nice-to-have; proceed without them if this fails
    }

    return res.status(200).json({
      ok: true,
      symbol: rawSymbol,
      lastPrice: ticker.lastPrice,
      change24h: ticker.priceChangePercent,
      high24: ticker.highPrice,
      low24: ticker.lowPrice,
      fundingRate,
      volume24: ticker.volume,
      recentCloses
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Fetch to Binance failed.' });
  }
};
      
