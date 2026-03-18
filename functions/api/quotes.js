const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
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

function parseQuoteRequest(rawSymbol) {
  const [exchange, value] = rawSymbol.split(":");
  if (value) {
    return { key: rawSymbol, exchange: exchange.toUpperCase(), value };
  }
  return { key: rawSymbol, exchange: "NSE", value: rawSymbol };
}

function getSetCookieArray(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  if (typeof headers.getAll === "function") {
    return headers.getAll("Set-Cookie");
  }

  const rawCookie = headers.get("set-cookie");
  if (!rawCookie) {
    return [];
  }

  return rawCookie.split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/);
}

async function getNseCookieHeader() {
  const response = await fetch("https://www.nseindia.com", {
    headers: {
      "user-agent": "Mozilla/5.0 Codex Cloudflare App",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`NSE landing page failed with ${response.status}`);
  }

  const rawCookies = getSetCookieArray(response.headers);
  return rawCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function fetchNseQuote(symbol, cookieHeader) {
  const quoteUrl = new URL("https://www.nseindia.com/api/quote-equity");
  quoteUrl.searchParams.set("symbol", symbol);

  const response = await fetch(quoteUrl.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0 Codex Cloudflare App",
      accept: "application/json,text/plain,*/*",
      referer: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
      cookie: cookieHeader,
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

  const response = await fetch(quoteUrl.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0 Codex Cloudflare App",
      accept: "application/json,text/plain,*/*",
      referer: "https://www.bseindia.com/",
    },
  });

  if (!response.ok) {
    throw new Error(`BSE quote failed for ${scripCode} with ${response.status}`);
  }

  return response.json();
}

export async function onRequestGet(context) {
  const rawSymbols = (context.request.url
    ? new URL(context.request.url).searchParams.get("symbols")
    : "") || "";

  const symbolList = rawSymbols
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean);

  if (!symbolList.length) {
    return json({ error: "Missing symbols query parameter." }, 400);
  }

  const uniqueSymbols = [...new Set(symbolList)].map(parseQuoteRequest);
  const quotes = [];

  try {
    const cookieHeader = await getNseCookieHeader();

    for (const symbol of uniqueSymbols) {
      try {
        if (symbol.exchange === "BSE") {
          const quote = await fetchBseQuote(symbol.value);
          const livePrice = Number(quote?.CurrVal);
          const previousClose = Number(quote?.PrevClose);
          const changePercent =
            Number.isFinite(livePrice) && Number.isFinite(previousClose) && previousClose !== 0
              ? ((livePrice - previousClose) / previousClose) * 100
              : null;

          quotes.push({
            symbol: symbol.key,
            regularMarketPrice: Number.isFinite(livePrice) ? livePrice : null,
            regularMarketChangePercent: changePercent,
            regularMarketTime: parseExchangeTimestamp(quote?.CurrDate),
            source: "BSE",
          });
          continue;
        }

        const quote = await fetchNseQuote(symbol.value, cookieHeader);
        quotes.push({
          symbol: symbol.key,
          regularMarketPrice:
            typeof quote?.priceInfo?.lastPrice === "number" ? quote.priceInfo.lastPrice : null,
          regularMarketChangePercent:
            typeof quote?.priceInfo?.pChange === "number" ? quote.priceInfo.pChange : null,
          regularMarketTime: parseExchangeTimestamp(quote?.metadata?.lastUpdateTime),
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

    return json({
      fetchedAt: new Date().toISOString(),
      quotes,
    });
  } catch (error) {
    return json(
      {
        error: "Unable to fetch live market quotes right now.",
        details: error.message,
      },
      502
    );
  }
}
