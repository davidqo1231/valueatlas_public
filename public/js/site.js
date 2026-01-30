(() => {
  const COUNTRIES_URL = "data/meta/countries.json";
  let _countriesPromise = null;

  function parseQuery(search = window.location.search) {
    const params = new URLSearchParams(search || "");
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }

  function setQueryParam(key, value, { replace = true } = {}) {
    const url = new URL(window.location.href);
    if (value == null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
    if (replace) window.history.replaceState(null, "", url.toString());
    else window.history.pushState(null, "", url.toString());
  }

  function normCode(raw, fallback = "SVK") {
    const c = String(raw || "").trim().toUpperCase();
    return c || fallback;
  }

  async function loadCountries() {
    if (_countriesPromise) return _countriesPromise;
    _countriesPromise = fetch(COUNTRIES_URL, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${COUNTRIES_URL}: ${r.status}`);
        return r.json();
      })
      .then((data) => (Array.isArray(data) ? data : []));
    return _countriesPromise;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function text(node, value) {
    if (!node) return;
    node.textContent = value == null ? "" : String(value);
  }

  function createCountryCard(c) {
    const a = document.createElement("a");
    a.className = "country-card";
    a.href = `country-profile.html?country=${encodeURIComponent(c.code)}`;
    a.setAttribute("data-code", c.code);
    a.setAttribute("data-name", c.name);

    const name = document.createElement("div");
    name.className = "country-name mono";
    name.textContent = c.name;

    const code = document.createElement("div");
    code.className = "country-code";
    code.textContent = `${c.code}${c.continent ? ` • ${c.continent}` : ""}`;

    a.appendChild(name);
    a.appendChild(code);
    return a;
  }

  function matchCountry(c, q) {
    const query = String(q || "").trim().toLowerCase();
    if (!query) return true;
    const code = String(c.code || "").toLowerCase();
    const name = String(c.name || "").toLowerCase();
    return code.includes(query) || name.includes(query);
  }

  async function initHome() {
    const input = el("countrySearch");
    const grid = el("countryGrid");
    if (!grid) return;

    const countries = await loadCountries();
    let currentQuery = input ? input.value : "";

    function render() {
      grid.innerHTML = "";
      const filtered = countries.filter((c) => matchCountry(c, currentQuery));
      for (const c of filtered) grid.appendChild(createCountryCard(c));
    }

    render();

    if (input) {
      input.addEventListener("input", () => {
        currentQuery = input.value;
        render();
      });
    }
  }

  function setupAutoHeight(iframe, { minHeight = 700 } = {}) {
    if (!iframe) return;

    function onMessage(event) {
      const data = event && event.data ? event.data : null;
      if (!data || data.type !== "twinTreemap:height") return;
      if (event.source !== iframe.contentWindow) return;
      const height = Number(data.height);
      if (!Number.isFinite(height) || height <= 0) return;
      iframe.style.height = `${Math.max(minHeight, Math.ceil(height))}px`;
    }

    window.addEventListener("message", onMessage);
  }

  async function initCountryProfile() {
    const q = parseQuery();
    const code = normCode(q.country, "SVK");
    const year = q.year ? String(q.year) : null;

    const countries = await loadCountries();
    const info = countries.find((c) => String(c.code).toUpperCase() === code) || null;

    text(el("countryName"), info ? info.name : code);
    text(el("countryCode"), code);
    text(el("countryContinent"), info && info.continent ? info.continent : "—");

    document.title = info ? `${info.name} (${code}) — ValueAtlas` : `${code} — ValueAtlas`;

    const iframe = el("twinTreemapEmbed");
    if (iframe) {
      const params = new URLSearchParams();
      params.set("country", code);
      if (year) params.set("year", year);
      iframe.src = `embeds/twinTreemap.html?${params.toString()}`;
      setupAutoHeight(iframe, { minHeight: 700 });
    }
  }

  function init() {
    const page = document.body ? document.body.getAttribute("data-page") : "";
    if (page === "home") initHome().catch(console.error);
    if (page === "country-profile") initCountryProfile().catch(console.error);
  }

  window.Site = {
    parseQuery,
    setQueryParam,
    loadCountries,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
