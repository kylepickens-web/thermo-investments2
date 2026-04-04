import { useState, useRef, useCallback, memo, useEffect } from "react";

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = process.env.REACT_APP_SUPA_URL;
const SUPA_KEY = process.env.REACT_APP_SUPA_KEY;

const supa = async (path, opts = {}) => {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer ?? "return=representation",
      ...opts.headers,
    },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const db = {
  get: (table, qs = "") => supa(`${table}?${qs}`),
  insert: (table, body) =>
    supa(`${table}`, { method: "POST", body: JSON.stringify(body) }),
  update: (table, qs, body) =>
    supa(`${table}?${qs}`, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (table, qs) =>
    supa(`${table}?${qs}`, { method: "DELETE", prefer: "" }),
};

const uploadFile = async (file, investmentId) => {
  const path = `${investmentId}/${Date.now()}_${file.name}`;
  const res = await fetch(
    `${SUPA_URL}/storage/v1/object/investment-files/${path}`,
    {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    }
  );
  if (!res.ok) throw new Error(await res.text());
  return path;
};

// ── Claude API ────────────────────────────────────────────────────────────────
const callClaude = async (systemPrompt, messages, maxTokens = 1000) => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  return data.content?.map((b) => b.text || "").join("") || "";
};

const extractCatalysts = async (noteText, investmentName) => {
  try {
    const reply = await callClaude("", [
      {
        role: "user",
        content: `You are an investment analyst. Analyze this note and extract catalysts, follow-ups, expected events, or deadlines.

Investment: ${investmentName}
Note: "${noteText}"

Return ONLY a JSON array (no markdown, no explanation):
[{"description":"clear description","date":"YYYY-MM-DD or null","dateLabel":"human readable hint or null","type":"catalyst|followup|deadline|event","status":"pending"}]

If none found, return: []`,
      },
    ]);
    return JSON.parse(reply.replace(/```json|```/g, "").trim());
  } catch {
    return [];
  }
};

// ── Market data ───────────────────────────────────────────────────────────────
const POLYGON_KEY = process.env.REACT_APP_POLYGON_KEY || "AngT3Bd_EsmLn67FSohWXMIgBpbIVBtx";

const fetchQuote = async (ticker) => {
  try {
    const res = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${POLYGON_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const r = data?.results?.[0];
    if (!r) return null;
    const price = r.c;
    const prev = r.o;
    const change = +(price - prev).toFixed(3);
    const pct = prev > 0 ? +((change / prev) * 100).toFixed(2) : 0;
    const vol = r.v ? (r.v / 1e6).toFixed(1) + "M" : "—";
    return {
      price: +price.toFixed(2),
      change,
      pct,
      mktCap: "—",
      pe: null,
      vol,
      source: "Polygon.io",
    };
  } catch {
    return null;
  }
};

const fetchAllQuotes = async (tickers) => {
  const results = [];
  for (const t of tickers) {
    const quote = await fetchQuote(t);
    results.push({ ticker: t, quote });
    if (tickers.length > 1) await new Promise((r) => setTimeout(r, 300));
  }
  return Object.fromEntries(results.map((r) => [r.ticker, r.quote]));
};

const fetchChartData = async (ticker) => {
  try {
    const to = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const res = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=365&apiKey=${POLYGON_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.results || null;
  } catch {
    return null;
  }
};

const fetchFundamentals = async (ticker) => {
  try {
    const refRes = await fetch(`https://api.polygon.io/v3/reference/tickers/${ticker}?apiKey=${POLYGON_KEY}`);
    await new Promise((r) => setTimeout(r, 300));
    const finRes = await fetch(`https://api.polygon.io/vX/reference/financials?ticker=${ticker}&timeframe=annual&limit=1&apiKey=${POLYGON_KEY}`);
    const refData = refRes.ok ? await refRes.json() : null;
    const finData = finRes.ok ? await finRes.json() : null;
    const r = refData?.results;
    const cap = r?.market_cap;
    const mktCap = cap
      ? cap >= 1e12
        ? (cap / 1e12).toFixed(2) + "T"
        : cap >= 1e9
        ? (cap / 1e9).toFixed(1) + "B"
        : (cap / 1e6).toFixed(0) + "M"
      : "—";
    const eps =
      finData?.results?.[0]?.financials?.income_statement
        ?.diluted_earnings_per_share?.value ?? null;
    return {
      mktCap,
      eps,
      employees: r?.total_employees ? r.total_employees.toLocaleString() : "—",
      description: r?.description || null,
    };
  } catch {
    return null;
  }
};

// ── Google Fonts ──────────────────────────────────────────────────────────────
const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href =
  "https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;700&display=swap";
document.head.appendChild(fontLink);

// ── Brand tokens ──────────────────────────────────────────────────────────────
const T = {
  black: "#0a0a0a",
  charcoal: "#1a1a1a",
  dark: "#222222",
  accent: "#c8a96e",
  light: "#f5f3ef",
  white: "#ffffff",
  green: "#4caf7d",
  red: "#e05252",
  blue: "#4a90d9",
  muted: "#888888",
};

const USERS = [
  { id: 1, name: "Kyle Pickens", role: "admin", initials: "KP" },
  { id: 2, name: "Jay Monroe", role: "analyst", initials: "JM" },
  { id: 3, name: "Tim Taylor", role: "analyst", initials: "TT" },
  { id: 4, name: "Christine Harkness", role: "analyst", initials: "CH" },
  { id: 5, name: "Jen Fyock", role: "analyst", initials: "JF" },
];

const FILE_ICONS = {
  pdf: "📄",
  xlsx: "📊",
  xls: "📊",
  csv: "📊",
  docx: "📝",
  doc: "📝",
  default: "📎",
};
const fileIcon = (n) =>
  FILE_ICONS[n.split(".").pop().toLowerCase()] || FILE_ICONS.default;

const fmt = (n) =>
  n == null
    ? "—"
    : "$" +
      (Math.abs(n) >= 1e9
        ? (n / 1e9).toFixed(2) + "B"
        : Math.abs(n) >= 1e6
        ? (n / 1e6).toFixed(1) + "M"
        : Number(n).toLocaleString());
const pct = (n) => (n == null ? "—" : Number(n).toFixed(1) + "%");
const clr = (n) => (n > 0 ? T.green : n < 0 ? T.red : T.muted);
const fmtN = (n) => (n == null ? "—" : Number(n).toLocaleString());
const num = (n) => Number(n) || 0;

// ── Shared UI ─────────────────────────────────────────────────────────────────
const Badge = ({ label, color }) => (
  <span
    style={{
      background: color + "22",
      color,
      border: `1px solid ${color}44`,
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 700,
      padding: "2px 8px",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    }}
  >
    {label}
  </span>
);
const TypeBadge = ({ type }) => {
  const m = {
    public: [T.blue, "PUBLIC"],
    private: [T.accent, "PRIVATE"],
    fund: [T.green, "FUND"],
    "10percent": ["#9b59b6", "10%"],
  };
  const [c, l] = m[type] || [T.muted, type];
  return <Badge label={l} color={c} />;
};
const Card = ({ children, style = {} }) => (
  <div
    style={{
      background: T.charcoal,
      border: "1px solid #333",
      borderRadius: 8,
      padding: "20px 24px",
      ...style,
    }}
  >
    {children}
  </div>
);
const PriceChart = memo(({ data }) => {
  if (!data || data.length < 2) return null;
  const prices = data.map((d) => d.c);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const W = 600, H = 100, PAD = 4;
  const pts = prices
    .map((p, i) => {
      const x = PAD + (i / (prices.length - 1)) * (W - PAD * 2);
      const y = PAD + (1 - (p - min) / range) * (H - PAD * 2);
      return `${x},${y}`;
    })
    .join(" ");
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? T.green : T.red;
  const firstPt = pts.split(" ")[0];
  const lastPt = pts.split(" ").slice(-1)[0];
  const firstX = firstPt.split(",")[0];
  const lastX = lastPt.split(",")[0];
  const fillPts = `${firstX},${H - PAD} ${pts} ${lastX},${H - PAD}`;
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: "block", marginTop: 12 }}
    >
      <defs>
        <linearGradient id={`cg_${isUp}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill={`url(#cg_${isUp})`} />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
});

const Stat = ({ label, value, color }) => (
  <div style={{ textAlign: "center" }}>
    <div
      style={{
        fontSize: 22,
        fontWeight: 700,
        color: color || T.accent,
        fontFamily: "Georgia,serif",
      }}
    >
      {value}
    </div>
    <div
      style={{
        fontSize: 11,
        color: T.muted,
        marginTop: 4,
        letterSpacing: 0.5,
        textTransform: "uppercase",
      }}
    >
      {label}
    </div>
  </div>
);
const Toast = ({ msg, type }) => (
  <div
    style={{
      position: "fixed",
      bottom: 24,
      right: 24,
      zIndex: 2000,
      background: type === "error" ? T.red : T.green,
      color: T.white,
      padding: "12px 20px",
      borderRadius: 8,
      fontSize: 13,
      fontWeight: 600,
      boxShadow: "0 4px 20px rgba(0,0,0,.4)",
    }}
  >
    {type === "error" ? "⚠ " : "✓ "}
    {msg}
  </div>
);

// ── Stable form fields ────────────────────────────────────────────────────────
const FieldInput = memo(
  ({
    label,
    value,
    onChange,
    type = "text",
    placeholder = "",
    highlight = false,
  }) => {
    const [focused, setFocused] = useState(false);
    return (
      <div style={{ marginBottom: 14 }}>
        <label
          style={{
            color: T.muted,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            display: "block",
            marginBottom: 4,
          }}
        >
          {label}
        </label>
        <input
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            width: "100%",
            background: highlight ? "#1a2a1a" : T.dark,
            color: highlight ? T.green : T.white,
            border: `1px solid ${
              focused ? T.accent : highlight ? "#4caf7d44" : "#444"
            }`,
            borderRadius: 6,
            padding: "9px 12px",
            fontSize: 13,
            boxSizing: "border-box",
            fontFamily: "inherit",
            outline: "none",
          }}
        />
      </div>
    );
  }
);
const FieldSelect = memo(({ label, value, onChange, children }) => (
  <div style={{ marginBottom: 14 }}>
    <label
      style={{
        color: T.muted,
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        display: "block",
        marginBottom: 4,
      }}
    >
      {label}
    </label>
    <select
      value={value}
      onChange={onChange}
      style={{
        width: "100%",
        background: T.dark,
        color: T.white,
        border: "1px solid #444",
        borderRadius: 6,
        padding: "9px 12px",
        fontSize: 13,
        outline: "none",
        fontFamily: "inherit",
      }}
    >
      {children}
    </select>
  </div>
));
const FieldTextarea = memo(({ label, value, onChange, placeholder = "" }) => {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          color: T.muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          display: "block",
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: "100%",
          background: T.dark,
          color: T.white,
          border: `1px solid ${focused ? T.accent : "#444"}`,
          borderRadius: 6,
          padding: "9px 12px",
          fontSize: 13,
          minHeight: 72,
          resize: "vertical",
          fontFamily: "inherit",
          boxSizing: "border-box",
          outline: "none",
        }}
      />
    </div>
  );
});

// ── Ticker DB ─────────────────────────────────────────────────────────────────
const TICKER_DB = {
  GSAT: { name: "Globalstar, Inc.", sector: "Satellite / Telecom" },
  AAPL: { name: "Apple Inc.", sector: "Technology" },
  MSFT: { name: "Microsoft Corporation", sector: "Technology" },
  TSLA: { name: "Tesla, Inc.", sector: "Automotive / Energy" },
  AMZN: { name: "Amazon.com, Inc.", sector: "E-Commerce / Cloud" },
  GOOGL: { name: "Alphabet Inc.", sector: "Technology" },
  META: { name: "Meta Platforms, Inc.", sector: "Technology" },
  JPM: { name: "JPMorgan Chase & Co.", sector: "Banking" },
  XOM: { name: "Exxon Mobil Corporation", sector: "Energy" },
  NEE: { name: "NextEra Energy, Inc.", sector: "Utilities / Energy" },
  BEP: { name: "Brookfield Renewable", sector: "Renewable Energy" },
  ENPH: { name: "Enphase Energy", sector: "Solar / Energy Tech" },
  VICI: { name: "VICI Properties", sector: "Real Estate / Gaming" },
  AMT: { name: "American Tower", sector: "Real Estate / Telecom" },
};

// ── Notes Section ─────────────────────────────────────────────────────────────
const NotesSection = memo(
  ({ invNotes, currentUser, onAdd, investmentName }) => {
    const [noteText, setNoteText] = useState("");
    const [noteType, setNoteType] = useState("update");
    const [saving, setSaving] = useState(false);

    const handleAdd = async () => {
      if (!noteText.trim()) return;
      setSaving(true);
      await onAdd(noteText.trim(), noteType);
      setNoteText("");
      setSaving(false);
    };

    return (
      <Card>
        <div
          style={{
            color: T.accent,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: "uppercase",
            marginBottom: 16,
          }}
        >
          Meeting Notes & Updates
        </div>
        {invNotes.map((n) => (
          <div
            key={n.id}
            style={{
              borderBottom: "1px solid #2a2a2a",
              paddingBottom: 14,
              marginBottom: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: T.accent,
                    color: T.black,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {n.author}
                </div>
                <Badge
                  label={n.type}
                  color={
                    n.type === "meeting"
                      ? T.blue
                      : n.type === "call"
                      ? T.green
                      : T.accent
                  }
                />
              </div>
              <span style={{ color: T.muted, fontSize: 11 }}>
                {n.created_at?.slice(0, 10)}
              </span>
            </div>
            <div
              style={{
                color: T.light,
                fontSize: 13,
                lineHeight: 1.75,
                paddingLeft: 36,
              }}
            >
              {n.text}
            </div>
          </div>
        ))}
        {invNotes.length === 0 && (
          <div style={{ color: T.muted, fontSize: 13, marginBottom: 16 }}>
            No notes yet.
          </div>
        )}
        {currentUser.role !== "viewer" && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              {["update", "meeting", "call", "other"].map((t) => (
                <button
                  key={t}
                  onClick={() => setNoteType(t)}
                  style={{
                    background: noteType === t ? T.accent : T.dark,
                    color: noteType === t ? T.black : T.muted,
                    border: `1px solid ${noteType === t ? T.accent : "#444"}`,
                    borderRadius: 4,
                    padding: "4px 14px",
                    cursor: "pointer",
                    fontSize: 11,
                    textTransform: "capitalize",
                    fontWeight: noteType === t ? 700 : 400,
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note, meeting summary, or update…"
              style={{
                width: "100%",
                background: T.dark,
                color: T.light,
                border: "1px solid #444",
                borderRadius: 6,
                padding: "10px 12px",
                fontSize: 13,
                resize: "vertical",
                minHeight: 88,
                fontFamily: "inherit",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
            <button
              onClick={handleAdd}
              disabled={saving || !noteText.trim()}
              style={{
                marginTop: 8,
                background: noteText.trim() ? T.accent : "#333",
                color: noteText.trim() ? T.black : T.muted,
                border: "none",
                borderRadius: 6,
                padding: "8px 24px",
                cursor: noteText.trim() ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 700,
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? "Saving…" : "Save Note"}
            </button>
          </div>
        )}
      </Card>
    );
  }
);

// ── Position Editor ───────────────────────────────────────────────────────────
const PositionEditor = memo(({ selected, currentUser, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [units, setUnits] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);

  const open = () => {
    setUnits(selected.units ? String(selected.units) : "");
    setPrice(selected.price_per_unit ? String(selected.price_per_unit) : "");
    setEditing(true);
  };
  const implied =
    units && price ? Math.round(Number(units) * Number(price)) : null;
  const unitsLabel =
    selected.type === "fund"
      ? "Units / LP Interest"
      : selected.type === "private"
      ? "Shares / Units"
      : "# of Shares";
  const priceLabel =
    selected.type === "fund"
      ? "Price Per Unit ($)"
      : selected.type === "public"
      ? "Price Per Share ($)"
      : "Price Per Share / Bond ($)";

  const handleSave = async () => {
    if (!units || !price) return;
    setSaving(true);
    await onSave(Number(units), Number(price));
    setSaving(false);
    setEditing(false);
  };

  return (
    <>
      <Card style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              color: T.accent,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
            }}
          >
            Position Detail
          </div>
          {currentUser.role !== "viewer" && (
            <button
              onClick={open}
              style={{
                background: T.accent + "22",
                color: T.accent,
                border: `1px solid ${T.accent}44`,
                borderRadius: 6,
                padding: "5px 14px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              ✏ Edit Position
            </button>
          )}
        </div>
        {selected.units || selected.price_per_unit ? (
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
            {selected.units && (
              <div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: T.light,
                    fontFamily: "Georgia,serif",
                  }}
                >
                  {fmtN(selected.units)}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginTop: 2,
                  }}
                >
                  {selected.type === "fund" ? "Units" : "Shares / Units"}
                </div>
              </div>
            )}
            {selected.price_per_unit && (
              <div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: T.light,
                    fontFamily: "Georgia,serif",
                  }}
                >
                  {fmt(selected.price_per_unit)}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginTop: 2,
                  }}
                >
                  Avg. Cost Per {selected.type === "fund" ? "Unit" : "Share"}
                </div>
              </div>
            )}
            {selected.units && selected.price_per_unit && (
              <div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: T.accent,
                    fontFamily: "Georgia,serif",
                  }}
                >
                  {fmt(Math.round(selected.units * selected.price_per_unit))}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginTop: 2,
                  }}
                >
                  Total Cost Basis
                </div>
              </div>
            )}
            {selected.bloombergData && selected.units && (
              <div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    fontFamily: "Georgia,serif",
                    color:
                      selected.bloombergData.price >= selected.price_per_unit
                        ? T.green
                        : T.red,
                  }}
                >
                  {fmt(
                    Math.round(selected.units * selected.bloombergData.price)
                  )}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginTop: 2,
                  }}
                >
                  Market Value
                </div>
              </div>
            )}
            {selected.bloombergData &&
              selected.units &&
              selected.price_per_unit && (
                <div>
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 700,
                      fontFamily: "Georgia,serif",
                      color:
                        selected.bloombergData.price >= selected.price_per_unit
                          ? T.green
                          : T.red,
                    }}
                  >
                    {fmt(
                      Math.round(
                        (selected.bloombergData.price -
                          selected.price_per_unit) *
                          selected.units
                      )
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: T.muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      marginTop: 2,
                    }}
                  >
                    Unrealized G/L
                  </div>
                </div>
              )}
          </div>
        ) : (
          <div style={{ color: T.muted, fontSize: 13 }}>
            No position data yet. Click Edit Position to add.
          </div>
        )}
      </Card>
      {editing && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.82)",
            zIndex: 999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditing(false);
          }}
        >
          <div
            style={{
              background: T.charcoal,
              border: "1px solid #333",
              borderRadius: 8,
              width: 460,
              padding: 32,
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 22,
              }}
            >
              <span
                style={{
                  color: T.white,
                  fontSize: 18,
                  fontFamily: "Georgia,serif",
                }}
              >
                Edit Position — {selected.name}
              </span>
              <button
                onClick={() => setEditing(false)}
                style={{
                  background: "none",
                  color: T.muted,
                  border: "none",
                  fontSize: 22,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
            <FieldInput
              label={unitsLabel}
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              type="number"
              placeholder="e.g. 500000"
            />
            <FieldInput
              label={priceLabel}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              type="number"
              placeholder="e.g. 2.50"
            />
            {implied !== null && (
              <div
                style={{
                  background: T.dark,
                  border: "1px solid #333",
                  borderRadius: 6,
                  padding: "12px 16px",
                  marginBottom: 16,
                  display: "flex",
                  gap: 24,
                }}
              >
                <div>
                  <div
                    style={{
                      color: T.muted,
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Total Cost Basis
                  </div>
                  <div
                    style={{ color: T.accent, fontSize: 16, fontWeight: 700 }}
                  >
                    {fmt(implied)}
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      color: T.muted,
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Committed (will update)
                  </div>
                  <div
                    style={{ color: T.green, fontSize: 16, fontWeight: 700 }}
                  >
                    {fmt(implied)}
                  </div>
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={handleSave}
                disabled={!units || !price || saving}
                style={{
                  flex: 1,
                  background: units && price ? T.accent : "#333",
                  color: units && price ? T.black : T.muted,
                  border: "none",
                  borderRadius: 6,
                  padding: "11px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: units && price ? "pointer" : "not-allowed",
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? "Saving…" : "Save Position"}
              </button>
              <button
                onClick={() => setEditing(false)}
                style={{
                  flex: 1,
                  background: "transparent",
                  color: T.muted,
                  border: "1px solid #444",
                  borderRadius: 6,
                  padding: "11px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

// ── Edit Investment Modal ─────────────────────────────────────────────────────
const EditInvestmentModal = memo(({ investment, onSave, onClose }) => {
  const [form, setForm] = useState({
    name: investment.name || "",
    ticker: investment.ticker || "",
    sector: investment.sector || "",
    type: investment.type || "private",
    vintage: investment.vintage || "",
    irr: investment.irr || "",
    moic: investment.moic || "",
    description: investment.description || "",
    warrants: investment.warrants || "",
    strikePrice: investment.strike_price || "",
  });
  const [saving, setSaving] = useState(false);
  const set = useCallback((k, v) => setForm((p) => ({ ...p, [k]: v })), []);
  const handleSave = async () => {
    if (!form.name || !form.sector) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.82)",
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: T.charcoal,
          border: "1px solid #333",
          borderRadius: 8,
          width: 540,
          padding: 32,
          maxHeight: "92vh",
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 22,
          }}
        >
          <span
            style={{
              color: T.white,
              fontSize: 18,
              fontFamily: "Georgia,serif",
            }}
          >
            Edit Investment
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              color: T.muted,
              border: "none",
              fontSize: 22,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
        <FieldInput
          label="Investment Name *"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
        />
        <FieldSelect
          label="Type *"
          value={form.type}
          onChange={(e) => set("type", e.target.value)}
        >
          <option value="public">Public Equity</option>
          <option value="private">Private Investment</option>
          <option value="fund">Fund</option>
          <option value="10percent">10%</option>
        </FieldSelect>
        {form.type === "public" && (
          <FieldInput
            label="Ticker Symbol"
            value={form.ticker}
            onChange={(e) => set("ticker", e.target.value.toUpperCase())}
            placeholder="e.g. AAPL"
          />
        )}
        <FieldInput
          label="Sector *"
          value={form.sector}
          onChange={(e) => set("sector", e.target.value)}
        />
        <FieldInput
          label="Vintage Year"
          value={form.vintage}
          onChange={(e) => set("vintage", e.target.value)}
          type="number"
        />
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <FieldInput
            label="Net IRR (%)"
            value={form.irr}
            onChange={(e) => set("irr", e.target.value)}
            type="number"
            placeholder="e.g. 14.5"
          />
          <FieldInput
            label="MOIC (x)"
            value={form.moic}
            onChange={(e) => set("moic", e.target.value)}
            type="number"
            placeholder="e.g. 2.1"
          />
        </div>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <FieldInput
            label="Warrants"
            value={form.warrants}
            onChange={(e) => set("warrants", e.target.value)}
            type="number"
            placeholder="# of warrants"
          />
          <FieldInput
            label="Strike Price ($)"
            value={form.strikePrice}
            onChange={(e) => set("strikePrice", e.target.value)}
            type="number"
            placeholder="e.g. 12.50"
          />
        </div>
        <FieldTextarea
          label="Description"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleSave}
            disabled={!form.name || !form.sector || saving}
            style={{
              flex: 1,
              background: form.name && form.sector ? T.accent : "#333",
              color: form.name && form.sector ? T.black : T.muted,
              border: "none",
              borderRadius: 6,
              padding: "11px",
              fontSize: 13,
              fontWeight: 700,
              cursor: form.name && form.sector ? "pointer" : "not-allowed",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              background: "transparent",
              color: T.muted,
              border: "1px solid #444",
              borderRadius: 6,
              padding: "11px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
});

// ── Add Investment Modal ──────────────────────────────────────────────────────
const BLANK = {
  name: "",
  ticker: "",
  type: "public",
  sector: "",
  committed: "",
  vintage: "",
  description: "",
  units: "",
  pricePerUnit: "",
  warrants: "",
  strikePrice: "",
};
const AddInvestmentModal = memo(({ onSave, onClose }) => {
  const [form, setForm] = useState(BLANK);
  const [tickerStatus, setTickerStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const tickerTimer = useRef(null);
  const set = useCallback((k, v) => setForm((p) => ({ ...p, [k]: v })), []);

  const handleTicker = useCallback(
    (e) => {
      const v = e.target.value.toUpperCase();
      set("ticker", v);
      if (form.type !== "public") return;
      setTickerStatus("loading");
      clearTimeout(tickerTimer.current);
      tickerTimer.current = setTimeout(() => {
        const hit = TICKER_DB[v];
        if (hit) {
          setForm((p) => ({ ...p, name: hit.name, sector: hit.sector }));
          setTickerStatus("found");
        } else setTickerStatus(v.length > 0 ? "notfound" : null);
      }, 600);
    },
    [form.type, set]
  );

  const implied =
    form.units && form.pricePerUnit
      ? Math.round(Number(form.units) * Number(form.pricePerUnit))
      : null;
  const unitLabel =
    form.type === "fund"
      ? "Units / LP Interest"
      : form.type === "private"
      ? "Shares / Units"
      : "# of Shares";
  const priceLabel =
    form.type === "fund"
      ? "Price Per Unit ($)"
      : form.type === "public"
      ? "Price Paid Per Share ($)"
      : "Price Paid Per Share / Bond ($)";

  const handleSave = async () => {
    if (!form.name || !form.sector) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.82)",
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: T.charcoal,
          border: "1px solid #333",
          borderRadius: 8,
          width: 540,
          padding: 32,
          maxHeight: "92vh",
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 22,
          }}
        >
          <span
            style={{
              color: T.white,
              fontSize: 18,
              fontFamily: "Georgia,serif",
            }}
          >
            Add Investment
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              color: T.muted,
              border: "none",
              fontSize: 22,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
        <FieldSelect
          label="Type *"
          value={form.type}
          onChange={(e) => {
            set("type", e.target.value);
            setTickerStatus(null);
          }}
        >
          <option value="public">Public Equity</option>
          <option value="private">Private Investment</option>
          <option value="fund">Fund</option>
          <option value="10percent">10%</option>
        </FieldSelect>
        {form.type === "public" && (
          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                color: T.muted,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                display: "block",
                marginBottom: 4,
              }}
            >
              Ticker Symbol
            </label>
            <div style={{ position: "relative" }}>
              <input
                value={form.ticker}
                onChange={handleTicker}
                placeholder="e.g. AAPL"
                style={{
                  width: "100%",
                  background: T.dark,
                  color: T.white,
                  border: `1px solid ${
                    tickerStatus === "found" ? T.green : "#444"
                  }`,
                  borderRadius: 6,
                  padding: "9px 40px 9px 12px",
                  fontSize: 13,
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  outline: "none",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                }}
              >
                {tickerStatus === "loading" && (
                  <span style={{ color: T.muted }}>⟳</span>
                )}
                {tickerStatus === "found" && (
                  <span style={{ color: T.green }}>✓</span>
                )}
                {tickerStatus === "notfound" && (
                  <span style={{ color: T.muted, fontSize: 11 }}>?</span>
                )}
              </span>
            </div>
            {tickerStatus === "found" && (
              <div style={{ color: T.green, fontSize: 11, marginTop: 4 }}>
                ✓ Auto-filled from ticker
              </div>
            )}
          </div>
        )}
        <FieldInput
          label="Company / Fund Name *"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          highlight={tickerStatus === "found"}
        />
        <FieldInput
          label="Sector *"
          value={form.sector}
          onChange={(e) => set("sector", e.target.value)}
          highlight={tickerStatus === "found"}
        />
        <FieldInput
          label="Committed Capital ($)"
          value={form.committed}
          onChange={(e) => set("committed", e.target.value)}
          type="number"
          placeholder="e.g. 25000000"
        />
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <FieldInput
            label={unitLabel}
            value={form.units}
            onChange={(e) => set("units", e.target.value)}
            type="number"
            placeholder="e.g. 500000"
          />
          <FieldInput
            label={priceLabel}
            value={form.pricePerUnit}
            onChange={(e) => set("pricePerUnit", e.target.value)}
            type="number"
            placeholder="e.g. 2.50"
          />
        </div>
        {implied !== null && (
          <div
            style={{
              background: T.dark,
              border: "1px solid #333",
              borderRadius: 6,
              padding: "10px 14px",
              marginBottom: 14,
              marginTop: -6,
              display: "flex",
              gap: 20,
            }}
          >
            <div>
              <div
                style={{
                  color: T.muted,
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Implied Cost Basis
              </div>
              <div style={{ color: T.accent, fontSize: 15, fontWeight: 700 }}>
                {fmt(implied)}
              </div>
            </div>
            {form.committed && Number(form.committed) > 0 && (
              <div>
                <div
                  style={{
                    color: T.muted,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  vs. Committed
                </div>
                <div style={{ color: T.muted, fontSize: 15, fontWeight: 700 }}>
                  {fmt(Number(form.committed))}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => set("committed", String(implied))}
              style={{
                background: T.accent,
                color: T.black,
                border: "none",
                borderRadius: 6,
                padding: "6px 14px",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                whiteSpace: "nowrap",
                marginLeft: "auto",
              }}
            >
              Apply to Committed
            </button>
          </div>
        )}
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <FieldInput
            label="Warrants"
            value={form.warrants}
            onChange={(e) => set("warrants", e.target.value)}
            type="number"
            placeholder="# of warrants"
          />
          <FieldInput
            label="Strike Price ($)"
            value={form.strikePrice}
            onChange={(e) => set("strikePrice", e.target.value)}
            type="number"
            placeholder="e.g. 12.50"
          />
        </div>
        <FieldInput
          label="Vintage Year"
          value={form.vintage}
          onChange={(e) => set("vintage", e.target.value)}
          type="number"
          placeholder={String(new Date().getFullYear())}
        />
        <FieldTextarea
          label="Description"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Brief description of the investment…"
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleSave}
            disabled={!form.name || !form.sector || saving}
            style={{
              flex: 1,
              background: form.name && form.sector ? T.accent : "#333",
              color: form.name && form.sector ? T.black : T.muted,
              border: "none",
              borderRadius: 6,
              padding: "11px",
              fontSize: 13,
              fontWeight: 700,
              cursor: form.name && form.sector ? "pointer" : "not-allowed",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "Saving…" : "Save Investment"}
          </button>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              background: "transparent",
              color: T.muted,
              border: "1px solid #444",
              borderRadius: 6,
              padding: "11px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
});

// ── Bloomberg Modal ───────────────────────────────────────────────────────────
const BBModal = memo(({ onClose }) => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,.8)",
      zIndex: 1000,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
    onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div
      style={{
        background: T.charcoal,
        border: "1px solid #333",
        borderRadius: 8,
        width: 560,
        padding: 32,
        maxHeight: "80vh",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <span
          style={{ color: T.white, fontSize: 18, fontFamily: "Georgia,serif" }}
        >
          Bloomberg Integration
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            color: T.muted,
            border: "none",
            fontSize: 22,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>
      {[
        [
          "Bloomberg B-PIPE / Server API",
          "Recommended for firm-wide deployment. Requires a Bloomberg Data License and server-side proxy. Supports real-time streaming, historical data, and corporate actions.",
        ],
        [
          "Bloomberg PORT API",
          "Ideal if your team already uses PORT for portfolio analytics.",
        ],
        [
          "Bloomberg Open API (Desktop)",
          "Free with an active Bloomberg Terminal subscription.",
        ],
      ].map(([t, d]) => (
        <div
          key={t}
          style={{
            background: T.dark,
            border: "1px solid #333",
            borderRadius: 8,
            padding: "16px 18px",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              color: T.accent,
              fontWeight: 700,
              fontSize: 13,
              marginBottom: 6,
            }}
          >
            {t}
          </div>
          <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.7 }}>
            {d}
          </div>
        </div>
      ))}
      <div
        style={{
          background: "#1a1a2e",
          border: "1px solid #4a90d933",
          borderRadius: 8,
          padding: "14px 18px",
          marginTop: 8,
        }}
      >
        <div
          style={{
            color: T.blue,
            fontSize: 12,
            fontWeight: 700,
            marginBottom: 6,
          }}
        >
          Current Status
        </div>
        <div style={{ color: T.muted, fontSize: 12 }}>
          Running on Polygon.io live data.
        </div>
      </div>
    </div>
  </div>
));

// ── Capital Allocation Framework ──────────────────────────────────────────────
const MACRO_FACTORS = [
  { id: "rates", label: "Rising rates" },
  { id: "recession", label: "US recession" },
  { id: "inflation", label: "Persistent inflation" },
  { id: "geopolitical", label: "Geopolitical shock" },
  { id: "usd", label: "Strong USD" },
  { id: "regulation", label: "Regulation" },
  { id: "commodities", label: "Commodity collapse" },
  { id: "techselloff", label: "Tech selloff" },
];
const SENS_COLORS = {
  "-2": "#e05252",
  "-1": "#D85A30",
  0: "#888888",
  1: "#4caf7d",
  2: "#0F6E56",
};
const SENS_LABELS = { "-2": "−−", "-1": "−", 0: "—", 1: "+", 2: "++" };
const defaultFramework = () => ({
  expectedReturn: "",
  timeHorizon: "",
  conviction: 5,
  downside: "",
  whatMustBeTrue: "",
  catalysts: "",
  exitCondition: "",
  notes: "",
  macro: Object.fromEntries(MACRO_FACTORS.map((f) => [f.id, "0"])),
});
const convictionColor = (v) =>
  v >= 8 ? T.green : v >= 6 ? T.blue : v >= 4 ? "#BA7517" : T.red;

const FrameworkTab = memo(({ investments, currentUser }) => {
  const [fwTab, setFwTab] = useState(0);
  const [selectedId, setSelId] = useState(null);
  const [scores, setScores] = useState({});
  const [saving, setSaving] = useState(false);
  const [loadingFw, setLoadingFw] = useState(true);

  useEffect(() => {
    (async () => {
      setLoadingFw(true);
      try {
        const rows = await db.get("framework_scores", "");
        const map = {};
        (rows || []).forEach((r) => {
          try {
            r.macro =
              typeof r.macro === "string" ? JSON.parse(r.macro) : r.macro;
          } catch {}
          map[r.investment_id] = r;
        });
        setScores(map);
      } catch {}
      setLoadingFw(false);
    })();
  }, []);

  useEffect(() => {
    if (investments.length > 0 && !selectedId) setSelId(investments[0].id);
  }, [investments, selectedId]);

  const sc = selectedId
    ? scores[selectedId] || defaultFramework()
    : defaultFramework();
  const inv = investments.find((i) => i.id === selectedId);
  const update = (field, val) =>
    setScores((p) => ({
      ...p,
      [selectedId]: { ...(p[selectedId] || defaultFramework()), [field]: val },
    }));
  const portfolioAvg = (fid) => {
    const vals = investments.map((i) =>
      parseInt(scores[i.id]?.macro?.[fid] || "0")
    );
    return (vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1)).toFixed(
      1
    );
  };

  const saveScores = async () => {
    if (!selectedId) return;
    setSaving(true);
    const s = scores[selectedId] || defaultFramework();
    const row = {
      investment_id: selectedId,
      expected_return: s.expectedReturn || null,
      time_horizon: s.timeHorizon || null,
      conviction: s.conviction || 5,
      downside: s.downside || null,
      what_must_be_true: s.whatMustBeTrue || null,
      catalysts: s.catalysts || null,
      exit_condition: s.exitCondition || null,
      notes: s.notes || null,
      macro: JSON.stringify(s.macro || {}),
    };
    try {
      await db
        .delete("framework_scores", `investment_id=eq.${selectedId}`)
        .catch(() => {});
      await db.insert("framework_scores", row);
    } catch {}
    setSaving(false);
  };

  const inputSt = {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    border: "1px solid #333",
    borderRadius: 6,
    background: T.dark,
    color: T.white,
    boxSizing: "border-box",
    fontFamily: "inherit",
    outline: "none",
  };
  const labelSt = {
    fontSize: 11,
    color: T.muted,
    marginBottom: 4,
    display: "block",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
  const FW_TABS = ["Scorecard", "Macro & Correlation", "Summary"];

  if (loadingFw)
    return (
      <div style={{ padding: 40, color: T.muted, fontSize: 13 }}>
        Loading framework…
      </div>
    );

  return (
    <div
      style={{
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "16px 32px 0",
          borderBottom: "1px solid #2a2a2a",
          display: "flex",
          gap: 8,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          {FW_TABS.map((t, i) => (
            <button
              key={t}
              onClick={() => setFwTab(i)}
              style={{
                background: fwTab === i ? T.accent + "22" : "transparent",
                color: fwTab === i ? T.accent : T.muted,
                border: `1px solid ${
                  fwTab === i ? T.accent + "44" : "transparent"
                }`,
                borderRadius: 6,
                padding: "6px 16px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: fwTab === i ? 600 : 400,
              }}
            >
              {t}
            </button>
          ))}
        </div>
        {currentUser.role !== "viewer" && (
          <button
            onClick={saveScores}
            disabled={saving}
            style={{
              background: T.accent,
              color: T.black,
              border: "none",
              borderRadius: 6,
              padding: "6px 18px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "Saving…" : "Save Scores"}
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 32 }}>
        {fwTab === 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "240px 1fr",
              gap: 20,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  color: T.muted,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  marginBottom: 4,
                }}
              >
                Investments
              </div>
              {investments.map((i) => {
                const s = scores[i.id];
                return (
                  <button
                    key={i.id}
                    onClick={() => setSelId(i.id)}
                    style={{
                      textAlign: "left",
                      padding: "10px 14px",
                      borderRadius: 8,
                      cursor: "pointer",
                      border: `1px solid ${
                        i.id === selectedId ? T.accent : "#333"
                      }`,
                      background:
                        i.id === selectedId ? T.accent + "18" : T.charcoal,
                      color: i.id === selectedId ? T.accent : T.light,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {i.name}
                    </div>
                    <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>
                      {i.type} · {i.sector}
                    </div>
                    {s?.conviction && (
                      <div style={{ marginTop: 4 }}>
                        <span
                          style={{
                            fontSize: 10,
                            background: convictionColor(s.conviction),
                            color: T.white,
                            borderRadius: 4,
                            padding: "1px 6px",
                            fontWeight: 600,
                          }}
                        >
                          {s.conviction}/10
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {inv ? (
              <Card>
                <div style={{ marginBottom: 20 }}>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color: T.white,
                      fontFamily: "Georgia,serif",
                    }}
                  >
                    {inv.name}
                  </div>
                  <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
                    {inv.sector} · {inv.type}
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                    marginBottom: 14,
                  }}
                >
                  <div>
                    <label style={labelSt}>Expected Annual Return (%)</label>
                    <input
                      style={inputSt}
                      placeholder="e.g. 15%"
                      value={sc.expectedReturn || ""}
                      onChange={(e) => update("expectedReturn", e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={labelSt}>Time Horizon</label>
                    <input
                      style={inputSt}
                      placeholder="e.g. 3–5 years"
                      value={sc.timeHorizon || ""}
                      onChange={(e) => update("timeHorizon", e.target.value)}
                    />
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelSt}>
                    Conviction — {sc.conviction || 5}/10
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={sc.conviction || 5}
                    onChange={(e) =>
                      update("conviction", parseInt(e.target.value))
                    }
                    style={{
                      width: "100%",
                      accentColor: convictionColor(sc.conviction || 5),
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 10,
                      color: T.muted,
                      marginTop: 2,
                    }}
                  >
                    <span>Low</span>
                    <span
                      style={{
                        color: convictionColor(sc.conviction || 5),
                        fontWeight: 600,
                      }}
                    >
                      {(sc.conviction || 5) >= 8
                        ? "High conviction"
                        : (sc.conviction || 5) >= 6
                        ? "Moderate-high"
                        : (sc.conviction || 5) >= 4
                        ? "Moderate"
                        : "Low conviction"}
                    </span>
                    <span>High</span>
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelSt}>Downside Scenario</label>
                  <input
                    style={inputSt}
                    placeholder="What does -30% or worse look like?"
                    value={sc.downside || ""}
                    onChange={(e) => update("downside", e.target.value)}
                  />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelSt}>What Has to Be True?</label>
                  <textarea
                    style={{ ...inputSt, minHeight: 64, resize: "vertical" }}
                    value={sc.whatMustBeTrue || ""}
                    onChange={(e) => update("whatMustBeTrue", e.target.value)}
                    placeholder="Key assumptions…"
                  />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelSt}>Catalysts</label>
                  <input
                    style={inputSt}
                    placeholder="What unlocks the value?"
                    value={sc.catalysts || ""}
                    onChange={(e) => update("catalysts", e.target.value)}
                  />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelSt}>Exit / Trim Condition</label>
                  <input
                    style={inputSt}
                    placeholder="What would make you sell?"
                    value={sc.exitCondition || ""}
                    onChange={(e) => update("exitCondition", e.target.value)}
                  />
                </div>
                <div>
                  <label style={labelSt}>Notes</label>
                  <textarea
                    style={{ ...inputSt, minHeight: 56, resize: "vertical" }}
                    value={sc.notes || ""}
                    onChange={(e) => update("notes", e.target.value)}
                    placeholder="Any other context…"
                  />
                </div>
              </Card>
            ) : (
              <div
                style={{
                  color: T.muted,
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                Select an investment
              </div>
            )}
          </div>
        )}
        {fwTab === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Card>
              <div
                style={{
                  color: T.accent,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  marginBottom: 4,
                }}
              >
                Macro Sensitivity Matrix
              </div>
              <div style={{ color: T.muted, fontSize: 12, marginBottom: 16 }}>
                Rate each position's sensitivity to macro scenarios.
              </div>
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 11,
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "6px 8px",
                          color: T.muted,
                          fontWeight: 500,
                          minWidth: 140,
                        }}
                      >
                        Position
                      </th>
                      {MACRO_FACTORS.map((f) => (
                        <th
                          key={f.id}
                          style={{
                            padding: "6px 4px",
                            color: T.muted,
                            fontWeight: 500,
                            fontSize: 10,
                            textAlign: "center",
                            minWidth: 70,
                          }}
                        >
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {investments.map((inv, pi) => (
                      <tr
                        key={inv.id}
                        style={{
                          background: pi % 2 === 0 ? T.dark : "transparent",
                        }}
                      >
                        <td
                          style={{
                            padding: "6px 8px",
                            fontSize: 11,
                            color: T.light,
                            fontWeight: 500,
                          }}
                        >
                          {inv.name.split(" ").slice(0, 2).join(" ")}
                        </td>
                        {MACRO_FACTORS.map((f) => {
                          const val = scores[inv.id]?.macro?.[f.id] || "0";
                          return (
                            <td
                              key={f.id}
                              style={{ padding: "4px", textAlign: "center" }}
                            >
                              <select
                                value={val}
                                onChange={(e) =>
                                  setScores((p) => ({
                                    ...p,
                                    [inv.id]: {
                                      ...(p[inv.id] || defaultFramework()),
                                      macro: {
                                        ...(p[inv.id] || defaultFramework())
                                          .macro,
                                        [f.id]: e.target.value,
                                      },
                                    },
                                  }))
                                }
                                style={{
                                  fontSize: 11,
                                  padding: "3px 4px",
                                  borderRadius: 4,
                                  cursor: "pointer",
                                  border: `1px solid ${SENS_COLORS[val]}`,
                                  background: "transparent",
                                  color: SENS_COLORS[val],
                                  fontWeight: 700,
                                  width: 44,
                                }}
                              >
                                {Object.entries(SENS_LABELS).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </select>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr style={{ borderTop: `2px solid ${T.accent}` }}>
                      <td
                        style={{
                          padding: "6px 8px",
                          fontSize: 11,
                          color: T.accent,
                          fontWeight: 700,
                        }}
                      >
                        Portfolio avg
                      </td>
                      {MACRO_FACTORS.map((f) => {
                        const avg = parseFloat(portfolioAvg(f.id));
                        const col =
                          avg > 0.3
                            ? SENS_COLORS["1"]
                            : avg < -0.3
                            ? SENS_COLORS["-1"]
                            : SENS_COLORS["0"];
                        return (
                          <td
                            key={f.id}
                            style={{
                              padding: "6px 4px",
                              textAlign: "center",
                              color: col,
                              fontWeight: 700,
                              fontSize: 11,
                            }}
                          >
                            {avg > 0 ? "+" : ""}
                            {avg}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                {Object.entries(SENS_COLORS).map(([k, c]) => (
                  <span
                    key={k}
                    style={{ color: c, fontSize: 11, fontWeight: 600 }}
                  >
                    {SENS_LABELS[k]}{" "}
                    {k === "-2"
                      ? "Very negative"
                      : k === "-1"
                      ? "Negative"
                      : k === "0"
                      ? "Neutral"
                      : k === "1"
                      ? "Positive"
                      : "Very positive"}
                  </span>
                ))}
              </div>
            </Card>
            <Card>
              <div
                style={{
                  color: T.accent,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  marginBottom: 14,
                }}
              >
                Portfolio Concentration Risk
              </div>
              {[
                {
                  sector: "Telecom Infrastructure",
                  positions: [
                    "Lumen Technologies",
                    "American Innovation Network",
                  ],
                  note: "Correlated — both sensitive to rates and capex cycles",
                },
                {
                  sector: "Energy",
                  positions: ["Kinder Morgan", "Private Oil Company"],
                  note: "Correlated — commodity price and rate sensitive",
                },
                {
                  sector: "Technology",
                  positions: ["Amazon", "Quantum Corp"],
                  note: "Partial correlation — Amazon more diversified",
                },
                {
                  sector: "Metals / Hard Assets",
                  positions: ["Gold Reserve"],
                  note: "Natural hedge — tends to be inversely correlated with tech",
                },
                {
                  sector: "Diversified Private",
                  positions: ["Western Investments"],
                  note: "Depends on underlying — assess separately",
                },
              ].map((s) => (
                <div
                  key={s.sector}
                  style={{
                    marginBottom: 14,
                    paddingBottom: 14,
                    borderBottom: "1px solid #2a2a2a",
                  }}
                >
                  <div
                    style={{ fontWeight: 600, fontSize: 13, color: T.white }}
                  >
                    {s.sector}
                  </div>
                  <div
                    style={{ fontSize: 12, color: T.accent, margin: "3px 0" }}
                  >
                    {s.positions.join(" · ")}
                  </div>
                  <div style={{ fontSize: 12, color: T.muted }}>{s.note}</div>
                </div>
              ))}
            </Card>
          </div>
        )}
        {fwTab === 2 && (
          <Card>
            <div
              style={{
                color: T.accent,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
                marginBottom: 20,
              }}
            >
              Portfolio Scorecard Summary
            </div>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr style={{ borderBottom: `1px solid #333` }}>
                    {[
                      "Position",
                      "Exp. Return",
                      "Horizon",
                      "Conviction",
                      "Catalysts",
                      "Exit Condition",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "8px",
                          color: T.muted,
                          fontWeight: 500,
                          fontSize: 11,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {investments.map((inv, i) => {
                    const s = scores[inv.id] || defaultFramework();
                    return (
                      <tr
                        key={inv.id}
                        style={{
                          borderBottom: "1px solid #2a2a2a",
                          background: i % 2 === 0 ? T.dark : "transparent",
                        }}
                      >
                        <td
                          style={{
                            padding: "10px 8px",
                            fontWeight: 600,
                            color: T.white,
                          }}
                        >
                          {inv.name}
                        </td>
                        <td
                          style={{
                            padding: "10px 8px",
                            color: s.expectedReturn ? T.green : T.muted,
                          }}
                        >
                          {s.expectedReturn || "—"}
                        </td>
                        <td style={{ padding: "10px 8px", color: T.light }}>
                          {s.timeHorizon || "—"}
                        </td>
                        <td style={{ padding: "10px 8px" }}>
                          <span
                            style={{
                              color: T.white,
                              background: convictionColor(s.conviction || 5),
                              borderRadius: 4,
                              padding: "2px 8px",
                              fontSize: 11,
                              fontWeight: 700,
                            }}
                          >
                            {s.conviction || 5}/10
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "10px 8px",
                            color: T.muted,
                            fontSize: 11,
                            maxWidth: 160,
                          }}
                        >
                          {s.catalysts || "—"}
                        </td>
                        <td
                          style={{
                            padding: "10px 8px",
                            color: T.muted,
                            fontSize: 11,
                            maxWidth: 160,
                          }}
                        >
                          {s.exitCondition || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div
              style={{
                marginTop: 20,
                padding: "14px 18px",
                background: "#1a1a2e",
                border: `1px solid ${T.blue}33`,
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  color: T.blue,
                  fontSize: 11,
                  fontWeight: 700,
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Competition for Capital
              </div>
              <div style={{ color: T.muted, fontSize: 13, lineHeight: 1.7 }}>
                Any position with conviction below 6 should be pressure-tested
                against the highest-conviction idea in the portfolio. If it
                can't win that comparison, it shouldn't be held.
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
});

// ── Claude AI Assistant ───────────────────────────────────────────────────────
const ClaudeAssistant = memo(({ investments, notes, files, currentUser }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selInvId, setSelInvId] = useState(null);
  const bottomRef = useRef();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const buildContext = useCallback(() => {
    const invList = investments.map((inv) => {
      const invNotes = notes.filter((n) => n.investment_id === inv.id);
      const invFiles = files.filter((f) => f.investment_id === inv.id);
      return `INVESTMENT: ${inv.name} (${inv.ticker || "private"})
Type: ${inv.type} | Sector: ${inv.sector} | Vintage: ${inv.vintage}
Committed: ${fmt(inv.committed)} | NAV: ${fmt(inv.nav)} | IRR: ${
        inv.irr || 0
      }% | MOIC: ${inv.moic || 1}x
Description: ${inv.description || "None"}
Files: ${invFiles.length > 0 ? invFiles.map((f) => f.name).join(", ") : "None"}
Notes (${invNotes.length}):
${
  invNotes.length > 0
    ? invNotes
        .map(
          (n) =>
            `  [${
              n.created_at?.slice(0, 10) || "—"
            }] [${n.type?.toUpperCase()}] ${n.author}: ${n.text}`
        )
        .join("\n")
    : "  No notes yet."
}`;
    });
    const focused = selInvId
      ? invList.filter((_, i) => investments[i]?.id === selInvId)
      : invList;
    return `You are an AI investment analyst for Thermo Companies Investments, a Denver-based family office. Investment lead: Kyle Pickens CFA. Team: Jay Monroe (founder), Tim Taylor, Christine Harkness, Jen Fyock. Goal: $1B/year cash flow. Investing style: hard assets, industries in transition, permanent capital — think Berkshire, Loews, Fairfax.

Date: ${new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })}
User: ${currentUser.name} (${currentUser.role})
Portfolio: ${investments.length} investments | NAV: ${fmt(
      investments.reduce((s, i) => s + num(i.nav), 0)
    )} | Notes: ${notes.length}

${focused.join("\n\n")}

Be direct, concise, and speak like a sophisticated institutional investor.`;
  }, [investments, notes, files, currentUser, selInvId]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input.trim() };
    setMessages((p) => [...p, userMsg]);
    setInput("");
    setLoading(true);
    try {
      const history = [...messages, userMsg].slice(-20);
      const reply = await callClaude(
        buildContext(),
        history.map((m) => ({ role: m.role, content: m.content }))
      );
      setMessages((p) => [...p, { role: "assistant", content: reply }]);
    } catch {
      setMessages((p) => [
        ...p,
        { role: "assistant", content: "⚠ Connection error. Please try again." },
      ]);
    }
    setLoading(false);
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };
  const selInv = investments.find((i) => i.id === selInvId);
  const SUGGESTIONS = [
    "Summarize all meeting notes from the last 30 days",
    "What are the key risks across the portfolio?",
    "Which investments have the highest conviction?",
    "What follow-up actions are outstanding?",
    "Compare IRR and MOIC across all positions",
    "What sectors are we most concentrated in?",
  ];

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div
        style={{
          width: 260,
          borderRight: "1px solid #2a2a2a",
          display: "flex",
          flexDirection: "column",
          background: T.black,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: "20px 16px 12px",
            borderBottom: "1px solid #2a2a2a",
          }}
        >
          <div
            style={{
              color: T.accent,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
              marginBottom: 12,
            }}
          >
            Context
          </div>
          <button
            onClick={() => setSelInvId(null)}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              borderRadius: 6,
              cursor: "pointer",
              marginBottom: 6,
              background: !selInvId ? T.accent + "22" : "transparent",
              color: !selInvId ? T.accent : T.muted,
              border: `1px solid ${!selInvId ? T.accent + "44" : "#333"}`,
              fontSize: 12,
              fontWeight: !selInvId ? 600 : 400,
            }}
          >
            🗂 Full Portfolio
          </button>
          <div
            style={{
              color: T.muted,
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              margin: "10px 0 6px",
              paddingLeft: 2,
            }}
          >
            Or focus on one
          </div>
          {investments.map((inv) => (
            <button
              key={inv.id}
              onClick={() => setSelInvId(inv.id)}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "7px 12px",
                borderRadius: 6,
                cursor: "pointer",
                marginBottom: 4,
                background:
                  selInvId === inv.id ? T.accent + "22" : "transparent",
                color: selInvId === inv.id ? T.accent : T.light,
                border: `1px solid ${
                  selInvId === inv.id ? T.accent + "44" : "transparent"
                }`,
                fontSize: 11,
                fontWeight: selInvId === inv.id ? 600 : 400,
              }}
            >
              <div>{inv.name}</div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>
                {notes.filter((n) => n.investment_id === inv.id).length} notes
              </div>
            </button>
          ))}
        </div>
        <div style={{ padding: "16px", flex: 1, overflowY: "auto" }}>
          <div
            style={{
              color: T.muted,
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 10,
            }}
          >
            Suggested
          </div>
          {SUGGESTIONS.map((s, i) => (
            <button
              key={i}
              onClick={() => setInput(s)}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: 6,
                cursor: "pointer",
                marginBottom: 6,
                background: T.charcoal,
                color: T.muted,
                border: "1px solid #2a2a2a",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 28px",
            borderBottom: "1px solid #2a2a2a",
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "linear-gradient(135deg,#c8a96e,#e8c98e)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              flexShrink: 0,
            }}
          >
            ✦
          </div>
          <div>
            <div style={{ color: T.white, fontWeight: 600, fontSize: 14 }}>
              Claude — Thermo Investment Analyst
            </div>
            <div style={{ color: T.muted, fontSize: 11, marginTop: 2 }}>
              {selInv
                ? `Focused on ${selInv.name} · ${
                    notes.filter((n) => n.investment_id === selInv.id).length
                  } notes`
                : `Full portfolio · ${investments.length} investments · ${notes.length} notes`}
            </div>
          </div>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {messages.length === 0 && (
            <div style={{ textAlign: "center", marginTop: 40 }}>
              <div style={{ fontSize: 32, marginBottom: 16 }}>✦</div>
              <div
                style={{
                  color: T.white,
                  fontSize: 16,
                  fontWeight: 600,
                  marginBottom: 8,
                  fontFamily: "Georgia,serif",
                }}
              >
                Thermo Investment Intelligence
              </div>
              <div
                style={{
                  color: T.muted,
                  fontSize: 13,
                  lineHeight: 1.7,
                  maxWidth: 440,
                  margin: "0 auto",
                }}
              >
                I have full visibility into your portfolio — investments,
                meeting notes, updates, and calls. Ask me anything or select a
                suggested question.
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                flexDirection: m.role === "user" ? "row-reverse" : "row",
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  background:
                    m.role === "user"
                      ? T.accent
                      : "linear-gradient(135deg,#c8a96e,#e8c98e)",
                  color: T.black,
                }}
              >
                {m.role === "user" ? currentUser.initials : "✦"}
              </div>
              <div
                style={{
                  maxWidth: "72%",
                  padding: "12px 16px",
                  borderRadius:
                    m.role === "user"
                      ? "16px 4px 16px 16px"
                      : "4px 16px 16px 16px",
                  background: m.role === "user" ? T.accent + "22" : T.charcoal,
                  border: `1px solid ${
                    m.role === "user" ? T.accent + "33" : "#333"
                  }`,
                  color: T.light,
                  fontSize: 13,
                  lineHeight: 1.75,
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg,#c8a96e,#e8c98e)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  color: T.black,
                }}
              >
                ✦
              </div>
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "4px 16px 16px 16px",
                  background: T.charcoal,
                  border: "1px solid #333",
                }}
              >
                <div style={{ display: "flex", gap: 4 }}>
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: T.accent,
                        animation: `bounce 1.2s ease-in-out ${
                          i * 0.2
                        }s infinite`,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div
          style={{
            padding: "16px 28px",
            borderTop: "1px solid #2a2a2a",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about your portfolio, notes, risks, follow-ups…"
              rows={2}
              style={{
                flex: 1,
                background: T.charcoal,
                color: T.white,
                border: "1px solid #444",
                borderRadius: 10,
                padding: "10px 14px",
                fontSize: 13,
                fontFamily: "inherit",
                resize: "none",
                outline: "none",
                lineHeight: 1.6,
                boxSizing: "border-box",
              }}
            />
            <button
              onClick={sendMessage}
              disabled={loading || !input.trim()}
              style={{
                background: input.trim() && !loading ? T.accent : "#333",
                color: input.trim() && !loading ? T.black : T.muted,
                border: "none",
                borderRadius: 10,
                padding: "10px 20px",
                cursor: input.trim() && !loading ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 700,
                flexShrink: 0,
                height: 52,
              }}
            >
              {loading ? "…" : "Send"}
            </button>
          </div>
          <div
            style={{
              color: "#444",
              fontSize: 10,
              marginTop: 6,
              textAlign: "center",
            }}
          >
            Enter to send · Shift+Enter for new line
          </div>
        </div>
      </div>
      <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}`}</style>
    </div>
  );
});

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [currentUser, setCurrentUser] = useState(USERS[0]);
  const [view, setView] = useState("dashboard");
  const [investments, setInvestments] = useState([]);
  const [notes, setNotes] = useState([]);
  const [files, setFiles] = useState([]);
  const [catalysts, setCatalysts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filterType, setFilterType] = useState("all");
  const [filterSector, setFilterSector] = useState("all");
  const [showAddInv, setShowAddInv] = useState(false);
  const [showEditInv, setShowEditInv] = useState(false);
  const [showBBModal, setShowBBModal] = useState(false);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quoteSource, setQuoteSource] = useState("Polygon.io");
  const [fileTab, setFileTab] = useState("all");
  const [activityFilter, setActivityFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [fundamentals, setFundamentals] = useState(null);
  const fileRef = useRef();

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Load all data ────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [inv, nt, fl, cat] = await Promise.all([
        db.get("investments", "order=created_at.asc"),
        db.get("notes", "order=created_at.desc"),
        db.get("files", "order=created_at.desc"),
        db.get("catalysts", "order=created_at.desc").catch(() => []),
      ]);
      const withBB = (inv || []).map((i) => ({
        ...i,
        committed: num(i.committed),
        nav: num(i.nav),
        irr: num(i.irr),
        moic: Number(i.moic) || 1,
        units: i.units != null ? num(i.units) : null,
        price_per_unit: i.price_per_unit != null ? num(i.price_per_unit) : null,
        bloombergData:
          i.type === "public" && i.ticker
            ? {
                price: 0,
                change: 0,
                pct: 0,
                mktCap: "—",
                pe: null,
                vol: "—",
                source: "Loading…",
              }
            : null,
      }));
      // Fetch live quotes
      const publicInvs = withBB.filter((i) => i.ticker);
      if (publicInvs.length > 0) {
        const quotes = await fetchAllQuotes(publicInvs.map((i) => i.ticker));
        for (const i of withBB) {
          if (i.ticker && quotes[i.ticker]) {
            const q = quotes[i.ticker];
            i.bloombergData = { ...q };
            if (i.units) {
              const warrantValue = i.warrants && i.strike_price && q.price > i.strike_price
                ? i.warrants * (q.price - i.strike_price)
                : 0;
              i.nav = Math.round(i.units * q.price + warrantValue);
              db.update("investments", `id=eq.${i.id}`, {
                nav: String(i.nav),
              }).catch(() => {});
            }
          }
        }
      }
      setInvestments(withBB);
      setNotes(nt || []);
      setFiles(fl || []);
      setCatalysts(cat || []);
    } catch (e) {
      showToast("Failed to connect to Supabase", "error");
    }
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const inv = investments.find((i) => i.id === selectedId);
    if (!inv?.ticker) {
      setChartData(null);
      setFundamentals(null);
      return;
    }
    setChartData(null);
    setFundamentals(null);
    fetchChartData(inv.ticker).then(setChartData);
    fetchFundamentals(inv.ticker).then(setFundamentals);
  }, [selectedId, investments]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const selected = investments.find((i) => i.id === selectedId) || null;
  const invNotes = notes.filter((n) => n.investment_id === selectedId);
  const invFiles = files.filter((f) => f.investment_id === selectedId);
  const totalCommit = investments.reduce((s, i) => s + i.committed, 0);
  const totalNAV = investments.reduce((s, i) => s + i.nav, 0);
  const totalGain = totalNAV - totalCommit;
  const avgIRR = investments.length
    ? (investments.reduce((s, i) => s + i.irr, 0) / investments.length).toFixed(
        1
      )
    : "0.0";
  const sectors = [...new Set(investments.map((i) => i.sector))];
  const filtered = investments.filter(
    (i) =>
      (filterType === "all" || i.type === filterType) &&
      (filterSector === "all" || i.sector === filterSector)
  );
  const fileFilter = (f) =>
    fileTab === "all"
      ? true
      : fileTab === "pdf"
      ? f.ext === "pdf"
      : fileTab === "excel"
      ? ["xlsx", "xls", "csv"].includes(f.ext)
      : ["docx", "doc"].includes(f.ext);
  const allNotes = notes
    .map((n) => {
      const inv = investments.find((i) => i.id === n.investment_id) || {};
      return { ...n, invName: inv.name || "—", invType: inv.type || "private" };
    })
    .filter((n) => activityFilter === "all" || n.type === activityFilter);

  // ── Add note + catalyst extraction ───────────────────────────────────────
  const addNote = useCallback(
    (investmentId, investmentName) => async (text, type) => {
      try {
        const res = await db.insert("notes", {
          investment_id: investmentId,
          author: currentUser.initials,
          text,
          type,
        });
        setNotes((p) => [res[0], ...p]);
        showToast("Note saved");
        // Extract catalysts in background
        extractCatalysts(text, investmentName).then(async (extracted) => {
          for (const c of extracted) {
            try {
              const row = {
                investment_id: investmentId,
                description: c.description,
                date: c.date || null,
                date_label: c.dateLabel || null,
                type: c.type || "followup",
                status: "pending",
                source_note: text.slice(0, 200),
              };
              const saved = await db.insert("catalysts", row);
              setCatalysts((p) => [saved[0], ...p]);
            } catch {}
          }
          if (extracted.length > 0)
            showToast(
              `⚡ ${extracted.length} catalyst${
                extracted.length > 1 ? "s" : ""
              } detected`
            );
        });
      } catch {
        showToast("Failed to save note", "error");
      }
    },
    [currentUser, showToast]
  );

  // ── File upload ───────────────────────────────────────────────────────────
  const handleFile = async (e) => {
    const ok = ["pdf", "xlsx", "xls", "csv", "docx", "doc"];
    const list = Array.from(e.target.files).filter((f) =>
      ok.includes(f.name.split(".").pop().toLowerCase())
    );
    if (!list.length || !selected) return;
    for (const f of list) {
      try {
        const path = await uploadFile(f, selected.id);
        const meta = {
          investment_id: selected.id,
          name: f.name,
          size: (f.size / 1024).toFixed(0) + "KB",
          ext: f.name.split(".").pop().toLowerCase(),
          storage_path: path,
          author: currentUser.initials,
        };
        const res = await db.insert("files", meta);
        setFiles((p) => [res[0], ...p]);
        showToast(`${f.name} uploaded`);
      } catch {
        try {
          const meta = {
            investment_id: selected.id,
            name: f.name,
            size: (f.size / 1024).toFixed(0) + "KB",
            ext: f.name.split(".").pop().toLowerCase(),
            storage_path: null,
            author: currentUser.initials,
          };
          const res = await db.insert("files", meta);
          setFiles((p) => [res[0], ...p]);
          showToast(`${f.name} saved (create storage bucket for full uploads)`);
        } catch {
          showToast("File upload failed", "error");
        }
      }
    }
    e.target.value = "";
  };

  // ── Refresh prices ────────────────────────────────────────────────────────
  const refreshQuotes = async () => {
    const publicInvs = investments.filter((i) => i.ticker);
    if (!publicInvs.length) return;
    setQuotesLoading(true);
    try {
      const quotes = await fetchAllQuotes(publicInvs.map((i) => i.ticker));
      let anyUpdated = false;
      const updated = investments.map((i) => {
        if (i.ticker && quotes[i.ticker]) {
          anyUpdated = true;
          const q = quotes[i.ticker];
          const warrantValue = i.warrants && i.strike_price && q.price > i.strike_price
            ? i.warrants * (q.price - i.strike_price)
            : 0;
          const nav = i.units ? Math.round(i.units * q.price + warrantValue) : i.nav;
          return { ...i, bloombergData: { ...q }, nav };
        }
        return i;
      });
      setInvestments(updated);
      if (anyUpdated) {
        updated.forEach((i) => {
          if (i.ticker && quotes[i.ticker] && i.units)
            db.update("investments", `id=eq.${i.id}`, {
              nav: String(i.nav),
            }).catch(() => {});
        });
        showToast("Live prices updated from Polygon.io");
      } else {
        showToast("Could not fetch prices", "error");
      }
    } catch {
      showToast("Failed to fetch prices", "error");
    }
    setQuotesLoading(false);
  };

  // ── Save new investment ───────────────────────────────────────────────────
  const saveNewInv = useCallback(
    async (form) => {
      const committed = Math.round(Number(form.committed) || 0);
      const body = {
        name: form.name,
        ticker: form.ticker || null,
        type: form.type,
        sector: form.sector,
        committed: String(committed),
        nav: String(committed),
        irr: 0,
        moic: 1.0,
        units: form.units ? String(Math.round(Number(form.units))) : null,
        price_per_unit: form.pricePerUnit
          ? String(Number(form.pricePerUnit))
          : null,
        description: form.description || null,
        tags: [],
        vintage: Number(form.vintage) || new Date().getFullYear(),
        status: "active",
        warrants: form.warrants ? Math.round(Number(form.warrants)) : null,
        strike_price: form.strikePrice ? Number(form.strikePrice) : null,
      };
      try {
        const res = await db.insert("investments", body);
        const inv = {
          ...res[0],
          committed: num(res[0].committed),
          nav: num(res[0].nav),
          irr: num(res[0].irr),
          moic: Number(res[0].moic) || 1,
          units: res[0].units != null ? num(res[0].units) : null,
          price_per_unit:
            res[0].price_per_unit != null ? num(res[0].price_per_unit) : null,
          bloombergData:
            res[0].type === "public" && res[0].ticker
              ? {
                  price: 0,
                  change: 0,
                  pct: 0,
                  mktCap: "—",
                  pe: null,
                  vol: "—",
                  source: "Loading…",
                }
              : null,
        };
        setInvestments((p) => [...p, inv]);
        setShowAddInv(false);
        showToast(`${inv.name} added`);
      } catch (e) {
        let msg = "Failed to save investment";
        try {
          const d = JSON.parse(e.message);
          msg = d.message || d.hint || d.error || e.message;
        } catch {
          msg = e.message;
        }
        showToast(msg, "error");
      }
    },
    [showToast]
  );

  // ── Save edited investment ────────────────────────────────────────────────
  const saveEditedInv = useCallback(
    async (form) => {
      if (!selected) return;
      const body = {
        name: form.name,
        ticker: form.ticker || null,
        sector: form.sector,
        type: form.type,
        vintage: Number(form.vintage) || selected.vintage,
        irr: form.irr !== "" ? Number(form.irr) : selected.irr,
        moic: form.moic !== "" ? Number(form.moic) : selected.moic,
        description: form.description || null,
        warrants: form.warrants ? Math.round(Number(form.warrants)) : null,
        strike_price: form.strikePrice ? Number(form.strikePrice) : null,
      };
      try {
        await db.update("investments", `id=eq.${selected.id}`, body);
        setInvestments((p) =>
          p.map((i) => (i.id === selected.id ? { ...i, ...body } : i))
        );
        setShowEditInv(false);
        showToast(`${form.name} updated`);
      } catch {
        showToast("Failed to save changes", "error");
      }
    },
    [selected, showToast]
  );

  // ── Save position ─────────────────────────────────────────────────────────
  const savePosition = useCallback(
    async (units, pricePerUnit) => {
      if (!selected) return;
      const implied = Math.round(units * pricePerUnit);
      try {
        await db.update("investments", `id=eq.${selected.id}`, {
          units: String(Math.round(units)),
          price_per_unit: String(pricePerUnit),
          committed: String(implied),
          nav: String(implied),
        });
        setInvestments((p) =>
          p.map((i) =>
            i.id === selected.id
              ? {
                  ...i,
                  units: Math.round(units),
                  price_per_unit: pricePerUnit,
                  committed: implied,
                  nav: implied,
                }
              : i
          )
        );
        showToast("Position updated");
      } catch {
        showToast("Failed to update position", "error");
      }
    },
    [selected, showToast]
  );

  // ── Type badge colors ─────────────────────────────────────────────────────
  const CAT_TYPE_COLORS = {
    catalyst: T.green,
    followup: T.accent,
    deadline: T.red,
    event: T.blue,
  };

  // ── Nav ───────────────────────────────────────────────────────────────────
  const Nav = () => (
    <div
      style={{
        background: T.black,
        borderBottom: "1px solid #2a2a2a",
        padding: "0 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 64,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            style={{
              color: "#cc2222",
              fontSize: 20,
              fontWeight: 700,
              fontFamily: "'Montserrat',sans-serif",
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            Thermo
          </span>
          <span
            style={{
              color: T.white,
              fontSize: 20,
              fontWeight: 300,
              fontFamily: "'Montserrat',sans-serif",
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            Investments
          </span>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {[
            ["dashboard", "Dashboard"],
            ["portfolio", "Portfolio"],
            ["activity", "Activity"],
            ["catalysts", "⚡ Catalysts"],
            ["framework", "Framework"],
            ["claude", "✦ Claude"],
          ].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                background: view === v ? T.accent + "22" : "transparent",
                color: view === v ? T.accent : T.muted,
                border: "none",
                borderRadius: 6,
                padding: "5px 12px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: view === v ? 600 : 400,
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <select
          value={currentUser.id}
          onChange={(e) =>
            setCurrentUser(USERS.find((u) => u.id === Number(e.target.value)))
          }
          style={{
            background: T.charcoal,
            color: T.light,
            border: "1px solid #333",
            borderRadius: 6,
            padding: "5px 8px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {USERS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.role})
            </option>
          ))}
        </select>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: T.accent,
            color: T.black,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {currentUser.initials}
        </div>
      </div>
    </div>
  );

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading)
    return (
      <div
        style={{
          height: "100vh",
          background: T.black,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily: "'Helvetica Neue',sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            style={{
              color: "#cc2222",
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "'Montserrat',sans-serif",
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            Thermo
          </span>
          <span
            style={{
              color: T.white,
              fontSize: 28,
              fontWeight: 300,
              fontFamily: "'Montserrat',sans-serif",
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            Investments
          </span>
        </div>
        <div
          style={{
            color: T.muted,
            fontSize: 12,
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          Connecting…
        </div>
        <div
          style={{
            width: 200,
            height: 2,
            background: "#222",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "60%",
              height: "100%",
              background: T.accent,
              borderRadius: 2,
              animation: "slide 1.2s ease-in-out infinite",
            }}
          />
        </div>
        <style>{`@keyframes slide{0%{transform:translateX(-200%)}100%{transform:translateX(400%)}}`}</style>
      </div>
    );

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const Dashboard = () => (
    <div style={{ padding: 32, overflowY: "auto", flex: 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 28,
        }}
      >
        <div>
          <h1
            style={{
              color: T.white,
              fontSize: 28,
              fontFamily: "Georgia,serif",
              margin: 0,
            }}
          >
            Portfolio Overview
          </h1>
          <div style={{ color: T.muted, fontSize: 13, marginTop: 4 }}>
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => setShowBBModal(true)}
            style={{
              background: "#1a1a2e",
              color: T.blue,
              border: "1px solid #4a90d944",
              borderRadius: 6,
              padding: "8px 14px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Bloomberg Setup
          </button>
          <button
            onClick={refreshQuotes}
            disabled={quotesLoading}
            style={{
              background: quotesLoading ? "#333" : T.accent + "22",
              color: quotesLoading ? T.muted : T.accent,
              border: `1px solid ${quotesLoading ? "#333" : T.accent + "44"}`,
              borderRadius: 6,
              padding: "8px 14px",
              cursor: quotesLoading ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {quotesLoading ? "⟳ Fetching…" : "⟳ Refresh Prices"}
          </button>
          {currentUser.role === "admin" && (
            <button
              onClick={() => setShowAddInv(true)}
              style={{
                background: T.accent,
                color: T.black,
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              + Add Investment
            </button>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5,1fr)",
          gap: 16,
          marginBottom: 24,
        }}
      >
        {[
          ["Total Committed", fmt(totalCommit), T.accent],
          ["Total NAV", fmt(totalNAV), T.accent],
          ["Unrealized Gain", fmt(totalGain), totalGain >= 0 ? T.green : T.red],
          ["Avg. Net IRR", pct(parseFloat(avgIRR)), T.accent],
          ["# Investments", investments.length, T.accent],
        ].map(([l, v, c]) => (
          <Card key={l} style={{ padding: "18px 20px" }}>
            <Stat label={l} value={v} color={c} />
          </Card>
        ))}
      </div>

      {/* Pending catalysts banner */}
      {catalysts.filter((c) => c.status === "pending").length > 0 && (
        <div
          onClick={() => setView("catalysts")}
          style={{
            background: "#1a150a",
            border: `1px solid ${T.accent}44`,
            borderRadius: 8,
            padding: "12px 20px",
            marginBottom: 24,
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <div>
              <div style={{ color: T.accent, fontWeight: 600, fontSize: 13 }}>
                {catalysts.filter((c) => c.status === "pending").length} pending
                catalysts & follow-ups
              </div>
              <div style={{ color: T.muted, fontSize: 11, marginTop: 2 }}>
                Click to view all
              </div>
            </div>
          </div>
          <span style={{ color: T.accent, fontSize: 16 }}>→</span>
        </div>
      )}

      {/* Bloomberg ticker */}
      {investments.some((i) => i.bloombergData) && (
        <Card style={{ marginBottom: 24, padding: "16px 24px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                color: T.accent,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
              }}
            >
              Live Market Data — Public Holdings
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ color: T.green, fontSize: 11 }}>
                ● {quoteSource}
              </span>
              <button
                onClick={() => setShowBBModal(true)}
                style={{
                  background: "none",
                  border: "none",
                  color: T.muted,
                  fontSize: 11,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                {quotesLoading ? "Fetching…" : "Upgrade to Bloomberg →"}
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 36, flexWrap: "wrap" }}>
            {investments
              .filter((i) => i.bloombergData)
              .map((i) => (
                <div key={i.id} style={{ minWidth: 120 }}>
                  <div
                    style={{
                      color: T.white,
                      fontSize: 13,
                      fontWeight: 700,
                      marginBottom: 2,
                    }}
                  >
                    {i.ticker}
                  </div>
                  {i.bloombergData.price === 0 ? (
                    <div style={{ color: T.muted, fontSize: 13 }}>
                      Fetching…
                    </div>
                  ) : (
                    <>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 22,
                            fontWeight: 700,
                            color: T.light,
                            fontFamily: "'Montserrat',sans-serif",
                          }}
                        >
                          ${i.bloombergData.price.toFixed(2)}
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: clr(i.bloombergData.pct),
                          }}
                        >
                          {i.bloombergData.pct >= 0 ? "▲" : "▼"}{" "}
                          {Math.abs(i.bloombergData.pct).toFixed(2)}%
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: clr(i.bloombergData.change),
                          marginTop: 1,
                        }}
                      >
                        {i.bloombergData.change >= 0 ? "+" : ""}
                        {i.bloombergData.change.toFixed(2)} today
                      </div>
                      <div
                        style={{ fontSize: 10, color: T.muted, marginTop: 1 }}
                      >
                        Cap {i.bloombergData.mktCap} · Vol {i.bloombergData.vol}
                      </div>
                    </>
                  )}
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* Charts */}
      {investments.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20,
            marginBottom: 24,
          }}
        >
          <Card>
            <div
              style={{
                color: T.accent,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
                marginBottom: 16,
              }}
            >
              NAV by Type
            </div>
            {["public", "private", "fund", "10percent"].map((t) => {
              const n = investments
                .filter((i) => i.type === t)
                .reduce((s, i) => s + i.nav, 0);
              const p = totalNAV > 0 ? ((n / totalNAV) * 100).toFixed(1) : "0";
              const c =
                t === "public"
                  ? T.blue
                  : t === "private"
                  ? T.accent
                  : t === "fund"
                  ? T.green
                  : "#9b59b6";
              return (
                <div key={t} style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        color: T.light,
                        fontSize: 13,
                        textTransform: "capitalize",
                      }}
                    >
                      {t === "10percent" ? "10%" : t}
                    </span>
                    <span style={{ color: T.muted, fontSize: 12 }}>
                      {fmt(n)} · {p}%
                    </span>
                  </div>
                  <div
                    style={{ height: 6, background: "#333", borderRadius: 3 }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: p + "%",
                        background: c,
                        borderRadius: 3,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </Card>
          <Card>
            <div
              style={{
                color: T.accent,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
                marginBottom: 16,
              }}
            >
              NAV by Sector
            </div>
            {sectors.map((s, idx) => {
              const n = investments
                .filter((i) => i.sector === s)
                .reduce((a, i) => a + i.nav, 0);
              const p = totalNAV > 0 ? ((n / totalNAV) * 100).toFixed(1) : "0";
              const cols = [
                T.accent,
                T.blue,
                T.green,
                "#9b59b6",
                "#e67e22",
                "#e84393",
              ];
              return (
                <div key={s} style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ color: T.light, fontSize: 13 }}>{s}</span>
                    <span style={{ color: T.muted, fontSize: 12 }}>{p}%</span>
                  </div>
                  <div
                    style={{ height: 6, background: "#333", borderRadius: 3 }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: p + "%",
                        background: cols[idx % cols.length],
                        borderRadius: 3,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </Card>
        </div>
      )}

      {/* Recent notes */}
      <Card>
        <div
          style={{
            color: T.accent,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: "uppercase",
            marginBottom: 16,
          }}
        >
          Recent Notes & Updates
        </div>
        {notes.slice(0, 6).map((n) => {
          const inv = investments.find((i) => i.id === n.investment_id) || {};
          return (
            <div
              key={n.id}
              style={{
                borderBottom: "1px solid #2a2a2a",
                paddingBottom: 12,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 4,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span
                    style={{
                      color: T.accent,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setSelectedId(n.investment_id);
                      setView("portfolio");
                    }}
                  >
                    {inv.name || "—"}
                  </span>
                  <Badge
                    label={n.type}
                    color={n.type === "meeting" ? T.blue : T.accent}
                  />
                </div>
                <span style={{ color: T.muted, fontSize: 11 }}>
                  {n.created_at?.slice(0, 10)} · {n.author}
                </span>
              </div>
              <div style={{ color: T.light, fontSize: 13, lineHeight: 1.6 }}>
                {n.text}
              </div>
            </div>
          );
        })}
        {notes.length === 0 && (
          <div style={{ color: T.muted, fontSize: 13 }}>No notes yet.</div>
        )}
      </Card>
    </div>
  );

  // ── Catalyst strip (used in Portfolio detail) ─────────────────────────────
  const InvCatalysts = ({ investmentId }) => {
    const invCats = catalysts
      .filter((c) => c.investment_id === investmentId && c.status === "pending")
      .sort((a, b) => {
        if (a.date && b.date) return a.date.localeCompare(b.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return 0;
      });
    if (!invCats.length) return null;
    return (
      <Card style={{ marginBottom: 24, borderLeft: `3px solid ${T.accent}` }}>
        <div
          style={{
            color: T.accent,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: "uppercase",
            marginBottom: 14,
          }}
        >
          ⚡ Active Catalysts & Follow-ups ({invCats.length})
        </div>
        {invCats.map((cat) => (
          <div
            key={cat.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              padding: "8px 0",
              borderBottom: "1px solid #2a2a2a",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                flex: 1,
              }}
            >
              <Badge
                label={cat.type || "followup"}
                color={CAT_TYPE_COLORS[cat.type] || T.accent}
              />
              <div style={{ color: T.light, fontSize: 13, lineHeight: 1.6 }}>
                {cat.description}
              </div>
            </div>
            {(cat.date_label || cat.date) && (
              <div
                style={{
                  color: T.accent,
                  fontSize: 11,
                  fontWeight: 600,
                  flexShrink: 0,
                  marginLeft: 12,
                }}
              >
                📅 {cat.date_label || cat.date}
              </div>
            )}
          </div>
        ))}
      </Card>
    );
  };

  // ── Portfolio ──────────────────────────────────────────────────────────────
  const Portfolio = () => (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* List */}
      <div
        style={{
          width: 360,
          borderRight: "1px solid #2a2a2a",
          overflowY: "auto",
          background: T.black,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: "16px 14px 10px",
            borderBottom: "1px solid #1e1e1e",
            position: "sticky",
            top: 0,
            background: T.black,
            zIndex: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 6,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            {["all", "public", "private", "fund", "10percent"].map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                style={{
                  background: filterType === t ? T.accent : T.charcoal,
                  color: filterType === t ? T.black : T.muted,
                  border: `1px solid ${filterType === t ? T.accent : "#333"}`,
                  borderRadius: 4,
                  padding: "4px 10px",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                }}
              >
                {t === "10percent" ? "10%" : t}
              </button>
            ))}
          </div>
          <select
            value={filterSector}
            onChange={(e) => setFilterSector(e.target.value)}
            style={{
              width: "100%",
              background: T.charcoal,
              color: T.light,
              border: "1px solid #333",
              borderRadius: 6,
              padding: "7px 10px",
              fontSize: 12,
            }}
          >
            <option value="all">All Sectors</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {filtered.length === 0 && (
          <div
            style={{
              padding: 24,
              color: T.muted,
              fontSize: 13,
              textAlign: "center",
            }}
          >
            No investments yet.
          </div>
        )}
        {filtered.map((inv) => (
          <div
            key={inv.id}
            onClick={() => setSelectedId(inv.id)}
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid #1e1e1e",
              cursor: "pointer",
              background: selectedId === inv.id ? T.charcoal : "transparent",
              borderLeft: `3px solid ${
                selectedId === inv.id ? T.accent : "transparent"
              }`,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 6,
              }}
            >
              <span style={{ color: T.white, fontWeight: 600, fontSize: 14 }}>
                {inv.name}
              </span>
              <TypeBadge type={inv.type} />
            </div>
            <div style={{ color: T.muted, fontSize: 11, marginBottom: 8 }}>
              {inv.sector} · {inv.vintage}
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <div>
                <div style={{ color: T.accent, fontSize: 13, fontWeight: 600 }}>
                  {fmt(inv.nav)}
                </div>
                <div
                  style={{
                    color: T.muted,
                    fontSize: 10,
                    textTransform: "uppercase",
                  }}
                >
                  NAV
                </div>
              </div>
              <div>
                <div style={{ color: T.green, fontSize: 13, fontWeight: 600 }}>
                  {pct(inv.irr)}
                </div>
                <div
                  style={{
                    color: T.muted,
                    fontSize: 10,
                    textTransform: "uppercase",
                  }}
                >
                  IRR
                </div>
              </div>
              <div>
                <div style={{ color: T.light, fontSize: 13, fontWeight: 600 }}>
                  {(inv.moic || 1).toFixed(2)}x
                </div>
                <div
                  style={{
                    color: T.muted,
                    fontSize: 10,
                    textTransform: "uppercase",
                  }}
                >
                  MOIC
                </div>
              </div>
              {catalysts.filter(
                (c) => c.investment_id === inv.id && c.status === "pending"
              ).length > 0 && (
                <div>
                  <div style={{ color: T.accent, fontSize: 13 }}>
                    ⚡
                    {
                      catalysts.filter(
                        (c) =>
                          c.investment_id === inv.id && c.status === "pending"
                      ).length
                    }
                  </div>
                  <div
                    style={{
                      color: T.muted,
                      fontSize: 10,
                      textTransform: "uppercase",
                    }}
                  >
                    Catalysts
                  </div>
                </div>
              )}
              {files.filter((f) => f.investment_id === inv.id).length > 0 && (
                <div>
                  <div style={{ color: T.muted, fontSize: 13 }}>
                    📎{files.filter((f) => f.investment_id === inv.id).length}
                  </div>
                  <div
                    style={{
                      color: T.muted,
                      fontSize: 10,
                      textTransform: "uppercase",
                    }}
                  >
                    Files
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {currentUser.role === "admin" && (
          <div style={{ padding: 14 }}>
            <button
              onClick={() => setShowAddInv(true)}
              style={{
                width: "100%",
                background: "transparent",
                color: T.accent,
                border: `1px dashed ${T.accent}44`,
                borderRadius: 6,
                padding: "10px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              + Add Investment
            </button>
          </div>
        )}
      </div>

      {/* Detail */}
      {selected ? (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 32,
            background: T.black,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: 24,
            }}
          >
            <div>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <h2
                  style={{
                    color: T.white,
                    fontSize: 26,
                    fontFamily: "Georgia,serif",
                    margin: 0,
                  }}
                >
                  {selected.name}
                </h2>
                <TypeBadge type={selected.type} />
                {selected.ticker && (
                  <span
                    style={{ color: T.muted, fontSize: 14, fontWeight: 600 }}
                  >
                    {selected.ticker}
                  </span>
                )}
              </div>
              <div style={{ color: T.muted, fontSize: 13 }}>
                {selected.sector} · Vintage {selected.vintage}
              </div>
              <div
                style={{
                  color: T.light,
                  fontSize: 13,
                  marginTop: 8,
                  maxWidth: 600,
                  lineHeight: 1.7,
                }}
              >
                {selected.description}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {currentUser.role !== "viewer" && (
                <button
                  onClick={() => setShowEditInv(true)}
                  style={{
                    background: T.accent + "22",
                    color: T.accent,
                    border: `1px solid ${T.accent}44`,
                    borderRadius: 6,
                    padding: "7px 14px",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  ✏ Edit
                </button>
              )}
              {selected.bloombergData && (
                <button
                  onClick={refreshQuotes}
                  disabled={quotesLoading}
                  style={{
                    background: T.accent + "22",
                    color: T.accent,
                    border: `1px solid ${T.accent}44`,
                    borderRadius: 6,
                    padding: "7px 14px",
                    cursor: quotesLoading ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {quotesLoading ? "⟳ …" : "⟳ Refresh"}
                </button>
              )}
            </div>
          </div>

          {/* Bloomberg */}
          {selected.bloombergData && selected.bloombergData.price > 0 && (
            <Card style={{ marginBottom: 24 }}>
              <div
                style={{
                  color: T.accent,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                Live Market Data{" "}
                <span
                  style={{
                    color: T.green,
                    fontWeight: 400,
                    marginLeft: 8,
                    fontSize: 10,
                  }}
                >
                  ● {selected.bloombergData.source || quoteSource}
                </span>
              </div>
              <div style={{ display: "flex", gap: 36, flexWrap: "wrap" }}>
                {[
                  ["Price", "$" + selected.bloombergData.price, T.white],
                  [
                    "Change",
                    (selected.bloombergData.pct >= 0 ? "+" : "") +
                      selected.bloombergData.pct +
                      "%",
                    clr(selected.bloombergData.pct),
                  ],
                  ["Market Cap", fundamentals?.mktCap || selected.bloombergData.mktCap, T.light],
                  ["P/E", fundamentals?.eps && fundamentals.eps > 0 ? (selected.bloombergData.price / fundamentals.eps).toFixed(1) + "x" : "N/M", T.light],
                  ["Volume", selected.bloombergData.vol, T.light],
                  ["Employees", fundamentals?.employees || "—", T.light],
                ].map(([l, v, c]) => (
                  <div key={l}>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 700,
                        color: c,
                        fontFamily: "Georgia,serif",
                      }}
                    >
                      {v}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: T.muted,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        marginTop: 2,
                      }}
                    >
                      {l}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: T.muted, textTransform: "uppercase", letterSpacing: 1 }}>
                    1-Year Price
                  </span>
                  {chartData && (
                    <span style={{ fontSize: 11, color: T.muted }}>
                      {new Date(chartData[0].t).toLocaleDateString()} – {new Date(chartData[chartData.length - 1].t).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {chartData ? (
                  <PriceChart data={chartData} />
                ) : (
                  <div style={{ color: T.muted, fontSize: 12, marginTop: 8 }}>Loading chart…</div>
                )}
              </div>
            </Card>
          )}

          {/* Metrics */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4,1fr)",
              gap: 14,
              marginBottom: 24,
            }}
          >
            {[
              ["Committed", fmt(selected.committed), T.accent],
              ["Current NAV", fmt(selected.nav), T.accent],
              ["Net IRR", pct(selected.irr), T.green],
              ["MOIC", (selected.moic || 1).toFixed(2) + "x", T.accent],
            ].map(([l, v, c]) => (
              <Card key={l} style={{ padding: "16px 18px" }}>
                <Stat label={l} value={v} color={c} />
              </Card>
            ))}
          </div>

          {/* Catalysts strip */}
          <InvCatalysts investmentId={selected.id} />

          {/* Position */}
          <PositionEditor
            selected={selected}
            currentUser={currentUser}
            onSave={savePosition}
          />

          {/* Files */}
          <Card style={{ marginBottom: 24 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  color: T.accent,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Documents & Files
              </div>
              {currentUser.role !== "viewer" && (
                <button
                  onClick={() => fileRef.current.click()}
                  style={{
                    background: T.accent + "22",
                    color: T.accent,
                    border: `1px solid ${T.accent}44`,
                    borderRadius: 6,
                    padding: "5px 14px",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  + Upload
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.xlsx,.xls,.csv,.docx,.doc"
              style={{ display: "none" }}
              onChange={handleFile}
            />
            {invFiles.length > 0 && (
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                {["all", "pdf", "excel", "word"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setFileTab(t)}
                    style={{
                      background: fileTab === t ? T.dark : "transparent",
                      color: fileTab === t ? T.light : T.muted,
                      border: `1px solid ${
                        fileTab === t ? "#555" : "transparent"
                      }`,
                      borderRadius: 4,
                      padding: "3px 12px",
                      cursor: "pointer",
                      fontSize: 11,
                      textTransform: "capitalize",
                    }}
                  >
                    {t === "excel" ? "Excel/CSV" : t}
                  </button>
                ))}
              </div>
            )}
            {invFiles.filter(fileFilter).length === 0 ? (
              <div style={{ color: T.muted, fontSize: 13, padding: "8px 0" }}>
                {invFiles.length === 0
                  ? "No files uploaded yet."
                  : "No files in this category."}
              </div>
            ) : (
              invFiles.filter(fileFilter).map((f, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderRadius: 6,
                    background: T.dark,
                    marginBottom: 6,
                  }}
                >
                  <div
                    style={{ display: "flex", gap: 10, alignItems: "center" }}
                  >
                    <span style={{ fontSize: 18 }}>{fileIcon(f.name)}</span>
                    <div>
                      <div style={{ color: T.light, fontSize: 13 }}>
                        {f.name}
                      </div>
                      <div style={{ color: T.muted, fontSize: 11 }}>
                        {f.size} · {f.author}
                      </div>
                    </div>
                  </div>
                  <span style={{ color: T.muted, fontSize: 11 }}>
                    {f.created_at?.slice(0, 10)}
                  </span>
                </div>
              ))
            )}
          </Card>

          {/* Notes */}
          <NotesSection
            invNotes={invNotes}
            currentUser={currentUser}
            investmentName={selected.name}
            onAdd={addNote(selected.id, selected.name)}
          />
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ color: "#333", fontSize: 48 }}>📂</div>
          <div style={{ color: T.muted, fontSize: 14 }}>
            Select an investment to view details
          </div>
        </div>
      )}
    </div>
  );

  // ── Activity Log ───────────────────────────────────────────────────────────
  const Activity = () => (
    <div style={{ padding: 32, overflowY: "auto", flex: 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 24,
        }}
      >
        <div>
          <h1
            style={{
              color: T.white,
              fontSize: 28,
              fontFamily: "Georgia,serif",
              margin: 0,
            }}
          >
            Activity Log
          </h1>
          <div style={{ color: T.muted, fontSize: 13, marginTop: 4 }}>
            {notes.length} total entries
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["all", "update", "meeting", "call", "other"].map((t) => (
            <button
              key={t}
              onClick={() => setActivityFilter(t)}
              style={{
                background: activityFilter === t ? T.accent : T.charcoal,
                color: activityFilter === t ? T.black : T.muted,
                border: `1px solid ${activityFilter === t ? T.accent : "#333"}`,
                borderRadius: 4,
                padding: "5px 12px",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {allNotes.map((n) => (
        <Card key={n.id} style={{ marginBottom: 10, padding: "14px 20px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span
                style={{
                  color: T.accent,
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: "pointer",
                }}
                onClick={() => {
                  setSelectedId(n.investment_id);
                  setView("portfolio");
                }}
              >
                {n.invName}
              </span>
              <TypeBadge type={n.invType} />
              <Badge
                label={n.type}
                color={
                  n.type === "meeting"
                    ? T.blue
                    : n.type === "call"
                    ? T.green
                    : T.accent
                }
              />
            </div>
            <span style={{ color: T.muted, fontSize: 12 }}>
              {n.created_at?.slice(0, 10)} · {n.author}
            </span>
          </div>
          <div style={{ color: T.light, fontSize: 13, lineHeight: 1.7 }}>
            {n.text}
          </div>
        </Card>
      ))}
      {allNotes.length === 0 && (
        <div style={{ color: T.muted, fontSize: 14 }}>
          No activity recorded yet.
        </div>
      )}
    </div>
  );

  // ── Catalysts Page ─────────────────────────────────────────────────────────
  const CatalystsPage = () => {
    const [statusFilter, setStatusFilter] = useState("pending");
    const [typeFilter, setTypeFilter] = useState("all");

    const toggleStatus = async (cat) => {
      const newStatus = cat.status === "pending" ? "complete" : "pending";
      try {
        await db.update("catalysts", `id=eq.${cat.id}`, { status: newStatus });
        setCatalysts((p) =>
          p.map((c) => (c.id === cat.id ? { ...c, status: newStatus } : c))
        );
      } catch {
        showToast("Failed to update", "error");
      }
    };

    const rows = catalysts
      .map((c) => ({
        ...c,
        invName: investments.find((i) => i.id === c.investment_id)?.name || "—",
      }))
      .filter(
        (c) =>
          (statusFilter === "all" || c.status === statusFilter) &&
          (typeFilter === "all" || c.type === typeFilter)
      )
      .sort((a, b) => {
        if (a.date && b.date) return a.date.localeCompare(b.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return 0;
      });

    return (
      <div style={{ padding: 32, overflowY: "auto", flex: 1 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 24,
          }}
        >
          <div>
            <h1
              style={{
                color: T.white,
                fontSize: 28,
                fontFamily: "Georgia,serif",
                margin: 0,
              }}
            >
              Catalysts & Follow-ups
            </h1>
            <div style={{ color: T.muted, fontSize: 13, marginTop: 4 }}>
              {catalysts.filter((c) => c.status === "pending").length} pending ·
              auto-extracted from notes by Claude
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 4 }}>
              {["all", "pending", "complete"].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  style={{
                    background: statusFilter === s ? T.accent : T.charcoal,
                    color: statusFilter === s ? T.black : T.muted,
                    border: `1px solid ${
                      statusFilter === s ? T.accent : "#333"
                    }`,
                    borderRadius: 4,
                    padding: "5px 12px",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "capitalize",
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {["all", "catalyst", "followup", "deadline", "event"].map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  style={{
                    background:
                      typeFilter === t
                        ? (CAT_TYPE_COLORS[t] || T.accent) + "22"
                        : "transparent",
                    color:
                      typeFilter === t
                        ? CAT_TYPE_COLORS[t] || T.accent
                        : T.muted,
                    border: `1px solid ${
                      typeFilter === t
                        ? (CAT_TYPE_COLORS[t] || T.accent) + "44"
                        : "transparent"
                    }`,
                    borderRadius: 4,
                    padding: "5px 12px",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "capitalize",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <Card style={{ textAlign: "center", padding: 48 }}>
            <div style={{ color: "#333", fontSize: 36, marginBottom: 12 }}>
              ⚡
            </div>
            <div style={{ color: T.muted, fontSize: 14 }}>
              No catalysts yet. They'll appear automatically when Claude detects
              them in your notes.
            </div>
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((cat) => (
              <Card
                key={cat.id}
                style={{
                  padding: "16px 20px",
                  opacity: cat.status === "complete" ? 0.55 : 1,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: 16,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      flex: 1,
                    }}
                  >
                    <button
                      onClick={() => toggleStatus(cat)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        border: `2px solid ${
                          cat.status === "complete" ? T.green : "#555"
                        }`,
                        background:
                          cat.status === "complete" ? T.green : "transparent",
                        cursor: "pointer",
                        flexShrink: 0,
                        marginTop: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color: T.black,
                        fontWeight: 700,
                      }}
                    >
                      {cat.status === "complete" ? "✓" : ""}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          marginBottom: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            color: T.accent,
                            fontWeight: 600,
                            fontSize: 14,
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            setSelectedId(cat.investment_id);
                            setView("portfolio");
                          }}
                        >
                          {cat.invName}
                        </span>
                        <Badge
                          label={cat.type || "followup"}
                          color={CAT_TYPE_COLORS[cat.type] || T.accent}
                        />
                        {cat.status === "complete" && (
                          <Badge label="Complete" color={T.green} />
                        )}
                      </div>
                      <div
                        style={{
                          color: cat.status === "complete" ? T.muted : T.light,
                          fontSize: 13,
                          lineHeight: 1.7,
                          textDecoration:
                            cat.status === "complete" ? "line-through" : "none",
                        }}
                      >
                        {cat.description}
                      </div>
                      {cat.source_note && (
                        <div
                          style={{
                            color: "#555",
                            fontSize: 11,
                            marginTop: 6,
                            fontStyle: "italic",
                            borderLeft: "2px solid #333",
                            paddingLeft: 8,
                          }}
                        >
                          "{cat.source_note.slice(0, 120)}
                          {cat.source_note.length > 120 ? "…" : ""}"
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {(cat.date_label || cat.date) && (
                      <div
                        style={{
                          color:
                            cat.date &&
                            new Date(cat.date) < new Date() &&
                            cat.status === "pending"
                              ? T.red
                              : T.accent,
                          fontSize: 12,
                          fontWeight: 600,
                          marginBottom: 2,
                        }}
                      >
                        📅 {cat.date_label || cat.date}
                      </div>
                    )}
                    <div style={{ color: T.muted, fontSize: 11 }}>
                      {cat.created_at?.slice(0, 10)}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: T.black,
        fontFamily: "'Helvetica Neue',Arial,sans-serif",
        color: T.white,
        overflow: "hidden",
      }}
    >
      <Nav />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {view === "dashboard" && <Dashboard />}
        {view === "portfolio" && <Portfolio />}
        {view === "activity" && <Activity />}
        {view === "catalysts" && <CatalystsPage />}
        {view === "framework" && (
          <FrameworkTab investments={investments} currentUser={currentUser} />
        )}
        {view === "claude" && (
          <ClaudeAssistant
            investments={investments}
            notes={notes}
            files={files}
            currentUser={currentUser}
          />
        )}
      </div>
      {showAddInv && (
        <AddInvestmentModal
          onSave={saveNewInv}
          onClose={() => setShowAddInv(false)}
        />
      )}
      {showEditInv && selected && (
        <EditInvestmentModal
          investment={selected}
          onSave={saveEditedInv}
          onClose={() => setShowEditInv(false)}
        />
      )}
      {showBBModal && <BBModal onClose={() => setShowBBModal(false)} />}
      {toast && <Toast msg={toast.msg} type={toast.type} />}
      <div
        style={{
          background: T.black,
          borderTop: "1px solid #1a1a1a",
          padding: "6px 32px",
          display: "flex",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#333", fontSize: 11 }}>
          Thermo Investments Portal · Proprietary © {new Date().getFullYear()}
        </span>
        <span style={{ color: "#333", fontSize: 11 }}>
          Denver, CO · 1735 19th Street #200
        </span>
      </div>
    </div>
  );
}
