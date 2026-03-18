const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".ico": "image/x-icon",
};

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseExchangeTimestamp(value) {
  if (!value) {
    return null;
  }

  const nseMatch = value.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  const bseMatch = value.match(/^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  const months = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };

  if (nseMatch) {
    const [, day, month, year, hour, minute, second] = nseMatch;
    return Math.floor(
      new Date(
        Number(year),
        months[month],
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      ).getTime() / 1000
    );
  }

  if (bseMatch) {
    const [, month, day, year, hour, minute, second] = bseMatch;
    return Math.floor(
      new Date(
        Number(year),
        months[month],
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      ).getTime() / 1000
    );
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

async function getNseCookieHeader() {
  const response = await fetch("https://www.nseindia.com", {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex Local Dashboard",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`NSE landing page failed with ${response.status}`);
  }

  const rawCookies = response.headers.getSetCookie?.() || [];
  return rawCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function fetchNseQuote(symbol, cookieHeader) {
  const quoteUrl = new URL("https://www.nseindia.com/api/quote-equity");
  quoteUrl.searchParams.set("symbol", symbol);

  const response = await fetch(quoteUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex Local Dashboard",
      Accept: "application/json,text/plain,*/*",
      Referer: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
      Cookie: cookieHeader,
    },
  });

  if (!response.ok) {
    throw new Error(`NSE quote failed for ${symbol} with ${response.status}`);
  }

  return response.json();
}

async function fetchBseQuote(scripCode) {
  const quoteUrl = new URL("https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w");
  quoteUrl.searchParams.set("scripcode", scripCode);
  quoteUrl.searchParams.set("flag", "0");
  quoteUrl.searchParams.set("fromdate", "");
  quoteUrl.searchParams.set("todate", "");
  quoteUrl.searchParams.set("seriesid", "");

  const stdout = await execFileAsync("curl", [
    "-s",
    quoteUrl.toString(),
    "-A",
    "Mozilla/5.0 Codex Local Dashboard",
    "-H",
    "Referer: https://www.bseindia.com/",
  ]);

  return JSON.parse(stdout);
}

function parseQuoteRequest(rawSymbol) {
  const [exchange, value] = rawSymbol.split(":");
  if (value) {
    return { key: rawSymbol, exchange: exchange.toUpperCase(), value };
  }
  return { key: rawSymbol, exchange: "NSE", value: rawSymbol };
}

async function handleQuotesApi(reqUrl, res) {
  const rawSymbols = (reqUrl.searchParams.get("symbols") || "")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean);

  if (!rawSymbols.length) {
    return sendJson(res, 400, { error: "Missing symbols query parameter." });
  }

  const uniqueSymbols = [...new Set(rawSymbols)].map(parseQuoteRequest);
  const quotes = [];

  try {
    const cookieHeader = await getNseCookieHeader();

    for (const symbol of uniqueSymbols) {
      try {
        if (symbol.exchange === "BSE") {
          const quote = await fetchBseQuote(symbol.value);
          const livePrice = Number(quote?.CurrVal);
          const previousClose = Number(quote?.PrevClose);
          const currentDateTime = quote?.CurrDate;
          const changePercent =
            Number.isFinite(livePrice) && Number.isFinite(previousClose) && previousClose !== 0
              ? ((livePrice - previousClose) / previousClose) * 100
              : null;

          quotes.push({
            symbol: symbol.key,
            regularMarketPrice: Number.isFinite(livePrice) ? livePrice : null,
            regularMarketChangePercent: changePercent,
            regularMarketTime: parseExchangeTimestamp(currentDateTime),
            source: "BSE",
          });
          continue;
        }

        const quote = await fetchNseQuote(symbol.value, cookieHeader);
        const livePrice = quote?.priceInfo?.lastPrice;
        const changePercent = quote?.priceInfo?.pChange;
        const updateTime = quote?.metadata?.lastUpdateTime;
        quotes.push({
          symbol: symbol.key,
          regularMarketPrice: typeof livePrice === "number" ? livePrice : null,
          regularMarketChangePercent: typeof changePercent === "number" ? changePercent : null,
          regularMarketTime: parseExchangeTimestamp(updateTime),
          source: "NSE",
        });
      } catch (error) {
        quotes.push({
          symbol: symbol.key,
          error: error.message,
          source: symbol.exchange,
        });
      }
    }

    return sendJson(res, 200, {
      fetchedAt: new Date().toISOString(),
      quotes,
    });
  } catch (error) {
    return sendJson(res, 502, {
      error: "Unable to fetch live market quotes right now.",
      details: error.message,
    });
  }
}

function serveFile(filePath, res) {
  const resolvedPath = path.normalize(filePath);

  if (!resolvedPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolvedPath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.writeHead(500);
      res.end("Internal server error");
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && reqUrl.pathname === "/api/quotes") {
    handleQuotesApi(reqUrl, res);
    return;
  }

  let filePath = path.join(ROOT, reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname);
  if (reqUrl.pathname === "/") {
    filePath = path.join(ROOT, "index.html");
  }

  serveFile(filePath, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Indian DMA screener running at http://${HOST}:${PORT}`);
});
