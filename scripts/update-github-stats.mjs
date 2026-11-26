#!/usr/bin/env node
// Redraws the live cards of the profile README from real GitHub API data.
//
//   GH_TOKEN=... node scripts/update-github-stats.mjs            live cards + README numbers
//   node scripts/update-github-stats.mjs --static                 static cards only (no API call)
//
// Node 20+, no dependencies. Any API failure exits non-zero before a single file is written.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USER = 'kdjadeja21';
const SITE = 'https://kdjadeja.vercel.app';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const README = path.join(ROOT, 'README.md');

// ---------------------------------------------------------------------------
// Design system (tokens taken from kdjadeja.vercel.app)
// ---------------------------------------------------------------------------

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const THEMES = {
  light: {
    card: '#fbfaf6',
    panel: '#f0efe9',
    panelLine: '#14120b',
    dot: '#66615a',
    border: '#14120b',
    shadow: '#14120b',
    ink: '#0a0a0c',
    muted: '#5f5f68',
    line: '#cfcec6',
    accent: '#cdf138',
    accentInk: '#0a0a0c',
    star: '#5d7300',
    tiles: ['#cfe1f5', '#d3ecd6', '#ead8c3', '#ddd5f2', '#cdebe8'],
    heat: ['#e2e1da', '#dcee8f', '#bfe03a', '#8aab0c', '#4c6300'],
    lineStroke: '#0a0a0c',
  },
  dark: {
    card: '#121216',
    panel: '#1c1c23',
    panelLine: '#2f2f38',
    dot: '#8f8f98',
    border: '#000000',
    shadow: '#000000',
    ink: '#f0efe9',
    muted: '#9a9aa4',
    line: '#2f2f38',
    accent: '#cdf138',
    accentInk: '#0a0a0c',
    star: '#cdf138',
    tiles: ['#243650', '#233d2e', '#40322a', '#352b52', '#1f3d3d'],
    heat: ['#1f1f26', '#3a4a12', '#6b8a14', '#a3c42a', '#cdf138'],
    lineStroke: '#cdf138',
  },
};

const VARIANTS = [
  { suffix: 'light', phone: false, theme: 'light' },
  { suffix: 'dark', phone: false, theme: 'dark' },
  { suffix: 'phone-light', phone: true, theme: 'light' },
  { suffix: 'phone-dark', phone: true, theme: 'dark' },
];

// Cards are drawn inside a dotted outer panel (14px inset + 4px hard shadow), so the
// generators work with the inner width.
const TOTAL_DESKTOP_W = 880;
const TOTAL_PHONE_W = 440;
const FRAME = 32;
const DESKTOP_W = TOTAL_DESKTOP_W - FRAME;
const PHONE_W = TOTAL_PHONE_W - FRAME;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
const num = (n) => n.toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

const NARROW = new Set("iljtfI.,:;'|!()[]/ -");
function textWidth(s, size, { mono = false, weight = 400 } = {}) {
  if (mono) return s.length * size * 0.6;
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w += 0.28;
    else if (NARROW.has(ch)) w += 0.32;
    else if (/[mMwW@]/.test(ch)) w += 0.9;
    else if (/[A-Z]/.test(ch)) w += 0.68;
    else if (/[0-9]/.test(ch)) w += 0.58;
    else w += 0.56;
  }
  return w * size * (weight >= 700 ? 1.06 : 1);
}

function wrap(s, maxWidth, size, opts) {
  const lines = [];
  let cur = '';
  for (const word of s.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && textWidth(next, size, opts) > maxWidth) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

function text(x, y, s, { size = 16, weight = 400, fill, mono = false, anchor = 'start', ls, op, extra = '' } = {}) {
  return (
    `<text x="${r1(x)}" y="${r1(y)}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}"` +
    (op != null ? ` fill-opacity="${op}"` : '') +
    (anchor !== 'start' ? ` text-anchor="${anchor}"` : '') +
    (ls ? ` letter-spacing="${ls}"` : '') +
    `${extra}>${esc(s)}</text>`
  );
}

// four-point sparkle, the portfolio's ✦ accent, drawn as a path so no font is needed
function star(cx, cy, rad, fill) {
  const p = (x, y) => `${r1(cx + x)} ${r1(cy + y)}`;
  return (
    `<path d="M${p(0, -rad)}Q${p(0, 0)} ${p(rad, 0)}Q${p(0, 0)} ${p(0, rad)}Q${p(0, 0)} ${p(-rad, 0)}Q${p(0, 0)} ${p(0, -rad)}Z" fill="${fill}"/>`
  );
}

function svgDoc(w, h, label, body, th, defs = '') {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">` +
    `<title>${esc(label)}</title><defs>${defs}</defs>${body}</svg>\n`
  );
}

// Inner card: 2px near-black border, hard offset shadow, no blur.
function card(w, h, th, { fill = th.card, shadow = 4, rx = 14 } = {}) {
  return (
    `<rect x="${shadow}" y="${shadow}" width="${w}" height="${h}" rx="${rx}" fill="${th.shadow}"/>` +
    `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${rx - 1}" fill="${fill}" stroke="${th.border}" stroke-width="2"/>`
  );
}

function cardAt(x, y, w, h, th, opts) {
  return `<g transform="translate(${r1(x)} ${r1(y)})">${card(w, h, th, opts)}</g>`;
}

function pill(x, y, w, h, fill, stroke) {
  return `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${h}" rx="${h / 2}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.5"` : ''}/>`;
}

const ICONS = {
  calendar:
    '<path d="M5 5H19A2 2 0 0 1 21 7V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V7A2 2 0 0 1 5 5Z"/><path d="M3 10H21"/><path d="M8 3V7"/><path d="M16 3V7"/>',
  flame: '<path d="M12 2.5C12.5 7 18 9 18 14.5A6 6 0 0 1 6 14.5C6 11.5 8 10 9 8C10 10 11 10.5 12 9.5C12.5 7 12 4.5 12 2.5Z"/>',
  trophy:
    '<path d="M7 4H17V10A5 5 0 0 1 7 10Z"/><path d="M7 6H4V8A3 3 0 0 0 7 11"/><path d="M17 6H20V8A3 3 0 0 1 17 11"/><path d="M12 15V19"/><path d="M8 20.5H16"/>',
  bars: '<path d="M4 20V12H8V20Z"/><path d="M10 20V5H14V20Z"/><path d="M16 20V9H20V20Z"/>',
  repo: '<path d="M5 4H16A3 3 0 0 1 19 7V20H8A3 3 0 0 1 5 17Z"/><path d="M5 17A3 3 0 0 1 8 14H19"/>',
  star: '<path d="M12 3L14.7 8.6L20.8 9.5L16.4 13.8L17.4 19.9L12 17L6.6 19.9L7.6 13.8L3.2 9.5L9.3 8.6Z"/>',
  arrow: '<path d="M7 17L17 7"/><path d="M8 7H17V16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12H21"/><path d="M12 3C15 6 15 18 12 21C9 18 9 6 12 3Z"/>',
  cursor: '<path d="M6 3L6 18.5L10 15L12.6 21L15.2 19.9L12.6 14H18Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 7.5L12 13L20 7.5"/>',
  cards:
    '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="2" fill="none"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="2" fill="none"/><rect x="13" y="13" width="7.5" height="7.5" rx="2"/>',
  ticket:
    '<path d="M3 8A2 2 0 0 1 5 6H19A2 2 0 0 1 21 8V10A2 2 0 0 0 21 14V16A2 2 0 0 1 19 18H5A2 2 0 0 1 3 16V14A2 2 0 0 0 3 10Z"/><path d="M14.5 7V17" fill="none" stroke-dasharray="2 2.5"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3.5"/><path d="M10 9.2L15 12L10 14.8Z" fill="#14120b"/>',
  trend: '<path d="M4 18L9.5 12.5L13 15.5L20 7.5" fill="none"/><path d="M15 7.5H20V12.5" fill="none"/>',
};

function icon(name, x, y, size, stroke, fill = 'none') {
  const s = size / 24;
  return `<g transform="translate(${r1(x)} ${r1(y)}) scale(${r1(s * 100) / 100})" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}

// ---------------------------------------------------------------------------
// Date helpers (all dates are YYYY-MM-DD strings, arithmetic in UTC)
// ---------------------------------------------------------------------------

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const toStr = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => toStr(new Date(toDate(s).getTime() + n * 86400000));
const dayOfWeek = (s) => toDate(s).getUTCDay();
function addMonths(s, n) {
  const d = toDate(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toStr(d);
}
const fmtDay = (s) => `${Number(s.slice(8))} ${MONTHS[Number(s.slice(5, 7)) - 1]}`;
const fmtFull = (s) => `${fmtDay(s)} ${s.slice(0, 4)}`;

// ---------------------------------------------------------------------------
// Shared card parts
// ---------------------------------------------------------------------------

function header(W, pad, phone, th, numberText, caption) {
  let body = star(pad + 9, pad + 21, 9, th.star);
  const nx = pad + 26;
  if (phone) {
    body += text(nx, pad + 32, numberText, { size: 34, weight: 800, fill: th.ink, ls: -0.8 });
    const lines = wrap(caption, W - pad * 2, 14.5, { mono: true });
    lines.forEach((l, i) => {
      body += text(pad, pad + 62 + i * 20, l, { size: 14.5, mono: true, fill: th.muted });
    });
    return { body, bottom: pad + 62 + (lines.length - 1) * 20 };
  }
  body += text(nx, pad + 32, numberText, { size: 32, weight: 800, fill: th.ink, ls: -0.8 });
  const cx = nx + textWidth(numberText, 32, { weight: 800 }) + 14;
  body += text(cx, pad + 31, caption, { size: 17, mono: true, fill: th.muted });
  return { body, bottom: pad + 32 };
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

const TITLE = "Hi, I'm Krushnasinh";
const ROLE_LINE = 'Senior Software Engineer · AI Consultant';
const ROLES = ['Senior Software Engineer', 'AI Consultant'];
const SKILLS = ['TypeScript', 'React', 'Next.js', 'Node.js', 'GraphQL', 'AI-assisted engineering'];

function flowChips(items, x0, y, maxX, th, { size = 14, h = 30, gap = 8, rowGap = 10 } = {}) {
  let x = x0;
  let row = 0;
  let body = '';
  for (const label of items) {
    const w = textWidth(label, size, { mono: true }) + 26;
    if (x + w > maxX && x > x0) {
      x = x0;
      row += 1;
    }
    const top = y + row * (h + rowGap);
    body += pill(x, top, w, h, 'none', th.line);
    body += text(x + w / 2, top + h / 2 + size * 0.35, label, { size, mono: true, fill: th.ink, anchor: 'middle' });
    x += w + gap;
  }
  return { body, bottom: y + row * (h + rowGap) + h };
}

function dotted(x, y, s, size, th, ls) {
  return `<text x="${x}" y="${y}" font-family="${SANS}" font-size="${size}" font-weight="800" fill="${th.ink}" letter-spacing="${ls}">${esc(s)}<tspan fill="${th.star}">.</tspan></text>`;
}

function heroCard({ phone, theme }) {
  const th = THEMES[theme];
  const W = phone ? PHONE_W : DESKTOP_W;
  const pad = phone ? 24 : 40;
  const label = `${TITLE}. ${ROLE_LINE}`;
  let body = '';
  let h;

  if (phone) {
    body += star(W - 42, 46, 24, th.star) + star(W - 78, 88, 9, th.star);
    body += text(pad, 88, "Hi, I'm", { size: 50, weight: 800, fill: th.ink, ls: -1.5 });
    body += dotted(pad, 144, 'Krushnasinh', 50, th, -1.5);
    ROLES.forEach((role, i) => {
      body += star(pad + 7, 181 + i * 30, 6, th.star);
      body += text(pad + 24, 187 + i * 30, role, { size: 19, weight: 500, fill: th.ink });
    });
    const chips = flowChips(SKILLS, pad, 248, W - pad, th, { size: 13, h: 28, gap: 7, rowGap: 9 });
    body += chips.body;
    h = chips.bottom + 28;
  } else {
    body += star(W - 78, 66, 38, th.star) + star(W - 142, 112, 13, th.star) + star(W - 46, 126, 9, th.star);
    body += dotted(pad, 100, TITLE, 64, th, -2);
    body += text(pad, 148, ROLE_LINE, { size: 23, weight: 500, fill: th.ink, op: 0.82 });
    const chips = flowChips(SKILLS, pad, 180, W - pad, th);
    body += chips.body;
    h = chips.bottom + 36;
  }
  return { w: W, h, label, body: card(W, h, th) + body, th };
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function badgeCard({ theme, phone, label, value, icon: ic, color }) {
  const th = THEMES[theme];
  const ls = phone ? 12.5 : 14;
  const vs = phone ? 11.5 : 13;
  const d = phone ? 20 : 24;
  const pad = phone ? 8 : 10;
  const labelW = textWidth(label, ls, { weight: 700 });
  const valueW = value.length * vs * 0.6;
  const bw = Math.ceil(pad + d + 7 + labelW + 7 + valueW + pad + 2);
  const H = 36;
  const bh = 32;
  const cy = bh / 2 + 1;
  const body =
    `<rect x="3" y="3" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${th.shadow}"/>` +
    `<rect x="1" y="1" width="${bw - 2}" height="${bh - 2}" rx="${bh / 2 - 1}" fill="${th.tiles[color]}" stroke="${th.border}" stroke-width="2"/>` +
    `<circle cx="${pad + d / 2 + 1}" cy="${cy}" r="${d / 2}" fill="${th.accent}" stroke="${th.border}" stroke-width="1.5"/>` +
    icon(ic, pad + 1 + d * 0.2, cy - d * 0.3, d * 0.6, th.accentInk) +
    text(pad + d + 8, cy + ls * 0.35, label, { size: ls, weight: 700, fill: th.ink }) +
    text(pad + d + 8 + labelW + 7, cy + vs * 0.35, value, { size: vs, mono: true, fill: th.ink, op: 0.75 });
  return { w: bw + 3, h: H, label: `${label} ${value}`, body, th, bare: true };
}

const BADGES = [
  { name: 'badge-site', label: 'Portfolio', value: 'kdjadeja.vercel.app', icon: 'globe', color: 0 },
  { name: 'badge-cursor', label: 'Cursor', value: '@kdjadeja', icon: 'cursor', color: 3 },
  { name: 'badge-email', label: 'Email', value: 'kdjadeja209@gmail.com', icon: 'mail', color: 1 },
];

// ---------------------------------------------------------------------------
// whoami (terminal card)
// ---------------------------------------------------------------------------

const WHOAMI_CMD1 = 'whoami';
const WHOAMI_CMD2 = 'cat about.txt';
const WHOAMI_LINE = ['krushnasinh, senior software engineer, Gujarat, India.'];
const WHOAMI_LINE_PHONE = ['krushnasinh, senior software engineer,', 'Gujarat, India.'];
const WHOAMI_FACTS = [
  { desktop: ['7+ years shipping production software.'] },
  { desktop: ['Senior Software Engineer at EPAM Systems.'] },
  { desktop: ['SpaceX AI Ambassador.'] },
  { desktop: ['Cursor India community: 1000+ members.'] },
  {
    desktop: ['Co-organized Cursor Hackathon Ahmedabad:', '1,100+ registrations, 138 check-ins, 35 teams.'],
    phone: ['Co-organized Cursor Hackathon Ahmedabad:', '1,100+ registrations,', '138 check-ins, 35 teams.'],
  },
];
const WHOAMI_ALT = `whoami: ${WHOAMI_LINE.join(' ')} ${WHOAMI_FACTS.map((f) => f.desktop.join(' ')).join(' ')}`;

function whoamiCard({ phone, theme }) {
  const th = THEMES[theme];
  const W = phone ? PHONE_W : DESKTOP_W;
  const pad = phone ? 22 : 36;
  const fs = phone ? 13.5 : 17;
  const lh = Math.round(fs * 1.55);
  const charW = fs * 0.6;
  let body = '';

  body += `<line x1="1" y1="54" x2="${W - 1}" y2="54" stroke="${th.border}" stroke-width="2"/>`;
  [th.accent, th.muted, th.line].forEach((c, i) => {
    body += `<circle cx="${pad + 6 + i * 20}" cy="28" r="6" fill="${c}" stroke="${th.border}" stroke-width="1.5"/>`;
  });
  body += text(W - pad, 33, 'krushnasinh@gujarat: ~', { size: phone ? 13 : 14, mono: true, fill: th.muted, anchor: 'end' });

  let y = 54 + (phone ? 40 : 46);
  const prompt = (cmd) => {
    body += text(pad, y, '$', { size: fs, mono: true, weight: 700, fill: th.star });
    body += text(pad + charW * 2, y, cmd, { size: fs, mono: true, weight: 600, fill: th.ink });
    y += lh;
  };
  const lines = (arr, bullet) => {
    if (bullet) body += star(pad + 5, y - fs * 0.32, 5.5, th.star);
    arr.forEach((l, i) => {
      body += text(pad + (bullet ? charW * 2.4 : 0), y + i * lh, l, { size: fs, mono: true, fill: th.ink, op: bullet ? 0.9 : 1 });
    });
    y += arr.length * lh + (bullet ? 6 : 4);
  };

  prompt(WHOAMI_CMD1);
  lines(phone ? WHOAMI_LINE_PHONE : WHOAMI_LINE, false);
  y += 8;
  prompt(WHOAMI_CMD2);
  y += 2;
  WHOAMI_FACTS.forEach((f) => lines(phone ? f.phone || f.desktop : f.desktop, true));
  body += text(pad, y + 4, '$', { size: fs, mono: true, weight: 700, fill: th.star });
  body += `<rect x="${pad + charW * 2}" y="${y + 4 - fs * 0.85}" width="${r1(charW)}" height="${r1(fs * 1.05)}" fill="${th.accent}"/>`;
  const h = Math.ceil(y + 4 + pad);
  return { w: W, h, label: WHOAMI_ALT, body: card(W, h, th) + body, th };
}

// ---------------------------------------------------------------------------
// "What I ship" label
// ---------------------------------------------------------------------------

function labelCard({ phone, theme }) {
  const th = THEMES[theme];
  const W = phone ? TOTAL_PHONE_W : TOTAL_DESKTOP_W;
  const sub = phone ? 'built end-to-end' : 'small public products, built end-to-end';
  const title = 'What I ship';
  const pillW = textWidth(title, 28, { weight: 800 }) + 64;
  const pillH = 46;
  let body = `<rect x="6" y="6" width="${r1(pillW)}" height="${pillH}" rx="14" fill="${th.shadow}"/>`;
  body += `<rect x="2" y="2" width="${r1(pillW)}" height="${pillH}" rx="14" fill="${th.accent}" stroke="${th.border}" stroke-width="2"/>`;
  body += star(2 + 28, 25, 8, th.accentInk);
  body += text(2 + 46, 35, title, { size: 28, weight: 800, fill: th.accentInk, ls: -0.5 });
  const sx = 2 + pillW + 18;
  const sw = textWidth(sub, 14.5, { mono: true }) + 28;
  body += `<rect x="${r1(sx)}" y="10" width="${r1(sw)}" height="30" rx="15" fill="none" stroke="${th.muted}" stroke-width="1.5" stroke-opacity="0.6"/>`;
  body += text(sx + sw / 2, 30, sub, { size: 14.5, mono: true, fill: th.muted, anchor: 'middle' });
  return { w: W, h: 56, label: title, body, th, bare: true };
}

// ---------------------------------------------------------------------------
// App cards
// ---------------------------------------------------------------------------

const APPS = [
  {
    name: 'app-blinq',
    title: 'blinq',
    tags: ['Next.js', 'Clerk', 'Vercel'],
    desc: 'A visual memory game with solo play, daily challenges, and real-time multiplayer.',
    glyph: 'cards',
    color: 0,
  },
  {
    name: 'app-eventclaim',
    title: 'EventClaim',
    tags: ['React', 'Google Auth'],
    desc: 'Check-in, coupon, and credit/offer distribution for the Cursor community.',
    glyph: 'ticket',
    color: 1,
  },
  {
    name: 'app-demo-video-plugin',
    title: 'Demo Video Plugin',
    tags: ['Cursor', 'Agent plugin'],
    desc: 'Turns a demo.config.json into narrated 1080p product demo videos.',
    glyph: 'play',
    color: 3,
  },
  {
    name: 'app-in-hand-helper',
    title: 'In-Hand Helper',
    tags: ['TypeScript', 'React'],
    desc: 'Salary impact dashboard: 50% basic-salary rule, old vs new tax regime.',
    glyph: 'trend',
    color: 2,
  },
];

const APP_TOTAL_PHONE_W = 200;

function appLayout(app, phone) {
  const inset = phone ? 8 : 14;
  const shadow = phone ? 3 : 4;
  const W = (phone ? APP_TOTAL_PHONE_W : TOTAL_DESKTOP_W / 2) - inset * 2 - shadow;
  const pad = phone ? 13 : 22;
  const inner = W - pad * 2;
  const tile = phone ? 38 : 54;
  const titleSize = phone ? Math.min(19, Math.floor(inner / textWidth(app.title, 1, { weight: 800 }))) : 26;
  const descSize = phone ? 13 : 16;
  const titleLines = wrap(app.title, inner, titleSize, { weight: 800 });
  const descLines = wrap(app.desc, inner, descSize);
  const titleLh = Math.round(titleSize * 1.2);
  const descLh = Math.round(descSize * 1.45);
  const chipSize = phone ? 12 : 14;
  const chipH = phone ? 25 : 30;
  const rows = [[]];
  let rowW = 0;
  for (const tag of app.tags) {
    const w = textWidth(tag, chipSize, { mono: true }) + (phone ? 18 : 26);
    if (rowW + w > inner && rows[rows.length - 1].length) {
      rows.push([]);
      rowW = 0;
    }
    rows[rows.length - 1].push({ tag, w });
    rowW += w + 7;
  }
  const titleY = pad + tile + (phone ? 24 : 34);
  const descY = titleY + (titleLines.length - 1) * titleLh + (phone ? 12 : 16);
  const chipsTop = descY + descLines.length * descLh + (phone ? 12 : 16);
  const h = chipsTop + rows.length * chipH + (rows.length - 1) * 8 + pad;
  return { inset, shadow, W, pad, tile, titleSize, descSize, titleLines, descLines, titleLh, descLh, chipSize, chipH, rows, titleY, descY, chipsTop, h };
}

function appCard({ phone, theme, app, height }) {
  const th = THEMES[theme];
  const m = appLayout(app, phone);
  const { W, pad } = m;
  const h = height;
  const label = `${app.title}: ${app.desc} ${app.tags.join(', ')}.`;
  let body = '';

  body += cardAt(pad, pad, m.tile, m.tile, th, { shadow: 3, rx: 12 });
  body += icon(app.glyph, pad + m.tile * 0.22, pad + m.tile * 0.22, m.tile * 0.56, th.ink, th.accent);
  const bub = phone ? 28 : 38;
  body += `<circle cx="${W - pad - bub / 2}" cy="${pad + bub / 2}" r="${bub / 2}" fill="${th.card}" stroke="${th.border}" stroke-width="2"/>`;
  body += icon('arrow', W - pad - bub + bub * 0.25, pad + bub * 0.25, bub * 0.5, th.ink);

  m.titleLines.forEach((l, i) => {
    body += text(pad, m.titleY + i * m.titleLh, l, { size: m.titleSize, weight: 800, fill: th.ink, ls: -0.4 });
  });
  m.descLines.forEach((l, i) => {
    body += text(pad, m.descY + i * m.descLh + m.descSize * 0.8, l, { size: m.descSize, fill: th.ink, op: 0.72 });
  });
  m.rows.forEach((row, ri) => {
    let x = pad;
    row.forEach(({ tag, w }) => {
      const top = m.chipsTop + ri * (m.chipH + 8);
      body += pill(x, top, w, m.chipH, th.card, th.border);
      body += text(x + w / 2, top + m.chipH / 2 + m.chipSize * 0.35, tag, { size: m.chipSize, mono: true, fill: th.ink, anchor: 'middle' });
      x += w + 7;
    });
  });
  return { w: W, h, label, body: card(W, h, th, { fill: th.tiles[app.color] }) + body, th, inset: m.inset, shadow: m.shadow };
}

// Cards sharing a row of the 2-up grid get the same height.
function appHeights(phone) {
  const own = APPS.map((a) => appLayout(a, phone).h);
  return own.map((_, i) => Math.max(own[i - (i % 2)], own[i - (i % 2) + 1]));
}

// ---------------------------------------------------------------------------
// Live: "On GitHub" stats card
// ---------------------------------------------------------------------------

function githubAlt(s) {
  const streakSince = `since ${fmtDay(s.streak.start)}`;
  return (
    `On GitHub: ${plural(s.lastYear, 'contribution')} in the last year, ` +
    `a ${s.streak.length}-day current streak, ${streakSince}, ` +
    `longest streak ${plural(s.longest.length, 'day')}, ` +
    `${plural(s.allTime, 'contribution')} since ${s.joinedYear}, ` +
    `${plural(s.publicRepos, 'public repo')}, ${plural(s.stars, 'star')} earned.`
  );
}

function githubCard({ phone, theme }, s) {
  const th = THEMES[theme];
  const W = phone ? PHONE_W : DESKTOP_W;
  const pad = phone ? 24 : 32;
  const label = githubAlt(s);
  const streakCap = s.streak.length > 0 ? `since ${fmtDay(s.streak.start)}` : 'no active streak';
  const tiles = [
    { icon: 'calendar', value: num(s.lastYear), cap: ['contributions in', 'the last year'], hot: true },
    { icon: 'flame', value: plural(s.streak.length, 'day'), cap: ['current streak,', streakCap] },
    { icon: 'trophy', value: plural(s.longest.length, 'day'), cap: ['longest streak', 'ever'] },
    { icon: 'bars', value: num(s.allTime), cap: ['contributions', `since ${s.joinedYear}`] },
    { icon: 'repo', value: num(s.publicRepos), cap: ['public repos', 'owned by me'] },
    { icon: 'star', value: num(s.stars), cap: ['stars earned', 'on my own repos'] },
  ];
  const cols = phone ? 2 : 3;
  const gap = phone ? 14 : 16;
  const tw = (W - pad * 2 - 3 - gap * (cols - 1)) / cols;
  const th_ = phone ? 112 : 124;
  const top = phone ? 92 : 92;
  let body = star(pad + 9, pad + 21, 9, th.star);
  body += text(pad + 26, pad + 32, 'On GitHub', { size: phone ? 28 : 32, weight: 800, fill: th.ink, ls: -0.8 });
  body += text(W - pad, pad + 30, phone ? 'redrawn nightly' : `redrawn every night · ${fmtFull(s.today)}`, {
    size: phone ? 13 : 15,
    mono: true,
    fill: th.muted,
    anchor: 'end',
  });
  tiles.forEach((t, i) => {
    const x = pad + (i % cols) * (tw + gap);
    const y = top + Math.floor(i / cols) * (th_ + gap);
    const fill = t.hot ? th.accent : th.tiles[(i - 1) % th.tiles.length];
    const ink = t.hot ? th.accentInk : th.ink;
    const capFill = t.hot ? th.accentInk : th.ink;
    body += cardAt(x, y, tw, th_, th, { fill, shadow: 3, rx: 12 });
    const bub = 32;
    const bx = x + tw - 16 - bub;
    body += `<circle cx="${r1(bx + bub / 2)}" cy="${y + 16 + bub / 2}" r="${bub / 2}" fill="${t.hot ? th.accentInk : th.card}" stroke="${th.border}" stroke-width="1.5"/>`;
    body += icon(t.icon, bx + 7, y + 23, 18, t.hot ? th.accent : th.ink);
    body += text(x + 16, y + (phone ? 62 : 70), t.value, { size: phone ? 30 : 36, weight: 800, fill: ink, ls: -0.8 });
    t.cap.forEach((c, k) => {
      body += text(x + 16, y + (phone ? 84 : 94) + k * (phone ? 17 : 19), c, { size: phone ? 13.5 : 14.5, mono: true, fill: capFill, op: t.hot ? 0.78 : 0.72 });
    });
  });
  const rowsN = Math.ceil(tiles.length / cols);
  const h = top + rowsN * th_ + (rowsN - 1) * gap + pad;
  return { w: W, h, label, body: card(W, h, th) + body, th };
}

// ---------------------------------------------------------------------------
// Live: contribution graphs
// ---------------------------------------------------------------------------

function buildWeeks(days, start, end) {
  const map = new Map(days.map((d) => [d.date, d]));
  const first = addDays(start, -dayOfWeek(start));
  const weeks = [];
  for (let s = first; s <= end; s = addDays(s, 7)) {
    const col = [];
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(s, i);
      col.push(date >= start && date <= end ? map.get(date) || { date, count: 0, level: 0 } : null);
    }
    weeks.push(col);
  }
  return weeks;
}

function drawBlock(weeks, x0, y0, pitch, cellSize, th, weekdayLabels) {
  let body = '';
  const labelsAt = [];
  weeks.forEach((col, i) => {
    const hit = col.find((d) => d && d.date.slice(8) === '01');
    if (hit) labelsAt.push({ i, m: Number(hit.date.slice(5, 7)) - 1 });
  });
  const firstDay = weeks[0].find(Boolean);
  if (firstDay && (!labelsAt.length || labelsAt[0].i >= 3)) {
    labelsAt.unshift({ i: 0, m: Number(firstDay.date.slice(5, 7)) - 1 });
  }
  let last = -10;
  for (const l of labelsAt) {
    if (l.i - last < 3) continue;
    body += text(x0 + l.i * pitch, y0 - 10, MONTHS[l.m], { size: 13, mono: true, fill: th.muted });
    last = l.i;
  }
  if (weekdayLabels) {
    [1, 3, 5].forEach((d) => {
      body += text(x0 - 10, y0 + d * pitch + cellSize * 0.72, ['Mon', 'Wed', 'Fri'][(d - 1) / 2], { size: 12, mono: true, fill: th.muted, anchor: 'end' });
    });
  }
  const byLevel = [[], [], [], [], []];
  const rx = r1(Math.max(2, cellSize * 0.24));
  weeks.forEach((col, i) => {
    col.forEach((d, j) => {
      if (d) byLevel[d.level].push(`<rect x="${r1(x0 + i * pitch)}" y="${r1(y0 + j * pitch)}" width="${r1(cellSize)}" height="${r1(cellSize)}" rx="${rx}"/>`);
    });
  });
  byLevel.forEach((rects, lvl) => {
    if (rects.length) body += `<g fill="${th.heat[lvl]}">${rects.join('')}</g>`;
  });
  return { body, height: 7 * pitch - (pitch - cellSize) };
}

function graphCard({ phone, theme }, { days, start, end, total, caption }) {
  const th = THEMES[theme];
  const W = phone ? PHONE_W : DESKTOP_W;
  const pad = phone ? 24 : 32;
  const label = `${plural(total, 'contribution')} ${caption}`;
  const head = header(W, pad, phone, th, num(total), `${total === 1 ? 'contribution' : 'contributions'} ${caption}`);
  let body = head.body;
  const weeks = buildWeeks(days, start, end);
  let y;

  const perBlock = weeks.length > 30 ? Math.ceil(weeks.length / 2) : weeks.length;
  const blocks = [];
  for (let i = 0; i < weeks.length; i += perBlock) blocks.push(weeks.slice(i, i + perBlock));
  const gx = phone ? pad : pad + 38;
  const pitch = Math.min(30, (W - pad - gx) / Math.max(perBlock, 26));
  const cell = Math.floor((pitch - (pitch > 20 ? 4 : 3)) * 10) / 10;
  y = head.bottom + (phone ? 50 : 56);
  blocks.forEach((b, bi) => {
    const d = drawBlock(b, gx, y, pitch, cell, th, !phone);
    body += d.body;
    y += d.height + (bi < blocks.length - 1 ? 44 : 0);
  });
  y += 30;

  const legendCell = 12;
  const lw = 5 * (legendCell + 4) - 4;
  const wordW = textWidth('Less', 13, { mono: true });
  let lx = W - pad - (wordW * 2 + 16 + lw);
  body += text(lx, y + 10, 'Less', { size: 13, mono: true, fill: th.muted });
  lx += wordW + 8;
  th.heat.forEach((c, i) => {
    body += `<rect x="${lx + i * (legendCell + 4)}" y="${y}" width="${legendCell}" height="${legendCell}" rx="3" fill="${c}"/>`;
  });
  body += text(lx + lw + 8, y + 10, 'More', { size: 13, mono: true, fill: th.muted });
  const h = y + legendCell + pad;
  return { w: W, h, label, body: card(W, h, th) + body, th };
}

// ---------------------------------------------------------------------------
// Live: 30-day line chart
// ---------------------------------------------------------------------------

function niceStep(max) {
  if (max <= 0) return 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return Math.max(1, m * mag);
  return 10 * mag;
}

// Monotone cubic (Fritsch-Carlson): smooth, but never dips below zero between points.
function smoothSegments(pts) {
  const n = pts.length;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i += 1) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const sq = a * a + b * b;
    if (sq > 9) {
      const k = 3 / Math.sqrt(sq);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = '';
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    d += ` C${r1(x0 + dx[i] / 3)} ${r1(y0 + (t[i] * dx[i]) / 3)} ${r1(x1 - dx[i] / 3)} ${r1(y1 - (t[i + 1] * dx[i]) / 3)} ${r1(x1)} ${r1(y1)}`;
  }
  return d;
}

function lineCard({ phone, theme }, { days, total }) {
  const th = THEMES[theme];
  const W = phone ? PHONE_W : DESKTOP_W;
  const pad = phone ? 24 : 32;
  const label = `${plural(total, 'contribution')} in the last 30 days`;
  const head = header(W, pad, phone, th, num(total), `${total === 1 ? 'contribution' : 'contributions'} in the last 30 days`);
  let body = head.body;
  const max = Math.max(...days.map((d) => d.count));
  const step = niceStep(max);
  const top = step * 4;
  const x0 = pad + (phone ? 28 : 36);
  const x1 = W - pad - 8;
  const yTop = head.bottom + (phone ? 40 : 50);
  const chartH = phone ? 190 : 220;
  const yBase = yTop + chartH;
  const px = (i) => x0 + 6 + (i * (x1 - x0 - 12)) / (days.length - 1);
  const py = (v) => yBase - (v / top) * chartH;

  for (let k = 0; k <= 4; k += 1) {
    const v = k * step;
    const y = py(v);
    body += `<line x1="${x0}" y1="${r1(y)}" x2="${x1}" y2="${r1(y)}" stroke="${th.line}" stroke-width="1.5"${k ? ' stroke-dasharray="4 5"' : ''}/>`;
    body += text(x0 - 10, y + 4.5, String(v), { size: 12.5, mono: true, fill: th.muted, anchor: 'end' });
  }
  const pts = days.map((d, i) => [px(i), py(d.count)]);
  const curve = `M${r1(pts[0][0])} ${r1(pts[0][1])}${smoothSegments(pts)}`;
  const area = `${curve} L${r1(px(days.length - 1))} ${yBase} L${r1(px(0))} ${yBase} Z`;
  const gid = 'area';
  const defs = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.accent}" stop-opacity="${theme === 'dark' ? 0.32 : 0.75}"/><stop offset="1" stop-color="${th.accent}" stop-opacity="0"/></linearGradient>`;
  body += `<path d="${area}" fill="url(#${gid})"/>`;
  body += `<path d="${curve}" fill="none" stroke="${th.lineStroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  days.forEach((d, i) => {
    body += `<circle cx="${r1(px(i))}" cy="${r1(py(d.count))}" r="${phone ? 2.8 : 3.4}" fill="${th.accent}" stroke="${th.lineStroke}" stroke-width="1.5"/>`;
  });
  if (max > 0) {
    const mi = days.findIndex((d) => d.count === max);
    const label2 = `peak ${num(max)}`;
    const lw = textWidth(label2, 13, { mono: true }) + 20;
    const cx = Math.min(Math.max(px(mi), x0 + lw / 2), x1 - lw / 2);
    const cy = Math.max(py(max) - 38, yTop - 8);
    body += pill(cx - lw / 2, cy, lw, 26, th.accent);
    body += text(cx, cy + 17.5, label2, { size: 13, mono: true, weight: 600, fill: th.accentInk, anchor: 'middle' });
  }
  const last = days.length - 1;
  days.forEach((d, i) => {
    if ((last - i) % 3 !== 0) return;
    const lbl = phone ? String(Number(d.date.slice(8))) : fmtDay(d.date);
    const anchor = i === last ? 'end' : 'middle';
    body += text(px(i) + (i === last ? 6 : 0), yBase + 26, lbl, { size: 12.5, mono: true, fill: th.muted, anchor });
  });
  let bottom = yBase + 26;
  if (phone) {
    bottom += 24;
    body += text((x0 + x1) / 2, bottom, `${fmtDay(days[0].date)} – ${fmtFull(days[last].date)}`, { size: 12.5, mono: true, fill: th.muted, anchor: 'middle' });
  }
  const h = bottom + pad;
  return { w: W, h, label, body: card(W, h, th) + body, th, defs };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function render(c) {
  const th = c.th;
  let w = c.w;
  let h = c.h;
  let body = c.body;
  if (!c.bare) {
    const inset = c.inset ?? 14;
    const shadow = c.shadow ?? 4;
    w = c.w + inset * 2 + shadow;
    h = c.h + inset * 2 + shadow;
    body =
      `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="18" fill="${th.panel}" stroke="${th.panelLine}" stroke-width="2"/>` +
      `<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="17" fill="url(#dots)"/>` +
      `<g transform="translate(${inset} ${inset})">${c.body}</g>`;
  }
  const dots = `<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="1.3" fill="${th.dot}" fill-opacity="0.3"/></pattern>`;
  return svgDoc(w, h, c.label, body, th, dots + (c.defs || ''));
}

function allVariants(name, build) {
  return VARIANTS.map((v) => ({ file: `${name}-${v.suffix}.svg`, svg: render(build(v)) }));
}

function staticAssets() {
  const out = [];
  out.push(...allVariants('hero', heroCard));
  for (const b of BADGES) out.push(...allVariants(b.name, (v) => badgeCard({ ...v, ...b })));
  out.push(...allVariants('whoami', whoamiCard));
  out.push(...allVariants('label-ship', labelCard));
  APPS.forEach((app, i) => {
    for (const v of VARIANTS) {
      out.push({ file: `${app.name}-${v.suffix}.svg`, svg: render(appCard({ ...v, app, height: appHeights(v.phone)[i] })) });
    }
  });
  return out;
}

function liveAssets(s) {
  const out = [];
  out.push(...allVariants('github', (v) => githubCard(v, s)));
  out.push(
    ...allVariants('graph-6m', (v) => graphCard(v, { days: s.sixMonths.days, start: s.sixMonths.start, end: s.today, total: s.sixMonths.total, caption: 'in the last 6 months' })),
  );
  out.push(
    ...allVariants('graph-12m', (v) => graphCard(v, { days: s.lastYearDays, start: s.lastYearStart, end: s.today, total: s.lastYear, caption: 'in the last 12 months' })),
  );
  for (const y of s.years) {
    out.push(
      ...allVariants(`graph-${y.year}`, (v) => graphCard(v, { days: y.days, start: `${y.year}-01-01`, end: y.end, total: y.total, caption: `in ${y.year}` })),
    );
  }
  out.push(...allVariants('line-30d', (v) => lineCard(v, { days: s.thirty.days, total: s.thirty.total })));
  return out;
}

// ---------------------------------------------------------------------------
// README sections
// ---------------------------------------------------------------------------

function picture(name, alt, width = '100%') {
  return (
    `<picture><source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="assets/${name}-phone-dark.svg">` +
    `<source media="(max-width: 600px)" srcset="assets/${name}-phone-light.svg">` +
    `<source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg">` +
    `<img src="assets/${name}-light.svg" width="${width}" alt="${esc(alt)}"></picture>`
  );
}

function readmeSections(s) {
  const years = s.years
    .map((y) => `<details><summary>${y.year}: ${plural(y.total, 'contribution')}</summary>\n\n${picture(`graph-${y.year}`, `${plural(y.total, 'contribution')} in ${y.year}`)}\n\n</details>`)
    .join('\n\n');
  return {
    github: picture('github', githubAlt(s)),
    'graph-6m': picture('graph-6m', `${plural(s.sixMonths.total, 'contribution')} in the last 6 months`),
    years:
      `<details><summary>Last 12 months: ${plural(s.lastYear, 'contribution')}</summary>\n\n${picture('graph-12m', `${plural(s.lastYear, 'contribution')} in the last 12 months`)}\n\n</details>\n\n` +
      years,
    'line-30d': picture('line-30d', `${plural(s.thirty.total, 'contribution')} in the last 30 days`),
  };
}

function patchReadme(source, sections) {
  let next = source;
  for (const [key, value] of Object.entries(sections)) {
    const re = new RegExp(`(<!--stats:${key}-->)[\\s\\S]*?(<!--/stats:${key}-->)`);
    if (!re.test(next)) throw new Error(`README.md is missing the <!--stats:${key}--> markers`);
    next = next.replace(re, (_, a, b) => `${a}\n${value}\n${b}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function gql(token, query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-readme-stats' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors)}`);
  if (!json.data) throw new Error('GitHub GraphQL returned no data');
  return json.data;
}

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const CALENDAR = 'contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } }';

function flattenCalendar(cal) {
  const days = [];
  for (const week of cal.weeks) {
    for (const d of week.contributionDays) {
      if (!(d.contributionLevel in LEVELS)) throw new Error(`Unknown contribution level ${d.contributionLevel}`);
      days.push({ date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] });
    }
  }
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchStars(token) {
  let stars = 0;
  let cursor = null;
  for (;;) {
    const data = await gql(
      token,
      `query($login: String!, $cursor: String) { user(login: $login) { repositories(first: 100, after: $cursor, privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false) { pageInfo { hasNextPage endCursor } nodes { stargazerCount } } } }`,
      { login: USER, cursor },
    );
    const repos = data.user.repositories;
    for (const n of repos.nodes) stars += n.stargazerCount;
    if (!repos.pageInfo.hasNextPage) return stars;
    cursor = repos.pageInfo.endCursor;
  }
}

function streaks(daysAsc, today) {
  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null };
  for (const d of daysAsc) {
    if (d.count > 0) {
      if (!run.length) run = { length: 0, start: d.date };
      run.length += 1;
      if (run.length > longest.length) longest = { length: run.length, start: run.start, end: d.date };
    } else run = { length: 0, start: null };
  }
  const byDate = new Map(daysAsc.map((d) => [d.date, d.count]));
  let cursor = byDate.get(today) > 0 ? today : addDays(today, -1);
  let length = 0;
  let start = null;
  while ((byDate.get(cursor) || 0) > 0) {
    length += 1;
    start = cursor;
    cursor = addDays(cursor, -1);
  }
  return { current: { length, start }, longest };
}

async function collectStats(token) {
  const head = await gql(
    token,
    `query($login: String!) { user(login: $login) { createdAt repositories(privacy: PUBLIC, ownerAffiliations: OWNER) { totalCount } lastYear: contributionsCollection { ${CALENDAR} } } }`,
    { login: USER },
  );
  const user = head.user;
  if (!user) throw new Error(`GitHub user ${USER} not found`);
  const lastYearDays = flattenCalendar(user.lastYear.contributionCalendar);
  const lastYear = user.lastYear.contributionCalendar.totalContributions;
  const today = lastYearDays[lastYearDays.length - 1].date;
  const lastYearStart = lastYearDays[0].date;
  const joinedYear = Number(user.createdAt.slice(0, 4));
  const currentYear = Number(today.slice(0, 4));

  const aliases = [];
  for (let y = joinedYear; y <= currentYear; y += 1) {
    const to = y === currentYear ? `${today}T23:59:59Z` : `${y}-12-31T23:59:59Z`;
    aliases.push(`y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${to}") { ${CALENDAR} }`);
  }
  const perYear = await gql(token, `query($login: String!) { user(login: $login) { ${aliases.join(' ')} } }`, { login: USER });
  const stars = await fetchStars(token);

  const years = [];
  const merged = new Map();
  for (let y = currentYear; y >= joinedYear; y -= 1) {
    const cal = perYear.user[`y${y}`].contributionCalendar;
    const end = y === currentYear ? today : `${y}-12-31`;
    const days = flattenCalendar(cal).filter((d) => d.date.slice(0, 4) === String(y) && d.date <= end);
    years.push({ year: y, total: cal.totalContributions, days, end });
    for (const d of days) merged.set(d.date, d);
  }
  for (const d of lastYearDays) if (!merged.has(d.date)) merged.set(d.date, d);
  const allDays = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const { current, longest } = streaks(allDays, today);

  const sixStart = addDays(addMonths(today, -6), 1);
  const sixDays = lastYearDays.filter((d) => d.date >= sixStart);
  const thirtyDays = lastYearDays.filter((d) => d.date >= addDays(today, -29));
  if (thirtyDays.length !== 30) throw new Error(`Expected 30 days of data, got ${thirtyDays.length}`);

  const sum = (arr) => arr.reduce((a, d) => a + d.count, 0);
  return {
    today,
    joinedYear,
    lastYear,
    lastYearDays,
    lastYearStart,
    allTime: years.reduce((a, y) => a + y.total, 0),
    streak: current,
    longest,
    publicRepos: user.repositories.totalCount,
    stars,
    years,
    sixMonths: { days: sixDays, start: sixStart, total: sum(sixDays) },
    thirty: { days: thirtyDays, total: sum(thirtyDays) },
  };
}

// ---------------------------------------------------------------------------

async function writeAll(files) {
  await mkdir(ASSETS, { recursive: true });
  for (const f of files) await writeFile(path.join(ASSETS, f.file), f.svg);
}

async function main() {
  if (process.argv.includes('--static')) {
    await writeAll(staticAssets());
    console.log('static assets written');
    return;
  }
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set');
  const stats = await collectStats(token);
  const files = liveAssets(stats);
  const readme = patchReadme(await readFile(README, 'utf8'), readmeSections(stats));
  await writeAll(files);
  await writeFile(README, readme);
  console.log(
    `ok: ${num(stats.lastYear)} last year, ${num(stats.allTime)} since ${stats.joinedYear}, streak ${stats.streak.length}d, longest ${stats.longest.length}d, ${stats.publicRepos} repos, ${stats.stars} stars, ${stats.years.length} yearly graphs`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
