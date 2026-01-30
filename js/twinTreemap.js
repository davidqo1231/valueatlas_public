/* global d3 */

(function () {
  const TWIN_TREEMAP_VERSION = "20260120-14";
  const YEAR_MIN = 1995;
  const YEAR_MAX = 2022;
  const DEFAULT_COUNTRY = "SVK";
  const DEFAULT_YEAR = 2022;
  const ANIM_MS = 260;
  const TILE_PADDING = 8;
  const TILE_TEXT_Y_OFFSET = 2;
  const TILE_TEXT_MIN_GAP_PX = 3;
  const TILE_ELLIPSIS = "..";
  const TILE_NAME_LINE_HEIGHT_EM = 1.1;
  const TILE_NAME_MIN_FONT_PX = 9;
  const TILE_VALUE_MIN_FONT_PX = 9;
  const jsonCache = new Map(); // url -> parsed JSON
  let activeCleanup = null;

  function prefersReducedMotion() {
    try {
      return (
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch {
      return false;
    }
  }

  function makeStableId(prefix, raw) {
    return `${prefix}-${String(raw)}`.replace(/[^a-zA-Z0-9-_]/g, "_");
  }

  function wrapTextTwoLines(textEl, text, maxWidthPx) {
    const node = textEl.node();
    if (!node) return;
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    textEl.text(null);

    if (words.length === 0) return;

    let line = [];
    let lineNumber = 0;
    const lineHeightEm = 1.15;
    const x = textEl.attr("x") || 0;
    const y = textEl.attr("y") || 0;

    let tspan = textEl
      .append("tspan")
      .attr("x", x)
      .attr("y", y)
      .attr("dy", "0em");

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      line.push(w);
      tspan.text(line.join(" "));

      if (tspan.node().getComputedTextLength() > maxWidthPx && line.length > 1) {
        // Backtrack: put this word on a new line.
        line.pop();
        tspan.text(line.join(" "));

        line = [w];
        lineNumber += 1;
        if (lineNumber >= 2) {
          // Too many lines: truncate last line (no word splitting).
          let truncated = tspan.text();
          while (
            truncated &&
            tspan.node().getComputedTextLength() > maxWidthPx
          ) {
            const parts = truncated.split(" ");
            parts.pop();
            truncated = parts.join(" ");
            tspan.text(truncated ? `${truncated}…` : "…");
          }
          return;
        }

        tspan = textEl
          .append("tspan")
          .attr("x", x)
          .attr("y", y)
          .attr("dy", `${lineHeightEm}em`)
          .text(line.join(" "));
      }
    }

    // If a single long word still overflows, truncate with ellipsis.
    if (tspan.node().getComputedTextLength() > maxWidthPx) {
      const full = tspan.text();
      // Remove trailing words first (none in single-word case), then hard ellipsis.
      tspan.text(full ? `${full}…` : "…");
      while (tspan.node().getComputedTextLength() > maxWidthPx) {
        const s = tspan.text();
        if (s.length <= 1) break;
        tspan.text(s.slice(0, -2) + "…");
      }
    }
  }

  function truncateOneLine(textEl, text, maxWidthPx, { forceEllipsis = false } = {}) {
    const node = textEl.node();
    if (!node) return false;
    const full = String(text || "").trim();
    textEl.text(full);
    if (!full) return false;
    if (maxWidthPx <= 0) {
      textEl.text(TILE_ELLIPSIS);
      return true;
    }
    const fits = textEl.node().getComputedTextLength() <= maxWidthPx;
    if (fits && !forceEllipsis) return false;

    // Binary search the longest prefix that fits with ellipsis.
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = `${full.slice(0, mid).trimEnd()}${TILE_ELLIPSIS}`;
      textEl.text(candidate);
      if (textEl.node().getComputedTextLength() <= maxWidthPx) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const prefix = full.slice(0, lo).trimEnd();
    textEl.text(prefix ? `${prefix}${TILE_ELLIPSIS}` : TILE_ELLIPSIS);
    return true;
  }

  function wrapWordsMaxLines(textEl, text, maxWidthPx, { maxLines, lineHeightEm }) {
    const node = textEl.node();
    if (!node) return { linesUsed: 0 };

    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    textEl.text(null);
    if (words.length === 0) return { linesUsed: 0 };

    const safeMaxLines = Math.max(1, Math.min(3, Number(maxLines) || 1));
    const lh = Number.isFinite(Number(lineHeightEm)) ? Number(lineHeightEm) : 1.1;

    let lineIndex = 0;
    let lineWords = [];
    let ellipsized = false;

    const makeTspan = (dy) =>
      textEl.append("tspan").attr("x", TILE_PADDING).attr("dy", dy);

    let tspan = makeTspan("0em");

    for (let i = 0; i < words.length; i++) {
      const w = words[i];

      const candidate = lineWords.length ? `${lineWords.join(" ")} ${w}` : w;
      tspan.text(candidate);

      if (tspan.node().getComputedTextLength() <= maxWidthPx) {
        lineWords.push(w);
        continue;
      }

      if (lineWords.length === 0) {
        // Even the first word doesn't fit -> truncate and stop (looks better than wrapping).
        ellipsized = truncateOneLine(tspan, w, maxWidthPx, { forceEllipsis: true });
        return { linesUsed: 1, ellipsized };
      }

      // Commit previous line.
      tspan.text(lineWords.join(" "));
      lineIndex += 1;
      if (lineIndex >= safeMaxLines) {
        // No more lines available -> ellipsize the last line.
        ellipsized =
          truncateOneLine(tspan, `${lineWords.join(" ")} ${w}`.trim(), maxWidthPx, {
            forceEllipsis: true,
          }) || ellipsized;
        return { linesUsed: safeMaxLines, ellipsized };
      }

      // Start a new line with current word.
      lineWords = [w];
      tspan = makeTspan(`${lh}em`);
      tspan.text(w);
      if (tspan.node().getComputedTextLength() > maxWidthPx) {
        ellipsized =
          truncateOneLine(tspan, w, maxWidthPx, { forceEllipsis: true }) || ellipsized;
        return { linesUsed: lineIndex + 1, ellipsized };
      }
    }

    // Finalize last line.
    tspan.text(lineWords.join(" "));
    return { linesUsed: lineIndex + 1, ellipsized };
  }

  const _fontMetricsCache = new Map(); // key -> { ascent, descent }
  let _metricsCtx = null;
  function getFontMetrics(fontSizePx, fontFamily, fontWeight) {
    const size = Number(fontSizePx) || 12;
    const family = String(fontFamily || "sans-serif");
    const weight = String(fontWeight || "400");
    const key = `${weight}|${family}|${size}`;
    if (_fontMetricsCache.has(key)) return _fontMetricsCache.get(key);

    if (!_metricsCtx) {
      const canvas = document.createElement("canvas");
      _metricsCtx = canvas.getContext("2d");
    }

    const fallback = { ascent: size * 0.8, descent: size * 0.2 };
    if (!_metricsCtx) {
      _fontMetricsCache.set(key, fallback);
      return fallback;
    }

    _metricsCtx.font = `${weight} ${size}px ${family}`;
    const m = _metricsCtx.measureText("Hg");
    const ascent = Number(m.actualBoundingBoxAscent);
    const descent = Number(m.actualBoundingBoxDescent);

    const out = {
      ascent: Number.isFinite(ascent) && ascent > 0 ? ascent : fallback.ascent,
      descent: Number.isFinite(descent) && descent > 0 ? descent : fallback.descent,
    };
    _fontMetricsCache.set(key, out);
    return out;
  }

  function getDataUrl() {
    const params = new URLSearchParams(window.location.search);
    const byPath = params.get("data");
    if (byPath) return byPath;

    const country = params.get("country");
    const year = params.get("year");
    if (country && year) {
      return `data/tiva/FDVA/year=${encodeURIComponent(year)}/${encodeURIComponent(
        country.toUpperCase()
      )}.json`;
    }

    return `data/tiva/FDVA/year=${DEFAULT_YEAR}/${DEFAULT_COUNTRY}.json`;
  }

  function buildDataUrl(country, year) {
    const y = String(year);
    const c = String(country || DEFAULT_COUNTRY).toUpperCase();
    return `data/tiva/FDVA/year=${encodeURIComponent(y)}/${encodeURIComponent(c)}.json`;
  }

  function parseInitialRoute() {
    const params = new URLSearchParams(window.location.search);
    const byPath = params.get("data");
    if (byPath) {
      // Try to infer country/year from common path pattern.
      const m = byPath.match(/year=(\d{4})\/([A-Za-z]{3})\.json$/);
      const year = m ? Number(m[1]) : Number(params.get("year")) || DEFAULT_YEAR;
      const country = (m ? m[2] : params.get("country") || DEFAULT_COUNTRY).toUpperCase();
      return { country, year, dataUrl: byPath, hasDataOverride: true };
    }

    const country = (params.get("country") || DEFAULT_COUNTRY).toUpperCase();
    const year = Number(params.get("year")) || DEFAULT_YEAR;
    return { country, year, dataUrl: buildDataUrl(country, year), hasDataOverride: false };
  }

  function updateUrlParams({ country, year }) {
    const params = new URLSearchParams(window.location.search);
    params.set("country", String(country).toUpperCase());
    params.set("year", String(year));
    params.delete("data");
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", next);
  }

  async function fetchJson(url, { signal } = {}) {
    if (jsonCache.has(url)) return jsonCache.get(url);
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
    const data = await resp.json();
    jsonCache.set(url, data);
    return data;
  }

  function formatMil(value) {
    const n = Number(value) || 0;
    return `${new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
    }).format(n)} mil. $`;
  }

  function inferRawToUsdMultiplier(meta) {
    const unitRaw = String(meta?.value?.unit || "").trim().toLowerCase();
    if (unitRaw === "usd") return 1;
    if (unitRaw.includes("mil") || unitRaw.includes("million")) return 1e6;
    // TiVA FDVA in this repo is typically "millions of USD" (meta often says "as_reported").
    return 1e6;
  }

  function selectChartUnit(maxUsd) {
    const m = Number(maxUsd) || 0;
    if (m >= 1e12) return { unit: "T", scaleUsd: 1e12 };
    if (m >= 1e9) return { unit: "B", scaleUsd: 1e9 };
    if (m >= 1e6) return { unit: "M", scaleUsd: 1e6 };
    if (m >= 1e3) return { unit: "K", scaleUsd: 1e3 };
    return { unit: "", scaleUsd: 1 };
  }

  const _shortNumberFmtCache = new Map(); // maxFractionDigits -> Intl.NumberFormat
  function formatShortNumber(value, maxFractionDigits) {
    const v = Number(value);
    if (!Number.isFinite(v)) return "0";
    const d = Math.max(0, Math.min(6, Number(maxFractionDigits) || 0));
    if (!_shortNumberFmtCache.has(d)) {
      _shortNumberFmtCache.set(
        d,
        new Intl.NumberFormat("en-US", {
          useGrouping: false,
          maximumFractionDigits: d,
        })
      );
    }
    return _shortNumberFmtCache.get(d).format(v);
  }

  function decimalsForScaledValue(valueScaled) {
    const v = Math.abs(Number(valueScaled) || 0);
    if (v >= 100) return 0;
    if (v >= 10) return 1;
    if (v >= 1) return 2; // 1–2; favor readability + a bit more precision
    return 2;
  }

  function formatChartValueUsd(valueUsd, chartUnit) {
    const vUsd = Number(valueUsd) || 0;
    const scaleUsd = Number(chartUnit?.scaleUsd) || 1;
    const unit = String(chartUnit?.unit || "");
    const scaled = scaleUsd ? vUsd / scaleUsd : vUsd;
    const decimals = decimalsForScaledValue(scaled);
    const numberPart = formatShortNumber(scaled, decimals);
    return unit ? `${numberPart} ${unit}` : numberPart;
  }

  function formatMoneyUsd(valueUsd, unitSpec) {
    const vUsd = Number(valueUsd) || 0;
    const scaleUsd = Number(unitSpec?.scaleUsd) || 1;
    const unit = String(unitSpec?.unit || "");
    const scaled = scaleUsd ? vUsd / scaleUsd : vUsd;
    const decimals = decimalsForScaledValue(scaled);
    const numberPart = formatShortNumber(scaled, decimals);
    return `$${numberPart}${unit}`;
  }

  function formatMoneyAutoUsd(valueUsd) {
    const vUsd = Number(valueUsd) || 0;
    return formatMoneyUsd(vUsd, selectChartUnit(Math.abs(vUsd)));
  }

  function formatTotalLineUsd(totalUsd) {
    return `Total: ${formatMoneyAutoUsd(totalUsd)}`;
  }

  function formatPct(part, total) {
    const p = Number(part) || 0;
    const t = Number(total) || 0;
    if (!t || !isFinite(t)) return "—";
    const pct = (p / t) * 100;
    return `${new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 1,
    }).format(pct)}%`;
  }

  function colorOrFallback(map, key, fallback) {
    return map.get(key) || fallback;
  }

  function sumBy(items, keyFn, valueFn) {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      const v = Number(valueFn(it)) || 0;
      m.set(k, (m.get(k) || 0) + v);
    }
    return m;
  }

  function buildTooltip(el) {
    return {
      show(html, x, y) {
        el.innerHTML = html;
        this.move(x, y);
        el.classList.add("show");
      },
      move(x, y) {
        const pad = 12;
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;

        // Temporarily place to measure.
        el.style.left = `0px`;
        el.style.top = `0px`;

        const rect = el.getBoundingClientRect();
        const w = rect.width || 0;
        const h = rect.height || 0;

        let left = x + pad;
        let top = y + pad;

        if (left + w + pad > vw) left = Math.max(pad, x - w - pad);
        if (top + h + pad > vh) top = Math.max(pad, y - h - pad);

        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      },
      hide() {
        el.classList.remove("show");
      },
    };
  }

  function createGroupedTreemapRenderer(container, idPrefix, tooltip) {
    const sel = d3.select(container);

    let svg = sel.select("svg");
    if (svg.empty()) {
      svg = sel.append("svg");
      svg.append("g").attr("class", "groups");
      svg.append("g").attr("class", "leaves");
    }

    const gGroups = svg.select("g.groups");
    const gLeaves = svg.select("g.leaves");
    let currentSelectedLeafId = null;

    return {
      updateSelection({ selectedLeafId, animate }) {
        currentSelectedLeafId = selectedLeafId ?? null;
        const t =
          animate && !prefersReducedMotion()
            ? d3.transition().duration(ANIM_MS).ease(d3.easeCubicOut)
            : null;

        const rects = gLeaves.selectAll("g.node > rect");
        const apply = (sel0, fn) => (t ? sel0.transition(t).call(fn) : sel0.call(fn));
        apply(rects, (s) =>
          s.attr("opacity", (d) =>
            currentSelectedLeafId && d.data.id !== currentSelectedLeafId ? 0.55 : 1
          )
        );
      },

      renderLayout({
        groups,
        groupColorFn,
        groupTooltipHtmlFn,
        leafColorFn,
        leafLabelFn,
        leafValueFn,
        leafValueLabelFn,
        leafTooltipHtmlFn,
        onLeafClick,
        selectedLeafId,
        animate,
      }) {
        currentSelectedLeafId = selectedLeafId ?? null;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!w || !h) return;

        svg.attr("width", w).attr("height", h);

        const root = d3
          .hierarchy({ children: groups })
          .sum((d) =>
            d.children ? 0 : Math.max(0, Number(leafValueFn(d)) || 0)
          )
          .sort((a, b) => (b.value || 0) - (a.value || 0));

        d3
          .treemap()
          .size([w, h])
          .paddingOuter(1)
          .paddingInner(1)
          .tile(d3.treemapSquarify.ratio(1.15))
          .round(true)(root);

        const groupNodes = root.children || [];
        const leafNodes = root.leaves();

        const t =
          animate && !prefersReducedMotion()
            ? d3.transition().duration(ANIM_MS).ease(d3.easeCubicOut)
            : null;

        // GROUP BOUNDS (thin separators)
        const groupsSel = gGroups
          .selectAll("g.group")
          .data(groupNodes, (d) => d.data.id)
          .join(
            (enter) => {
              const g = enter.append("g").attr("class", "group");
              g.append("rect");
              return g;
            },
            (update) => update,
            (exit) => exit.remove()
          );

        const groupsRect = groupsSel
          .select("rect")
          .attr("fill", "none")
          .attr("stroke", "rgba(17,24,39,0.10)")
          .attr("stroke-width", 1)
          .on("mouseenter", (event, d) => {
            if (!tooltip || !groupTooltipHtmlFn) return;
            tooltip.show(groupTooltipHtmlFn(d.data, d.value || 0), event.clientX, event.clientY);
          })
          .on("mousemove", (event) => {
            if (!tooltip) return;
            tooltip.move(event.clientX, event.clientY);
          })
          .on("mouseleave", () => {
            if (!tooltip) return;
            tooltip.hide();
          });

        if (t) {
          groupsSel
            .transition(t)
            .attr("transform", (d) => `translate(${d.x0},${d.y0})`);
          groupsRect
            .transition(t)
            .attr("width", (d) => Math.max(0, d.x1 - d.x0))
            .attr("height", (d) => Math.max(0, d.y1 - d.y0));
        } else {
          groupsSel.attr("transform", (d) => `translate(${d.x0},${d.y0})`);
          groupsRect
            .attr("width", (d) => Math.max(0, d.x1 - d.x0))
            .attr("height", (d) => Math.max(0, d.y1 - d.y0));
        }

        // LEAVES
        const nodesSel = gLeaves
          .selectAll("g.node")
          .data(leafNodes, (d) => d.data.id)
          .join(
            (enter) => {
              const g = enter.append("g").attr("class", "node");
              g.append("rect");
              // Keep labels in a separate layer without clip-path (prevents top clipping).
              const labels = g.append("g").attr("class", "labels");
              labels.append("text").attr("class", "tileName");
              labels.append("text").attr("class", "tileValue");
              return g;
            },
            (update) => update,
            (exit) => exit.remove()
          );

        const targetOpacity = (d) =>
          currentSelectedLeafId && d.data.id !== currentSelectedLeafId ? 0.55 : 1;

        const rectSel = nodesSel
          .select("rect")
          .attr("fill", (d) => leafColorFn(d.data))
          .attr("stroke", "rgba(255,255,255,0.9)")
          .attr("stroke-width", 1)
          .style("cursor", onLeafClick ? "pointer" : "default")
          .on("mouseenter", (event, d) => {
            if (!tooltip || !leafTooltipHtmlFn) return;
            tooltip.show(leafTooltipHtmlFn(d.data, d.value || 0), event.clientX, event.clientY);
          })
          .on("mousemove", (event) => {
            if (!tooltip) return;
            tooltip.move(event.clientX, event.clientY);
          })
          .on("mouseleave", () => {
            if (!tooltip) return;
            tooltip.hide();
          })
          .on("click", (event, d) => {
            if (onLeafClick) onLeafClick(event, d.data);
          });

        const labelsSel = nodesSel
          .select("g.labels")
          .attr("pointer-events", "none");

        const nameSel = labelsSel
          .select("text.tileName")
          .attr("text-anchor", "start")
          .attr("x", TILE_PADDING)
          .attr("fill", "#fff")
          .attr("font-weight", 400)
          .text(null);

        const valueSel = labelsSel
          .select("text.tileValue")
          .attr("text-anchor", "start")
          .attr("x", TILE_PADDING)
          .attr("fill", "rgba(255,255,255,0.92)")
          .attr("font-weight", 400)
          .text(null);

        const apply = (sel0, fn) => (t ? sel0.transition(t).call(fn) : sel0.call(fn));

        apply(nodesSel, (s) =>
          s.attr("transform", (d) => `translate(${d.x0},${d.y0})`)
        );
        apply(rectSel, (s) =>
          s
            .attr("width", (d) => Math.max(0, d.x1 - d.x0))
            .attr("height", (d) => Math.max(0, d.y1 - d.y0))
            .attr("opacity", (d) => targetOpacity(d))
        );

        // Text sizing/visibility (no animation, keep it cheap)
        const containerStyle = window.getComputedStyle(container);
        const fontFamily = containerStyle.fontFamily || "sans-serif";
        const fontWeight = containerStyle.fontWeight || "400";

        nodesSel.each(function (d) {
          const width = d.x1 - d.x0;
          const height = d.y1 - d.y0;
          const maxTextWidth = Math.max(0, width - TILE_PADDING * 2);
          const labelSizeBase = Math.max(11, Math.min(22, width / 9));
          const valueSizeBase = Math.max(11, Math.min(20, width / 11));

          const name = d3.select(this).select("text.tileName");
          const value = d3.select(this).select("text.tileValue");

          // Keep elements measurable (no `display:none`) until we decide what to show.
          name.style("display", null).text(null);
          value.style("display", null).text(null);
          if (maxTextWidth < 10 || width < 28 || height < 22) return;

          // NAME: top-left aligned, independent of font-size (baseline y computed from ascent).
          const nameTop = TILE_PADDING + TILE_TEXT_Y_OFFSET;
          const availableNameHeight = height - TILE_PADDING - nameTop;
          const showName = width >= 46 && height >= 28;

          let nameBlockBottom = nameTop;
          let nameShown = false;
          if (showName) {
            for (
              let labelSize = Math.floor(labelSizeBase);
              labelSize >= TILE_NAME_MIN_FONT_PX;
              labelSize -= 1
            ) {
              const labelMetrics = getFontMetrics(labelSize, fontFamily, "400");
              const line0 = labelMetrics.ascent + labelMetrics.descent;
              const allow1 = availableNameHeight >= line0;
              const allow2 =
                availableNameHeight >= line0 + labelSize * TILE_NAME_LINE_HEIGHT_EM;
              const maxNameLines = allow2 ? 2 : allow1 ? 1 : 0;
              if (maxNameLines === 0) continue;

              const nameBaselineY = nameTop + labelMetrics.ascent;
              name
                .attr("x", TILE_PADDING)
                .attr("y", nameBaselineY)
                .attr("font-size", labelSize)
                .attr("font-family", fontFamily)
                .attr("font-weight", 400)
                .text(null);

              let ellipsized = false;
              let linesUsed = 1;

              if (maxNameLines >= 2) {
                const r = wrapWordsMaxLines(name, d.data.label, maxTextWidth, {
                  maxLines: 2,
                  lineHeightEm: TILE_NAME_LINE_HEIGHT_EM,
                });
                linesUsed = r.linesUsed || 1;
                ellipsized = !!r.ellipsized;
              } else {
                ellipsized = truncateOneLine(name, d.data.label, maxTextWidth);
                linesUsed = 1;
              }

              nameShown = true;
              nameBlockBottom =
                nameTop + line0 + (linesUsed >= 2 ? labelSize * TILE_NAME_LINE_HEIGHT_EM : 0);

              // Prefer shrinking before using ellipsis.
              if (!ellipsized) break;
              if (labelSize === TILE_NAME_MIN_FONT_PX) break;
            }
          }
          if (!nameShown) name.style("display", "none");

          // VALUE: bottom-left aligned (as before), independent of font-size (baseline y uses descent).
          const valueBottom = height - TILE_PADDING;
          const minTop = nameShown ? nameBlockBottom + TILE_TEXT_MIN_GAP_PX : nameTop;
          const showValue = width >= 54;
          if (!showValue) {
            value.style("display", "none");
            return;
          }

          const valueLabel = leafValueLabelFn
            ? leafValueLabelFn(d.data)
            : formatMil(leafValueFn(d.data));

          let valueShown = false;
          for (
            let valueSize = Math.floor(valueSizeBase);
            valueSize >= TILE_VALUE_MIN_FONT_PX;
            valueSize -= 1
          ) {
            const valueMetrics = getFontMetrics(valueSize, fontFamily, "400");
            const valueBaselineY = valueBottom - valueMetrics.descent;
            const valueTop = valueBaselineY - valueMetrics.ascent;
            if (valueTop < minTop) continue;

            value
              .attr("x", TILE_PADDING)
              .attr("y", valueBaselineY)
              .attr("font-size", valueSize)
              .attr("font-family", fontFamily)
              .attr("font-weight", 400)
              .text(null);

            const ellipsized = truncateOneLine(value, valueLabel, maxTextWidth);
            valueShown = true;

            // Prefer shrinking before using ellipsis.
            if (!ellipsized) break;
            if (valueSize === TILE_VALUE_MIN_FONT_PX) break;
          }

          value.style("display", valueShown ? null : "none");
        });
      },
    };
  }

  function ensureTooltipEl() {
    let el = document.getElementById("tooltip");
    if (!el) {
      el = document.createElement("div");
      el.id = "tooltip";
      el.setAttribute("role", "tooltip");
      document.body.appendChild(el);
    }
    return el;
  }

  function normalizeYear(y) {
    const n = Number(y);
    if (!Number.isFinite(n)) return DEFAULT_YEAR;
    return Math.min(YEAR_MAX, Math.max(YEAR_MIN, n));
  }

  function normalizeCountry(c) {
    return String(c || DEFAULT_COUNTRY).toUpperCase();
  }

  function defaultElements() {
    return {
      sectorTreemap: document.getElementById("sectorTreemap"),
      countryTreemap: document.getElementById("countryTreemap"),
      resetBtn: document.getElementById("resetBtn"),
      toggleDomesticBtn: document.getElementById("toggleDomesticBtn"),
      toggleDomesticToggle: document.getElementById("toggleDomesticToggle"),
      selectionCountryLabel: document.getElementById("selectionCountryLabel"),
      selectionSectorLabel: document.getElementById("selectionSectorLabel"),
      countryTotal: document.getElementById("countryTotal"),
      sectorTotal: document.getElementById("sectorTotal"),
      dataPath: document.getElementById("dataPath"),
    };
  }

  function clearContainer(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderEmptyMessage(el, message) {
    if (!el) return;
    clearContainer(el);
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "center";
    wrap.style.height = "100%";
    wrap.style.minHeight = "220px";
    wrap.style.padding = "18px";
    wrap.style.textAlign = "center";
    wrap.style.color = "#6b7280";
    wrap.style.fontSize = "12px";
    wrap.style.lineHeight = "1.35";
    wrap.textContent = String(message || "");
    el.appendChild(wrap);
  }

  function setSelectionLabelStyle(el, { isSelected, color }) {
    if (!el) return;
    el.classList.toggle("is-selected", !!isSelected);
    el.style.color = isSelected && color ? String(color) : "";
  }

  async function renderTwinTreemap(config = {}) {
    if (!window.d3) {
      throw new Error("d3 is not loaded. Check the script tag in index.html.");
    }

    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }

    const abort = new AbortController();
    const onError =
      typeof config.onError === "function" ? config.onError : null;

    const els = config.elements || defaultElements();
    const elSector = els.sectorTreemap;
    const elCountry = els.countryTreemap;
    const elReset = els.resetBtn;
    const elToggleDomesticBtn = els.toggleDomesticBtn;
    const elToggleDomesticToggle = els.toggleDomesticToggle;
    const elSelectionCountry = els.selectionCountryLabel;
    const elSelectionSector = els.selectionSectorLabel;
    const elCountryTotal = els.countryTotal;
    const elSectorTotal = els.sectorTotal;
    const elDataPath = els.dataPath;

    if (!elSector || !elCountry) {
      if (onError) {
        onError("Missing required containers: #sectorTreemap and/or #countryTreemap.");
      }
      return;
    }

    clearContainer(elSector);
    clearContainer(elCountry);

    const tooltipEl = ensureTooltipEl();
    const tooltip = buildTooltip(tooltipEl);
    const sectorRenderer = createGroupedTreemapRenderer(elSector, "sectors", tooltip);
    const countryRenderer = createGroupedTreemapRenderer(
      elCountry,
      "countries",
      tooltip
    );
    let lastSectorLayoutKey = null;
    let lastCountryLayoutKey = null;

    let currentCountry = normalizeCountry(config.country);
    let currentYear = normalizeYear(config.year);

    const dataUrl = config.dataUrl
      ? String(config.dataUrl)
      : buildDataUrl(currentCountry, currentYear);
    if (elDataPath) elDataPath.textContent = dataUrl;

    if (onError) onError("");

    let data;
    try {
      data = await fetchJson(dataUrl, { signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) return;
      const msg = `No data available for ${currentCountry} in ${currentYear}. Try another year.`;
      if (onError) onError(msg);
      // Keep the page interactive (dropdown etc.) even if this year/country is missing.
      return;
    }

    if (data && data.meta && Number.isFinite(data.meta.year)) {
      currentYear = normalizeYear(data.meta.year);
    }
    if (data && data.meta && data.meta.origin_country && data.meta.origin_country.code) {
      currentCountry = normalizeCountry(data.meta.origin_country.code);
    }

    const rawToUsd = inferRawToUsdMultiplier(data?.meta);

    const leafSectors = (data.sectors || []).filter((s) => Number(s.is_leaf) === 1);
    const realCountries = (data.demandCountries || []).filter(
      (c) => Number(c.is_country) === 1
    );

    const sectorById = new Map(leafSectors.map((s) => [s.id, s]));
    const countryById = new Map(realCountries.map((c) => [c.id, c]));

    const linksRaw = Array.isArray(data.links) ? data.links : [];
    const links = linksRaw.filter(
      (l) => sectorById.has(l.sector) && countryById.has(l.demand)
    );

    // Countries: keep grouping by continent (as before), but use a palette close to your spec.
    const CONTINENT_COLORS = new Map([
      ["Europe", "#60A5FA"],
      ["North America", "#52DCCE"],
      ["South America", "#41B1A6"],
      ["Asia", "#E083AC"],
      ["Oceania", "#DC9354"],
      ["Africa", "#BF8F1C"],
      ["Unknown", "#837E7B"],
    ]);

    const continentColor = (continent) =>
      colorOrFallback(CONTINENT_COLORS, continent || "Unknown", "#837E7B");

    // Sections -> consistent, *high-contrast* colors (between families).
    // This is intentionally more saturated/distinct than the country palette.
    // Keys match `section_long_name` in `mappings/industries_tiva.csv`.
    const SECTION_COLOR_BY_LONG = new Map([
      ["Agriculture, forestry and fishing", "#F28E2B"], // orange
      ["Mining and quarrying", "#EDC948"], // yellow
      ["Manufacturing", "#4E79A7"], // blue
      ["Electricity, gas, water and waste", "#59A14F"], // green
      ["Construction", "#9C755F"], // brown
      ["Wholesale and retail trade", "#E083AC"], // pink
      ["Transportation and storage", "#76B7B2"], // teal
      ["Information and communication", "#52DCCE"], // mint
      ["Professional and administrative services", "#B07AA1"], // purple
      ["Financial services and real estate", "#5E5A59"], // dark grey
      ["Public administration, education and health", "#C7508A"], // magenta
      ["Accommodation and food services", "#E15759"], // red
      ["Arts, recreation and other services", "#837E7B"], // grey
      ["SERVICES", "#A9A39F"], // aggregate
      ["ALL", "#BAB0AC"], // aggregate
    ]);

    const SECTION_PALETTE = [
      "#F3C09F",
      "#DC9354",
      "#BF8F1C",
      "#AB7240",
      "#7C512C",
      "#E083AC",
      "#C7508A",
      "#903863",
      "#69AAAF",
      "#508387",
      "#52DCCE",
      "#41B1A6",
      "#308980",
      "#A9A39F",
      "#837E7B",
      "#5E5A59",
    ];

    function sectionColor(sectionCode, sectionLongName) {
      if (sectionLongName && SECTION_COLOR_BY_LONG.has(sectionLongName)) {
        return SECTION_COLOR_BY_LONG.get(sectionLongName);
      }
      if (!sectionCode) return "#A9A39F";
      // stable fallback: hash code -> palette index
      let h = 0;
      for (let i = 0; i < sectionCode.length; i++) {
        h = (h * 31 + sectionCode.charCodeAt(i)) >>> 0;
      }
      return SECTION_PALETTE[h % SECTION_PALETTE.length];
    }

    const sectionCodes = Array.from(
      new Set(leafSectors.map((s) => (s.section && s.section.code) || "UNK"))
    ).sort();
    const sectionScale = d3.scaleOrdinal().domain(sectionCodes).range(
      sectionCodes.map((code) => {
        const firstMatch = leafSectors.find(
          (s) => (s.section && s.section.code) === code
        );
        const longName = firstMatch?.section?.long_name || null;
        return sectionColor(code, longName);
      })
    );

    const domesticCountryId =
      (data &&
        data.meta &&
        data.meta.origin_country &&
        data.meta.origin_country.code) ||
      null;

    // Precompute adjacency maps for fast interaction (no filtering loops on every click).
    const sectorToCountry = new Map(); // sector -> Map(country -> value)
    const countryToSector = new Map(); // country -> Map(sector -> value)

    for (const l of links) {
      const sector = l.sector;
      const country = l.demand;
      const value = Number(l.value) || 0;

      if (!sectorToCountry.has(sector)) sectorToCountry.set(sector, new Map());
      const m1 = sectorToCountry.get(sector);
      m1.set(country, (m1.get(country) || 0) + value);

      if (!countryToSector.has(country)) countryToSector.set(country, new Map());
      const m2 = countryToSector.get(country);
      m2.set(sector, (m2.get(sector) || 0) + value);
    }

    const allSectorTotalsAll = new Map();
    const allCountryTotalsAll = new Map();
    for (const [sector, m] of sectorToCountry) {
      let s = 0;
      for (const v of m.values()) s += v;
      allSectorTotalsAll.set(sector, s);
    }
    for (const [country, m] of countryToSector) {
      let s = 0;
      for (const v of m.values()) s += v;
      allCountryTotalsAll.set(country, s);
    }

    const allSectorTotalsNoDomestic = new Map();
    const allCountryTotalsNoDomestic = new Map();
    if (domesticCountryId) {
      // Sector totals excluding domestic demand
      for (const [sector, m] of sectorToCountry) {
        let s = 0;
        for (const [country, v] of m) {
          if (country === domesticCountryId) continue;
          s += v;
        }
        allSectorTotalsNoDomestic.set(sector, s);
      }
      // Country totals excluding domestic country entirely
      for (const [country, total] of allCountryTotalsAll) {
        if (country === domesticCountryId) continue;
        allCountryTotalsNoDomestic.set(country, total);
      }
    }

    const state = {
      selectedSectorId: null,
      selectedCountryId: null,
      hideDomestic: false,
    };

    function updateDomesticButton() {
      if (elToggleDomesticToggle) elToggleDomesticToggle.checked = !!state.hideDomestic;

      if (!domesticCountryId) {
        if (elToggleDomesticToggle) {
          elToggleDomesticToggle.disabled = true;
          elToggleDomesticToggle.title = "No origin country in dataset meta";
        }
        if (elToggleDomesticBtn) {
          elToggleDomesticBtn.disabled = true;
          elToggleDomesticBtn.title = "No origin country in dataset meta";
        }
      } else {
        if (elToggleDomesticToggle) {
          elToggleDomesticToggle.disabled = false;
          elToggleDomesticToggle.title = `Origin country: ${domesticCountryId}`;
        }
        if (elToggleDomesticBtn) {
          elToggleDomesticBtn.disabled = false;
          elToggleDomesticBtn.title = `Origin country: ${domesticCountryId}`;
        }
      }
    }

    function sectorNodesForSelection() {
      const totals =
        state.selectedCountryId == null
          ? state.hideDomestic && domesticCountryId
            ? allSectorTotalsNoDomestic
            : allSectorTotalsAll
          : countryToSector.get(state.selectedCountryId) || new Map();

      return leafSectors
        .map((s) => ({
          id: s.id,
          label: s.short_name || s.long_name || s.id,
          longName: s.long_name || s.short_name || s.id,
          code: s.id,
          section: (s.section && s.section.code) || "UNK",
          sectionShortName: (s.section && s.section.short_name) || "Unknown",
          sectionLongName: (s.section && s.section.long_name) || "Unknown",
          value: totals.get(s.id) || 0,
        }))
        .filter((n) => n.value > 0)
        .sort((a, b) => b.value - a.value);
    }

    function countryNodesForSelection() {
      const totals =
        state.selectedSectorId == null
          ? state.hideDomestic && domesticCountryId
            ? allCountryTotalsNoDomestic
            : allCountryTotalsAll
          : sectorToCountry.get(state.selectedSectorId) || new Map();

      return realCountries
        .map((c) => ({
          id: c.id,
          label: c.name || c.id,
          continent: c.continent || "Unknown",
          value: totals.get(c.id) || 0,
        }))
        .filter(
          (n) =>
            !state.hideDomestic ||
            !domesticCountryId ||
            n.id !== domesticCountryId
        )
        .filter((n) => n.value > 0)
        .sort((a, b) => b.value - a.value);
    }

    function continentGroups(countryNodes) {
      const byContinent = new Map();
      for (const n of countryNodes) {
        const cont = n.continent || "Unknown";
        if (!byContinent.has(cont)) byContinent.set(cont, []);
        byContinent.get(cont).push(n);
      }

      const groups = Array.from(byContinent, ([continent, children]) => {
        children.sort((a, b) => b.value - a.value);
        const total = children.reduce((s, c) => s + (Number(c.value) || 0), 0);
        return {
          id: `continent:${continent}`,
          continent,
          label: continent,
          value: total,
          children,
        };
      });

      groups.sort((a, b) => (b.value || 0) - (a.value || 0));
      return groups;
    }

    function sectionGroups(sectorNodes) {
      const bySection = new Map();
      for (const n of sectorNodes) {
        const code = n.section || "UNK";
        if (!bySection.has(code)) bySection.set(code, []);
        bySection.get(code).push(n);
      }

      const groups = Array.from(bySection, ([sectionCode, children]) => {
        children.sort((a, b) => b.value - a.value);
        const total = children.reduce((s, c) => s + (Number(c.value) || 0), 0);
        const label =
          children[0]?.sectionLongName ||
          children[0]?.sectionShortName ||
          sectionCode;
        return {
          id: `section:${sectionCode}`,
          sectionCode,
          label,
          value: total,
          children,
        };
      });

      groups.sort((a, b) => (b.value || 0) - (a.value || 0));
      return groups;
    }

    function renderAll({ animate = true } = {}) {
      if (
        state.hideDomestic &&
        domesticCountryId &&
        state.selectedCountryId === domesticCountryId
      ) {
        state.selectedCountryId = null;
      }

      const sectorLabel =
        state.selectedSectorId == null
          ? "No sector filter"
          : sectorById.get(state.selectedSectorId)?.short_name ||
            sectorById.get(state.selectedSectorId)?.long_name ||
            state.selectedSectorId;
      if (elSelectionSector) elSelectionSector.textContent = sectorLabel;
      if (elSelectionSector) {
        const s = state.selectedSectorId ? sectorById.get(state.selectedSectorId) : null;
        const sectionCode = s?.section?.code || "UNK";
        setSelectionLabelStyle(elSelectionSector, {
          isSelected: !!state.selectedSectorId,
          color: state.selectedSectorId ? sectionScale(sectionCode) : null,
        });
      }

      const countryLabel =
        state.selectedCountryId == null
          ? "No country filter"
          : countryById.get(state.selectedCountryId)?.name || state.selectedCountryId;
      if (elSelectionCountry) elSelectionCountry.textContent = countryLabel;
      if (elSelectionCountry) {
        const c = state.selectedCountryId ? countryById.get(state.selectedCountryId) : null;
        setSelectionLabelStyle(elSelectionCountry, {
          isSelected: !!state.selectedCountryId,
          color: state.selectedCountryId ? continentColor(c?.continent) : null,
        });
      }

      const sectorNodes = sectorNodesForSelection();
      const sectorTotal = sectorNodes.reduce(
        (s, n) => s + (Number(n.value) || 0),
        0
      );
      const sectorTotalUsd = sectorTotal * rawToUsd;
      if (elSectorTotal) {
        elSectorTotal.textContent = formatTotalLineUsd(sectorTotalUsd);
      }
      const sectorGroups = sectionGroups(sectorNodes);
      const sectorLayoutKey = `${state.hideDomestic ? "nd" : "all"}|${
        state.selectedCountryId || ""
      }`;
      if (sectorGroups.length === 0) {
        lastSectorLayoutKey = null;
        renderEmptyMessage(
          elSector,
          "No results for this selection. Clear selection or choose a different year."
        );
      } else if (sectorLayoutKey !== lastSectorLayoutKey) {
        lastSectorLayoutKey = sectorLayoutKey;
        sectorRenderer.renderLayout({
          groups: sectorGroups,
          groupColorFn: (d) => sectionScale(d.sectionCode),
          groupTooltipHtmlFn: (d, v) =>
            `<div style="font-weight:750;font-size:13px">${d.label}</div>
             <div style="margin-top:6px;font-weight:650">Value added embodied in final demand: ${formatMoneyAutoUsd(
               v * rawToUsd
             )}</div>`,
          leafColorFn: (d) => sectionScale(d.section),
          leafLabelFn: (d) => d.label,
          leafValueFn: (d) => d.value,
          leafValueLabelFn: (d) => formatMoneyAutoUsd(d.value * rawToUsd),
          leafTooltipHtmlFn: (d) =>
            `<div style="opacity:.85;font-weight:650">Sector</div>
             <div style="font-weight:750;font-size:13px">${d.longName}</div>
             <div style="opacity:.85">${d.sectionLongName}</div>
             <div style="margin-top:6px;font-weight:650">Value added embodied in final demand: ${formatMoneyAutoUsd(
               d.value * rawToUsd
             )}</div>
             <div style="opacity:.85">Share of selection: ${formatPct(
               d.value,
               sectorTotal
             )}</div>`,
          selectedLeafId: state.selectedSectorId,
          onLeafClick: (_, d) => {
            state.selectedSectorId =
              state.selectedSectorId === d.id ? null : d.id;
            state.selectedCountryId = null;
            renderAll({ animate: true });
          },
          animate,
        });
      } else {
        sectorRenderer.updateSelection({
          selectedLeafId: state.selectedSectorId,
          animate,
        });
      }

      const cNodes = countryNodesForSelection();
      const countryTotal = cNodes.reduce(
        (s, n) => s + (Number(n.value) || 0),
        0
      );
      const countryTotalUsd = countryTotal * rawToUsd;
      if (elCountryTotal) {
        elCountryTotal.textContent = formatTotalLineUsd(countryTotalUsd);
      }
      const groups = continentGroups(cNodes);
      const countryLayoutKey = `${state.hideDomestic ? "nd" : "all"}|${
        state.selectedSectorId || ""
      }`;
      if (groups.length === 0) {
        lastCountryLayoutKey = null;
        renderEmptyMessage(
          elCountry,
          "No results for this selection. Clear selection or choose a different year."
        );
      } else if (countryLayoutKey !== lastCountryLayoutKey) {
        lastCountryLayoutKey = countryLayoutKey;
        countryRenderer.renderLayout({
          groups,
          groupColorFn: (d) => continentColor(d.continent),
          groupTooltipHtmlFn: (d, v) =>
            `<div style="font-weight:750;font-size:13px">${d.label}</div>
             <div style="margin-top:6px;font-weight:650">Value added embodied in final demand: ${formatMoneyAutoUsd(
               v * rawToUsd
             )}</div>`,
          leafColorFn: (d) => continentColor(d.continent),
          leafLabelFn: (d) => d.label,
          leafValueFn: (d) => d.value,
          leafValueLabelFn: (d) => formatMoneyAutoUsd(d.value * rawToUsd),
          leafTooltipHtmlFn: (d) =>
            `<div style="opacity:.85;font-weight:650">Final demand country</div>
             <div style="font-weight:750;font-size:13px">${d.label}</div>
             <div style="opacity:.85">${d.continent}</div>
             <div style="margin-top:6px;font-weight:650">Value added from origin embodied here: ${formatMoneyAutoUsd(
               d.value * rawToUsd
             )}</div>
             <div style="opacity:.85">Share of selection: ${formatPct(
               d.value,
               countryTotal
             )}</div>`,
          selectedLeafId: state.selectedCountryId,
          onLeafClick: (_, d) => {
            state.selectedCountryId =
              state.selectedCountryId === d.id ? null : d.id;
            state.selectedSectorId = null;
            renderAll({ animate: true });
          },
          animate,
        });
      } else if (groups.length > 0) {
        countryRenderer.updateSelection({
          selectedLeafId: state.selectedCountryId,
          animate,
        });
      }
    }

    let resizeTimer = null;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => renderAll({ animate: false }), 120);
    };
    window.addEventListener("resize", onResize);

    updateDomesticButton();
    renderAll({ animate: false });

    const onReset = () => {
      state.selectedCountryId = null;
      state.selectedSectorId = null;
      renderAll({ animate: true });
    };
    const onToggleBtn = () => {
      state.hideDomestic = !state.hideDomestic;
      updateDomesticButton();
      renderAll({ animate: true });
    };
    const onToggleCheckbox = () => {
      state.hideDomestic = !!elToggleDomesticToggle.checked;
      updateDomesticButton();
      renderAll({ animate: true });
    };

    // Re-bind listeners with stable references so we can remove them in cleanup.
    if (elReset) {
      elReset.addEventListener("click", onReset);
    }
    if (elToggleDomesticToggle) {
      elToggleDomesticToggle.addEventListener("change", onToggleCheckbox);
    }
    if (elToggleDomesticBtn) {
      elToggleDomesticBtn.addEventListener("click", onToggleBtn);
    }

    activeCleanup = () => {
      abort.abort();
      tooltip.hide();
      window.removeEventListener("resize", onResize);
      if (elReset) elReset.removeEventListener("click", onReset);
      if (elToggleDomesticToggle) elToggleDomesticToggle.removeEventListener("change", onToggleCheckbox);
      if (elToggleDomesticBtn) elToggleDomesticBtn.removeEventListener("click", onToggleBtn);
      clearContainer(elSector);
      clearContainer(elCountry);
    };
  }

  window.renderTwinTreemap = renderTwinTreemap;
  window.__TWIN_TREEMAP_VERSION = TWIN_TREEMAP_VERSION;
})();
