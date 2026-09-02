// /api/mexc.js
// Serverless function (runs on Vercel, not in the browser).
// Fetches Kraken Futures' public ticker + candle data server-side, then
// computes 7 technical indicators from the REAL candle closes/highs/lows.
// (Route/filename kept as "mexc" so index.html doesn't need any changes —
// this now actually queries Kraken Futures under the hood.)
// Kraken is US-licensed, so unlike Binance/Bybit/OKX it does not geo-block
// requests coming from US-based cloud server IPs (like Vercel's).
// No API key required — Kraken's market data endpoints are public.
//
// IMPORTANT: indicators are only ever returned when computed from actual
// fetched candle data. If candles can't be fetched, indicators come back
// as null with indicatorsAvailable:false — never a made-up placeholder.

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

    const tickerJson = await tickerRes.json();
    const t = tickerJson.ticker || tickerJson; // single-symbol endpoint nests under "ticker"

    if (!t || !t.last) {
      return res.status(502).json({
        ok: false,
        error: `No Kraken data found for ${krakenSymbol} (from ${rawSymbol})`
      });
    }

    // --- Fetch hourly candles for indicator math. Try both known symbol
    // prefixes since Kraken's docs are inconsistent about PF_ vs PI_ for
    // the charts endpoint specifically.
    let candles = [];
    let candleSourceSymbol = null;
    for (const candidateSymbol of [krakenSymbol, krakenSymbol.replace('PF_', 'PI_')]) {
      try {
        const chartRes = await fetch(`https://futures.kraken.com/api/charts/v1/trade/${candidateSymbol}/1h`);
        if (chartRes.ok) {
          const chartJson = await chartRes.json();
          if (Array.isArray(chartJson.candles) && chartJson.candles.length > 0) {
            candles = chartJson.candles;
            candleSourceSymbol = candidateSymbol;
            break;
          }
        }
      } catch (e) {
        // try next candidate
      }
    }

    let indicators = null;
    let indicatorsAvailable = false;
    let indicatorsNote = 'Candle data unavailable — indicators not computed.';
    let recentCloses = [];

    if (candles.length >= 30) {
      const closes = candles.map(c => Number(c.close));
      const highs = candles.map(c => Number(c.high));
      const lows = candles.map(c => Number(c.low));
      recentCloses = closes.slice(-24);

      indicators = computeIndicators(closes, highs, lows);
      indicatorsAvailable = true;
      indicatorsNote = `Computed from ${candles.length} real 1h candles (${candleSourceSymbol}).`;
    } else if (candles.length > 0) {
      indicatorsNote = `Only ${candles.length} candles available — not enough history for reliable indicators (need 30+).`;
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
      recentCloses,
      indicators,
      indicatorsAvailable,
      indicatorsNote
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Fetch to Kraken failed.' });
  }
};

// ---------- Real technical indicator math (no external libraries) ----------

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [seed];
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (values.length < slow + signalPeriod) return null;
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const offset = fastSeries.length - slowSeries.length;
  const macdLine = slowSeries.map((v, i) => fastSeries[i + offset] - v);
  const signalSeries = emaSeries(macdLine, signalPeriod);
  if (!signalSeries.length) return null;
  const macdVal = macdLine[macdLine.length - 1];
  const signalVal = signalSeries[signalSeries.length - 1];
  return { macd: macdVal, signal: signalVal, histogram: macdVal - signalVal };
}

function bollingerBands(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: mean + mult * stdDev, middle: mean, lower: mean - mult * stdDev };
}

function stochastic(highs, lows, closes, period = 14, smoothD = 3) {
  if (closes.length < period + smoothD) return null;
  const rawKs = [];
  for (let i = closes.length - smoothD; i < closes.length; i++) {
    const hSlice = highs.slice(i - period + 1, i + 1);
    const lSlice = lows.slice(i - period + 1, i + 1);
    const highest = Math.max(...hSlice);
    const lowest = Math.min(...lSlice);
    const k = highest === lowest ? 50 : ((closes[i] - lowest) / (highest - lowest)) * 100;
    rawKs.push(k);
  }
  const kVal = rawKs[rawKs.length - 1];
  const dVal = rawKs.reduce((a, b) => a + b, 0) / rawKs.length;
  return { k: kVal, d: dVal };
}

function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const highLow = highs[i] - lows[i];
    const highClose = Math.abs(highs[i] - closes[i - 1]);
    const lowClose = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(highLow, highClose, lowClose));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function round(n, dp = 2) {
  return n == null ? null : Number(n.toFixed(dp));
}

function computeIndicators(closes, highs, lows) {
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes);
  const stochResult = stochastic(highs, lows, closes);
  return {
    sma20: round(sma(closes, 20)),
    ema12: round(ema(closes, 12)),
    rsi14: round(rsi(closes, 14)),
    macd: macdResult ? {
      macd: round(macdResult.macd, 4),
      signal: round(macdResult.signal, 4),
      histogram: round(macdResult.histogram, 4)
    } : null,
    bollinger: bbResult ? {
      upper: round(bbResult.upper),
      middle: round(bbResult.middle),
      lower: round(bbResult.lower)
    } : null,
    stochastic: stochResult ? {
      k: round(stochResult.k),
      d: round(stochResult.d)
    } : null,
    atr14: round(atr(highs, lows, closes, 14))
  };
  }
    
