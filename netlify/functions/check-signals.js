// netlify/functions/check-signals.js
// Se ejecuta sola cada 15 minutos (ver "config.schedule" al final del archivo).
// Replica EXACTAMENTE la lógica de los 7 filtros del index.html, pero corriendo
// en el servidor de Netlify (no en el celular), para poder enviar Web Push real
// aunque el celular esté bloqueado o el navegador cerrado.

import webpush from "web-push";
import { getStore } from "@netlify/blobs";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:jaem-signals@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const ASSETS = { BTC: "BTCUSDT", ETH: "ETHUSDT" };
const MIN_FILTERS = 5;
const SL_MULT = 1.5;
const BINANCE_BASE = "https://data-api.binance.vision/api/v3";

// ---------- Mismas funciones matemáticas que el cliente (index.html) ----------

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += prices[i];
  ema /= period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcStdDev(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length);
}

function calcSqueeze(candles) {
  const P = 20, BB = 2.0, KC = 1.5;
  if (candles.length < P) return { sqz: false, momentum: 0 };
  const sl = candles.slice(-P);
  const closes = sl.map((c) => c.close);
  const highs = sl.map((c) => c.high);
  const lows = sl.map((c) => c.low);
  const mean = closes.reduce((a, b) => a + b) / closes.length;
  const std = calcStdDev(closes);
  const trs = [];
  for (let i = 1; i < sl.length; i++) {
    trs.push(Math.max(sl[i].high - sl[i].low, Math.abs(sl[i].high - sl[i - 1].close), Math.abs(sl[i].low - sl[i - 1].close)));
  }
  const atr = trs.reduce((a, b) => a + b) / trs.length;
  const sqz = mean + BB * std < mean + KC * atr && mean - BB * std > mean - KC * atr;
  const maxH = Math.max(...highs), minL = Math.min(...lows);
  const delta = closes[closes.length - 1] - (maxH + minL) / 2;
  const ph = highs.slice(0, -1), pl = lows.slice(0, -1);
  const prevDelta = closes[closes.length - 2] - (Math.max(...ph) + Math.min(...pl)) / 2;
  return { sqz, momentum: delta, rising: delta > prevDelta };
}

function parseKlines(arr) {
  return arr.map((k) => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], time: k[0] }));
}

async function fetchKlines(symbol, interval, limit) {
  const r = await fetch(`${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`Binance ${symbol} ${interval}: HTTP ${r.status}`);
  return parseKlines(await r.json());
}

async function fetchPrice(symbol) {
  const r = await fetch(`${BINANCE_BASE}/ticker/price?symbol=${symbol}`);
  if (!r.ok) throw new Error(`Binance price ${symbol}: HTTP ${r.status}`);
  const d = await r.json();
  return +d.price;
}

// ---------- Evaluación de los 7 filtros para un activo ----------

async function evaluateAsset(symbol) {
  const [candles1h, candles15m, price] = await Promise.all([
    fetchKlines(symbol, "1h", 120),
    fetchKlines(symbol, "15m", 100),
    fetchPrice(symbol),
  ]);

  if (!candles1h.length || !price) return null;
  const closes1h = candles1h.map((c) => c.close);
  const ema10 = calcEMA(closes1h, 10);
  const ema55 = calcEMA(closes1h, 55);
  if (!ema10 || !ema55) return null;
  const trend = ema10 > ema55 ? "BULL" : "BEAR";

  const rH = candles1h.slice(-20).map((c) => c.high);
  const rL = candles1h.slice(-20).map((c) => c.low);
  const nearSup = Math.abs(price - Math.min(...rL)) / price < 0.015;
  const nearRes = Math.abs(price - Math.max(...rH)) / price < 0.015;
  const nearE55 = Math.abs(price - ema55) / price < 0.012;

  const ema10p = calcEMA(closes1h.slice(0, -5), 10);
  const ema55p = calcEMA(closes1h.slice(0, -5), 55);
  const slope = ema10p ? Math.abs((ema10 - ema10p) / ema10p) * 100 : 0;
  const crossUp = ema10p < ema55p && ema10 >= ema55;
  const crossDown = ema10p > ema55p && ema10 <= ema55;

  const sqz = calcSqueeze(candles15m);
  const lastC = candles15m[candles15m.length - 1];
  const bullC = lastC && lastC.close > lastC.open;
  const bodyPct = lastC ? Math.abs(lastC.close - lastC.open) / lastC.open * 100 : 0;

  const filters = [
    { pass: true, bullish: trend === "BULL" },
    { pass: nearSup || nearRes || nearE55, bullish: nearSup || (nearE55 && trend === "BULL") },
    { pass: (price > ema10 && price > ema55) || (price < ema10 && price < ema55), bullish: price > ema10 && price > ema55 },
    { pass: true, bullish: crossUp || (!crossDown && trend === "BULL") },
    { pass: slope > 0.3, bullish: ema10 > ema10p },
    { pass: !sqz.sqz && Math.abs(sqz.momentum) > 10, bullish: sqz.momentum > 0 },
    { pass: bodyPct > 0.1, bullish: bullC },
  ];

  const bullScore = filters.filter((f) => f.pass && f.bullish).length;
  const bearScore = filters.filter((f) => f.pass && !f.bullish).length;
  let newSignal = null;
  if (bullScore >= MIN_FILTERS) newSignal = "BUY";
  else if (bearScore >= MIN_FILTERS) newSignal = "SELL";

  if (!newSignal) return { newSignal: null };

  const atr = calcATR(candles1h, 14) || price * 0.01;
  const entry = price;
  let sl, tp1;
  if (newSignal === "BUY") {
    sl = entry - atr * SL_MULT;
    tp1 = entry + atr * 1.5;
  } else {
    sl = entry + atr * SL_MULT;
    tp1 = entry - atr * 1.5;
  }
  const score = newSignal === "BUY" ? bullScore : bearScore;
  const msg = `${newSignal === "BUY" ? "COMPRA" : "VENTA"} — ${score}/7 filtros @ $${Math.round(price).toLocaleString("en-US")} | SL: $${Math.round(sl).toLocaleString("en-US")} | TP1: $${Math.round(tp1).toLocaleString("en-US")}`;

  return { newSignal, msg };
}

// ---------- Envío del push a todas las suscripciones guardadas ----------

async function sendToAll(store, subscriptions, title, body) {
  const stillValid = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        sub,
        JSON.stringify({ title, body, icon: "/icon-192.png", badge: "/icon-192.png" })
      );
      stillValid.push(sub);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log("Suscripción expirada, se elimina:", sub.endpoint);
      } else {
        console.error("Error enviando push:", err.statusCode, err.body);
        stillValid.push(sub); // error transitorio, no la borramos
      }
    }
  }
  if (stillValid.length !== subscriptions.length) {
    await store.setJSON("subscriptions", stillValid);
  }
}

// ---------- Handler programado ----------

export default async () => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en las variables de entorno de Netlify.");
    return new Response("Faltan VAPID keys", { status: 500 });
  }

  const store = getStore("jaem-push");
  const state = (await store.get("state", { type: "json" })) || { BTC: null, ETH: null };
  const subscriptions = (await store.get("subscriptions", { type: "json" })) || [];

  for (const [key, symbol] of Object.entries(ASSETS)) {
    try {
      const result = await evaluateAsset(symbol);
      if (!result) continue;
      const { newSignal, msg } = result;
      if (newSignal && newSignal !== state[key]) {
        state[key] = newSignal;
        console.log(`Nueva señal ${key}: ${newSignal} — ${msg}`);
        if (subscriptions.length) {
          await sendToAll(store, subscriptions, `JAEM — ${key} Trading Latino Signal`, msg);
        }
      } else if (!newSignal) {
        state[key] = null;
      }
    } catch (err) {
      console.error(`Error evaluando ${key}:`, err);
    }
  }

  await store.setJSON("state", state);
  return new Response("ok");
};

export const config = {
  schedule: "*/15 * * * *",
};
