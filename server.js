"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = __dirname;

loadEnvFile();

const PORT = Number(process.env.PORT) || 4173;
const SUPPORTED_CURRENCIES = new Set(["EUR", "GBP", "USD", "CAD"]);
const MARKETS = {
  FR: { code: "FR", name: "France", flag: "🇫🇷", language: "fr", currency: "EUR" },
  BE: { code: "BE", name: "Belgique", flag: "🇧🇪", language: "fr", currency: "EUR" },
  DE: { code: "DE", name: "Allemagne", flag: "🇩🇪", language: "de", currency: "EUR" },
  ES: { code: "ES", name: "Espagne", flag: "🇪🇸", language: "es", currency: "EUR" },
  IT: { code: "IT", name: "Italie", flag: "🇮🇹", language: "it", currency: "EUR" },
  GB: { code: "GB", name: "Royaume-Uni", flag: "🇬🇧", language: "en", currency: "GBP" },
  US: { code: "US", name: "États-Unis", flag: "🇺🇸", language: "en", currency: "USD" },
  CA: { code: "CA", name: "Canada", flag: "🇨🇦", language: "en", currency: "CAD" }
};

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function normalize(value) {
  return String(value || "").toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function relevance(title, query) {
  const tokens = normalize(query).split(/[^a-z0-9]+/).filter(token => token.length >= 2);
  if (!tokens.length) return 1;
  const normalizedTitle = normalize(title);
  return tokens.filter(token => normalizedTitle.includes(token)).length / tokens.length;
}

const ACCESSORY_TERMS = [
  "case", "cover", "charger", "adapter", "cable", "stand", "holder",
  "screen protector", "skin", "coque", "etui", "chargeur", "adaptateur",
  "cable", "support", "protection"
];

function isLikelyAccessory(title, query) {
  const normalizedTitle = normalize(title);
  const normalizedQuery = normalize(query);
  return ACCESSORY_TERMS.some(term =>
    normalizedTitle.includes(term) && !normalizedQuery.includes(term)
  );
}

function currencyFor(priceText, market) {
  const explicit = String(priceText || "").match(/\b(EUR|GBP|USD|CAD)\b/i);
  if (explicit) return explicit[1].toUpperCase();
  const text = String(priceText || "");
  if (text.includes("€")) return "EUR";
  if (text.includes("£")) return "GBP";
  if (text.includes("$")) return market.currency;
  return market.currency;
}

function extractCandidates(results, query, market) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 40).map(item => {
    const amount = Number(item.extracted_price);
    const title = String(item.title || "");
    const price = String(item.price || "");
    const currency = currencyFor(price, market);
    if (!title || !Number.isFinite(amount) || amount <= 0 || !SUPPORTED_CURRENCIES.has(currency)) return null;
    return {
      title,
      source: String(item.source || ""),
      price,
      amount,
      currency,
      delivery: String(item.delivery || ""),
      link: String(item.product_link || ""),
      score: relevance(title, query)
    };
  }).filter(item => item && item.score >= 0.75 && !isLikelyAccessory(item.title, query));
}

async function searchMarket(query, market, apiKey) {
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    gl: market.code.toLowerCase(),
    hl: market.language,
    api_key: apiKey
  });
  const response = await fetch("https://serpapi.com/search.json?" + params.toString(), {
    signal: AbortSignal.timeout(25000)
  });
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  if (response.status === 401 || response.status === 403) throw new Error("La clé API n’est pas reconnue. Vérifie le fichier .env.");
  if (response.status === 429) throw new Error("Le quota gratuit est atteint ou la limite temporaire est dépassée.");
  if (!response.ok || data.error) throw new Error("Google Shopping est indisponible pour cette recherche.");
  return Array.isArray(data.shopping_results) ? data.shopping_results : [];
}

async function exchangeRateToEur(currency) {
  if (currency === "EUR") return { rate: 1, date: null };
  const url = "https://api.frankfurter.dev/v2/rate/" + encodeURIComponent(currency) + "/EUR";
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Taux de conversion indisponible.");
  const data = await response.json();
  const rate = Number(data.rate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Taux de conversion invalide.");
  return { rate, date: String(data.date || "") };
}

async function compareMarkets(query, codes, apiKey) {
  const requested = Array.from(new Set(codes))
    .map(code => MARKETS[String(code).toUpperCase()])
    .filter(Boolean);
  if (!requested.length) throw new Error("Sélectionne au moins un pays.");
  if (!apiKey || apiKey === "COLLE_TA_CLE_ICI") throw new Error("Ajoute ta clé SerpApi dans le fichier .env.");

  const rawMarkets = await Promise.all(requested.map(async market => {
    try {
      const results = await searchMarket(query, market, apiKey);
      return { market, candidates: extractCandidates(results, query, market), error: null };
    } catch (error) {
      const safeError = /clé API|quota gratuit/i.test(error.message)
        ? error.message
        : "Recherche indisponible dans ce pays. Vérifie ta connexion ou le quota.";
      return { market, candidates: [], error: safeError };
    }
  }));

  const currencies = Array.from(new Set(
    rawMarkets.flatMap(item => item.candidates.map(candidate => candidate.currency))
  ));
  const rates = { EUR: { rate: 1, date: null } };
  await Promise.all(currencies.filter(currency => currency !== "EUR").map(async currency => {
    try {
      rates[currency] = await exchangeRateToEur(currency);
    } catch (error) {
      rates[currency] = { error: true };
    }
  }));

  const comparisons = rawMarkets.map(({ market, candidates, error }) => {
    if (error) return { code: market.code, name: market.name, flag: market.flag, error };
    const converted = candidates
      .filter(candidate => rates[candidate.currency] && !rates[candidate.currency].error)
      .map(candidate => ({
        ...candidate,
        priceEur: Number((candidate.amount * rates[candidate.currency].rate).toFixed(2))
      }))
      .sort((a, b) => a.priceEur - b.priceEur);

    if (!converted.length) {
      return {
        code: market.code,
        name: market.name,
        flag: market.flag,
        error: candidates.length ? "Conversion monétaire indisponible." : "Aucune offre avec prix comparable trouvée."
      };
    }

    const best = converted[0];
    return {
      code: market.code,
      name: market.name,
      flag: market.flag,
      best: {
        title: best.title,
        source: best.source,
        price: best.price,
        currency: best.currency,
        priceEur: best.priceEur,
        delivery: best.delivery,
        link: best.link
      }
    };
  }).sort((a, b) => {
    if (a.best && b.best) return a.best.priceEur - b.best.priceEur;
    if (a.best) return -1;
    if (b.best) return 1;
    return a.name.localeCompare(b.name, "fr");
  });

  const cheapestMarket = comparisons.find(item => item.best);
  const dates = currencies.map(currency => rates[currency] && rates[currency].date).filter(Boolean).sort();
  return {
    query,
    rateDate: dates.length ? dates[dates.length - 1] : null,
    cheapest: cheapestMarket ? {
      code: cheapestMarket.code,
      name: cheapestMarket.name,
      priceEur: cheapestMarket.best.priceEur
    } : null,
    markets: comparisons
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function createServer() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1:" + PORT);

    if (requestUrl.pathname === "/api/compare") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Méthode non autorisée." });
        return;
      }
      const query = String(requestUrl.searchParams.get("q") || "").trim();
      if (!query || query.length > 140) {
        sendJson(response, 400, { error: "Saisis un produit (140 caractères maximum)." });
        return;
      }
      const requested = requestUrl.searchParams.getAll("market");
      const codes = requested.length ? requested.slice(0, 8) : ["FR"];
      const validCodes = codes.filter(code => MARKETS[String(code).toUpperCase()]);
      if (!validCodes.length) {
        sendJson(response, 400, { error: "Choisis au moins un pays valide." });
        return;
      }
      const apiKey = process.env.SERPAPI_KEY;
      if (!apiKey || apiKey === "COLLE_TA_CLE_ICI") {
        sendJson(response, 503, { error: "Ajoute ta clé SerpApi dans le fichier .env puis relance PrixRadar." });
        return;
      }
      try {
        sendJson(response, 200, await compareMarkets(query, validCodes, apiKey));
      } catch (error) {
        sendJson(response, 502, { error: error.message || "La comparaison a échoué." });
      }
      return;
    }

    if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")) {
      try {
        const page = fs.readFileSync(path.join(ROOT, "index.html"));
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(page);
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Impossible d’ouvrir index.html.");
      }
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Page introuvable.");
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, process.env.HOST || "127.0.0.1", () => {
    console.log("PrixRadar est disponible sur http://127.0.0.1:" + PORT);
    if (!process.env.SERPAPI_KEY || process.env.SERPAPI_KEY === "COLLE_TA_CLE_ICI") {
      console.log("Ajoute une clé SerpApi dans .env pour activer la comparaison réelle.");
    }
  });
}

module.exports = { MARKETS, compareMarkets, createServer, extractCandidates };