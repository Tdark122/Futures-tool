// /api/mexc.js
// Serverless function (runs on Vercel, not in the browser).
// Fetches Kraken Futures' public ticker data server-side.
// (Route/filename kept as "mexc" so index.html doesn't need any changes —
// this now actually queries Kraken Futures under the hood.)
// Kraken is US-licensed, so unlike Binance/Bybit/OKX it does not geo-block
// requests coming from US-based cloud server IPs (like Vercel's).
// No API key required — Kraken's market data endpoints are public.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const { symbol: rawSymbol } = req.query;
  if (!rawSymbol || typeof rawSymbol !== 'string') {
    return res.status(400).json({ error: 'Missing "symbol" query parameter, e.g. ?symbol=BTC_USDT' });
  }

  // Our app uses BTC_USDT style symbols. Kraken Futures perpetuals use
  // PF_{BASE}USD, and Kraken calls Bitcoin "XBT" instead of "BTC".
  const BASE_ALIASES = { BTC: 'XBT' };
  let [base] = rawSymbol.toUpperCase().split('_');
  base = BASE_ALIASES[base] || base;
  const krakenSymbol = `PF_${base}USD`;

  try {
    const tickerRes = await fetch(`https://futures.kraken.com/derivatives/api/v3/tickers/${krakenSymbol}`);

    if (!tickerRes.ok) {
      const detail = await tickerRes.text();
      return res.status(502).json({
        ok: false,
        error: `Kraken ${tickerRes.status}: ${detail.slice(0, 150)}`,
        detail: detail.slice(0, 300)
      });
    }

    const json = await tickerRes.json();
    const t = json.ticker || json; // single-symbol endpoint nests under "ticker"

    if (!t || !t.last) {
      return res.status(502).json({
        ok: false,
        error: `No Kraken data found for ${krakenSymbol} (from ${rawSymbol})`
      });
    }

    return res.status(200).json({
      ok: true,
      symbol: rawSymbol,
      lastPrice: t.last,
      change24h: t.change24h != null ? Number(t.change24h).toFixed(2) : null,
      high24: t.high24h ?? t.open24h ?? null,
      low24: t.low24h ?? null,
      fundingRate: t.fundingRate,
      volume24: t.vol24h,
      recentCloses: [] // Kraken candle data not wired in yet; live price/stats above are real
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Fetch to Kraken failed.' });
  }
};
  
