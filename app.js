const state = {
  rows: [],
  quoteMap: new Map(),
  pollHandle: null,
  lastAlertKeys: new Set(),
  notificationsEnabled: false,
};

const elements = {
  rows: document.getElementById("rows"),
  rowTemplate: document.getElementById("rowTemplate"),
  alertCount: document.getElementById("alertCount"),
  alertSplit: document.getElementById("alertSplit"),
  qualifiedCount: document.getElementById("qualifiedCount"),
  liveCount: document.getElementById("liveCount"),
  deepestSignal: document.getElementById("deepestSignal"),
  deepestSignalMeta: document.getElementById("deepestSignalMeta"),
  lastRefresh: document.getElementById("lastRefresh"),
  marketStatus: document.getElementById("marketStatus"),
  feedStatus: document.getElementById("feedStatus"),
  maxPe: document.getElementById("maxPe"),
  maxPeValue: document.getElementById("maxPeValue"),
  minFcf: document.getElementById("minFcf"),
  minOcf: document.getElementById("minOcf"),
  pollInterval: document.getElementById("pollInterval"),
  requireIndustryPe: document.getElementById("requireIndustryPe"),
  showOnlyAlerts: document.getElementById("showOnlyAlerts"),
  notifyButton: document.getElementById("notifyButton"),
};

function parseCsv(csvText) {
  const rows = [];
  let current = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      current.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        i += 1;
      }
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field.length || current.length) {
    current.push(field);
    rows.push(current);
  }

  const [header, ...dataRows] = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  return dataRows.map((row) => {
    const entry = {};
    header.forEach((key, index) => {
      entry[key] = (row[index] || "").trim();
    });
    return entry;
  });
}

function parseNumber(value) {
  const normalized = String(value || "")
    .replace(/,/g, "")
    .trim();
  if (!normalized) {
    return null;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function getPreferredTicker(stock) {
  const nse = stock["NSE Code"];
  const bse = stock["BSE Code"];

  if (nse) {
    return `NSE:${nse}`;
  }
  if (bse) {
    return `BSE:${bse}`;
  }
  return null;
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: value > 999 ? 0 : 2,
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${value.toFixed(2)}%`;
}

function formatTime(epochSeconds) {
  if (!epochSeconds) {
    return "--";
  }
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function computeSignal(livePrice, dma50, dma200) {
  if (!Number.isFinite(livePrice)) {
    return {
      label: "No live price",
      tone: "signal-clear",
      severity: 0,
      discount: null,
    };
  }

  if (Number.isFinite(dma200) && livePrice < dma200) {
    return {
      label: "Below 200 DMA",
      tone: "signal-200",
      severity: 2,
      discount: ((livePrice - dma200) / dma200) * 100,
    };
  }

  if (Number.isFinite(dma50) && livePrice < dma50) {
    return {
      label: "Below 50 DMA",
      tone: "signal-50",
      severity: 1,
      discount: ((livePrice - dma50) / dma50) * 100,
    };
  }

  return {
    label: "Above key DMAs",
    tone: "signal-clear",
    severity: 0,
    discount:
      Number.isFinite(dma50) && dma50 !== 0 ? ((livePrice - dma50) / dma50) * 100 : null,
  };
}

function screenStocks() {
  const maxPe = Number(elements.maxPe.value);
  const minFcf = Number(elements.minFcf.value || 0);
  const minOcf = Number(elements.minOcf.value || 0);
  const requireIndustryPe = elements.requireIndustryPe.checked;
  const showOnlyAlerts = elements.showOnlyAlerts.checked;

  const screened = state.rows
    .map((stock) => {
      const liveQuote = state.quoteMap.get(stock.ticker) || null;
      const livePrice = liveQuote?.regularMarketPrice ?? stock.currentPrice;
      const signal = computeSignal(livePrice, stock.dma50, stock.dma200);
      const peCutoff = requireIndustryPe && Number.isFinite(stock.industryPe)
        ? Math.min(maxPe, stock.industryPe)
        : maxPe;
      const qualifies =
        Number.isFinite(stock.pe) &&
        stock.pe <= peCutoff &&
        Number.isFinite(stock.freeCashFlow) &&
        stock.freeCashFlow >= minFcf &&
        Number.isFinite(stock.operatingCashFlow3y) &&
        stock.operatingCashFlow3y >= minOcf;

      return {
        ...stock,
        liveQuote,
        livePrice,
        signal,
        qualifies,
      };
    })
    .filter((stock) => stock.qualifies)
    .filter((stock) => (showOnlyAlerts ? stock.signal.severity > 0 : true))
    .sort((left, right) => {
      if (right.signal.severity !== left.signal.severity) {
        return right.signal.severity - left.signal.severity;
      }
      return (left.signal.discount ?? 999) - (right.signal.discount ?? 999);
    });

  renderDashboard(screened);
  emitAlerts(screened);
}

function renderDashboard(screened) {
  const liveCount = screened.filter((stock) => stock.liveQuote?.regularMarketPrice).length;
  const alerts = screened.filter((stock) => stock.signal.severity > 0);
  const below50 = alerts.filter((stock) => stock.signal.severity === 1).length;
  const below200 = alerts.filter((stock) => stock.signal.severity === 2).length;
  const deepest = alerts[0] || null;

  elements.qualifiedCount.textContent = String(screened.length);
  elements.liveCount.textContent = String(liveCount);
  elements.alertCount.textContent = String(alerts.length);
  elements.alertSplit.textContent = `${below50} below 50 DMA / ${below200} below 200 DMA`;
  elements.deepestSignal.textContent = deepest ? deepest.name : "None";
  elements.deepestSignalMeta.textContent = deepest
    ? `${deepest.signal.label} at ${formatPercent(deepest.signal.discount)}`
    : "No active DMA breaches";

  elements.rows.innerHTML = "";

  screened.forEach((stock) => {
    const fragment = elements.rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");

    row.querySelector(".stock-name").textContent = stock.name;
    row.querySelector(".stock-symbol").textContent = `${stock.symbol} • ${stock.ticker}`;
    row.querySelector(".live-price").textContent = formatCurrency(stock.livePrice);
    row.querySelector(".dma50").textContent = formatCurrency(stock.dma50);
    row.querySelector(".dma200").textContent = formatCurrency(stock.dma200);

    const signalCell = row.querySelector(".signal");
    const signalPill = document.createElement("span");
    signalPill.className = `signal-pill ${stock.signal.tone}`;
    signalPill.textContent = stock.signal.label;
    signalCell.appendChild(signalPill);

    row.querySelector(".pe").textContent = stock.pe?.toFixed(2) ?? "--";
    row.querySelector(".fcf").textContent = formatCurrency(stock.freeCashFlow);
    row.querySelector(".ocf").textContent = formatCurrency(stock.operatingCashFlow3y);

    const changeCell = row.querySelector(".change");
    const changePercent = stock.liveQuote?.regularMarketChangePercent;
    changeCell.textContent = formatPercent(changePercent);
    changeCell.classList.add(changePercent >= 0 ? "positive" : "negative");

    row.querySelector(".updated").textContent = formatTime(stock.liveQuote?.regularMarketTime);

    if (stock.signal.severity === 2) {
      row.style.background = "rgba(182, 61, 50, 0.06)";
    } else if (stock.signal.severity === 1) {
      row.style.background = "rgba(220, 138, 34, 0.07)";
    }

    elements.rows.appendChild(fragment);
  });

  const marketOpen = liveCount > 0;
  elements.marketStatus.textContent = marketOpen ? "Live quotes streaming" : "Waiting for live market data";
  elements.marketStatus.className = `pill ${marketOpen ? "positive" : "negative"}`;
  elements.feedStatus.textContent = `${screened.length} screened / ${state.rows.length} tracked`;
  elements.feedStatus.className = "pill";
}

function emitAlerts(screened) {
  const currentAlerts = new Set();

  screened.forEach((stock) => {
    if (stock.signal.severity > 0) {
      const key = `${stock.ticker}:${stock.signal.label}`;
      currentAlerts.add(key);

      if (!state.lastAlertKeys.has(key)) {
        playTone();
        if (state.notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
          new Notification(`${stock.name} triggered ${stock.signal.label}`, {
            body: `Live price ${formatCurrency(stock.livePrice)} vs 50 DMA ${formatCurrency(stock.dma50)} / 200 DMA ${formatCurrency(stock.dma200)}`,
          });
        }
      }
    }
  });

  state.lastAlertKeys = currentAlerts;
}

function playTone() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  const audioContext = new AudioContextClass();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.value = 720;
  gain.gain.value = 0.015;
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.18);
}

async function fetchQuotes() {
  const tickers = state.rows.map((stock) => stock.ticker).filter(Boolean);
  if (!tickers.length) {
    return;
  }

  try {
    const response = await fetch(`/api/quotes?symbols=${encodeURIComponent(tickers.join(","))}`);
    if (!response.ok) {
      throw new Error(`Quote API returned ${response.status}`);
    }
    const payload = await response.json();
    state.quoteMap = new Map(
      (payload.quotes || [])
        .filter((quote) => quote.symbol && Number.isFinite(quote.regularMarketPrice))
        .map((quote) => [quote.symbol, quote])
    );
    elements.lastRefresh.textContent = new Date(payload.fetchedAt).toLocaleTimeString("en-IN");
  } catch (error) {
    elements.feedStatus.textContent = `Quote feed issue: ${error.message}`;
    elements.feedStatus.className = "pill negative";
  }

  screenStocks();
}

function resetPolling() {
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
  }
  const seconds = Number(elements.pollInterval.value);
  state.pollHandle = window.setInterval(fetchQuotes, seconds * 1000);
}

async function loadData() {
  const response = await fetch("./data/2026-bets.csv");
  const csvText = await response.text();
  const parsed = parseCsv(csvText);

  state.rows = parsed
    .map((row) => {
      const ticker = getPreferredTicker(row);
      return {
        name: row.Name,
        symbol: row["NSE Code"] || row["BSE Code"] || row.Name,
        ticker,
        exchange: row["NSE Code"] ? "NSE" : row["BSE Code"] ? "BSE" : "--",
        currentPrice: parseNumber(row["Current Price"]),
        dma50: parseNumber(row["DMA 50"]),
        dma200: parseNumber(row["DMA 200"]),
        freeCashFlow: parseNumber(row["Free cash flow last year"]),
        operatingCashFlow3y: parseNumber(row["Operating cash flow 3years"]),
        pe: parseNumber(row["Price to Earning"]),
        industryPe: parseNumber(row["Industry PE"]),
      };
    })
    .filter((row) => row.ticker);
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    elements.notifyButton.textContent = "Notifications unavailable";
    return;
  }
  const permission = await Notification.requestPermission();
  state.notificationsEnabled = permission === "granted";
  elements.notifyButton.textContent = state.notificationsEnabled
    ? "Notifications enabled"
    : "Notifications blocked";
}

function bindEvents() {
  elements.maxPe.addEventListener("input", () => {
    elements.maxPeValue.textContent = elements.maxPe.value;
    screenStocks();
  });

  [
    elements.minFcf,
    elements.minOcf,
    elements.requireIndustryPe,
    elements.showOnlyAlerts,
  ].forEach((element) => {
    element.addEventListener("input", screenStocks);
    element.addEventListener("change", screenStocks);
  });

  elements.pollInterval.addEventListener("change", () => {
    resetPolling();
    fetchQuotes();
  });

  elements.notifyButton.addEventListener("click", enableNotifications);
}

async function init() {
  bindEvents();
  await loadData();
  screenStocks();
  await fetchQuotes();
  resetPolling();
}

init().catch((error) => {
  elements.marketStatus.textContent = "Failed to load dashboard";
  elements.marketStatus.className = "pill negative";
  elements.feedStatus.textContent = error.message;
  elements.feedStatus.className = "pill negative";
  console.error(error);
});
