/*
 * design-scan.js —— 前端設計確定性偵測器（不需 LLM，在瀏覽器頁面內執行）
 *
 * 出處：改寫自 pbakaus/impeccable（Apache-2.0）
 *       https://github.com/pbakaus/impeccable
 *       commit ece38d9904b8a619b3f77cab476eacad09c4fb11
 *       規則清單：crates/live/assets/antipatterns.json（61 條）
 *       規則邏輯：crates/core/src/browser/*.rs、crates/core/src/checks/*.rs、
 *                 crates/detect/src/regex_matchers.rs（buzzword／cadence／broken-image）
 *       原作 Copyright (c) 2026 Paul Bakaus，依 Apache License 2.0 授權。
 *       本檔為改寫（衍生作品）：以原 Rust 實作的門檻與判準為準，改寫成單一、
 *       不依賴外部套件、不發網路請求的 DOM 版本；與原作的差異寫在
 *       design-rules.md 的「與原作的差異」一節。
 *
 * 用法：整份檔案是一個運算式，丟進 page.evaluate(原始碼字串) 就會回傳結果：
 *   { 規則數, 命中: [{ id, 嚴重度, 說明, 選擇器或節點描述, 細節 }], 略過, 錯誤 }
 *
 * 選項（可省略）：在注入前先設 globalThis.__DESIGN_SCAN_OPTIONS__ = {...}
 *   行長上限      line-length 的字數上限（預設 80）
 *   設計系統      { 字型: [...], 顏色: ['#112233', ...], 圓角: [8, 12], 字級: [14, 16, 24],
 *                  允許膠囊圓角: true, 宣告的選擇器: ['.eyebrow'] }
 *                 —— 沒給就不跑 design-system-* 四條（放進「略過」）
 *   只列規則      true 時只回傳規則清單，不掃描
 *   錯誤收集器    script-error 讀的陣列名稱（預設 '__designScanErrors'），
 *                 要在頁面載入前用 addInitScript 裝好（見 design-rules.md）
 *
 * 誤報防線（沿用 inspect-ui 重疊偵測器踩過的坑）：
 *   - 逐元素規則只看「真的有畫出來」的元素：checkVisibility() 會往上看整條
 *     祖先鏈的 display:none／visibility／opacity:0／content-visibility。
 *   - 會被 position:fixed／sticky 祖先帶著走的東西，在遮擋類規則（text-occlusion、
 *     heading-rhythm、body-text-viewport-edge）裡往上走祖先鏈判斷，不只看自己。
 *   - getBoundingClientRect 回的是幾何不是視覺：行長用逐行框（Range.getClientRects
 *     併成行），遮擋用 elementFromPoint 取樣，且先被 overflow 祖先裁切。
 *   - data-impeccable-ignore／data-design-scan-ignore="規則id …" 可在子樹內停用規則。
 */
(() => {
  'use strict';
  const W = window;
  const D = document;
  const 選項 = (W.__DESIGN_SCAN_OPTIONS__ && typeof W.__DESIGN_SCAN_OPTIONS__ === 'object')
    ? W.__DESIGN_SCAN_OPTIONS__ : {};

  // ───────────────────────── 常數（照抄原作） ─────────────────────────

  const SAFE_TAGS = new Set(['blockquote', 'nav', 'a', 'input', 'textarea', 'select', 'pre', 'code',
    'span', 'th', 'td', 'tr', 'li', 'label', 'button', 'hr', 'html', 'head', 'body', 'script', 'style',
    'link', 'meta', 'title', 'br', 'img', 'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
    'g', 'defs', 'use']);
  // BORDER_SAFE_TAGS = SAFE_TAGS 去掉 label（卡片狀可點的 label 是典型 side-tab）
  const BORDER_SAFE_TAGS = new Set([...SAFE_TAGS].filter(t => t !== 'label'));
  const OVERUSED_FONTS = new Set(['inter', 'roboto', 'open sans', 'lato', 'montserrat', 'arial',
    'helvetica', 'fraunces', 'instrument sans', 'instrument serif', 'geist', 'geist sans', 'geist mono',
    'mona sans', 'plus jakarta sans', 'space grotesk', 'recoleta']);
  const GOOGLE_DOMAINS = ['google.com', 'youtube.com', 'android.com', 'chromium.org', 'chrome.com',
    'web.dev', 'gstatic.com', 'firebase.google.com'];
  const BRAND_FONT_DOMAINS = {
    'roboto': GOOGLE_DOMAINS, 'google sans': GOOGLE_DOMAINS, 'product sans': GOOGLE_DOMAINS,
    'geist': ['vercel.com', 'nextjs.org', 'v0.app'], 'geist sans': ['vercel.com', 'nextjs.org', 'v0.app'],
    'geist mono': ['vercel.com', 'nextjs.org', 'v0.app'], 'mona sans': ['github.com', 'githubnext.com'],
  };
  const CSS_GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'inherit',
    'initial', 'unset', 'revert']);
  const GENERIC_FONTS = new Set([...CSS_GENERIC_FONTS, 'system-ui', 'ui-serif', 'ui-sans-serif',
    'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont', 'segoe ui']);
  const KNOWN_SERIF_FONTS = new Set(['fraunces', 'recoleta', 'newsreader', 'playfair display', 'playfair',
    'cormorant', 'cormorant garamond', 'garamond', 'eb garamond', 'tiempos', 'tiempos headline',
    'tiempos text', 'lora', 'vollkorn', 'spectral', 'source serif pro', 'source serif 4', 'source serif',
    'ibm plex serif', 'merriweather', 'libre caslon', 'libre baskerville', 'baskerville', 'georgia',
    'times new roman', 'times', 'dm serif display', 'dm serif text', 'instrument serif', 'gt sectra', 'ogg',
    'canela', 'freight display', 'freight text']);
  const WCAG_LARGE_TEXT_PX = 18 * (96 / 72);
  const WCAG_LARGE_BOLD_TEXT_PX = 14 * (96 / 72);
  const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const QUALITY_TEXT_TAGS = new Set(['p', 'li', 'td', 'th', 'dd', 'blockquote', 'figcaption']);
  const TEXT_EDGE_QUERY = 'a, button, code, dd, dt, figcaption, h1, h2, h3, h4, h5, h6, li, p, pre, span, td, th';
  const SR_ONLY_SELECTOR = '.sr-only, .visually-hidden, .visuallyhidden, .screen-reader, .screen-reader-only, .screenreader, .a11y-hidden, .hidden-visually, [class*="sr-only" i], [class*="visually-hidden" i], [class*="visuallyhidden" i], [class*="screen-reader" i], [class*="screenreader" i]';
  const NON_RENDERED_TAGS = new Set(['script', 'style', 'title', 'noscript', 'template', 'head', 'meta',
    'link', 'base', 'param', 'source', 'track', 'datalist', 'col', 'colgroup', 'map', 'area']);
  const TEXT_OVERFLOW_SKIP_TAGS = new Set(['pre', 'code', 'textarea', 'svg', 'canvas', 'select', 'option', 'marquee']);
  const FLUSH_SKIP_TAGS = new Set(['html', 'body', 'main', 'header', 'footer', 'nav', 'article', 'aside',
    'button', 'a', 'label', 'summary', 'code', 'pre', 'input', 'textarea', 'select', 'form', 'figure',
    'table', 'tbody', 'thead', 'tr', 'td', 'th']);
  const TINY_TEXT_UI_CONTEXT = 'button, a, label, summary, pre, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], nav, footer, [aria-hidden="true"], [class*="badge" i], [class*="caption" i], [class*="chip" i], [class*="code" i], [class*="console" i], [class*="diff" i], [class*="label" i], [class*="meta" i], [class*="mock" i], [class*="pill" i], [class*="preview" i], [class*="tag" i], [class*="terminal" i], [class*="writes" i]';
  const EXEMPT_CONTEXT = 'pre, code, kbd, samp, var, svg, [aria-hidden="true"], [class*="terminal" i], [class*="console" i], [class*="code" i], [class*="mock" i], [class*="editor" i], [class*="syntax" i], [class*="diff" i]';
  const INTERACTIVE = 'a[href], button, summary, label, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"], [tabindex]';
  const FURNITURE = 'nav, [role="navigation"], td, th, [role="gridcell"], [role="cell"], caption, figcaption, dt, dd, footer, [class*="meta" i], [class*="label" i], [class*="badge" i], [class*="chip" i], [class*="pill" i], [class*="tag" i], [class*="kicker" i], [class*="eyebrow" i], [class*="breadcrumb" i], [class*="timestamp" i], [class*="category" i], [class*="caption" i], [class*="nav" i]';
  const SMALLPRINT = 'small, footer, [class*="legal" i], [class*="copyright" i], [class*="fineprint" i], [class*="fine-print" i], [class*="smallprint" i], [class*="small-print" i], [class*="disclaimer" i], [class*="disclosure" i], [class*="footnote" i]';
  const KICKER_SKIP_SELECTOR = 'nav,form,table,thead,tbody,tfoot,figure,figcaption,ol,ul,li,[role="navigation"],[aria-label*="breadcrumb" i],[class*="breadcrumb" i],[aria-hidden="true"],[data-impeccable-allow-kickers]';
  const KICKER_CARD_CONTEXT_SELECTOR = 'article,button,a,li,[role="listitem"],[role="option"]';
  const APP_CONTEXT = '[role="tabpanel"], [role="dialog"], [role="application"], dialog';
  const NUMBERED_LABEL_TAGS = new Set(['span', 'p', 'div', 'small', 'em', 'strong', 'b']);
  const REPEATED_TEXT_SKIP_SELECTOR = 'table,select,datalist,nav,menu,[role="navigation"],[role="menu"],[role="menubar"],[role="listbox"],[role="grid"],[role="tablist"],[role="radiogroup"],[aria-hidden="true"]';
  const REPEATED_TEXT_CONTAINER_TAGS = new Set(['div', 'section', 'article', 'aside', 'main', 'figure',
    'form', 'fieldset', 'details', 'li']);
  const POSITIONED_CHILD_INTERACTIVE_SELECTOR = 'a[href],button,input,select,summary,textarea,[tabindex]:not([tabindex="-1"]),[role="button"],[role="dialog"],[role="link"],[role="listbox"],[role="menu"],[role="menuitem"],[role="option"],[role="tooltip"]';
  const HIDDEN_TEXT_EXCLUDE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'title', 'head',
    'meta', 'link', 'option', 'optgroup', 'select', 'datalist', 'dialog']);
  const OCCLUSION_TEXT_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'title']);
  const LAYOUT_TRANSITION_PROPS = new Set(['width', 'height', 'padding', 'margin', 'max-height', 'max-width',
    'min-height', 'min-width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left']);
  const BUZZWORDS = ['streamline your', 'empower your', 'supercharge your', 'unleash your',
    'unleash the power', 'leverage the power', 'built for the modern', 'trusted by leading',
    'trusted by the world', 'best-in-class', 'industry-leading', 'world-class', 'enterprise-grade',
    'next-generation', 'cutting-edge', 'transform your business', 'revolutionize', 'game-changer',
    'game changing', 'mission-critical', 'best of breed', 'future-proof', 'future proof',
    'seamless experience', 'seamlessly integrate', 'drive engagement', 'drive growth', 'drive results',
    'harness the power'];
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  // ───────────────────────── 基本工具 ─────────────────────────

  const csCache = new Map();
  const cs = el => {
    let s = csCache.get(el);
    if (!s) { s = W.getComputedStyle(el); csCache.set(el, s); }
    return s;
  };
  const pcs = (el, which) => { try { return W.getComputedStyle(el, which); } catch { return null; } };
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const tagOf = el => (el && el.tagName ? el.tagName.toLowerCase() : '');
  const collapse = s => String(s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { const a = Array.from(String(s || '')); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
  const closest = (el, sel) => { try { return el && el.closest ? el.closest(sel) : null; } catch { return null; } };
  const matches = (el, sel) => { try { return !!(el && el.matches && el.matches(sel)); } catch { return false; } };
  const qsa = (root, sel) => { try { return Array.from((root || D).querySelectorAll(sel)); } catch { return []; } };
  const rectOf = el => el.getBoundingClientRect();
  const classStr = el => (el.getAttribute && el.getAttribute('class')) || '';
  const directText = el => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t;
  };
  const hasDirectTextLongerThan = (el, n) => {
    for (const c of el.childNodes) if (c.nodeType === 3 && c.textContent.trim().length > n) return true;
    return false;
  };
  const cleanInlineText = el => {
    const parts = [];
    for (const c of el.childNodes) if (c.nodeType === 3) parts.push(c.textContent);
    return collapse(parts.join(' '));
  };
  const isEmojiOnly = s => {
    const t = String(s || '').trim();
    if (!t) return false;
    try { return /^[\p{Extended_Pictographic}\p{Emoji_Component}\s‍️]+$/u.test(t) && !/[0-9#*]/.test(t); } catch { return false; }
  };
  const vw = () => W.innerWidth || 1280;
  const vh = () => W.innerHeight || 800;

  // 「真的有畫出來」：用瀏覽器自己的判斷，會往上看整條祖先鏈。
  const visCache = new Map();
  function isVisible(el) {
    if (!el || el === D.body || el === D.documentElement) return true;
    if (visCache.has(el)) return visCache.get(el);
    let v;
    if (typeof el.checkVisibility === 'function') {
      v = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
    } else {
      v = true;
      for (let p = el; p && p !== D.documentElement; p = p.parentElement) {
        const s = cs(p);
        if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || num(s.opacity) === 0 && s.opacity !== '') { v = false; break; }
      }
    }
    visCache.set(el, v);
    return v;
  }
  // 原作的 isRenderedForBrowserRule：連 aria-hidden 與 opacity≤0.01 也算沒畫
  function isRenderedForRule(el) {
    for (let c = el; c; c = c.parentElement) {
      if (c.getAttribute && c.getAttribute('aria-hidden') === 'true') return false;
      const s = cs(c);
      const vis = (s.visibility || '').toLowerCase();
      if (s.display === 'none' || vis === 'hidden' || vis === 'collapse') return false;
      if (s.opacity !== '' && num(s.opacity) <= 0.01) return false;
      if ((s.contentVisibility || '').toLowerCase() === 'hidden') return false;
    }
    return true;
  }
  function effectiveOpacity(el) {
    let o = 1;
    for (let c = el; c; c = c.parentElement) {
      const raw = cs(c).opacity;
      o *= raw === '' ? 1 : parseFloat(raw);
      if (o <= 0.02) return 0;
    }
    return o;
  }
  // 祖先鏈上有沒有 fixed／sticky（會跟著視窗走的層）
  function pinnedAncestor(el) {
    for (let c = el; c && c !== D.body; c = c.parentElement) {
      const p = cs(c).position;
      if (p === 'fixed' || p === 'sticky') return c;
    }
    return null;
  }
  function layered(el) {
    for (let c = el; c && c !== D.body; c = c.parentElement) {
      const p = cs(c).position || 'static';
      if (p === 'absolute' || p === 'fixed' || p === 'sticky') return true;
    }
    return false;
  }
  // 規則局部停用
  function ignored(el, id) {
    for (let c = el; c; c = c.parentElement) {
      for (const attr of ['data-impeccable-ignore', 'data-design-scan-ignore']) {
        const v = c.getAttribute && c.getAttribute(attr);
        if (v == null) continue;
        const rules = v.toLowerCase().split(/[\s,]+/).filter(Boolean);
        if (!rules.length || rules.includes('*') || rules.includes(id)) return true;
      }
    }
    return false;
  }

  // ───────────────────────── 顏色 ─────────────────────────

  const colorCache = new Map();
  let ctx2d = null;
  function parseColor(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (colorCache.has(s)) return colorCache.get(s);
    let out = null;
    const m = /^rgba?\(\s*(-?[\d.]+)(%?)[\s,]+(-?[\d.]+)(%?)[\s,]+(-?[\d.]+)(%?)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(s);
    if (m) {
      const ch = (v, p) => (p ? parseFloat(v) * 2.55 : parseFloat(v));
      let a = m[7] === undefined ? 1 : parseFloat(m[7]) / (m[8] ? 100 : 1);
      out = { r: ch(m[1], m[2]), g: ch(m[3], m[4]), b: ch(m[5], m[6]), a };
    } else if (/^transparent$/i.test(s)) {
      out = { r: 0, g: 0, b: 0, a: 0 };
    } else if (/^(currentcolor|inherit|initial|unset|revert|none|auto|normal)$/i.test(s)) {
      out = null;
    } else if (W.CSS && CSS.supports && CSS.supports('color', s)) {
      // 其他色彩空間（oklch、lab、color-mix…）交給 2D canvas 換算成 sRGB
      try {
        if (!ctx2d) {
          const cv = D.createElement('canvas'); cv.width = 1; cv.height = 1;
          ctx2d = cv.getContext('2d', { willReadFrequently: true });
        }
        ctx2d.clearRect(0, 0, 1, 1);
        ctx2d.fillStyle = '#000';
        ctx2d.fillStyle = s;
        ctx2d.fillRect(0, 0, 1, 1);
        const d = ctx2d.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      } catch { out = null; }
    }
    colorCache.set(s, out);
    return out;
  }
  const alphaOf = c => (c && c.a != null ? c.a : 1);
  const spread = c => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const hasChroma = (c, t = 30) => !!c && spread(c) >= t;
  function luminance(c) {
    const lin = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  }
  const contrast = (a, b) => { const l1 = luminance(a), l2 = luminance(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  function hue(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return 0;
    const d = mx - mn;
    let h;
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return Math.round(h * 360);
  }
  function isGrayInk(c) {
    const mx = Math.max(c.r, c.g, c.b) / 255, mn = Math.min(c.r, c.g, c.b) / 255;
    const l = (mx + mn) / 2, d = mx - mn;
    const s = d <= 0 || l <= 0 || l >= 1 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return s < 0.2 && l > 0.2 && l < 0.85;
  }
  const hex = c => (c ? '#' + [c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('') : '?');
  const composite = (top, base) => {
    const a = alphaOf(top);
    return { r: top.r * a + base.r * (1 - a), g: top.g * a + base.g * (1 - a), b: top.b * a + base.b * (1 - a), a: 1 };
  };
  const isNeutral = raw => { const c = parseColor(raw); return !c || alphaOf(c) === 0 || spread(c) < 30; };
  const isTransparentCss = raw => { const s = String(raw || '').trim().toLowerCase(); if (!s || s === 'transparent') return true; const c = parseColor(s); return c ? alphaOf(c) <= 0.05 : false; };
  const COLOR_TOKEN_RE = /(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix|color)\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-fA-F]{3,8}\b|\btransparent\b/gi;
  const colorTokens = s => (String(s || '').match(COLOR_TOKEN_RE) || []);
  const gradientColors = bg => (/gradient/i.test(bg || '') ? colorTokens(bg).map(parseColor).filter(Boolean) : []);
  function splitTopLevel(s) {
    const out = []; let depth = 0, cur = '';
    for (const ch of String(s || '')) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }
  // 陰影一層 → { 顏色, 數值[x, y, blur, spread], inset }
  function shadowLayers(value) {
    if (!value || value === 'none') return [];
    return splitTopLevel(value).map(layer => {
      const toks = colorTokens(layer);
      const color = toks.length ? parseColor(toks[0]) : null;
      const rest = layer.replace(COLOR_TOKEN_RE, ' ');
      const nums = (rest.match(/-?\d*\.?\d+(?=px|\b)/g) || []).map(parseFloat);
      return { color, nums, inset: /\binset\b/i.test(layer) };
    });
  }

  // 背景色解析（原作 resolveBackgroundInfo）：往上疊半透明層，遇到不透明底就結束；
  // 遇到圖片或判斷不了的東西就回 unresolved，避免拿錯的底去算對比。
  function resolveBg(el) {
    const overlays = [];
    const flatten = base => { let acc = base; for (let i = overlays.length - 1; i >= 0; i--) acc = composite(overlays[i], acc); return acc; };
    for (let cur = el; cur; cur = cur.parentElement) {
      const s = cs(cur);
      const bgImage = s.backgroundImage;
      const hasPaint = bgImage && bgImage !== 'none' && /gradient|url\s*\(/i.test(bgImage);
      let bg = parseColor(s.backgroundColor);
      if ((!bg || alphaOf(bg) < 0.1) && /^currentcolor$/i.test((s.backgroundColor || '').trim())) bg = parseColor(s.color);
      if (bg && alphaOf(bg) > 0.1) {
        if (alphaOf(bg) >= 0.99) return { color: flatten(bg), unresolved: false };
        overlays.push(bg);
      } else if (!bg && s.backgroundColor && !isTransparentCss(s.backgroundColor)) {
        return { color: null, unresolved: true };
      }
      if (hasPaint) {
        const layers = splitTopLevel(bgImage);
        const top = layers.find(l => /gradient\s*\(/i.test(l) || /url\s*\(/i.test(l));
        const gradientOnTop = !!top && /gradient\s*\(/i.test(top) && !/^\s*url\s*\(/i.test(top);
        if (!gradientOnTop) return { color: null, unresolved: true };
        const urlBeneath = layers.some(l => l !== top && /url\s*\(/i.test(l));
        if (urlBeneath) {
          const stops = gradientColors(top);
          if (!(stops.length && stops.every(c => alphaOf(c) >= 0.99))) return { color: null, unresolved: true };
        }
        return { color: null, unresolved: false };
      }
    }
    return { color: flatten({ r: 255, g: 255, b: 255, a: 1 }), unresolved: false };
  }
  function resolveGradientStops(el) {
    const overlays = [];
    for (let cur = el; cur; cur = cur.parentElement) {
      const s = cs(cur);
      const bgImage = s.backgroundImage;
      if (bgImage && bgImage !== 'none' && /url\s*\(/i.test(bgImage)) return null;
      if (bgImage && bgImage !== 'none' && /gradient/i.test(bgImage)) {
        const stops = gradientColors(bgImage);
        if (stops.length) {
          let comp = stops;
          if (stops.some(c => alphaOf(c) < 0.99)) {
            const base = resolveBg(cur.parentElement || cur).color;
            comp = stops.map(c => (alphaOf(c) >= 0.99 ? c : base ? composite(c, base) : null)).filter(Boolean);
            if (!comp.length) return null;
          }
          return comp.map(stop => { let acc = stop; for (let i = overlays.length - 1; i >= 0; i--) acc = composite(overlays[i], acc); return acc; });
        }
      }
      const bg = parseColor(s.backgroundColor);
      if (bg && alphaOf(bg) > 0.1) {
        if (alphaOf(bg) >= 0.99) return null;
        overlays.push(bg);
      }
    }
    return null;
  }
  function gradientAncestorAverage(start) {
    for (let c = start; c; c = c.parentElement) {
      const g = gradientColors(cs(c).backgroundImage);
      if (g.length) {
        const n = g.length;
        return { r: Math.round(g.reduce((a, x) => a + x.r, 0) / n), g: Math.round(g.reduce((a, x) => a + x.g, 0) / n), b: Math.round(g.reduce((a, x) => a + x.b, 0) / n), a: 1 };
      }
    }
    return null;
  }
  function pageBg() {
    let bg = parseColor(cs(D.body).backgroundColor);
    if (!bg || alphaOf(bg) === 0) bg = parseColor(cs(D.documentElement).backgroundColor);
    if (!bg || alphaOf(bg) === 0) bg = { r: 255, g: 255, b: 255, a: 1 };
    return bg;
  }
  const pageIsDark = () => { const bg = pageBg(); return alphaOf(bg) > 0.5 && luminance(bg) < 0.1; };

  // ───────────────────────── 文字幾何 ─────────────────────────

  function textNodeRects(el, deep) {
    const out = [];
    const walk = node => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          if (!c.textContent.trim()) continue;
          const r = D.createRange(); r.selectNodeContents(c);
          for (const rr of r.getClientRects()) if (rr.width > 0 && rr.height > 0) out.push(rr);
        } else if (deep && c.nodeType === 1) walk(c);
      }
    };
    walk(el);
    return out;
  }
  function directTextRect(el) {
    const rs = textNodeRects(el, false);
    if (!rs.length) return null;
    const left = Math.min(...rs.map(r => r.left)), top = Math.min(...rs.map(r => r.top));
    const right = Math.max(...rs.map(r => r.right)), bottom = Math.max(...rs.map(r => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  // 把同一行的片段併回一行，回傳每一行的寬度（行長用，不拿聯集框當行）
  function lineWidths(el) {
    const rs = textNodeRects(el, true).sort((a, b) => a.top - b.top);
    const lines = [];
    for (const r of rs) {
      const mid = (r.top + r.bottom) / 2;
      const line = lines.find(l => mid >= l.top && mid <= l.bottom);
      if (line) { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right); line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom); }
      else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return lines.map(l => l.right - l.left).filter(w => w > 0);
  }
  const lengthPx = (v, fs) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === 'normal' || s === 'auto' || s === 'none') return null;
    const m = /^(-?[\d.]+)(px|em|rem|%)?$/.exec(s);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (m[2] === 'em') return n * fs;
    if (m[2] === 'rem') return n * 16;
    if (m[2] === '%') return null;
    return n;
  };
  function isScreenReaderOnly(el) {
    if (matches(el, SR_ONLY_SELECTOR) || closest(el, SR_ONLY_SELECTOR)) return true;
    const s = cs(el);
    const clipsOverflow = [s.overflow, s.overflowX, s.overflowY].some(v => v === 'hidden' || v === 'clip');
    const r = rectOf(el);
    if (s.position === 'absolute' && r.width <= 2 && r.height <= 2 && clipsOverflow) return true;
    if (/inset\(\s*(?:50%|99|100%)/.test(s.clipPath || '') || /rect\(\s*0/.test(s.clip || '')) return true;
    return false;
  }

  // ───────────────────────── 樣式表（keyframes、規則） ─────────────────────────

  let sheetRulesCache = null;
  function allRules() {
    if (sheetRulesCache) return sheetRulesCache;
    const out = [];
    const walk = list => {
      for (const r of list) {
        out.push(r);
        let inner = null;
        try { inner = r.cssRules; } catch { inner = null; }
        if (inner && r.type !== 7 /* KEYFRAMES */) walk(inner);
      }
    };
    for (const sh of D.styleSheets) {
      let list = null;
      try { list = sh.cssRules; } catch { list = null; } // 跨網域樣式表讀不到，略過
      if (list) walk(list);
    }
    sheetRulesCache = out;
    return out;
  }
  const keyframesCache = new Map();
  // 回傳 [{ 屬性: 值 }, ...]，找不到回 null
  function keyframes(name) {
    if (!name) return null;
    if (keyframesCache.has(name)) return keyframesCache.get(name);
    let out = null;
    for (const r of allRules()) {
      if (r.type === 7 && r.name === name) {
        out = [];
        for (const kf of r.cssRules) {
          const decl = {};
          for (let i = 0; i < kf.style.length; i++) { const p = kf.style[i]; decl[p] = kf.style.getPropertyValue(p); }
          out.push(decl);
        }
        break;
      }
    }
    keyframesCache.set(name, out);
    return out;
  }
  const animNames = el => (cs(el).animationName || '').split(',').map(s => s.trim()).filter(n => n && n !== 'none');
  const isInfinite = el => (cs(el).animationIterationCount || '').split(',').some(s => s.trim() === 'infinite');
  // 原作 checkHtmlPatterns 的樣式語料：<style> 與可讀的外部樣式表的 cssText ＋ 行內 style
  let corpusCache = null;
  function corpora() {
    if (corpusCache) return corpusCache;
    const style = [], cls = [];
    for (const r of allRules()) if (r.type === 1 || r.type === 7) style.push(r.cssText);
    for (const el of qsa(D, '[style]')) style.push('style="' + el.getAttribute('style') + '"');
    for (const el of qsa(D, '[class]')) cls.push(classStr(el));
    corpusCache = { style: style.join('\n'), cls: cls.join('\n') };
    return corpusCache;
  }

  // ───────────────────────── 選擇器描述 ─────────────────────────

  function selectorOf(el) {
    if (!el || el === D.body) return 'body';
    if (el === D.documentElement) return 'html';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== D.body && cur !== D.documentElement && depth < 6; depth++) {
      let seg = tagOf(cur);
      const classes = Array.from(cur.classList || []).filter(c => !(/^[a-z0-9]{6,}$/i.test(c) && /\d/.test(c)) && !/^(css|sc|emotion|jsx|module)-/i.test(c)).slice(0, 2);
      if (classes.length) seg += '.' + classes.map(c => CSS.escape(c)).join('.');
      const p = cur.parentElement;
      if (p) {
        const same = Array.from(p.children).filter(c => c.tagName === cur.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      const s = parts.join(' > ');
      try { if (D.querySelectorAll(s).length === 1) return s; } catch { /* 繼續往上 */ }
      cur = p;
      if (cur && cur.id) { parts.unshift('#' + CSS.escape(cur.id)); return parts.join(' > '); }
    }
    return parts.join(' > ');
  }
  function describe(el) {
    if (!el) return '頁面';
    const sel = selectorOf(el);
    if (el === D.body || el === D.documentElement) return sel + '（頁面）';
    const t = collapse(el.textContent);
    return t ? `${sel} «${clip(t, 30)}»` : sel;
  }
  const classSel = el => { const t = classStr(el).trim().split(/\s+/).filter(Boolean); return t.length ? `${tagOf(el)}.${t.join('.')}` : tagOf(el); };

  // ───────────────────────── 掃描範圍 ─────────────────────────

  let elementsCache = null;
  // 逐元素規則的母體：body 底下、真的有畫出來、且不是 script/style 這類不會渲染的節點
  function elements() {
    if (elementsCache) return elementsCache;
    elementsCache = qsa(D.body, '*').filter(el => !NON_RENDERED_TAGS.has(tagOf(el)) && isVisible(el));
    return elementsCache;
  }
  const memo = new Map();
  const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const hit = (el, 細節, 嚴重度) => ({ el, 細節, 嚴重度 });
  const byId = (key, fn, id) => once(key, fn).filter(h => h.id === id).map(h => hit(h.el, h.細節, h.嚴重度));

  // ───────────────────────── 共用判斷 ─────────────────────────

  const ACTIVE_CLASS_RE = /(?:^|[\s_-])(?:active|current|selected)(?:$|[\s_-])/i;
  function isTabContext(el) {
    if (closest(el, '[aria-selected="true"], [aria-current]:not([aria-current="false"])')) return true;
    let c = el;
    for (let d = 0; c && d < 6; d++, c = c.parentElement) if (ACTIVE_CLASS_RE.test(classStr(c))) return true;
    return false;
  }
  const isStatusContext = el => !!closest(el, '[role="status"], [role="alert"], [role="alertdialog"], [role="log"], [aria-live="polite"], [aria-live="assertive"]');
  function isCardLike(el) {
    const t = tagOf(el);
    if (SAFE_TAGS.has(t) || ['input', 'select', 'textarea', 'img', 'video', 'canvas', 'picture'].includes(t)) return false;
    const s = cs(el), cls = classStr(el);
    const hasShadow = (s.boxShadow && s.boxShadow !== 'none') || /\bshadow(?:-sm|-md|-lg|-xl|-2xl)?\b/.test(cls);
    const hasBorder = /\bborder\b/.test(cls);
    const hasRadius = num(s.borderRadius) > 0 || /\brounded(?:-sm|-md|-lg|-xl|-2xl|-full)?\b/.test(cls);
    const hasBg = (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') || /\bbg-(?:white|gray-\d+|slate-\d+)\b/.test(cls);
    if (!hasShadow && !hasBorder) return false;
    return !!(hasRadius || hasBg);
  }
  function isAccentColor(css) {
    const c = parseColor(css);
    return !!c && alphaOf(c) > 0.1 && spread(c) >= 40;
  }
  const fontPrimary = (ff, skip) => {
    const stack = String(ff || '').split(',').map(f => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
    return stack.find(f => f && !skip.has(f)) || '';
  };

  // ───────────────────────── 逐元素：顏色（gray-on-color／low-contrast／紫色標題） ─────────────────────────

  function pseudoSurface(el, rect) {
    for (const which of ['::before', '::after']) {
      const ps = pcs(el, which);
      if (!ps || !ps.content || ps.content === 'none') continue;
      if (ps.position !== 'absolute' && ps.position !== 'fixed') continue;
      if (ps.display === 'none' || (parseFloat(ps.opacity) || 1) < 0.9) continue;
      if (num(ps.width) < rect.width - 4 || num(ps.height) < rect.height - 4) continue;
      const bg = parseColor(ps.backgroundColor);
      if (bg && alphaOf(bg) >= 0.9) return bg;
    }
    return null;
  }
  // 用幾何判斷（不靠 elementsFromPoint，首屏以外也量得到）：往上最多 5 層祖先，
  // 找「不包含這段文字、但和文字框重疊一半以上」的圖片／影片／畫布或 url() 背景
  function overMedia(el) {
    const tr = directTextRect(el);
    if (!tr || tr.width <= 0 || tr.height <= 0) return false;
    let a = el.parentElement;
    for (let depth = 0; a && a !== D.body && depth < 5; depth++, a = a.parentElement) {
      for (const m of qsa(a, 'img, video, canvas, picture, iframe, [style*="url("]')) {
        if (m.contains(el) || !isVisible(m)) continue;
        if (m.matches('[style*="url("]') && !/url\(/i.test(cs(m).backgroundImage || '')) continue;
        const r = rectOf(m);
        const ix = Math.max(0, Math.min(r.right, tr.right) - Math.max(r.left, tr.left));
        const iy = Math.max(0, Math.min(r.bottom, tr.bottom) - Math.max(r.top, tr.top));
        if (ix * iy >= 0.5 * tr.width * tr.height) return true;
      }
      const bg = parseColor(cs(a).backgroundColor);
      if (bg && alphaOf(bg) >= 0.99) break; // 碰到不透明底就停，再上去的圖片被它蓋住
    }
    return false;
  }
  function contrastFindings(o, text) {
    const bgs = o.effectiveBg ? [o.effectiveBg] : (o.stops && o.stops.length ? o.stops : null);
    if (!bgs) return [];
    const out = [];
    if (isGrayInk(text) && bgs.every(b => hasChroma(b, 40))) {
      out.push({ id: 'gray-on-color', 細節: `灰字 ${hex(text)} 壓在彩色底 ${o.effectiveBg ? hex(o.effectiveBg) : 'gradient(' + bgs.map(hex).join(', ') + ')'}` });
    }
    const ratios = bgs.map(b => contrast(text, b));
    let wi = 0; ratios.forEach((r, i) => { if (r < ratios[wi]) wi = i; });
    const large = o.fontSize >= WCAG_LARGE_TEXT_PX || (o.fontSize >= WCAG_LARGE_BOLD_TEXT_PX && o.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    if (ratios[wi] < need) out.push({ id: 'low-contrast', 細節: `對比 ${ratios[wi].toFixed(2)}:1（需要 ${need}:1）—— 文字 ${hex(text)} 在 ${hex(bgs[wi])} 上` });
    return out;
  }
  function colorPass() {
    const out = [];
    for (const el of elements()) {
      const t = tagOf(el);
      const rect = rectOf(el);
      if (rect.width < 10 || rect.height < 10) continue;
      const s = cs(el);
      if (s.visibility === 'hidden' || effectiveOpacity(el) <= 0.02) continue;
      const direct = directText(el);
      const hasText = !!direct.trim();
      const info = resolveBg(el);
      let effectiveBg = info.color, unresolved = info.unresolved;
      let ownBg = parseColor(s.backgroundColor);
      if (!ownBg || alphaOf(ownBg) <= 0.5) {
        const ps = pseudoSurface(el, rect);
        if (ps) { ownBg = ps; effectiveBg = ps; unresolved = false; }
      }
      const fontSize = parseFloat(s.fontSize) || 16;
      const fontWeight = parseInt(s.fontWeight, 10) || 400;
      const bgClip = s.webkitBackgroundClip || s.backgroundClip;
      const bgImage = s.backgroundImage || '';
      // 原作的 SAFE_TAGS 閘門：span／a／li 這類行內或控制元件，只有自己有底色或漸層時才算
      let safeSkip = false;
      if (SAFE_TAGS.has(t)) {
        const ownGrad = /gradient/i.test(bgImage);
        safeSkip = !(hasText && ((ownBg && alphaOf(ownBg) > 0.5) || ownGrad) && fontSize >= 9);
        if (safeSkip && t !== 'input' && t !== 'textarea') continue; // input／textarea 仍要看 placeholder
      }
      // 加碼：文字疊在兄弟層的 <img>／影片上（圖片當底的標題），祖先鏈看不到那張圖，
      // 照算會拿到「白字在白底」這種假陽性；原作靠截圖補救，這裡改成判定為算不出來。
      if (!unresolved && hasText && overMedia(el)) unresolved = true;
      const o = { effectiveBg: unresolved ? null : effectiveBg, stops: (unresolved || effectiveBg) ? null : resolveGradientStops(el), fontSize, fontWeight };
      const text = parseColor(s.color);
      if (!safeSkip && hasText && text && !isEmojiOnly(direct)) {
        if (bgClip !== 'text') for (const f of contrastFindings(o, text)) out.push({ el, ...f });
        if (hasChroma(text, 50)) {
          const h = hue(text);
          if (h >= 260 && h <= 310 && (/^h[123]$/.test(t) || fontSize >= 20)) out.push({ el, id: 'ai-color-palette', 細節: `紫色標題文字 ${hex(text)}` });
        }
      }
      // Tailwind 的灰字＋彩色底 class 組合
      const cls = classStr(el);
      const gray = /\btext-(?:gray|slate|zinc|neutral|stone)-\d+\b/.exec(cls);
      const colorBg = /\bbg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+(?!\/)\b/.exec(cls);
      if (gray && colorBg) out.push({ el, id: 'gray-on-color', 細節: `${gray[0]} 疊在 ${colorBg[0]}（Tailwind）` });
      // placeholder 對比
      if ((t === 'input' || t === 'textarea') && (el.getAttribute('placeholder') || '').trim()) {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const skip = (t === 'input' && ['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'image', 'reset', 'range', 'color'].includes(type)) || !matches(el, ':placeholder-shown');
        const ps = pcs(el, '::placeholder');
        let ph = ps && parseColor(ps.color);
        if (!skip && ph) {
          let oo = o;
          if (alphaOf(ph) < 1 && o.effectiveBg) ph = composite(ph, o.effectiveBg);
          else if (alphaOf(ph) < 1 && o.stops && o.stops.length) { const st = o.stops[0]; ph = composite(ph, st); oo = { ...o, effectiveBg: st, stops: null }; }
          for (const f of contrastFindings(oo, ph)) out.push({ el, ...f, 細節: `placeholder「${clip(el.getAttribute('placeholder'), 20)}」${f.細節}` });
        }
      }
    }
    return out;
  }

  // ───────────────────────── 逐元素：邊框條紋（side-tab／border-accent-on-rounded） ─────────────────────────

  function borderPass() {
    const out = [];
    for (const el of elements()) {
      const t = tagOf(el);
      // (1) 粗單邊框
      if (!BORDER_SAFE_TAGS.has(t)) {
        const r = rectOf(el);
        if (r.width >= 20 && r.height >= 20 && !isStatusContext(el)) {
          const s = cs(el);
          const widths = SIDES.map(sd => num(s[`border${sd}Width`]));
          const colors = SIDES.map(sd => s[`border${sd}Color`]);
          const radius = num(s.borderRadius);
          const tab = isTabContext(el);
          for (let i = 0; i < 4; i++) {
            const w = widths[i];
            if (w < 1 || isNeutral(colors[i])) continue;
            const maxOther = Math.max(...widths.filter((_, j) => j !== i));
            if (!(w >= 2 && (maxOther <= 1 || w >= maxOther * 2))) continue;
            const sn = SIDES[i].toLowerCase();
            if (i === 1 || i === 3) {
              if (radius > 0) out.push({ el, id: 'side-tab', 細節: `border-${sn}: ${w}px + border-radius: ${radius}px` });
              else if (w >= 3) out.push({ el, id: 'side-tab', 細節: `border-${sn}: ${w}px` });
            } else if (radius > 0 && w >= 2) {
              out.push({ el, id: 'border-accent-on-rounded', 細節: `border-${sn}: ${w}px + border-radius: ${radius}px` });
            } else if (!tab && w >= 3 && w <= 12) {
              out.push({ el, id: 'side-tab', 細節: `border-${sn}: ${w}px` });
            }
          }
        }
      }
      // (2) 偽元素畫的條紋
      if (!BORDER_SAFE_TAGS.has(t) && t !== 'summary' && !closest(el, 'nav, blockquote, pre') && isRenderedForRule(el)) {
        const r = rectOf(el);
        if (r.width >= 40 && r.height >= 20 && !isTabContext(el)) {
          for (const which of ['::before', '::after']) {
            const ps = pcs(el, which);
            if (!ps || !ps.content || ps.content === 'none') continue;
            if (ps.position !== 'absolute' && ps.position !== 'fixed') continue;
            if (num(ps.opacity) <= 0.01 && ps.opacity !== '' || ps.display === 'none') continue;
            const w = num(ps.width), h = num(ps.height);
            if (!(w > 0 && h > 0)) continue;
            const hugs = v => { const n = parseFloat(v); return Number.isFinite(n) && n >= -2 && n <= 2; };
            let edge = null, th = 0;
            if (w >= 3 && w <= 12 && h >= r.height - 44 && h >= r.height * 0.5) { edge = hugs(ps.left) ? 'left' : hugs(ps.right) ? 'right' : null; th = w; }
            if (!edge && h >= 3 && h <= 12 && w >= r.width - 44 && w >= r.width * 0.5 && !/(?:^|[\s_-])(?:btn|button|link)(?:$|[\s\w-])/i.test(classStr(el))) {
              edge = hugs(ps.top) ? 'top' : hugs(ps.bottom) ? 'bottom' : null; th = h;
            }
            if (!edge) continue;
            const bg = parseColor(ps.backgroundColor);
            if (!bg || alphaOf(bg) < 0.1 || spread(bg) < 30) continue;
            out.push({ el, id: 'side-tab', 細節: `${classSel(el)}${which} —— 絕對定位 ${th}px 偽元素條紋（${edge}）` });
          }
        }
      }
      // (3) 專門畫條紋的空子元素
      if ((t === 'div' || t === 'span') && el.parentElement && !['body', 'html'].includes(tagOf(el.parentElement)) &&
          !el.children.length && !collapse(el.textContent) &&
          !closest(el, 'nav, blockquote, pre, table, button, a, select, progress, meter, [role="progressbar"], [role="slider"], [role="scrollbar"], [role="separator"], [role="tablist"]') &&
          isRenderedForRule(el) && !isTabContext(el) && !isStatusContext(el)) {
        const host = rectOf(el.parentElement), cr = rectOf(el);
        if (host.width >= 40 && host.height >= 20 && cr.height >= host.height - 44 && cr.height >= host.height * 0.5) {
          const hug = v => Math.abs(v) <= 3;
          const edge = hug(cr.left - host.left) ? 'left' : hug(host.right - cr.right) ? 'right' : null;
          const bg = parseColor(cs(el).backgroundColor);
          if (edge && cr.width >= 2 && cr.width <= 12 && bg && alphaOf(bg) > 0.1 && spread(bg) >= 30) {
            out.push({ el, id: 'side-tab', 細節: `${classSel(el)} —— ${Math.round(cr.width)}px 條紋子元素（${edge}）` });
          }
        }
      }
      // (4) inset box-shadow 畫的條紋（原作掃 CSS 文字，這裡改看計算後樣式）
      if (!['button', 'hr', 'tr', 'td', 'th', 'table', 'blockquote', 'pre', 'code'].includes(t) && !isTabContext(el)) {
        const bs = cs(el).boxShadow;
        if (bs && /inset/.test(bs) && rectOf(el).width > 40) {
          for (const L of shadowLayers(bs)) {
            if (!L.inset || !L.color || alphaOf(L.color) < 0.1 || spread(L.color) < 30) continue;
            const [x = 0, y = 0, blur = 0, sp = 0] = L.nums;
            if (blur || sp) continue;
            const ax = Math.abs(x), ay = Math.abs(y);
            if (!((ax >= 3 && ax <= 12 && ay === 0) || (ay >= 3 && ay <= 12 && ax === 0))) continue;
            const edge = ay === 0 ? (x > 0 ? 'left' : 'right') : (y > 0 ? 'top' : 'bottom');
            out.push({ el, id: 'side-tab', 細節: `${classSel(el)} —— inset box-shadow ${ay === 0 ? ax : ay}px 條紋（${edge}）` });
            break;
          }
        }
      }
    }
    return out;
  }

  // ───────────────────────── 逐元素：品質（可讀性） ─────────────────────────

  function hasVisibleBgBoundary(el) {
    const bg = cs(el).backgroundColor;
    if (isTransparentCss(bg)) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const pb = cs(p).backgroundColor;
      if (!isTransparentCss(pb)) {
        const a = parseColor(bg), b = parseColor(pb);
        if (!a || !b) return true;
        return !(Math.abs(alphaOf(a) - alphaOf(b)) <= 0.03 && Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) <= 3);
      }
    }
    return true;
  }
  function flushSides(el, rect) {
    const flush = [false, false, false, false];
    for (const node of qsa(el, TEXT_EDGE_QUERY)) {
      if (!hasDirectTextLongerThan(node, 4)) continue;
      const nr = directTextRect(node) || rectOf(node);
      if (nr.width <= 0 || nr.height <= 0) continue;
      if (nr.bottom < rect.top || nr.top > rect.bottom || nr.right < rect.left || nr.left > rect.right) continue;
      if (nr.top - rect.top <= 4) flush[0] = true;
      if (rect.right - nr.right <= 4) flush[1] = true;
      if (rect.bottom - nr.bottom <= 4) flush[2] = true;
      if (nr.left - rect.left <= 4) flush[3] = true;
    }
    return flush;
  }
  const isVisuallyHidden = el => {
    if (matches(el, SR_ONLY_SELECTOR) || closest(el, SR_ONLY_SELECTOR)) return true;
    const s = cs(el);
    if (s.position === 'absolute' || s.position === 'fixed') {
      if (/rect\(\s*0/.test(s.clip || '') || /inset\(\s*(?:50%|99|100%)/.test(s.clipPath || '')) return true;
      const w = parseFloat(s.width), h = parseFloat(s.height);
      if ((w === 1 || h === 1) && (s.overflow === 'hidden' || s.overflow === 'clip')) return true;
    }
    return false;
  };
  function qualityPass() {
    const out = [];
    const lineMax = Number(選項.行長上限) || 80;
    const viewportW = W.innerWidth || 0;
    for (const el of elements()) {
      const t = tagOf(el);
      const s = cs(el);
      const hasText = hasDirectTextLongerThan(el, 10);
      const textLen = el.textContent.trim().length;
      const fs = parseFloat(s.fontSize) || 16;
      const lh = lengthPx(s.lineHeight, fs);
      const ls = lengthPx(s.letterSpacing, fs);
      const rect = rectOf(el);
      const isHeading = HEADING_TAGS.has(t);
      const add = (id, 細節) => out.push({ el, id, 細節 });

      // line-length：量實際渲染出來的每一行，兩行以上超過才算
      if (hasText && QUALITY_TEXT_TAGS.has(t) && rect.width > 0 && textLen > lineMax) {
        const ws = lineWidths(el);
        const total = ws.reduce((a, b) => a + b, 0);
        if (total > 0) {
          const chars = w => textLen * w / total;
          const long = ws.filter(w => chars(w) > lineMax + 5).length;
          if (long >= 2) add('line-length', `約 ${Math.round(chars(Math.max(...ws)))} 字／行，${ws.length} 行中有 ${long} 行過長（目標 < ${lineMax}）`);
        }
      }
      // cramped-padding（一）：自己有字、有邊框或底色，但字貼著邊
      const inlineCode = t === 'code' && !closest(el, 'pre');
      if (!inlineCode && hasText && textLen > 20 && rect.width > 100 && rect.height > 30) {
        const b = SIDES.map(sd => num(s[`border${sd}Width`]));
        const hasBg = hasVisibleBgBoundary(el);
        if (b.filter(w => w > 0).length >= 2 || hasBg) {
          const tr = directTextRect(el);
          if (tr) {
            const v = [], h = [];
            if (hasBg || b[0] > 0) v.push(tr.top - (rect.top + b[0]));
            if (hasBg || b[2] > 0) v.push((rect.bottom - b[2]) - tr.bottom);
            if (hasBg || b[3] > 0) h.push(tr.left - (rect.left + b[3]));
            if (hasBg || b[1] > 0) h.push((rect.right - b[1]) - tr.right);
            const vMin = Math.min(Infinity, ...v), hMin = Math.min(Infinity, ...h);
            const vT = Math.max(4, fs * 0.3), hT = Math.max(8, fs * 0.5);
            // 加碼：字已經衝出框外（負值）是 text-overflow 的事，這裡不重複報成「內距太小」
            if (vMin < -1 || hMin < -1) { /* 交給 text-overflow */ }
            else if (vMin < vT) add('cramped-padding', `文字上下只有 ${Math.round(vMin * 10) / 10}px（${fs}px 字需要 ≥${vT.toFixed(1)}px）`);
            else if (hMin < hT) add('cramped-padding', `文字左右只有 ${Math.round(hMin * 10) / 10}px（${fs}px 字需要 ≥${hT.toFixed(1)}px）`);
          }
        }
      }
      // cramped-padding（二）：容器有可見邊界，子元素的字貼著邊、中間沒有任何內距
      if (!FLUSH_SKIP_TAGS.has(t) && !hasText && s.position !== 'fixed' && s.position !== 'absolute' && el.children.length) {
        const bw = SIDES.map(sd => num(s[`border${sd}Width`]));
        const bVis = SIDES.map((sd, i) => bw[i] > 0 && !isTransparentCss(s[`border${sd}Color`]));
        const oVis = num(s.outlineWidth) > 0 && !isTransparentCss(s.outlineColor) && s.outlineStyle && s.outlineStyle !== 'none';
        const bgVis = hasVisibleBgBoundary(el);
        if (bVis.some(Boolean) || oVis || bgVis) {
          const pad = SIDES.map(sd => lengthPx(s[`padding${sd}`], fs) || 0);
          const over = [false, false, false, false], ins = [false, false, false, false];
          for (const ch of el.children) {
            const c = cs(ch);
            const cp = SIDES.map(sd => lengthPx(c[`padding${sd}`], fs) || 0), cm = SIDES.map(sd => lengthPx(c[`margin${sd}`], fs) || 0);
            const cr = rectOf(ch);
            if (cr.width > 0 && cr.height > 0) {
              if (rect.top - cr.top > 1) over[0] = true; if (cr.right - rect.right > 1) over[1] = true;
              if (cr.bottom - rect.bottom > 1) over[2] = true; if (rect.left - cr.left > 1) over[3] = true;
              if (cr.top - rect.top >= 4) ins[0] = true; if (rect.right - cr.right >= 4) ins[1] = true;
              if (rect.bottom - cr.bottom >= 4) ins[2] = true; if (cr.left - rect.left >= 4) ins[3] = true;
            }
            for (let i = 0; i < 4; i++) if (cp[i] >= 4 || cm[i] >= 4) ins[i] = true;
          }
          const tf = flushSides(el, rect);
          const fullBleed = viewportW > 0 && rect.width >= viewportW * 0.94 && bgVis && !oVis;
          const names = ['上', '右', '下', '左'];
          const fl = [];
          for (let i = 0; i < 4; i++) {
            const bounded = bVis[i] || oVis || (bgVis && !(fullBleed && (i === 1 || i === 3)));
            if (bounded && pad[i] <= 2 && !ins[i] && !over[i] && tf[i]) fl.push(names[i]);
          }
          if (fl.length && Array.from(el.children).some(ch => ch.textContent.trim().length > 4)) {
            const kind = [bVis.every(Boolean) ? 'border' : bVis.some(Boolean) ? 'border-部分' : '', oVis ? 'outline' : '', bgVis ? '底色' : ''].filter(Boolean).join('+');
            add('cramped-padding', `<${t}> 子元素的字貼著 ${kind} 的${fl.length === 4 ? '四邊' : fl.join('／') + '邊'}（沒有內距）`);
          }
        }
      }
      // body-text-viewport-edge（加碼：祖先是 fixed／absolute 也排除）
      if (hasText && textLen > 40 && (t === 'p' || t === 'li') && viewportW > 0) {
        const inNav = closest(el, 'nav') || closest(el, 'header');
        const ownBg = s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
        const positioned = s.position === 'fixed' || s.position === 'absolute' || layered(el);
        const lc = rect.left < 16, rc = rect.right > viewportW - 16;
        if (!inNav && !ownBg && !positioned && rect.width / viewportW > 0.5 && (lc || rc)) {
          add('body-text-viewport-edge', `<${t}> ${textLen} 字的內文貼到視窗邊（${lc ? '左 ' + Math.round(rect.left) + 'px' : ''}${lc && rc ? '／' : ''}${rc ? '右 ' + Math.round(viewportW - rect.right) + 'px' : ''}）`);
        }
      }
      if (hasText && textLen > 50 && !isHeading && lh != null && fs > 0) {
        const ratio = lh / fs;
        if (ratio > 0 && ratio < 1.3) add('tight-leading', `line-height ${ratio.toFixed(2)} 倍（需要 ≥1.3）`);
      }
      if (hasText && s.textAlign === 'justify' && (s.hyphens || s.webkitHyphens) !== 'auto') add('justified-text', 'text-align: justify 卻沒有 hyphens: auto');
      if (hasText && textLen > 20 && fs < 12 && !['sub', 'sup', 'code', 'kbd', 'samp', 'var', 'caption', 'figcaption'].includes(t) && !closest(el, TINY_TEXT_UI_CONTEXT) && s.textTransform !== 'uppercase') {
        add('tiny-text', `${fs}px 內文`);
      }
      {
        const dt = collapse(directText(el));
        if (fs > 0 && fs < 11 && dt.length >= 2 && !['sub', 'sup', 'option'].includes(t) && !(matches(el, EXEMPT_CONTEXT) || closest(el, EXEMPT_CONTEXT)) && !isVisuallyHidden(el)) {
          const inter = matches(el, INTERACTIVE) || !!closest(el, INTERACTIVE);
          const furn = matches(el, FURNITURE) || !!closest(el, FURNITURE);
          const small = matches(el, SMALLPRINT) || !!closest(el, SMALLPRINT);
          const floor = !inter && small ? 10 : 11;
          if (fs < floor && (inter || furn || dt.length <= 20)) add('undersized-ui-text', `${fs}px 功能性文字「${clip(dt, 40)}」（低於 ${floor}px 下限）`);
        }
      }
      if (hasText && textLen > 30 && s.textTransform === 'uppercase' && !isHeading) add('all-caps-body', `${textLen} 字內文用 text-transform: uppercase`);
      if (hasText && textLen > 20 && s.textTransform !== 'uppercase' && ls != null && ls > 0 && ls / fs > 0.05) add('wide-tracking', `內文 letter-spacing: ${(ls / fs).toFixed(2)}em`);
      if (hasText && textLen > 20 && ls != null && ls < 0 && ls / fs <= -0.05) add('extreme-negative-tracking', `letter-spacing: ${(ls / fs).toFixed(2)}em —「${clip(collapse(el.textContent), 40)}」`);
    }
    return out;
  }

  // ───────────────────────── 樣式表語料：monotonous-spacing ─────────────────────────

  function monotonousSpacing() {
    const { style, cls } = corpora();
    const vals = [];
    for (const m of style.matchAll(/(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*(\d+)px/gi)) { const v = parseInt(m[1], 10); if (v > 0 && v < 200) vals.push(v); }
    for (const m of style.matchAll(/(?:^|[^-\w])gap\s*:\s*(\d+)px/gi)) vals.push(parseInt(m[1], 10));
    for (const m of cls.matchAll(/\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap)-(\d+)\b/g)) vals.push(parseInt(m[1], 10) * 4);
    for (const m of style.matchAll(/(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*([\d.]+)rem/gi)) { const v = Math.round(parseFloat(m[1]) * 16); if (v > 0 && v < 200) vals.push(v); }
    const r = vals.map(v => Math.round(v / 4) * 4);
    if (r.length < 10) return [];
    const counts = new Map(); r.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
    let dom = null, max = 0; counts.forEach((c, v) => { if (c > max) { max = c; dom = v; } });
    const uniq = [...new Set(r)].filter(v => v > 0);
    if (max / r.length > 0.6 && uniq.length <= 3) return [hit(D.body, `約 ${dom}px 用了 ${max}/${r.length} 次（${Math.round(max / r.length * 100)}%）`)];
    return [];
  }

  // ───────────────────────── 其他頁面層級量測 ─────────────────────────

  function typography() {
    const usage = new Map(); let total = 0;
    for (const el of qsa(D, 'p, h1, h2, h3, h4, h5, h6, li, td, th, dd, blockquote, figcaption, a, button, label, span')) {
      if (!hasDirectTextLongerThan(el, 0) || !isVisible(el)) continue;
      const p = fontPrimary(cs(el).fontFamily, CSS_GENERIC_FONTS);
      if (!p) continue;
      usage.set(p, (usage.get(p) || 0) + 1); total++;
    }
    if (total < 20) return [];
    const ranked = [...usage.entries()].sort((a, b) => b[1] - a[1]);
    const [font, count] = ranked[0];
    if (ranked[1] && ranked[1][1] === count) return [];
    const host = (location.hostname || '').toLowerCase();
    const own = (BRAND_FONT_DOMAINS[font] || []).some(d => host === d || host.endsWith('.' + d));
    if (OVERUSED_FONTS.has(font) && !own) return [hit(D.body, `主要字型：${font}（佔 ${Math.round(count / total * 100)}% 的文字）`)];
    return [];
  }
  function flatHierarchy() {
    const byRole = new Map();
    for (const el of qsa(D, 'h1,h2,h3,h4,h5,h6,p,li,td,th,dd,blockquote,figcaption')) {
      if (!el.textContent.trim() || !isVisible(el) || el.hidden) continue;
      const size = Math.round(parseFloat(cs(el).fontSize) * 10) / 10;
      if (!Number.isFinite(size) || size < 8 || size >= 200) continue;
      const role = /^h[1-6]$/.test(tagOf(el)) ? tagOf(el) : 'body';
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(size);
    }
    const roles = [];
    byRole.forEach((sizes, role) => {
      const c = new Map(); sizes.forEach(s => c.set(s, (c.get(s) || 0) + 1));
      const r = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (r.length > 1 && r[0][1] === r[1][1]) return;
      roles.push([role, r[0][0]]);
    });
    if (roles.length < 3) return [];
    roles.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    let step = 1;
    for (let i = 1; i < roles.length; i++) step = Math.max(step, roles[i][1] / roles[i - 1][1]);
    if (step >= 1.25) return [];
    return [hit(D.body, `各角色字級：${roles.map(([r, s]) => `${r} ${s}px`).join('、')}（相鄰最大級距 ${step.toFixed(2)}:1；目標 1.25:1）`)];
  }
  function nestedCards() {
    const flagged = [];
    for (const el of qsa(D.body, '*')) {
      if (!isVisible(el) || !isCardLike(el) || flagged.includes(el)) continue;
      const s = cs(el);
      if (s.position === 'absolute' || s.position === 'fixed') continue;
      if (/\b(?:dropdown|popover|tooltip|menu|modal|dialog)\b/i.test(classStr(el))) continue;
      if (el.textContent.trim().length < 10) continue;
      const r = rectOf(el);
      if (r.width < 50 || r.height < 30) continue;
      for (let p = el.parentElement; p; p = p.parentElement) if (isCardLike(p)) { flagged.push(el); break; }
    }
    return flagged.filter(el => !flagged.some(o => o !== el && el.contains(o))).map(el => hit(el, '卡片裡又套卡片'));
  }
  const isCream = c => !!c && Math.min(c.r, c.g, c.b) >= 209 && c.r >= c.g && c.g >= c.b && (c.r - c.b) >= 6 && (c.r - c.b) <= 48;
  const TAILWIND_BG_HEX = [['bg-amber-50', '#fffbeb'], ['bg-amber-100', '#fef3c7'], ['bg-orange-50', '#fff7ed'],
    ['bg-orange-100', '#ffedd5'], ['bg-yellow-50', '#fefce8'], ['bg-stone-50', '#fafaf9'], ['bg-stone-100', '#f5f5f4'], ['bg-stone-200', '#e7e5e4']];
  function creamPalette() {
    let bg = parseColor(cs(D.body).backgroundColor);
    if (!bg || alphaOf(bg) === 0) bg = parseColor(cs(D.documentElement).backgroundColor);
    if (bg && alphaOf(bg) > 0 && isCream(bg)) return [hit(D.body, `頁面底色是奶油／米色 rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`)];
    // Tailwind class 寫了但 CSS 沒編進來時，計算後樣式看不到，改看 class
    for (const el of [D.body, D.documentElement]) {
      const cls = classStr(el);
      const arb = /\bbg-\[([^\]]+)\]/.exec(cls);
      if (arb && isCream(parseColor(arb[1].replace(/_/g, ' ')))) return [hit(D.body, `頁面底色是奶油／米色（Tailwind bg-[${arb[1]}]）`)];
      for (const [tok, hx] of TAILWIND_BG_HEX) if (new RegExp(`(?:^|\\s)${tok}(?:$|\\s)`).test(cls) && isCream(parseColor(hx))) return [hit(D.body, `頁面底色是奶油／米色（Tailwind ${tok}）`)];
    }
    return [];
  }
  // 原作 checkHtmlPatterns 的「紫色強調色」：樣式表裡的 color 或漸層用了那幾個招牌紫
  function purpleAccentRules() {
    const A = ['#7c3aed', '#8b5cf6', '#a855f7', '#9333ea', '#7e22ce', '#6d28d9'].map(parseColor);
    const B = ['#7c3aed', '#8b5cf6', '#a855f7', '#764ba2', '#667eea'].map(parseColor);
    const same = (c, list) => c && list.some(x => Math.max(Math.abs(x.r - c.r), Math.abs(x.g - c.g), Math.abs(x.b - c.b)) <= 1);
    for (const r of allRules()) {
      if (r.type !== 1 || !r.selectorText) continue;
      const colorHit = same(parseColor(r.style.color), A);
      const gradHit = /gradient/i.test(r.style.backgroundImage || r.style.background || '') && colorTokens(r.style.backgroundImage || r.style.background).some(t => same(parseColor(t), B));
      if (!colorHit && !gradHit) continue;
      // 選擇器在畫面上真的有對到、而且畫得出來的元素才算（死 CSS 不報）
      const sel = r.selectorText.replace(/::?(before|after|first-line|first-letter|placeholder|marker|selection)\b/gi, '');
      const live = qsa(D, sel || '*').find(isVisible);
      if (live) return [hit(live, `樣式表 ${clip(r.selectorText, 60)} 用了招牌紫色強調色`)];
    }
    return [];
  }
  function skippedHeading() {
    const out = []; let prev = 0, prevText = '';
    for (const h of qsa(D, 'h1, h2, h3, h4, h5, h6')) {
      if (!isVisible(h)) continue; // 加碼：沒畫出來的標題不算進大綱
      const level = parseInt(h.tagName[1], 10);
      const text = clip(collapse(h.textContent), 60);
      if (prev > 0 && level > prev + 1) out.push(hit(h, `<h${prev}>「${prevText}」後面直接接 <h${level}>「${text}」（少了 h${prev + 1}）`));
      prev = level; prevText = text;
    }
    return out;
  }
  function contentHiddenAtRest() {
    const cache = new Map();
    const state = el => {
      if (!el || el === D.documentElement) return 'v';
      if (cache.has(el)) return cache.get(el);
      let st;
      if (HIDDEN_TEXT_EXCLUDE_TAGS.has(tagOf(el))) st = 'x';
      else {
        const ps = state(el.parentElement);
        const s = cs(el);
        if (ps === 'x') st = 'x';
        else if (s.display === 'none' || el.hidden || el.getAttribute('aria-hidden') === 'true' || (s.contentVisibility || '').toLowerCase() === 'hidden') st = 'x';
        else if (ps === 'i' || num(s.opacity) <= 0.02 && s.opacity !== '' || /^(hidden|collapse)$/.test(s.visibility)) st = 'i';
        else st = 'v';
      }
      cache.set(el, st); return st;
    };
    let total = 0, hidden = 0; const samples = [];
    for (const el of qsa(D, 'body *')) {
      let len = 0;
      for (const c of el.childNodes) if (c.nodeType === 3) len += collapse(c.textContent).length;
      if (!len) continue;
      const st = state(el);
      if (st === 'x') continue;
      total += len;
      if (st === 'i') { hidden += len; if (samples.length < 3) { const t = clip(collapse(el.textContent), 40); if (t) samples.push(t); } }
    }
    if (total < 200 || hidden < 150 || hidden / total <= 0.3) return [];
    return [hit(D.body, `${Math.round(hidden / total * 100)}% 的頁面文字（${hidden}/${total} 字）停在 opacity 0／visibility hidden${samples[0] ? `（例如「${samples[0]}」）` : ''}`)];
  }
  function headingRhythm() {
    const body = D.body;
    const flow = el => {
      const s = cs(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (num(s.opacity === '' ? '1' : s.opacity) <= 0.05) return false;
      if (['absolute', 'fixed', 'sticky'].includes(s.position)) return false;
      const r = rectOf(el); return r.width >= 1 && r.height >= 1;
    };
    const ox = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) >= 8;
    const ownTop = el => { const s = cs(el); const bg = parseColor(s.backgroundColor); return (bg && alphaOf(bg) > 0.05) || num(s.borderTopWidth) > 0 || (s.boxShadow && s.boxShadow !== 'none'); };
    const fsz = el => parseFloat(cs(el).fontSize) || 16;
    const cands = [];
    for (const h of qsa(D, 'h2, h3, h4')) {
      if (!flow(h) || !isVisible(h) || pinnedAncestor(h)) continue;
      const text = collapse(h.textContent);
      if (text.length < 3) continue;
      const rect = rectOf(h);
      let below = null;
      for (let n = h; n && n !== body && below == null; n = n.parentElement) {
        for (let s = n.nextElementSibling; s; s = s.nextElementSibling) if (flow(s)) { const sr = rectOf(s); if (sr.top >= rect.bottom - 2 && ox(sr, rect)) { below = sr.top; break; } }
      }
      if (below == null) continue;
      let topEl = h, top = rect.top;
      for (let i = 0; i < 3; i++) {
        const sib = topEl.previousElementSibling;
        if (!sib || !flow(sib)) break;
        const sr = rectOf(sib);
        if (!ox(sr, rect)) break;
        const gap = top - sr.bottom;
        if (gap < 0 || gap >= 28 || sr.height > 60) break;
        const tl = sib.textContent.trim().length;
        if (!(fsz(sib) < fsz(h) * 0.75 || tl <= 40) || tl > 80) break;
        topEl = sib; top = sr.top;
      }
      let above = null;
      outer: for (let n = topEl; n && n !== body;) {
        for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (flow(s)) { const sr = rectOf(s); if (sr.bottom <= top + 2 && ox(sr, rect)) { above = sr.bottom; break outer; } }
        const p = n.parentElement;
        if (!p || p === body || ownTop(p)) break;
        n = p;
      }
      if (above == null) continue;
      let small = false;
      for (let c = h.parentElement; c && c !== body; c = c.parentElement) if (isCardLike(c) && rectOf(c).height < 200) { small = true; break; }
      if (small) continue;
      const a = Math.max(0, top - above), b = Math.max(0, below - rect.bottom);
      if (b < 6 || b > 160) continue;
      if (a < b * 0.75 && b - a >= 12) cands.push({ h, a, b, text });
    }
    if (cands.length < 2) return [];
    return cands.map(c => hit(c.h, `${tagOf(c.h)}「${clip(c.text, 60)}」上方 ${Math.round(c.a)}px、下方 ${Math.round(c.b)}px —— 讀起來像屬於上一段（全頁 ${cands.length} 個標題）`));
  }
  function edgeFlushCards() {
    const out = [];
    const scroller = el => /(auto|scroll)/.test(cs(el).overflowX) || /(auto|scroll)/.test(cs(el).overflow);
    for (const sc of qsa(D.body, '*')) {
      if (!isVisible(sc) || !scroller(sc)) continue;
      if (sc.scrollWidth <= sc.clientWidth + 8 || sc.scrollLeft > 4) continue;
      const r = rectOf(sc);
      if (r.width < 120 || r.height < 60 || r.top + (W.scrollY || 0) > 2 * vh()) continue;
      const cl = r.left + sc.clientLeft, cr = cl + sc.clientWidth;
      const flush = [];
      for (const card of qsa(sc, '*')) {
        if (!isRenderedForRule(card)) continue;
        let owner = card.parentElement;
        while (owner && owner !== sc && !scroller(owner)) owner = owner.parentElement;
        if (owner !== sc) continue;
        const cr2 = rectOf(card);
        if (cr2.width < 80 || cr2.height < 40) continue;
        const bg = parseColor(cs(card).backgroundColor);
        const sides = SIDES.filter(sd => num(cs(card)[`border${sd}Width`]) > 0).length;
        if (!(bg && alphaOf(bg) > 0.5) && sides < 2) continue;
        const lg = cr2.left - cl, rg = cr - cr2.right;
        const fr = lg >= 6 && rg < 8 && rg > -24, fl = rg >= 6 && lg < 8 && lg > -24;
        if (fr || fl) flush.push({ card, edge: fr ? '右' : '左', gap: Math.round(fr ? rg : lg) });
      }
      if (!flush.length) continue;
      const worst = flush.reduce((a, b) => (b.gap < a.gap ? b : a));
      out.push(hit(sc, `${flush.length} 張卡片在靜止時貼著 ${classSel(sc)} 的${worst.edge}緣（間距 ${worst.gap}px，例如 ${classSel(worst.card)}）`));
    }
    return out;
  }
  function textOcclusion() {
    const out = []; const seen = new Set();
    const VW = vw(), VH = vh();
    const floated = el => ['left', 'right'].includes((cs(el).cssFloat || cs(el).float || 'none').toLowerCase());
    const marqueeish = el => el.tagName === 'MARQUEE' || /\b(marquee|ticker|scroller|carousel|conveyor)\b/i.test(classStr(el) + ' ' + (el.id || '')) || /marquee|ticker|scroll/.test((cs(el).animationName || '').toLowerCase());
    const painted = el => {
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
      for (let c = el; c; c = c.parentElement) {
        const s = cs(c); const v = (s.visibility || '').toLowerCase();
        if (s.display === 'none' || v === 'hidden' || v === 'collapse' || (s.opacity !== '' && num(s.opacity) <= 0.05) || (s.contentVisibility || '').toLowerCase() === 'hidden') return false;
      }
      return true;
    };
    // 被 overflow 祖先裁掉的部分不算（getBoundingClientRect 是幾何，不是看得到的東西）
    const paintedRect = (el, r) => {
      let { left, top, right, bottom } = r;
      for (let c = el.parentElement; c && c !== D.documentElement; c = c.parentElement) {
        const s = cs(c);
        const cx = (s.overflowX || 'visible') !== 'visible', cy = (s.overflowY || 'visible') !== 'visible';
        if (!cx && !cy) continue;
        const b = rectOf(c);
        if (cx) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
        if (cy) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
        if (right - left < 1 || bottom - top < 1) return null;
      }
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    };
    const opaqueBox = el => {
      const s = cs(el); const bg = parseColor(s.backgroundColor);
      if (bg && alphaOf(bg) > 0.6) return true;
      let n = 0;
      for (const sd of SIDES) { if (num(s[`border${sd}Width`]) <= 0) continue; const bc = parseColor(s[`border${sd}Color`]); if (bc && alphaOf(bc) > 0.3) n++; }
      return n >= 2;
    };
    const texts = [];
    for (const el of qsa(D, 'body *')) {
      const t = tagOf(el);
      if (OCCLUSION_TEXT_SKIP_TAGS.has(t)) continue;
      const inSvg = !!closest(el, 'svg');
      if (inSvg && t !== 'text') continue;
      const text = inSvg ? el.textContent.trim() : directText(el).trim();
      if (text.length < 2 || !painted(el) || effectiveOpacity(el) <= 0.02) continue;
      const full = rectOf(el);
      if (full.width < 6 || full.height < 6) continue;
      const r = paintedRect(el, full);
      if (!r || r.width < 6 || r.height < 6 || r.bottom <= 0 || r.top >= VH) continue;
      texts.push({ el, r, text });
    }
    for (const { el, r, text } of texts) {
      if (seen.has(el) || isScreenReaderOnly(el)) continue;
      const cols = Math.max(6, Math.min(30, Math.round(r.width / 12))), rows = Math.max(1, Math.min(4, Math.round(r.height / 14)));
      let total = 0, occ = 0, occEl = null, kind = '';
      for (let i = 0; i < cols; i++) {
        const x = r.left + r.width * ((i + 0.5) / cols);
        if (x < 1 || x > VW - 1) continue;
        for (let j = 0; j < rows; j++) {
          const y = r.top + r.height * ((j + 0.5) / rows);
          if (y < 1 || y > VH - 1) continue;
          total++;
          const top = D.elementFromPoint(x, y);
          if (!top || top === el || el.contains(top) || top.contains(el)) continue;
          // 固定／黏性層（導覽列、浮動按鈕）本來就疊在內容上，不算遮擋
          if (floated(top) || marqueeish(top) || pinnedAncestor(top)) continue;
          if (effectiveOpacity(top) <= 0.02) continue;
          if (['img', 'video', 'canvas', 'picture'].includes(tagOf(top))) continue;
          const topText = !!directText(top).trim() || !!closest(top, 'svg');
          if (opaqueBox(top)) { occ++; if (!occEl) { occEl = top; kind = 'box'; } }
          else if (topText) { occ++; if (!occEl) { occEl = top; kind = 'text'; } }
        }
      }
      if (!occEl || !total) continue;
      const frac = occ / total;
      if (frac < (kind === 'text' ? 0.45 : 0.3)) continue;
      if (kind === 'text') {
        const vs = closest(el, 'svg'), os = closest(occEl, 'svg');
        if (vs && os && vs === os) continue;
        if (!layered(el) && !layered(occEl)) continue;
      }
      seen.add(el);
      out.push(hit(el, `${classSel(el)}「${clip(text, 24)}」有 ${Math.round(frac * 100)}% 被${kind === 'text' ? '重疊的文字' : '不透明元素'} ${classSel(occEl)} 蓋住`));
    }
    // 大標題壓到卡片
    const cards = [];
    for (const el of qsa(D, 'body *')) {
      if (closest(el, 'svg') || !painted(el)) continue;
      const s = cs(el); const bg = parseColor(s.backgroundColor);
      if (!bg || alphaOf(bg) <= 0.7) continue;
      if (s.backgroundImage && s.backgroundImage !== 'none' && /(gradient|url)\(/i.test(s.backgroundImage)) continue;
      const border = SIDES.some(sd => num(s[`border${sd}Width`]) > 0), shadow = s.boxShadow && s.boxShadow !== 'none';
      if (!border && !shadow) continue;
      if (pinnedAncestor(el)) continue;
      const cr = rectOf(el);
      if (cr.width < 100 || cr.width > 0.8 * VW || cr.height < 60) continue;
      cards.push({ el, r: cr });
    }
    for (const { el, r, text } of texts) {
      if (seen.has(el)) continue;
      const fs = parseFloat(cs(el).fontSize) || 16;
      if (fs < 40) continue;
      let lh = parseFloat(cs(el).lineHeight); if (!Number.isFinite(lh)) lh = fs * 1.2;
      const cx = r.left + r.width / 2;
      for (const c of cards) {
        if (c.el === el || el.contains(c.el) || c.el.contains(el)) continue;
        const ix = Math.max(0, Math.min(r.right, c.r.right) - Math.max(r.left, c.r.left));
        const iy = Math.max(0, Math.min(r.bottom, c.r.bottom) - Math.max(r.top, c.r.top));
        if (ix < 8 || iy < 0.5 * lh || (cx >= c.r.left && cx <= c.r.right) || ix > 0.5 * r.width) continue;
        seen.add(el);
        out.push(hit(el, `${classSel(el)}「${clip(text, 24)}」凸出壓到 ${classSel(c.el)} ${Math.round(ix)}px —— 標題與卡片相撞`));
        break;
      }
    }
    // 行內元素的不透明底色往上下漏
    for (const el of qsa(D, 'body *')) {
      if (closest(el, 'svg') || !painted(el) || seen.has(el)) continue;
      const s = cs(el);
      if (s.display !== 'inline') continue;
      const bg = parseColor(s.backgroundColor);
      if (!bg || alphaOf(bg) <= 0.6) continue;
      if (num(s.paddingTop) + num(s.paddingBottom) < 24) continue;
      const r = rectOf(el);
      if (r.width < 12 || r.height < 24) continue;
      const fs = parseFloat(s.fontSize) || 16;
      let lh = parseFloat(s.lineHeight); if (!Number.isFinite(lh)) lh = fs * 1.4;
      if (r.height < 2.2 * lh) continue;
      let onto = null;
      for (const o of (el.parentElement ? el.parentElement.children : [])) {
        if (o === el || o.contains(el) || el.contains(o) || cs(o).display === 'none') continue;
        const or = rectOf(o);
        const ix = Math.max(0, Math.min(r.right, or.right) - Math.max(r.left, or.left)), iy = Math.max(0, Math.min(r.bottom, or.bottom) - Math.max(r.top, or.top));
        if (ix > 4 && iy > 4 && o.textContent.trim()) { onto = o; break; }
      }
      seen.add(el);
      out.push(hit(el, `${classSel(el)} 是行內元素，不透明底色漏出行高 ${Math.round(r.height)}px${onto ? '，壓到 ' + classSel(onto) : ''}`));
    }
    return out;
  }
  function firstViewportColumnOverflow() {
    const out = []; const VW = vw(), VH = vh(), sy = W.scrollY || 0;
    for (const el of qsa(D, 'body *')) {
      if (!/(^|inline-)(grid|flex)$/.test(cs(el).display) || !isVisible(el)) continue;
      const r = rectOf(el);
      if (r.width < 0.5 * VW) continue;
      const pt = r.top + sy;
      if (pt >= VH * 0.9 || pt + r.height <= VH) continue;
      const cols = [];
      for (const ch of el.children) {
        const s = cs(ch);
        if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed') continue;
        const cr = rectOf(ch); const share = cr.width / r.width;
        if (share < 0.25 || share > 0.9 || cr.height < 40) continue;
        let bottom = cr.top;
        for (const d of qsa(ch, '*')) {
          const ds = cs(d);
          if (ds.position === 'absolute' || ds.position === 'fixed' || ds.display === 'none' || ds.visibility === 'hidden') continue;
          const dr = rectOf(d); if (dr.width > 0 && dr.height > 0) bottom = Math.max(bottom, dr.bottom);
        }
        cols.push({ top: cr.top, h: bottom - cr.top });
      }
      if (cols.length < 2) continue;
      cols.sort((a, b) => b.h - a.h);
      const tall = cols[0], short = cols[cols.length - 1];
      if (Math.abs(tall.top - short.top) > 0.25 * VH || tall.h <= VH * 1.4 || short.h > VH) continue;
      out.push(hit(el, `${classSel(el)} 開頁就有一欄長到 ${Math.round(tall.h / VH * 100)}% 視窗高，旁邊一欄只有 ${Math.round(short.h / VH * 100)}%`));
    }
    return out;
  }
  function repeatedContainerText() {
    const isContainer = el => {
      const s = cs(el);
      const shadow = s.boxShadow && s.boxShadow !== 'none';
      const border = SIDES.filter(sd => num(s[`border${sd}Width`]) >= 1).length >= 3;
      const radius = num(s.borderRadius) > 0;
      const bg = parseColor(s.backgroundColor);
      if (!shadow && !border) return false;
      return radius || !!(bg && alphaOf(bg) > 0.1);
    };
    const containers = qsa(D, '*').filter(el => REPEATED_TEXT_CONTAINER_TAGS.has(tagOf(el)) && !closest(el, REPEATED_TEXT_SKIP_SELECTOR) && isContainer(el));
    const cset = new Set(containers); const out = [];
    for (const c of containers) {
      if (!isRenderedForRule(c)) continue;
      const desc = qsa(c, '*');
      if (desc.length > 250) continue;
      const groups = new Map();
      for (const d of desc) {
        let inner = false;
        for (let a = d.parentElement; a && a !== c; a = a.parentElement) if (cset.has(a)) { inner = true; break; }
        if (inner || closest(d, REPEATED_TEXT_SKIP_SELECTOR)) continue;
        if (/icon|material-symbols|(?:^|\s)fa[srlbd]?(?:\s|-|$)/i.test(classStr(d)) || !isRenderedForRule(d)) continue;
        const text = cleanInlineText(d);
        if (text.length < 4 || text.length > 48 || !/[a-zA-Z一-鿿]/.test(text)) continue;
        const sig = [];
        for (let x = d; x && x !== c; x = x.parentElement) { const cl = classStr(x).trim().split(/\s+/).filter(Boolean).sort().join('.'); sig.push(cl ? `${tagOf(x)}.${cl}` : tagOf(x)); }
        if (!groups.has(text)) groups.set(text, []);
        groups.get(text).push(sig.join('>'));
      }
      groups.forEach((sigs, text) => {
        if (sigs.length >= 3 && new Set(sigs).size >= 3) out.push(hit(c, `「${clip(text, 40)}」在 ${classSel(c)} 裡不同位置出現 ${sigs.length} 次`));
      });
    }
    return out;
  }

  // ───────────────────────── 文字（kicker／編號標籤／文案） ─────────────────────────

  const fsOf = el => parseFloat(cs(el).fontSize) || 0;
  function kickers() {
    const out = [];
    const declared = ((選項.設計系統 || {}).宣告的選擇器 || []);
    for (const h of qsa(D, 'h1, h2, h3, h4, [role="heading"]')) {
      if (!isVisible(h)) continue;
      const m = /^h([1-6])$/.exec(tagOf(h));
      const level = m ? +m[1] : (parseInt(h.getAttribute('aria-level'), 10) || 2);
      if (level > 4 || closest(h, KICKER_SKIP_SELECTOR) || closest(h, APP_CONTEXT)) continue;
      const k = h.previousElementSibling;
      if (!k || !isVisible(k) || closest(k, KICKER_SKIP_SELECTOR)) continue;
      const card = closest(h, KICKER_CARD_CONTEXT_SELECTOR); if (card && card.contains(k)) continue;
      if (declared.some(sel => matches(k, sel))) continue;
      const ht = collapse(h.textContent), kt = cleanInlineText(k) || collapse(k.textContent);
      const hfs = fsOf(h), kfs = fsOf(k);
      const kls = lengthPx(cs(k).letterSpacing, kfs) || 0;
      const kTag = tagOf(k);
      if (ht.length < 3 || /^\/[\w-]+/.test(ht.replace(/^"|"$/g, '').trim()) || !(hfs >= 20)) continue;
      if (HEADING_TAGS.has(kTag) || !['p', 'span', 'div', 'small'].includes(kTag)) continue;
      if (kt.length < 2 || kt.length > 34) continue;
      if (/^step\s*\d+/i.test(kt) || /^\d{1,2}$/.test(kt)) continue;
      if (/[·•|]|\s[/›»>]\s|\b(19|20)\d{2}\b/.test(kt)) continue;
      if (/^(§|\d+(\.\d+)+\b|(section|article|clause|appendix|exhibit|schedule|chapter|part|rule|title)\s+([0-9ivxlc]+\b|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/i.test(kt)) continue;
      const smallCaps = /small-caps/.test(cs(k).fontVariant + ' ' + cs(k).fontVariantCaps);
      const upper = cs(k).textTransform === 'uppercase' || (/[A-Z]/.test(kt) && !/[a-z]/.test(kt)) || smallCaps;
      if (!upper || !(kfs > 0 && kfs <= 14) || !(kls >= kfs * 0.06)) continue;
      if (tagOf(h) === 'h1' && hfs >= 48 && kls >= 1.6) continue; // 這種交給 hero-eyebrow-chip
      out.push(hit(k, `${tagOf(h)}「${clip(ht, 60)}」上方的小標「${clip(kt, 40)}」`));
    }
    return out;
  }
  function heroEyebrow() {
    const out = [];
    for (const h of qsa(D, 'h1')) {
      if (!isVisible(h) || closest(h, APP_CONTEXT)) continue;
      const sib = h.previousElementSibling;
      if (!sib || !isVisible(sib) || HEADING_TAGS.has(tagOf(sib))) continue;
      if (!(fsOf(h) >= 48)) continue;
      const text = sib.textContent.trim();
      if (text.length < 2 || text.length > 60) continue;
      const sfs = fsOf(sib);
      if (!(sfs > 0 && sfs <= 14)) continue;
      const ss = cs(sib);
      const upper = ss.textTransform === 'uppercase' || (/[A-Z]/.test(text) && !/[a-z]/.test(text));
      const tracked = upper && (lengthPx(ss.letterSpacing, sfs) || 0) >= 1.6;
      const bold = (Number(ss.fontWeight) || 400) >= 700 && isAccentColor(ss.color);
      let dash = false;
      for (const which of ['::before', '::after']) {
        const ps = pcs(sib, which);
        if (!ps || !ps.content || ps.content === 'none') continue;
        const w = num(ps.width), hh = num(ps.height);
        const bg = parseColor(ps.backgroundColor);
        if (w >= 8 && w <= 80 && hh >= 1 && hh <= 6 && bg && alphaOf(bg) >= 0.1 && spread(bg) >= 30) dash = true;
      }
      if (!tracked && !bold && !dash) continue;
      out.push(hit(sib, `眉標（${tracked ? '大寫加寬字距' : bold ? '粗體強調色' : '前置短線'}）「${clip(text, 40)}」在 h1「${clip(collapse(h.textContent), 60)}」上方`));
    }
    return out;
  }
  function numberedLabels() {
    const cands = []; const seenLabels = new Set();
    for (const h of qsa(D, 'h2, h3, h4')) {
      if (!isVisible(h) || closest(h, KICKER_SKIP_SELECTOR)) continue;
      let label = h.previousElementSibling;
      if (!label && h.parentElement && h.parentElement.firstElementChild === h) label = h.parentElement.previousElementSibling;
      if (!label || seenLabels.has(label) || !isVisible(label) || closest(label, KICKER_SKIP_SELECTOR) || HEADING_TAGS.has(tagOf(label))) continue;
      const card = closest(h, KICKER_CARD_CONTEXT_SELECTOR); if (card && card.contains(label)) continue;
      const lt = collapse(cleanInlineText(label) || label.textContent);
      if (!lt || lt.length > 40) continue;
      const m = /^(\d{2})$/.exec(lt) || /^(\d{1,2})\s*[^0-9A-Za-z_\s]\s*\S/.exec(lt);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      if (idx > 40) continue;
      const ht = collapse(h.textContent);
      const hfs = fsOf(h), lfs = fsOf(label);
      if (ht.length < 3 || !NUMBERED_LABEL_TAGS.has(tagOf(label)) || !(lfs > 0 && lfs <= 13)) continue;
      if (hfs > 0 && hfs < lfs * 1.3) continue;
      const ls = cs(label);
      const styled = /mono/i.test(ls.fontFamily) || (Number(ls.fontWeight) || 400) >= 600 || (lengthPx(ls.letterSpacing, lfs) || 0) >= 0.5 || ls.textTransform === 'uppercase' || isAccentColor(ls.color);
      if (!styled) continue;
      seenLabels.add(label);
      cands.push({ label, idx, lt, h, ht });
    }
    if (cands.length < 2 || new Set(cands.map(c => c.idx)).size < 2) return [];
    return cands.map(c => hit(c.label, `${tagOf(c.h)}「${clip(c.ht, 60)}」旁的小號編號「${clip(c.lt, 24)}」（全頁 ${cands.length} 個）`));
  }
  const bodyText = () => once('bodyText', () => (D.body.innerText || D.body.textContent || ''));
  function emDash() {
    const body = bodyText().replace(/\s+/g, ' ');
    const n = (body.match(/—|--(?=\S)/g) || []).length;
    if (n < 8 || body.length > n * 500) return [];
    return [hit(D.body, `內文有 ${n} 個破折號（密度約每 ${Math.round(body.length / n)} 字一個）`)];
  }
  function buzzwords() {
    const text = bodyText(); const lower = text.toLowerCase();
    let count = 0, sample = '';
    for (const p of BUZZWORDS) {
      let from = 0, i;
      while ((i = lower.indexOf(p, from)) !== -1) {
        count++;
        if (!sample) sample = text.slice(Math.max(0, i - 12), i + p.length + 12).trim();
        from = i + p.length;
      }
    }
    return count ? [hit(D.body, `${count} 個行銷套話：「${collapse(sample)}」`)] : [];
  }
  function cadence() {
    const text = bodyText();
    const ms = [...text.matchAll(/\bNot an? [a-z][^.!?]{1,40}[.!]\s+[A-Z][^.!?]{1,60}[.!]/g), ...text.matchAll(/\b[A-Z][^.!?]{4,80}[.!]\s+(No|Just)\s+[a-z][^.!?]{2,60}[.!]/g)];
    return ms.length >= 3 ? [hit(D.body, `${ms.length} 個格言式句型：「${clip(collapse(ms[0][0]), 80)}」`)] : [];
  }
  function theater() {
    const m = /\b(\w+)\s+theater\b/i.exec(bodyText());
    return m ? [hit(D.body, `「${m[0].trim()}」`)] : [];
  }

  // ───────────────────────── 逐元素：品味類 ─────────────────────────

  function paletteReadings() {
    const ds = 選項.設計系統;
    const allowed = ds && Array.isArray(ds.顏色) ? ds.顏色.map(parseColor).filter(Boolean) : [];
    const declared = c => allowed.some(a => Math.max(Math.abs(a.r - c.r), Math.abs(a.g - c.g), Math.abs(a.b - c.b)) <= 6);
    const band = h => (h >= 160 && h <= 200 ? 'cyan' : h >= 260 && h <= 310 ? 'purple' : null);
    const hits = [], ink = [], tells = new Set();
    for (const el of elements()) {
      for (const c of gradientColors(cs(el).backgroundImage)) {
        if (declared(c) || !hasChroma(c, 50)) continue;
        const b = band(hue(c));
        if (b) { if (!ignored(el, 'ai-color-palette')) tells.add(b); hits.push(hit(el, b === 'purple' ? `紫／藍紫色漸層背景（${hex(c)}）` : `青色漸層背景（${hex(c)}）`)); break; }
      }
      const tc = parseColor(cs(el).color);
      if (tc && !declared(tc) && hasChroma(tc, 80) && directText(el).trim()) {
        const b = band(hue(tc));
        if (b && el.parentElement) {
          const info = resolveBg(el.parentElement);
          let bg = info.color;
          if (!bg && !info.unresolved) bg = gradientAncestorAverage(el.parentElement);
          if (bg && luminance(bg) < 0.1) { if (!ignored(el, 'ai-color-palette')) tells.add(b); ink.push(hit(el, `${b === 'purple' ? '紫色' : '青色'}霓虹字在深色底上`)); }
        }
      }
      const cls = classStr(el);
      if (/\bfrom-(?:purple|violet|indigo)-\d+\b/.test(cls) && /\bto-(?:purple|violet|indigo|blue|cyan|pink|fuchsia)-\d+\b/.test(cls)) hits.push(hit(el, '紫色系漸層（Tailwind）'));
      const pt = /\btext-(?:purple|violet|indigo)-\d+\b/.exec(cls);
      if (pt && (/^h[123]$/.test(tagOf(el)) || /\btext-(?:[2-9]xl)\b/.test(cls))) hits.push(hit(el, `${pt[0]} 用在標題上（Tailwind）`));
    }
    // 兩種招牌色同時出現才算「那套配色」；只有一種是強調色
    return tells.has('cyan') && tells.has('purple') ? hits.concat(ink) : hits;
  }
  function gradientText() {
    const out = [];
    for (const el of elements()) {
      const s = cs(el);
      if ((s.webkitBackgroundClip || s.backgroundClip) === 'text' && /gradient/i.test(s.backgroundImage || '') && el.textContent.trim()) out.push(hit(el, 'background-clip: text ＋ 漸層'));
      else if (/\bbg-clip-text\b/.test(classStr(el)) && /\bbg-gradient-to-/.test(classStr(el))) out.push(hit(el, 'bg-clip-text ＋ bg-gradient（Tailwind）'));
    }
    return out;
  }
  function motion() {
    const out = [];
    for (const el of elements()) {
      if (SAFE_TAGS.has(tagOf(el))) continue;
      const s = cs(el);
      const name = s.animationName;
      if (name && name !== 'none' && /bounce|elastic|wobble|jiggle|spring/i.test(name)) out.push({ el, id: 'bounce-easing', 細節: `animation: ${name}` });
      if (/\banimate-bounce\b/.test(classStr(el))) out.push({ el, id: 'bounce-easing', 細節: 'animate-bounce（Tailwind）' });
      const tf = [s.animationTimingFunction, s.transitionTimingFunction].filter(Boolean).join(' ');
      for (const m of tf.matchAll(/cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g)) {
        const y1 = parseFloat(m[2]), y2 = parseFloat(m[4]);
        if (y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1) { out.push({ el, id: 'bounce-easing', 細節: m[0] }); break; }
      }
      const tp = s.transitionProperty;
      if (tp && tp !== 'all' && tp !== 'none') {
        const found = tp.split(',').map(p => p.trim().toLowerCase()).filter(p => LAYOUT_TRANSITION_PROPS.has(p));
        // 只有真的有轉場時間才算（transition-property 的預設值是 all，宣告了才會列出）
        const dur = (s.transitionDuration || '').split(',').some(d => parseFloat(d) > 0);
        if (found.length && dur) out.push({ el, id: 'layout-transition', 細節: `transition: ${found.join(', ')}` });
      }
    }
    return out;
  }
  function glow() {
    const out = [];
    for (const el of elements()) {
      const s = cs(el);
      const box = s.boxShadow && s.boxShadow !== 'none' ? s.boxShadow : '';
      let text = s.textShadow && s.textShadow !== 'none' ? s.textShadow : '';
      if (text && el.parentElement && cs(el.parentElement).textShadow === text) text = ''; // 繼承來的不重複算
      if (!box && !text) continue;
      const parent = el.parentElement || el;
      const info = resolveBg(parent);
      let bg = info.color;
      if (!bg && !info.unresolved) bg = gradientAncestorAverage(el.parentElement);
      const dark = !!bg && luminance(bg) < 0.1;
      const scan = (v, prop) => {
        for (const L of shadowLayers(v)) {
          if (!L.color || !hasChroma(L.color, 30)) continue;
          if (L.nums.length < 3 || L.nums[2] <= 4) continue;
          if (L.nums[0] === 0 && L.nums[1] === 0) return `零位移的 ${prop} 光暈（${hex(L.color)}）`;
          if (dark) return `深色底上的彩色 ${prop} 光暈（${hex(L.color)}）`;
        }
        return null;
      };
      const f = scan(box, 'box-shadow') || scan(text, 'text-shadow');
      if (f) out.push(hit(el, f));
    }
    return out;
  }
  // 這幾條常寫在 ::before／::after 上，偽元素也要看
  function withPseudos(fn) {
    const out = [];
    for (const el of elements()) {
      const r = rectOf(el);
      for (const which of [null, '::before', '::after']) {
        const s = which ? pcs(el, which) : cs(el);
        if (!s) continue;
        if (which && (!s.content || s.content === 'none' || s.display === 'none')) continue;
        const res = fn(el, s, which, r);
        if (res) { out.push(hit(el, res + (which ? `（${which}）` : ''))); break; }
      }
    }
    return out;
  }
  function firstRadial(bg) {
    const m = /(repeating-)?radial-gradient\(/i.exec(bg || '');
    if (!m || m[1]) return null;
    let depth = 0, i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < bg.length; i++) { if (bg[i] === '(') depth++; else if (bg[i] === ')') { depth--; if (depth === 0) break; } }
    return splitTopLevel(bg.slice(start, i));
  }
  function radialHalo() {
    if (!pageIsDark()) return [];
    return withPseudos((el, s) => {
      const bg = s.backgroundImage || '';
      if (/url\s*\(/i.test(bg)) return null;
      const args = firstRadial(bg);
      if (!args || args.length < 2) return null;
      const stops = args.filter(a => colorTokens(a).length);
      if (stops.length < 2) return null;
      if (stops.some(st => { const m = /(-?[\d.]+)px\b/.exec(st.replace(COLOR_TOKEN_RE, ' ')); return m && Math.abs(parseFloat(m[1])) <= 24; })) return null;
      const first = parseColor(colorTokens(stops[0])[0]), last = parseColor(colorTokens(stops[stops.length - 1])[0]);
      if (!last || alphaOf(last) > 0.05 || !first || alphaOf(first) < 0.7 || spread(first) < 24) return null;
      return `深色頁面上的 radial-gradient 光暈（${hex(first)} → 透明）`;
    });
  }
  function radialSpotlight() {
    return withPseudos((el, s, which, r) => {
      const bg = s.backgroundImage || '';
      const args = firstRadial(bg);
      if (!args) return null;
      const stops = args.filter(a => colorTokens(a).length).map(a => parseColor(colorTokens(a)[0])).filter(Boolean);
      if (stops.length < 2 || alphaOf(stops[stops.length - 1]) > 0.05) return null;
      const colored = stops.filter(c => alphaOf(c) > 0.05);
      if (!colored.length || colored.length > 2 || colored.some(c => alphaOf(c) >= 0.45)) return null;
      const chroma = colored.find(c => hasChroma(c, 24));
      if (!chroma) return null;
      const w = which ? num(s.width) || r.width : r.width, h = which ? num(s.height) || r.height : r.height;
      if (!(w >= 240 && h >= 160)) return null;
      return `radial-gradient 聚光燈光暈（${hex(chroma)} 透明度 ${alphaOf(chroma).toFixed(2)} → 透明），${Math.round(w)}×${Math.round(h)}px`;
    });
  }
  function repeatingStripes() {
    return withPseudos((el, s) => (/repeating-(?:linear|radial|conic)-gradient\s*\(/i.test(s.backgroundImage || '') ? 'repeating-gradient 裝飾條紋' : null));
  }
  function gridBackground() {
    const TRANSP = '(?:transparent|rgba\\(\\s*\\d+,\\s*\\d+,\\s*\\d+,\\s*0\\s*\\))';
    const hair = new RegExp(`\\b\\d{1,3}px\\s*,\\s*${TRANSP}\\s+\\d{1,3}px`, 'gi');
    const inv = new RegExp(`${TRANSP}\\s+calc\\(100%\\s*-\\s*\\d{1,3}px\\)`, 'gi');
    return withPseudos((el, s) => {
      const bg = s.backgroundImage || '';
      if (!/linear-gradient/i.test(bg)) return null;
      const n = (bg.match(hair) || []).length + (bg.match(inv) || []).length;
      if (n < 2 || !/\b\d{1,3}px\b/.test(s.backgroundSize || '')) return null;
      return `雙軸格線漸層背景（${n} 條細線，background-size ${s.backgroundSize}）`;
    });
  }
  function buriedRaster() {
    const out = [];
    for (const el of qsa(D.body, '*')) {
      // 這條要看「透明到看不見」的東西，所以不能先用 isVisible 濾掉；只排除 display:none 那種
      if (closest(el, '[hidden]') || NON_RENDERED_TAGS.has(tagOf(el))) continue;
      let gone = false; for (let c = el; c; c = c.parentElement) if (cs(c).display === 'none') { gone = true; break; }
      if (gone) continue;
      const s = cs(el); const t = tagOf(el);
      const op = parseFloat(s.opacity);
      if (Number.isFinite(op) && op >= 0 && op < 0.15 && (t === 'img' || /url\(/i.test(s.backgroundImage || ''))) {
        const r = rectOf(el);
        if (r.width > 0 && r.height > 0) { out.push(hit(el, `${t === 'img' ? '<img>' : '點陣背景'} 的 opacity 只有 ${op}${t === 'img' && el.alt ? `「${el.alt}」` : ''}`)); continue; }
      }
      const bg = s.backgroundImage || '';
      if (!/url\(/i.test(bg) || !/gradient\(/i.test(bg)) continue;
      if ((s.backgroundBlendMode && !/^normal(,\s*normal)*$/.test(s.backgroundBlendMode)) || (s.mixBlendMode && s.mixBlendMode !== 'normal')) continue;
      const layers = splitTopLevel(bg);
      const firstUrl = layers.findIndex(l => /url\(/i.test(l));
      const washes = layers.slice(0, firstUrl).filter(l => /gradient\(/i.test(l));
      const opaque = washes.some(w => { const cols = colorTokens(w).map(parseColor).filter(Boolean); return cols.length && cols.every(c => alphaOf(c) >= 0.9); });
      if (opaque) out.push(hit(el, `點陣圖被幾乎不透明的漸層蓋住：${clip(bg, 90)}`));
    }
    return out;
  }
  function organicClipPath() {
    const out = [];
    for (const el of elements()) {
      const cp = cs(el).clipPath || '';
      const m = /^(polygon|path)\((.*)\)$/i.exec(cp.trim());
      if (!m) continue;
      if (m[1].toLowerCase() === 'path') {
        const curves = (m[2].replace(/^\s*(?:evenodd|nonzero)\s*,/, '').match(/[CSQTAcsqta]/g) || []).length;
        if (curves >= 3) out.push(hit(el, `clip-path: path() 有 ${curves} 段曲線`));
        continue;
      }
      const pts = m[2].replace(/^\s*(?:evenodd|nonzero)\s*,/, '').split(',').map(p => p.trim()).filter(Boolean);
      if (pts.length < 10) continue;
      let off = 0;
      for (const p of pts) for (const n of (p.match(/-?[\d.]+/g) || [])) { const v = parseFloat(n); if (Math.abs(v - Math.round(v / 25) * 25) > 0.5) off++; }
      if (off >= pts.length) out.push(hit(el, `clip-path: polygon() 用 ${pts.length} 個頂點模擬有機輪廓`));
    }
    return out;
  }
  function pulseKf(name) {
    const kf = keyframes(name);
    if (kf == null) return /pulse|blink|ping/i.test(name);
    return kf.some(d => 'opacity' in d || 'box-shadow' in d || /scale/i.test(d.transform || '') || 'scale' in d);
  }
  function pulsingDot() {
    const out = [];
    for (const el of elements()) {
      if (!isInfinite(el)) continue;
      const name = animNames(el).find(pulseKf);
      if (!name) continue;
      const r = rectOf(el);
      if (r.width < 2 || r.height < 2 || r.width > 16 || r.height > 16) continue;
      const rad = cs(el).borderTopLeftRadius || cs(el).borderRadius || '';
      const rp = /%$/.test(rad.trim()) ? parseFloat(rad) >= 40 : num(rad) >= 999 || num(rad) >= 0.4 * Math.min(r.width, r.height);
      if (!rp) continue;
      const landmark = !!closest(el, 'header, nav, [role="banner"], [role="navigation"]');
      const top = r.top + (W.scrollY || 0);
      out.push(hit(el, `${classSel(el)} —— ${Math.round(r.width)}×${Math.round(r.height)}px 圓點掛著無限「${name}」動畫${landmark ? '（在 header／nav 裡）' : ''}`, landmark || top <= 900 ? 'error' : undefined));
    }
    for (const el of elements()) {
      const cls = classStr(el);
      const a = /\banimate-(ping|pulse)\b/.exec(cls);
      if (a && /\brounded-full\b/.test(cls) && /\b(?:w|h|size)-(?:1|1\.5|2|2\.5|3|3\.5|4)\b/.test(cls) && !out.some(h => h.el === el)) {
        out.push(hit(el, `極小的 rounded-full 元素掛 animate-${a[1]}（Tailwind）`, closest(el, 'header, nav') ? 'error' : undefined));
      }
    }
    return out;
  }
  function blinkingCursor() {
    const out = [];
    const togglesOut = name => {
      const kf = keyframes(name);
      if (!kf) return false;
      let t = false;
      for (const d of kf) for (const [p, v] of Object.entries(d)) {
        if (p === 'opacity') { if (num(v) <= 0.15) t = true; }
        else if (p === 'visibility') { if (/hidden/i.test(v)) t = true; }
        else if (p !== 'animation-timing-function') return false;
      }
      return t;
    };
    for (const el of elements()) {
      const t = tagOf(el);
      if (['input', 'textarea', 'select', 'img', 'svg', 'script', 'style'].includes(t) || !isInfinite(el)) continue;
      const names = animNames(el);
      if (!names.length) continue;
      const blink = names.find(n => /blink|caret|cursor/i.test(n)) || names.find(togglesOut);
      if (!blink || el.isContentEditable || closest(el, '[contenteditable=""], [contenteditable="true"], [role="textbox"]')) continue;
      const r = rectOf(el);
      if (r.width <= 0 || r.height <= 0) continue;
      const top = r.top + (W.scrollY || 0);
      if (top > 1200) continue;
      const text = el.textContent.trim();
      const glyph = Array.from(text).length === 1 && /^[_|▀-▟■▮❙❚｜]$/u.test(text);
      if (!glyph) {
        if (text || el.children.length) continue;
        const bg = parseColor(cs(el).backgroundColor);
        const filled = bg && alphaOf(bg) > 0.2;
        const bord = ['Left', 'Right', 'Bottom'].some(sd => num(cs(el)[`border${sd}Width`]) >= 1);
        if (!filled && !bord) continue;
        const vert = r.width >= 1 && r.width <= 24 && r.height >= 6 && r.height <= 48 && r.height >= r.width;
        const under = r.height >= 1 && r.height <= 6 && r.width >= 4 && r.width <= 24;
        if (!vert && !under) continue;
        if (num(cs(el).borderRadius) >= 0.4 * Math.min(r.width, r.height)) continue;
      }
      const hero = top <= 900 || !!closest(el, 'header, nav, [role="banner"], [role="navigation"]');
      out.push(hit(el, `${classSel(el)} —— ${Math.round(r.width)}×${Math.round(r.height)}px 閃爍游標（動畫「${blink}」）在首屏`, hero ? 'warn' : undefined));
    }
    return out;
  }
  function marquee() {
    const out = qsa(D, 'marquee').filter(isVisible).map(el => hit(el, '<marquee> 元素'));
    const marqueeKf = name => {
      const kf = keyframes(name);
      if (!kf) return false;
      const pct = [];
      let scaleOrOpacity = false;
      for (const d of kf) {
        const tr = d.transform || d.translate || '';
        for (const m of tr.matchAll(/translate(?:X|3d)?\(\s*(-?[\d.]+)%/gi)) pct.push(parseFloat(m[1]));
        if (d.translate) { const m = /^(-?[\d.]+)%/.exec(d.translate.trim()); if (m && !/translate/.test(tr)) pct.push(parseFloat(m[1])); }
        if ('opacity' in d || /scale/.test(tr)) scaleOrOpacity = true;
      }
      if (!pct.length || (pct.length === 1 && scaleOrOpacity)) return false;
      const travel = pct.length > 1 ? Math.max(...pct) - Math.min(...pct) : Math.abs(pct[0]);
      return travel >= 20;
    };
    for (const el of elements()) {
      if (!isInfinite(el)) continue;
      const name = animNames(el).find(marqueeKf);
      if (name) out.push(hit(el, `${classSel(el)} —— 無限水平循環動畫「${name}」`));
    }
    return out;
  }
  function shapeIllustration() {
    const out = [];
    for (const svg of qsa(D, 'svg')) {
      if (!isVisible(svg) || closest(svg.parentElement, 'svg')) continue;
      if (qsa(svg, 'text, tspan').length > 2 || qsa(svg, 'pattern').length) continue;
      const prims = qsa(svg, 'rect, circle, ellipse, polygon');
      if (prims.length < 8) continue;
      const r = rectOf(svg);
      if (r.width < 200 || r.height < 200) continue;
      const fills = new Set();
      for (const p of prims) {
        const f = (p.getAttribute('fill') || cs(p).fill || '').trim().toLowerCase();
        if (!f || ['none', 'transparent', 'currentcolor', 'inherit'].includes(f) || /^url\(/.test(f)) continue;
        const c = parseColor(f); fills.add(c ? hex(c) : f);
      }
      if (fills.size < 3) continue;
      out.push(hit(svg, `行內 <svg> 場景：${prims.length} 個基本圖形、約 ${Math.round(r.width)}×${Math.round(r.height)}px、${fills.size} 種填色`));
    }
    return out;
  }
  function iconTile() {
    const out = [];
    for (const h of qsa(D, 'h1, h2, h3, h4, h5, h6')) {
      if (!isVisible(h)) continue;
      const sib = h.previousElementSibling;
      if (!sib || !isVisible(sib) || HEADING_TAGS.has(tagOf(sib))) continue;
      const sr = rectOf(sib), hr = rectOf(h);
      const w = sr.width, hh = sr.height;
      if (!(w >= 32 && w <= 128 && hh >= 32 && hh <= 128)) continue;
      const ratio = w / hh; if (ratio < 0.7 || ratio > 1.4) continue;
      const ss = cs(sib);
      const bg = parseColor(ss.backgroundColor);
      const bgVis = (bg && alphaOf(bg) > 0.1) || (ss.backgroundImage && ss.backgroundImage !== 'none');
      if (!bgVis && !(num(ss.borderTopWidth) > 0)) continue;
      if (num(ss.borderRadius) >= w / 2) continue;
      const icon = sib.querySelector('svg, i[data-lucide], i[class*="fa-"], i[class*="icon"]');
      const emoji = !sib.children.length && isEmojiOnly(directText(sib));
      if (!icon && !emoji) continue;
      if (icon && rectOf(icon).width >= w * 0.95) continue;
      if (hr.top && sr.bottom && sr.bottom > hr.top + 4) continue;
      out.push(hit(sib, `${Math.round(w)}×${Math.round(hh)}px 圖示方塊疊在 ${tagOf(h)}「${clip(collapse(h.textContent), 60)}」上方`));
    }
    return out;
  }
  function italicSerif() {
    const out = [];
    for (const h of qsa(D, 'h1, h2')) {
      if (!isVisible(h)) continue;
      const stack = [h];
      while (stack.length) {
        const n = stack.pop();
        if (!isRenderedForRule(n)) continue;
        if (directText(n).trim()) {
          const s = cs(n); const fs = num(s.fontSize);
          if (s.fontStyle === 'italic' && fs >= 48 && (tagOf(h) === 'h1' || fs >= 48)) {
            const stackFonts = s.fontFamily.split(',').map(f => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
            const primary = stackFonts.find(f => f && !GENERIC_FONTS.has(f));
            if (primary && (KNOWN_SERIF_FONTS.has(primary) || stackFonts.includes('serif'))) {
              out.push(hit(h, `義大利斜體襯線 ${tagOf(h)}（${primary}）${Math.round(fs)}px「${clip(collapse(h.textContent), 60)}」`));
              break;
            }
          }
        }
        stack.push(...Array.from(n.children).reverse());
      }
    }
    return out;
  }
  function oversizedH1() {
    const out = [];
    for (const h of qsa(D, 'h1')) {
      if (!isVisible(h)) continue;
      const fs = num(cs(h).fontSize); const text = collapse(h.textContent);
      if (fs < 72 || text.length < 40) continue;
      const r = rectOf(h);
      const hr = r.height / vh(), ar = (r.width * r.height) / (vw() * vh());
      if (hr < 0.28 && ar < 0.25) continue;
      out.push(hit(h, `${Math.round(fs)}px 的 h1、${text.length} 字、佔 ${Math.round(hr * 100)}vh「${clip(text, 60)}」`));
    }
    return out;
  }
  function gptBorderShadow() {
    const out = [];
    for (const el of elements()) {
      const s = cs(el);
      if (!s.boxShadow || s.boxShadow === 'none') continue;
      const thin = SIDES.map(sd => [num(s[`border${sd}Width`]), s[`border${sd}Color`]])
        .filter(([w, c]) => w > 0 && w <= 1.5 && (isTransparentCss(c) ? 0 : alphaOf(parseColor(c) || { a: 1 })) >= 0.28).map(([w]) => w);
      let blur = 0;
      for (const L of shadowLayers(s.boxShadow)) { if (L.color && alphaOf(L.color) < 0.12) continue; if (L.nums.length >= 3) blur = Math.max(blur, L.nums[2]); }
      if (thin.length >= 2 && blur >= 16) out.push(hit(el, `${Math.max(...thin)}px 細框 ＋ ${Math.round(blur)}px 大範圍陰影`));
    }
    return out;
  }
  function imageHoverTransform() {
    const out = [];
    for (const r of allRules()) {
      if (r.type !== 1 || !r.selectorText) continue;
      if (!r.selectorText.split(',').some(sel => /\bimg\b[^,{}]*:hover\b/i.test(sel))) continue;
      if (/(scale|rotate|translate|matrix|skew)/i.test(r.style.transform || '') || /\S/.test(r.style.scale || '') || /\S/.test(r.style.rotate || '')) {
        out.push(hit(D.body, `${clip(r.selectorText, 80)} { transform } 規則`));
      }
    }
    for (const img of qsa(D, 'img[class]')) if (/\bhover:(?:scale|rotate|translate|skew)-/.test(classStr(img)) && isVisible(img)) out.push(hit(img, '<img> 上的 Tailwind hover 變形'));
    return out;
  }
  function brokenImage() {
    const out = [];
    for (const img of qsa(D, 'img')) {
      if (closest(img, 'template, noscript')) continue;
      const src = img.getAttribute('src'); const srcset = img.getAttribute('srcset');
      if (src == null && !srcset && !closest(img, 'picture')) out.push(hit(img, '<img> 沒有 src'));
      else if (src != null && /^\s*#?\s*$/.test(src) && !srcset) out.push(hit(img, `<img> 的 src 是空的或佔位值「${src}」`));
      else if (isVisible(img) && img.complete && img.naturalWidth === 0 && img.getAttribute('loading') !== 'lazy') out.push(hit(img, `圖片載入失敗：${clip(img.currentSrc || src || '', 80)}`)); // 加碼：DOM 才看得到的實際載入失敗
    }
    return out;
  }
  function textOverflow() {
    const out = [];
    const scrollRegion = el => /(auto|scroll)/.test(cs(el).overflowX) || /(auto|scroll)/.test(cs(el).overflow);
    for (const el of elements()) {
      const t = tagOf(el);
      if (TEXT_OVERFLOW_SKIP_TAGS.has(t) || el.namespaceURI === 'http://www.w3.org/2000/svg' || !isRenderedForRule(el) || !hasDirectTextLongerThan(el, 0)) continue;
      if (isScreenReaderOnly(el)) continue;
      let sc = false; for (let p = el; p; p = p.parentElement) if (scrollRegion(p)) { sc = true; break; }
      if (sc) continue;
      const cw = el.clientWidth, delta = el.scrollWidth - cw, r = rectOf(el);
      if (cw > 0 && delta >= 16) { out.push(hit(el, `${classSel(el)} 超出自己的框 ${Math.round(delta)}px`)); continue; }
      if (cw === 0 && r.width > 0) {
        let c = el.parentElement; while (c && c.clientWidth === 0) c = c.parentElement;
        if (!c) continue;
        let tf = false; for (let p = el; p && p !== c.parentElement; p = p.parentElement) { const v = cs(p).transform; if (v && v !== 'none') { tf = true; break; } }
        if (tf) continue;
        const spill = r.right - (rectOf(c).left + c.clientLeft + c.clientWidth);
        if (spill >= 16) out.push(hit(el, `${classSel(el)} 超出容器 ${Math.round(spill)}px`));
      }
    }
    return out;
  }
  function clippedOverflow() {
    const out = [];
    const DECOR = /\b(art|bg|background|badge|blob|crop|decor|dot|glow|grain|image|mask|ornament|overlay|photo|scrim|shadow|shine|texture)\b/i;
    for (const el of elements()) {
      const s = cs(el);
      const clips = v => v === 'hidden' || v === 'clip', scrolls = v => v === 'auto' || v === 'scroll';
      const cx = clips(s.overflowX) || clips(s.overflow), cy = clips(s.overflowY) || clips(s.overflow);
      if (!(cx || cy) || scrolls(s.overflowX) || scrolls(s.overflowY) || scrolls(s.overflow)) continue;
      if (/\b(carousel|slider)\b/.test((el.getAttribute('aria-roledescription') || '').toLowerCase())) continue;
      const ident = (classStr(el) + ' ' + (el.id || '')).toLowerCase();
      if (/\b(carousel|comparison|compare|fisheye|marquee|preview|scroller|slider|slideshow|split|viewport)\b/.test(ident) || /\b(demo-area|demo-stage|demo-viewport)\b/.test(ident)) continue;
      const pr = rectOf(el);
      for (const ch of qsa(el, '*')) {
        const pos = cs(ch).position;
        if (pos !== 'absolute' && pos !== 'fixed') continue;
        if (!isVisible(ch)) continue; // 加碼：沒畫出來的定位子元素不算
        if (closest(ch, '[aria-hidden="true"]') || ['none', 'presentation'].includes((ch.getAttribute('role') || '').toLowerCase()) || ['img', 'svg', 'canvas', 'video'].includes(tagOf(ch))) continue;
        const subst = !!collapse(ch.textContent) || matches(ch, POSITIONED_CHILD_INTERACTIVE_SELECTOR) || !!ch.querySelector(POSITIONED_CHILD_INTERACTIVE_SELECTOR);
        if (DECOR.test(classStr(ch) + ' ' + (ch.id || '')) && !subst) continue;
        const cr = rectOf(ch);
        let esc;
        if ((pr.width <= 0 && pr.height <= 0) || (cr.width <= 0 && cr.height <= 0)) {
          const cs2 = cs(ch);
          esc = ['top', 'right', 'bottom', 'left', 'inset'].some(p => /(?:^|[\s(])-+(?:\d|\.)|(?:^|[\s(])100(?:\.0+)?%/.test((cs2[p] || '').toLowerCase()));
        } else {
          esc = (cx && (cr.left < pr.left - 2 || cr.right > pr.right + 2)) || (cy && (cr.top < pr.top - 2 || cr.bottom > pr.bottom + 2));
        }
        if (!esc) continue;
        out.push(hit(el, `${classSel(el)} 把定位子元素 ${classSel(ch)} 裁掉了`));
        break;
      }
    }
    return out;
  }
  function scriptErrors() {
    const key = 選項.錯誤收集器 || '__designScanErrors';
    const list = W[key];
    if (!Array.isArray(list)) return null; // 沒裝收集器 → 這條沒跑
    return list.slice(0, 3).map(e => hit(D.body, clip(typeof e === 'string' ? e : (e && (e.message || e.toString())) || String(e), 200)));
  }

  // ───────────────────────── DESIGN.md 設計系統（需要選項） ─────────────────────────

  function designSystem() {
    const ds = 選項.設計系統;
    if (!ds) return null;
    const norm = f => String(f || '').trim().replace(/^["']|["']$/g, '').replace(/\+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    const fonts = (ds.字型 || []).map(norm).filter(Boolean);
    const colors = (ds.顏色 || []).map(parseColor).filter(Boolean);
    const radii = (ds.圓角 || []).map(Number).filter(Number.isFinite);
    const sizes = (ds.字級 || []).map(Number).filter(Number.isFinite);
    const seen = new Set(); const out = [];
    const sample = el => { const t = collapse(el.textContent); return t ? `「${clip(t, 30)}」` : ''; };
    for (const el of elements()) {
      const s = cs(el); const t = tagOf(el); const txt = hasDirectTextLongerThan(el, 0);
      if (fonts.length && txt && !/var\(/i.test(s.fontFamily)) {
        const f = fontPrimary(s.fontFamily, GENERIC_FONTS);
        if (f && !fonts.includes(f) && !seen.has('f:' + f)) { seen.add('f:' + f); out.push({ el, id: 'design-system-font', 細節: `${t}${sample(el)} 用了 ${f}，DESIGN.md 字型沒有宣告` }); }
      }
      if (colors.length) {
        const checks = [];
        if (txt) checks.push(['文字色', s.color]);
        if (!isTransparentCss(s.backgroundColor)) checks.push(['背景', s.backgroundColor]);
        SIDES.forEach(sd => { if (num(s[`border${sd}Width`]) > 0) checks.push([`border-${sd.toLowerCase()}`, s[`border${sd}Color`]]); });
        for (const [kind, raw] of checks) {
          const c = parseColor(raw);
          if (!c || alphaOf(c) <= 0.05) continue;
          if (colors.some(a => Math.max(Math.abs(a.r - c.r), Math.abs(a.g - c.g), Math.abs(a.b - c.b)) <= 6)) continue;
          const key = `c:${kind}:${hex(c)}`; if (seen.has(key)) continue; seen.add(key);
          out.push({ el, id: 'design-system-color', 細節: `${kind} ${hex(c)}（${t}${sample(el)}）不在 DESIGN.md 色盤裡` });
        }
      }
      if (radii.length) {
        for (const tok of (s.borderRadius || '').replace(/\s*\/\s*/g, ' ').split(/\s+/).filter(Boolean)) {
          if (tok === '0px' || /%/.test(tok)) continue;
          const v = num(tok);
          if (v <= 0.5 || (ds.允許膠囊圓角 && v >= 99) || radii.some(a => Math.abs(a - v) <= 0.5)) continue;
          if (seen.has('r:' + tok)) continue; seen.add('r:' + tok);
          out.push({ el, id: 'design-system-radius', 細節: `border-radius ${tok}（${t}${sample(el)}）不在 DESIGN.md 圓角級距裡` });
        }
      }
      if (sizes.length && txt) {
        const v = Math.round(num(s.fontSize) * 100) / 100;
        if (v && !sizes.some(a => Math.abs(a - v) <= 0.5) && !seen.has('s:' + v)) { seen.add('s:' + v); out.push({ el, id: 'design-system-font-size', 細節: `font-size ${v}px（${t}${sample(el)}）不在 DESIGN.md 字級表裡` }); }
      }
    }
    if (fonts.length) {
      for (const link of qsa(D, 'link[href*="fonts.googleapis.com/css"]')) {
        for (const m of (link.getAttribute('href') || '').matchAll(/[?&]family=([^&]+)/g)) {
          let fam = m[1].split(':')[0].replace(/\+/g, ' '); try { fam = decodeURIComponent(fam); } catch { /* 保留原字串 */ }
          const f = norm(fam);
          if (f && !fonts.includes(f) && !seen.has('f:' + f)) { seen.add('f:' + f); out.push({ el: D.body, id: 'design-system-font', 細節: `Google Fonts 載入了 ${fam}，DESIGN.md 字型沒有宣告` }); }
        }
      }
    }
    return out;
  }
  const dsRule = id => () => { const r = once('designSystem', designSystem); return r == null ? null : r.filter(h => h.id === id).map(h => hit(h.el, h.細節)); };

  // ───────────────────────── 61 條規則 ─────────────────────────
  // 類別：原作 category 是 slop → 「品味類」；quality → 「可讀性／破版類」
  // 嚴重度：原作 error → error；預設 warning → warn；advisory → info

  const 品味 = '品味類', 可讀 = '可讀性／破版類';
  const 規則 = [
    { id: 'side-tab', 類別: 品味, 嚴重度: 'warn', 說明: '卡片單邊的粗彩色邊框（含偽元素、條紋子元素、inset 陰影畫的），最典型的 AI 生成介面特徵', 檢查函式: () => byId('borders', borderPass, 'side-tab') },
    { id: 'border-accent-on-rounded', 類別: 品味, 嚴重度: 'warn', 說明: '圓角卡片的上／下緣加粗強調邊框，和圓角互相打架', 檢查函式: () => byId('borders', borderPass, 'border-accent-on-rounded') },
    { id: 'overused-font', 類別: 品味, 嚴重度: 'warn', 說明: '主要字型是 Inter、Roboto、Geist、Space Grotesk 這類被用爛的字', 檢查函式: typography },
    { id: 'flat-type-hierarchy', 類別: 品味, 嚴重度: 'warn', 說明: '標題與內文字級每一級都差不到 1.25 倍，層級是平的', 檢查函式: flatHierarchy },
    { id: 'gradient-text', 類別: 品味, 嚴重度: 'warn', 說明: '漸層文字（background-clip: text），裝飾大於意義', 檢查函式: gradientText },
    { id: 'ai-color-palette', 類別: 品味, 嚴重度: 'warn', 說明: '紫／藍紫漸層、紫色標題；青色＋紫色霓虹字壓深底（兩種招牌色同時出現才算）', 檢查函式: () => paletteReadings().concat(byId('colors', colorPass, 'ai-color-palette'), purpleAccentRules()) },
    { id: 'cream-palette', 類別: 品味, 嚴重度: 'warn', 說明: '頁面底色是反射性選的奶油／米色', 檢查函式: creamPalette },
    { id: 'nested-cards', 類別: 品味, 嚴重度: 'warn', 說明: '卡片裡又套卡片，層次過深', 檢查函式: nestedCards },
    { id: 'monotonous-spacing', 類別: 品味, 嚴重度: 'warn', 說明: '整頁幾乎只用同一個間距值，沒有節奏', 檢查函式: monotonousSpacing },
    { id: 'bounce-easing', 類別: 品味, 嚴重度: 'warn', 說明: '彈跳／彈性緩動（bounce、elastic、超出範圍的 cubic-bezier）', 檢查函式: () => byId('motion', motion, 'bounce-easing') },
    { id: 'pulsing-dot', 類別: 品味, 嚴重度: 'warn', 說明: '裝飾性的脈動小圓點假裝「即時」；在首屏或 header／nav 升為 error', 檢查函式: pulsingDot },
    { id: 'blinking-cursor', 類別: 品味, 嚴重度: 'info', 說明: '首屏裝飾用的閃爍游標，假裝在打字；在 hero 區升為 warn', 檢查函式: blinkingCursor },
    { id: 'shape-assembled-illustration', 類別: 品味, 嚴重度: 'info', 說明: '大型行內 SVG 用一堆基本圖形拼成的插圖，讀起來像佔位圖', 檢查函式: shapeIllustration },
    { id: 'organic-clip-path', 類別: 可讀, 嚴重度: 'warn', 說明: '用多頂點 polygon 或曲線 path() 的 clip-path 模擬撕邊／有機輪廓', 檢查函式: organicClipPath },
    { id: 'buried-raster', 類別: 可讀, 嚴重度: 'warn', 說明: '點陣圖被幾乎不透明的漸層蓋住，或 opacity 低到看不見', 檢查函式: buriedRaster },
    { id: 'dark-glow', 類別: 品味, 嚴重度: 'warn', 說明: '彩色光暈陰影：零位移的彩色 box／text-shadow，或深色底上的彩色模糊陰影', 檢查函式: glow },
    { id: 'radial-halo', 類別: 品味, 嚴重度: 'warn', 說明: '深色頁面上飽和的 radial-gradient 光暈背景', 檢查函式: radialHalo },
    { id: 'radial-spotlight-glow', 類別: 品味, 嚴重度: 'warn', 說明: '區塊後面低透明度的強調色 radial-gradient「聚光燈」', 檢查函式: radialSpotlight },
    { id: 'marquee', 類別: 品味, 嚴重度: 'warn', 說明: '持續自動水平捲動的跑馬燈', 檢查函式: marquee },
    { id: 'icon-tile-stack', 類別: 品味, 嚴重度: 'warn', 說明: '標題上方疊一個圓角方塊圖示，萬用 AI 功能卡模板', 檢查函式: iconTile },
    { id: 'italic-serif-display', 類別: 品味, 嚴重度: 'warn', 說明: '超大義大利斜體襯線字當主視覺標題', 檢查函式: italicSerif },
    { id: 'hero-eyebrow-chip', 類別: 品味, 嚴重度: 'warn', 說明: '超大 h1 上方的小號大寫加寬眉標／膠囊標籤', 檢查函式: heroEyebrow },
    { id: 'kicker-above-heading', 類別: 品味, 嚴重度: 'warn', 說明: '標題正上方獨立一行的小號大寫加寬標籤', 檢查函式: kickers },
    { id: 'numbered-section-labels', 類別: 品味, 嚴重度: 'info', 說明: '每節標題旁反覆出現的小號編號（01、02…）', 檢查函式: numberedLabels },
    { id: 'em-dash-overuse', 類別: 品味, 嚴重度: 'info', 說明: '內文破折號過密（≥8 個且約每 500 字一個）', 檢查函式: emDash },
    { id: 'marketing-buzzword', 類別: 品味, 嚴重度: 'warn', 說明: 'streamline／empower／world-class／cutting-edge 這類 SaaS 套話', 檢查函式: buzzwords },
    { id: 'aphoristic-cadence', 類別: 品味, 嚴重度: 'warn', 說明: '「X. No Y.」「Not a feature. A platform.」這類格言句型出現三次以上', 檢查函式: cadence },
    { id: 'oversized-h1', 類別: 品味, 嚴重度: 'warn', 說明: '整句長的 h1 用展示級字級，霸佔首屏', 檢查函式: oversizedH1 },
    { id: 'extreme-negative-tracking', 類別: 品味, 嚴重度: 'warn', 說明: '字距收到 ≤ -0.05em，字形擠壞', 檢查函式: () => byId('quality', qualityPass, 'extreme-negative-tracking') },
    { id: 'broken-image', 類別: 可讀, 嚴重度: 'warn', 說明: '<img> 沒有 src、src 是空的或佔位值，或實際載入失敗', 檢查函式: brokenImage },
    { id: 'script-error', 類別: 可讀, 嚴重度: 'error', 說明: '頁面載入時有未攔截的腳本錯誤（需事先安裝錯誤收集器）', 檢查函式: scriptErrors },
    { id: 'content-hidden-at-rest', 類別: 可讀, 嚴重度: 'error', 說明: '大量文字停在 opacity 0／visibility hidden，進場動畫失敗的特徵', 檢查函式: contentHiddenAtRest },
    { id: 'edge-flush-cards', 類別: 可讀, 嚴重度: 'warn', 說明: '水平捲動容器裡的卡片在靜止時貼著一側邊緣，圓角被切掉', 檢查函式: edgeFlushCards },
    { id: 'text-occlusion', 類別: 可讀, 嚴重度: 'warn', 說明: '文字被不透明元素或另一段文字蓋住（固定／黏性層不算）', 檢查函式: textOcclusion },
    { id: 'first-viewport-column-overflow', 類別: 可讀, 嚴重度: 'warn', 說明: '首屏多欄區塊有一欄遠超過摺線、另一欄很短', 檢查函式: firstViewportColumnOverflow },
    { id: 'gray-on-color', 類別: 可讀, 嚴重度: 'warn', 說明: '灰字壓在彩色底上，看起來髒', 檢查函式: () => byId('colors', colorPass, 'gray-on-color') },
    { id: 'low-contrast', 類別: 可讀, 嚴重度: 'warn', 說明: '文字對比不到 WCAG AA（內文 4.5:1、大字 3:1）', 檢查函式: () => byId('colors', colorPass, 'low-contrast') },
    { id: 'layout-transition', 類別: 可讀, 嚴重度: 'warn', 說明: '轉場動到 width／height／padding／margin，會造成版面抖動', 檢查函式: () => byId('motion', motion, 'layout-transition') },
    { id: 'line-length', 類別: 可讀, 嚴重度: 'warn', 說明: '實際渲染出來有兩行以上超過約 80 字', 檢查函式: () => byId('quality', qualityPass, 'line-length') },
    { id: 'cramped-padding', 類別: 可讀, 嚴重度: 'warn', 說明: '有邊框／底色的容器裡，文字離邊太近', 檢查函式: () => byId('quality', qualityPass, 'cramped-padding') },
    { id: 'body-text-viewport-edge', 類別: 可讀, 嚴重度: 'warn', 說明: '內文段落直接貼到視窗左右邊緣', 檢查函式: () => byId('quality', qualityPass, 'body-text-viewport-edge') },
    { id: 'tight-leading', 類別: 可讀, 嚴重度: 'warn', 說明: '多行內文行高低於 1.3 倍字級', 檢查函式: () => byId('quality', qualityPass, 'tight-leading') },
    { id: 'skipped-heading', 類別: 可讀, 嚴重度: 'warn', 說明: '標題層級跳級（h1 之後直接 h3）', 檢查函式: skippedHeading },
    { id: 'heading-rhythm', 類別: 可讀, 嚴重度: 'warn', 說明: '標題離上一段比離自己的內容還近（全頁至少兩處）', 檢查函式: headingRhythm },
    { id: 'justified-text', 類別: 可讀, 嚴重度: 'warn', 說明: '左右對齊卻沒開斷字，字距忽大忽小', 檢查函式: () => byId('quality', qualityPass, 'justified-text') },
    { id: 'tiny-text', 類別: 可讀, 嚴重度: 'warn', 說明: '內文字級小於 12px', 檢查函式: () => byId('quality', qualityPass, 'tiny-text') },
    { id: 'undersized-ui-text', 類別: 可讀, 嚴重度: 'warn', 說明: '連結、按鈕、標籤等功能性文字小於 11px（法律小字 10px）', 檢查函式: () => byId('quality', qualityPass, 'undersized-ui-text') },
    { id: 'all-caps-body', 類別: 可讀, 嚴重度: 'warn', 說明: '長段內文全大寫', 檢查函式: () => byId('quality', qualityPass, 'all-caps-body') },
    { id: 'wide-tracking', 類別: 可讀, 嚴重度: 'warn', 說明: '內文字距大於 0.05em', 檢查函式: () => byId('quality', qualityPass, 'wide-tracking') },
    { id: 'text-overflow', 類別: 可讀, 嚴重度: 'warn', 說明: '內容比容器寬、溢出去或撐出橫向捲軸', 檢查函式: textOverflow },
    { id: 'repeated-container-text', 類別: 可讀, 嚴重度: 'warn', 說明: '同一張卡片裡同一段字在三個不同位置重複出現', 檢查函式: repeatedContainerText },
    { id: 'clipped-overflow-container', 類別: 可讀, 嚴重度: 'warn', 說明: 'overflow:hidden 容器把需要溢出的定位子元素（選單、提示）裁掉', 檢查函式: clippedOverflow },
    { id: 'design-system-font', 類別: 可讀, 嚴重度: 'warn', 說明: '用了 DESIGN.md 沒宣告的字型（需提供設計系統選項）', 檢查函式: dsRule('design-system-font') },
    { id: 'design-system-color', 類別: 可讀, 嚴重度: 'info', 說明: '用了 DESIGN.md 色盤以外的顏色（需提供設計系統選項）', 檢查函式: dsRule('design-system-color') },
    { id: 'design-system-radius', 類別: 可讀, 嚴重度: 'info', 說明: '圓角不在 DESIGN.md 級距裡（需提供設計系統選項）', 檢查函式: dsRule('design-system-radius') },
    { id: 'design-system-font-size', 類別: 可讀, 嚴重度: 'info', 說明: '字級不在 DESIGN.md 字級表裡（需提供設計系統選項）', 檢查函式: dsRule('design-system-font-size') },
    { id: 'gpt-thin-border-wide-shadow', 類別: 品味, 嚴重度: 'info', 說明: '髮絲細框同時配大範圍柔和陰影', 檢查函式: gptBorderShadow },
    { id: 'repeating-stripes-gradient', 類別: 品味, 嚴重度: 'info', 說明: '用 repeating-gradient 畫裝飾條紋', 檢查函式: repeatingStripes },
    { id: 'codex-grid-background', 類別: 品味, 嚴重度: 'info', 說明: '用細線漸層鋪成的裝飾格線背景', 檢查函式: gridBackground },
    { id: 'theater-slop-phrase', 類別: 品味, 嚴重度: 'info', 說明: '把東西貶成「X theater」的生成文案口頭禪', 檢查函式: theater },
    { id: 'image-hover-transform', 類別: 品味, 嚴重度: 'info', 說明: '滑過圖片就放大或旋轉', 檢查函式: imageHoverTransform },
  ];

  if (選項.只列規則) {
    return { 規則數: 規則.length, 規則: 規則.map(({ id, 類別, 嚴重度, 說明 }) => ({ id, 類別, 嚴重度, 說明 })) };
  }

  // ───────────────────────── 執行 ─────────────────────────

  const 命中 = [], 略過 = [], 錯誤 = [];
  const seenKey = new Set();
  const t0 = (W.performance && performance.now()) || 0;
  for (const r of 規則) {
    let res;
    try { res = r.檢查函式(); } catch (e) { 錯誤.push({ id: r.id, 訊息: String(e && e.stack || e).slice(0, 300) }); continue; }
    if (res == null) { 略過.push({ id: r.id, 原因: r.id === 'script-error' ? '頁面上沒有錯誤收集器（見 design-rules.md）' : '沒有提供 設計系統 選項' }); continue; }
    for (const h of res) {
      const el = h.el || D.body;
      if (el !== D.body && ignored(el, r.id)) continue;
      const 描述 = describe(el);
      const key = r.id + '|' + 描述 + '|' + h.細節;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      命中.push({ id: r.id, 嚴重度: h.嚴重度 || r.嚴重度, 說明: r.說明, 選擇器或節點描述: 描述, 細節: h.細節 });
    }
  }
  const 秩 = { error: 0, warn: 1, info: 2 };
  命中.sort((a, b) => 秩[a.嚴重度] - 秩[b.嚴重度]);
  return { 規則數: 規則.length, 命中, 略過, 錯誤, 耗時毫秒: Math.round(((W.performance && performance.now()) || 0) - t0) };
})()
