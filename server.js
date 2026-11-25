"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = __dirname;

loadEnvFile();

const PORT = Number(process.env.PORT) || 4173;
const MARKETS = {
  FR: { code: "FR", name: "France", flag: "🇫🇷", language: "fr", currency: "EUR" }
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

const PRODUCT_SEARCH_CACHE = new Map();
const PRODUCT_SEARCH_TTL_MS = 10 * 60 * 1000;

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function extractGoogleProductCards(results, query) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 40).map(item => {
    const title = String(item.title || "").trim();
    const score = relevance(title, query);
    return {
      title,
      price: String(item.price || ""),
      source: String(item.source || ""),
      image: safeHttpsUrl(item.thumbnail || item.serpapi_thumbnail),
      link: safeHttpsUrl(item.product_link || item.link),
      rating: item.rating == null || !Number.isFinite(Number(item.rating)) ? null : Number(item.rating),
      reviews: item.reviews == null || !Number.isFinite(Number(item.reviews)) ? null : Number(item.reviews),
      delivery: String(item.delivery || ""),
      score
    };
  }).filter(item =>
    item.title &&
    item.score >= 0.5 &&
    !isLikelyAccessory(item.title, query)
  ).slice(0, 24);
}

async function searchGoogleProducts(query, apiKey) {
  if (!apiKey || apiKey === "COLLE_TA_CLE_ICI") {
    throw new Error("Ajoute ta clé SerpApi dans le fichier .env ou dans Render.");
  }
  const cacheKey = normalize(query);
  const now = Date.now();
  const cached = PRODUCT_SEARCH_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.payload;

  const rawResults = await searchMarket(query, MARKETS.FR, apiKey);
  const payload = {
    query,
    market: MARKETS.FR.name,
    products: extractGoogleProductCards(rawResults, query)
  };
  PRODUCT_SEARCH_CACHE.set(cacheKey, { expiresAt: now + PRODUCT_SEARCH_TTL_MS, payload });
  if (PRODUCT_SEARCH_CACHE.size > 100) {
    PRODUCT_SEARCH_CACHE.delete(PRODUCT_SEARCH_CACHE.keys().next().value);
  }
  return payload;
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

    if (requestUrl.pathname === "/api/products") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Méthode non autorisée." });
        return;
      }
      const query = String(requestUrl.searchParams.get("q") || "").trim();
      if (!query || query.length > 140) {
        sendJson(response, 400, { error: "Saisis un produit (140 caractères maximum)." });
        return;
      }
      const apiKey = process.env.SERPAPI_KEY;
      if (!apiKey || apiKey === "COLLE_TA_CLE_ICI") {
        sendJson(response, 503, { error: "Ajoute ta clé SerpApi dans .env en local ou dans les variables Render." });
        return;
      }
      try {
        sendJson(response, 200, await searchGoogleProducts(query, apiKey));
      } catch (error) {
        const safeError = /clé API|quota/i.test(error.message)
          ? error.message
          : "La recherche Google Shopping est momentanément indisponible.";
        sendJson(response, 502, { error: safeError });
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
      console.log("Ajoute une clé SerpApi dans .env pour activer la recherche Google Shopping.");
    }
  });
}

module.exports = { MARKETS, createServer, extractGoogleProductCards, searchGoogleProducts };