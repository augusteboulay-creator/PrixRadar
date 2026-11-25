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

const SEARCH_STOPWORDS = new Set([
  "a", "au", "aux", "de", "des", "du", "la", "le", "les", "un", "une",
  "et", "en", "pour", "avec", "sur", "sans", "the", "and", "for", "with"
]);
const SEARCH_CATEGORY_TERMS = new Set([
  "clavier", "claviers", "keyboard", "keyboards",
  "smartphone", "smartphones", "telephone", "telephones", "phone", "phones",
  "ordinateur", "ordinateurs", "pc", "laptop", "laptops",
  "souris", "mouse", "mice", "casque", "casques", "headphone", "headphones",
  "ecouteur", "ecouteurs", "earbud", "earbuds", "console", "consoles",
  "tablette", "tablettes", "tablet", "tablets", "ecran", "ecrans",
  "monitor", "monitors", "chaussure", "chaussures", "basket", "baskets",
  "sneaker", "sneakers", "vetement", "vetements", "robe", "canape",
  "lampe", "aspirateur", "maison", "sport", "gaming"
]);
const SEARCH_SYNONYM_GROUPS = [
  ["clavier", "claviers", "keyboard", "keyboards"],
  ["telephone", "telephones", "smartphone", "smartphones", "phone", "phones"],
  ["ordinateur", "ordinateurs", "pc", "laptop", "laptops", "notebook", "notebooks"],
  ["souris", "mouse", "mice"],
  ["casque", "casques", "headphone", "headphones", "headset", "headsets"],
  ["ecouteur", "ecouteurs", "earbud", "earbuds"],
  ["tablette", "tablettes", "tablet", "tablets"],
  ["ecran", "ecrans", "monitor", "monitors"],
  ["chaussure", "chaussures", "basket", "baskets", "sneaker", "sneakers"]
];

function oneEditApart(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 3) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) edits += 1;
  return edits <= 1;
}

function tokenMatchWeight(queryToken, titleTokens) {
  if (titleTokens.includes(queryToken)) return 1;
  if (SEARCH_SYNONYM_GROUPS.some(group =>
    group.includes(queryToken) && titleTokens.some(titleToken => group.includes(titleToken))
  )) return 0.72;
  if (/^\d+$/.test(queryToken)) return 0;
  return titleTokens.some(titleToken => oneEditApart(queryToken, titleToken)) ? 0.62 : 0;
}

function relevance(title, query) {
  const queryTokens = [...new Set(
    normalize(query).split(/[^a-z0-9]+/).filter(token => token.length >= 2 && !SEARCH_STOPWORDS.has(token))
  )];
  const titleTokens = normalize(title).split(/[^a-z0-9]+/).filter(Boolean);
  if (!queryTokens.length || !titleTokens.length) return 0;

  let totalWeight = 0;
  let matchedWeight = 0;
  for (const token of queryTokens) {
    const weight = SEARCH_CATEGORY_TERMS.has(token) ? 0.65 : /^\d+$/.test(token) ? 1.4 : 1.25;
    totalWeight += weight;
    matchedWeight += tokenMatchWeight(token, titleTokens) * weight;
  }
  return totalWeight ? matchedWeight / totalWeight : 0;
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
  if (response.status === 401 || response.status === 403) throw new Error("La clé SerpApi enregistrée sur Render est refusée. Dans le service PrixRadar, ouvre Environment et remplace SERPAPI_KEY par la valeur de ta clé uniquement, sans guillemets ni le texte SERPAPI_KEY=, puis enregistre.");
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
  const candidates = results.slice(0, 40).map((item, originalPosition) => {
    const title = String(item.title || "").trim();
    const score = relevance(title, query);
    return {
      originalPosition,
      title,
      price: String(item.price || ""),
      source: String(item.source || ""),
      image: safeHttpsUrl(item.thumbnail || item.serpapi_thumbnail),
      link: safeHttpsUrl(item.product_link || item.link),
      rating: item.rating == null || !Number.isFinite(Number(item.rating)) ? null : Number(item.rating),
      reviews: item.reviews == null || !Number.isFinite(Number(item.reviews)) ? null : Number(item.reviews),
      delivery: String(item.delivery || ""),
      description: String(item.description || item.product_description || item.snippet || "").trim().slice(0, 1400),
      details: Array.isArray(item.extensions)
        ? item.extensions.filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean).slice(0, 8)
        : [],
      score
    };
  }).filter(item =>
    item.title &&
    item.score > 0 &&
    !isLikelyAccessory(item.title, query)
  );

  const unique = [...new Map(candidates.map(item => [normalize(item.title), item])).values()]
    .sort((left, right) => right.score - left.score || left.originalPosition - right.originalPosition);
  const strongMatches = unique.filter(item => item.score >= 0.5);
  const includeAlternatives = strongMatches.length < 6;
  const selected = includeAlternatives
    ? unique.filter(item => item.score >= 0.12)
    : strongMatches;

  return selected.slice(0, 24).map(item => {
    const { originalPosition, ...product } = item;
    return {
      ...product,
      matchLabel: product.score >= 0.78
        ? "Bonne correspondance"
        : product.score >= 0.38
          ? "R\u00e9sultat proche"
          : "Alternative proche"
    };
  });
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
  const products = extractGoogleProductCards(rawResults, query);
  const payload = {
    query,
    market: MARKETS.FR.name,
    products,
    expanded: products.some(product => product.matchLabel === "Alternative proche")
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
    if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html" || requestUrl.pathname === "/product.html")) {
      try {
        const pageName = requestUrl.pathname === "/product.html" ? "product.html" : "index.html";
        const page = fs.readFileSync(path.join(ROOT, pageName));
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