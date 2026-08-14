/* ============================================================
   Link Center — dashboard SPA (vanilla JS, no dependencies)
   ============================================================ */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtN(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTimeAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Date.now() / 1000 - Number(ts));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtPct(n) { return (Number(n || 0) * 100).toFixed(1) + '%'; }

function shortUrl(u) {
  try { const p = new URL(u); return p.hostname + p.pathname; } catch { return u; }
}

/* ---------------- state ---------------- */
const state = {
  me: null,
  csrf: null,
  settings: null,
  campaigns: [],
  linksCache: null,
};

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const { method = 'GET', body, silent } = opts;
  const headers = { 'content-type': 'application/json' };
  if (state.csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = state.csrf;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    if (!silent) toast('Network error — please try again.', 'error');
    throw new Error('network');
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    state.me = null;
    state.csrf = null;
    if (location.pathname !== '/login') {
      navigate('/login');
    }
    throw new Error('unauthorized');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (!silent) toast(data?.error?.message || `Request failed (${res.status})`, 'error');
    const err = new Error(data?.error?.message || 'request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data?.data ?? data;
}

/* ---------------- toast ---------------- */
function toast(msg, type = 'info', ms = 3800) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

/* ---------------- modal ---------------- */
function openModal(html, { wide = false, onMount } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  const backdrop = $('.modal-backdrop', root);
  const modal = $('.modal', root);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  if (onMount) onMount(modal);
  return modal;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

/* ---------------- command palette ---------------- */
function openPalette() {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="palette-backdrop">
      <div class="palette">
        <input type="search" placeholder="Search links, or run an action…" autocomplete="off">
        <div class="results"></div>
      </div>
    </div>`;
  const backdrop = $('.palette-backdrop', root);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) root.innerHTML = ''; });
  const input = $('input', backdrop);
  const results = $('.results', backdrop);

  const actions = [
    { label: 'Create Link', hint: 'action', icon: '🔗', run: () => { root.innerHTML = ''; navigate('/dashboard/links/new'); } },
    { label: 'Compose Email', hint: 'action', icon: '✉️', run: () => { root.innerHTML = ''; navigate('/dashboard/mail'); } },
    { label: 'Create Campaign', hint: 'action', icon: '📣', run: () => { root.innerHTML = ''; navigate('/dashboard/campaigns?new=1'); } },
    { label: 'View Analytics', hint: 'action', icon: '📊', run: () => { root.innerHTML = ''; navigate('/dashboard/analytics'); } },
  ];
  let links = [];
  let sel = 0;

  function render() {
    const q = input.value.trim().toLowerCase();
    const items = [];
    for (const a of actions) if (!q || a.label.toLowerCase().includes(q)) items.push({ type: 'action', ...a });
    for (const l of links) {
      const hay = `${l.slug} ${l.title || ''} ${l.destination_url}`.toLowerCase();
      if (!q || hay.includes(q)) items.push({ type: 'link', label: `${l.type}/${l.slug}`, hint: fmtN(l.click_count) + ' clicks', icon: '↗️', run: () => { root.innerHTML = ''; navigate(`/dashboard/links/${l.id}/analytics`); } });
    }
    sel = Math.min(sel, Math.max(0, items.length - 1));
    if (!items.length) { results.innerHTML = '<div class="empty">No results</div>'; return; }
    results.innerHTML = items.map((it, i) =>
      `<div class="result ${i === sel ? 'sel' : ''}" data-i="${i}"><span>${it.icon}</span><span>${esc(it.label)}</span><span class="hint">${esc(it.hint)}</span></div>`).join('');
    $$('.result', results).forEach((r) => r.addEventListener('click', () => items[Number(r.dataset.i)].run()));
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, $$('.result', results).length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { const el = $$('.result', results)[sel]; if (el) el.click(); }
    else if (e.key === 'Escape') { root.innerHTML = ''; }
  });

  api('/api/links?perPage=100', { silent: true }).then((d) => { links = d.items || []; render(); }).catch(() => {});
  render();
  input.focus();
}

/* ---------------- charts ---------------- */
function lineChart(series, { height = 150 } = {}) {
  if (!series || !series.length) return '<div class="empty">No data yet</div>';
  const w = 720, h = height, pad = 34;
  const max = Math.max(1, ...series.map((s) => s.clicks));
  const step = (w - pad * 2) / Math.max(1, series.length - 1);
  const pts = series.map((s, i) => `${pad + i * step},${h - pad - (s.clicks / max) * (h - pad * 2)}`);
  const area = `${pad},${h - pad} ${pts.join(' ')} ${w - pad},${h - pad}`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px">
    <defs><linearGradient id="lg1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2563eb" stop-opacity="0.28"/><stop offset="100%" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>
    ${[0.25, 0.5, 0.75].map((f) => `<line x1="${pad}" y1="${h - pad - f * (h - pad * 2)}" x2="${w - pad}" y2="${h - pad - f * (h - pad * 2)}" stroke="#1f2937" stroke-width="1"/>`).join('')}
    <polygon points="${area}" fill="url(#lg1)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${series.map((s, i) => (i % Math.ceil(series.length / 8) === 0 || i === series.length - 1 ? `<text x="${pad + i * step}" y="${h - 10}" fill="#6b7a90" font-size="9" text-anchor="middle">${esc(s.label)}</text>` : '')).join('')}
    <text x="${w - pad}" y="${h - pad - ((series[series.length - 1]?.clicks ?? 0) / max) * (h - pad * 2) - 8}" fill="#93c5fd" font-size="11" text-anchor="end">${fmtN(series[series.length - 1]?.clicks)}</text>
  </svg>`;
}

function barChart(items, { color = '#3b82f6', height = 150 } = {}) {
  if (!items || !items.length) return '<div class="empty">No data yet</div>';
  const max = Math.max(1, ...items.map((i) => i.value));
  const bars = items.map((i) => `<div class="bar" style="height:${(i.value / max) * 100}%;background:${esc(color)}" title="${esc(i.label)}: ${fmtN(i.value)}"></div>`).join('');
  const step = Math.ceil(items.length / 10);
  return `<div class="bars" style="height:${height}px">${bars}</div>
    <div class="bar-axis">${items.filter((_, i) => i % step === 0 || i === items.length - 1).map((i) => `<span>${esc(i.label)}</span>`).join('')}</div>`;
}

function hbars(items) {
  if (!items || !items.length) return '<div class="empty">No data yet</div>';
  const max = Math.max(1, ...items.map((i) => i.count));
  return items.map((i) => `<div class="hbar-row">
      <div class="name" title="${esc(i.name)}">${esc(i.name)}</div>
      <div class="track"><div class="fill" style="width:${(i.count / max) * 100}%"></div></div>
      <div class="val">${fmtN(i.count)}</div>
    </div>`).join('');
}

/* ---------------- layout ---------------- */
const NAV = [
  { href: '/dashboard', icon: '🏠', label: 'Overview' },
  { href: '/dashboard/links', icon: '🔗', label: 'Links' },
  { href: '/dashboard/campaigns', icon: '📣', label: 'Campaigns' },
  { href: '/dashboard/mail', icon: '✉️', label: 'Mail' },
  { href: '/dashboard/mail/history', icon: '🗂️', label: 'Mail History' },
  { href: '/dashboard/analytics', icon: '📊', label: 'Analytics' },
  { href: '/dashboard/settings', icon: '⚙️', label: 'Settings' },
];

function renderShell(path) {
  const app = $('#app');
  const normPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const sortedNav = [...NAV].sort((a, b) => b.href.length - a.href.length);
  const active = sortedNav.find((n) => normPath === n.href || (n.href !== '/dashboard' && normPath.startsWith(n.href + '/')))
    || NAV.find((n) => normPath === n.href)
    || NAV[0];

  app.innerHTML = `
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><span class="logo">🔗</span><span>${esc(state.settings?.siteName || 'Link Center')}</span></div>
      <nav>
        ${NAV.map((n) => `<a href="${n.href}" class="${n.href === active.href ? 'active' : ''}"><span class="ic">${n.icon}</span>${n.label}</a>`).join('')}
      </nav>
      <div class="side-foot">
        <div class="user"><span>👤 ${esc(state.me?.username || 'admin')}</span><button class="icon-btn" id="logout" title="Sign out">⎋</button></div>
        <div>Link Center</div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="burger" id="burger">☰</button>
        <div class="page-title">${esc(active.label)}</div>
        <div class="cmd-trigger" id="cmd"><span>Search &amp; actions</span><kbd>Ctrl K</kbd></div>
      </header>
      <div class="content" id="content"></div>
    </div>
  </div>`;
  $('#burger').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#cmd').addEventListener('click', openPalette);
  $('#logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', silent: true }).catch(() => {});
    navigate('/login');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
  NAV.forEach((n) => { const el = $(`a[href="${n.href}"]`, app); if (el) el.addEventListener('click', () => $('#sidebar').classList.remove('open')); });
  return $('#content');
}

/* ---------------- page: overview ---------------- */
async function pageOverview(content) {
  content.innerHTML = '<div class="boot"><div class="spinner"></div><p>Loading overview…</p></div>';
  const [d, settings] = await Promise.all([api('/api/overview'), api('/api/settings')]);
  state.settings = settings;
  const e = d.email;
  content.innerHTML = `
    <div class="grid stats">
      <div class="stat"><div class="label">Total Links</div><div class="value">${fmtN(d.links.total)}</div><div class="hint">${fmtN(d.links.active)} active</div></div>
      <div class="stat"><div class="label">Total Clicks</div><div class="value">${fmtN(d.links.clicks)}</div><div class="hint">${fmtN(d.links.uniques)} unique</div></div>
      <div class="stat"><div class="label">Emails Sent</div><div class="value">${fmtN(e.sent)}</div><div class="hint">${fmtN(e.total)} total</div></div>
      <div class="stat"><div class="label">Delivery Rate</div><div class="value green">${fmtPct(e.deliveryRate)}</div><div class="hint">${fmtN(e.delivered)} delivered</div></div>
      <div class="stat"><div class="label">Open Rate</div><div class="value amber">${fmtPct(e.openRate)}</div><div class="hint">${fmtN(e.opened)} opened</div></div>
      <div class="stat"><div class="label">Click Rate</div><div class="value violet">${fmtPct(e.clickRate)}</div><div class="hint">${fmtN(e.clicked)} clicked</div></div>
    </div>

    <div class="card mt-16">
      <div class="row between"><h3>Quick actions</h3></div>
      <div class="row wrap">
        <a class="btn primary" href="/dashboard/links/new">＋ Create Link</a>
        <a class="btn" href="/dashboard/mail">✉️ Compose Email</a>
        <a class="btn" href="/dashboard/campaigns?new=1">📣 Create Campaign</a>
        <a class="btn" href="/dashboard/analytics">📊 View Analytics</a>
      </div>
    </div>

    <div class="grid cols-2 mt-16">
      <div class="card">
        <h3>Top links</h3>
        ${d.topLinks.length ? d.topLinks.map((l) => `
          <div class="hbar-row"><div class="name" title="${esc(l.title || l.slug)}">${esc(l.slug)}</div>
          <div class="track"><div class="fill" style="width:${(l.click_count / Math.max(1, d.topLinks[0].click_count)) * 100}%"></div></div>
          <div class="val">${fmtN(l.click_count)}</div></div>`).join('') : '<div class="empty">No links yet — create your first link.</div>'}
      </div>
      <div class="card">
        <h3>Recent emails</h3>
        ${d.recentEmails.length ? d.recentEmails.map((m) => `
          <div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border)">
            <div style="min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.subject)}</div>
            <div class="muted">#${esc(m.id)} · ${esc(m.recipient)}</div></div>
            <span class="pill ${esc(m.status)}">${esc(m.status)}</span>
          </div>`).join('') : '<div class="empty">No emails sent yet.</div>'}
      </div>
    </div>`;
}

/* ---------------- page: links ---------------- */
let linksState = { page: 1, search: '', type: '', status: '', sort: 'created', perPage: 20 };

async function pageLinks(content) {
  const params = new URLSearchParams(location.search);
  // Backward compatibility for old bookmarked create links.
  if (params.get('new') === '1') {
    history.replaceState(null, '', '/dashboard/links/new');
    return pageCreateLink(content);
  }
  const q = { ...linksState, page: params.get('page') ? Number(params.get('page')) : linksState.page };
  linksState = q;
  content.innerHTML = `
    <div class="row between wrap">
      <div class="row wrap">
        <input type="search" id="ls" placeholder="Search slug, title, destination…" value="${esc(q.search)}" style="max-width:260px">
        <select id="lt"><option value="">All types</option><option value="track" ${q.type === 'track' ? 'selected' : ''}>Track</option><option value="short" ${q.type === 'short' ? 'selected' : ''}>Short</option><option value="landing" ${q.type === 'landing' ? 'selected' : ''}>Landing</option></select>
        <select id="lst"><option value="">All statuses</option><option value="active" ${q.status === 'active' ? 'selected' : ''}>Active</option><option value="disabled" ${q.status === 'disabled' ? 'selected' : ''}>Disabled</option><option value="archived" ${q.status === 'archived' ? 'selected' : ''}>Archived</option></select>
      </div>
      <a class="btn primary" href="/dashboard/links/new">＋ Create Link</a>
    </div>
    <div class="card mt-16" id="linksTable"><div class="boot"><div class="spinner"></div></div></div>`;

  $('#ls').addEventListener('input', debounce(() => { linksState.search = $('#ls').value.trim(); linksState.page = 1; renderLinksTable(); }, 300));
  $('#lt').addEventListener('change', () => { linksState.type = $('#lt').value; linksState.page = 1; renderLinksTable(); });
  $('#lst').addEventListener('change', () => { linksState.status = $('#lst').value; linksState.page = 1; renderLinksTable(); });

  await renderLinksTable();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function renderLinksTable() {
  const box = $('#linksTable');
  box.innerHTML = '<div class="boot"><div class="spinner"></div></div>';
  const sp = new URLSearchParams({ page: linksState.page, perPage: linksState.perPage, sort: linksState.sort });
  if (linksState.search) sp.set('search', linksState.search);
  if (linksState.type) sp.set('type', linksState.type);
  if (linksState.status) sp.set('status', linksState.status);
  const d = await api('/api/links?' + sp.toString());
  const sortable = (key, label) => `<th class="sortable" data-sort="${key}">${label}${linksState.sort === key ? ' ↓' : ''}</th>`;

  box.innerHTML = `
    <div class="table-wrap">
    <table>
      <thead><tr>
        ${sortable('slug', 'Slug')}
        ${sortable('type', 'Type')}
        <th>Destination</th>
        ${sortable('clicks', 'Clicks')}
        <th>Unique</th>
        ${sortable('created', 'Created')}
        <th>Expires</th>
        <th>Campaign</th>
        <th>Status</th>
        <th style="text-align:right">Actions</th>
      </tr></thead>
      <tbody>
        ${d.items.length ? d.items.map((l) => `
          <tr>
            <td><span class="mono">${esc(l.slug)}</span></td>
            <td><span class="pill ${esc(l.type)}">${esc(l.type)}</span></td>
            <td><div class="dest" title="${esc(l.destination_url)}">${esc(shortUrl(l.destination_url))}</div></td>
            <td><b>${fmtN(l.click_count)}</b></td>
            <td class="muted">${fmtN(l.unique_visitors)}</td>
            <td class="muted">${fmtDay(l.created_at)}</td>
            <td class="muted">${l.expires_at ? fmtDay(l.expires_at) : 'Never'}</td>
            <td class="muted">${l.campaign_name ? esc(l.campaign_name) : '—'}</td>
            <td><span class="pill ${esc(l.status)}">${esc(l.status)}</span></td>
            <td><div class="actions">
              <button class="icon-btn" title="Copy URL" data-act="copy" data-url="${esc(l.publicUrl)}">📋</button>
              <button class="icon-btn" title="Open" data-act="open" data-url="${esc(l.publicUrl)}">↗️</button>
              <button class="icon-btn" title="Analytics" data-act="analytics" data-id="${esc(l.id)}">📊</button>
              <button class="icon-btn" title="Edit" data-act="edit" data-id="${esc(l.id)}">✏️</button>
              <button class="icon-btn" title="${l.status === 'active' ? 'Disable' : 'Enable'}" data-act="toggle" data-id="${esc(l.id)}">${l.status === 'active' ? '⏸' : '▶️'}</button>
              <button class="icon-btn" title="More" data-act="more" data-id="${esc(l.id)}">⋯</button>
            </div></td>
          </tr>`).join('') : '<tr><td colspan="10"><div class="empty"><div class="big">🔗</div><h3>No links found</h3><p>Create your first link to get started.</p><a class="btn primary" href="/dashboard/links/new">Create Link</a></div></td></tr>'}
      </tbody>
    </table>
    </div>
    ${d.meta.totalPages > 1 ? `<div class="pagination">
      <button class="btn sm" data-page="${d.meta.page - 1}" ${d.meta.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${d.meta.page} of ${d.meta.totalPages} · ${fmtN(d.meta.total)} links</span>
      <button class="btn sm" data-page="${d.meta.page + 1}" ${d.meta.page >= d.meta.totalPages ? 'disabled' : ''}>Next →</button>
    </div>` : `<div class="pagination"><span>${fmtN(d.meta.total)} links</span></div>`}`;

  $$('th.sortable', box).forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    linksState.sort = linksState.sort === key ? (key.endsWith('_asc') ? key.replace('_asc', '') : key + '_asc') : key;
    renderLinksTable();
  }));
  $$('[data-page]', box).forEach((b) => b.addEventListener('click', () => { linksState.page = Number(b.dataset.page); renderLinksTable(); }));
  $$('[data-act]', box).forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (act === 'copy') { await navigator.clipboard.writeText(b.dataset.url).catch(() => {}); toast('URL copied to clipboard', 'success'); }
    else if (act === 'open') window.open(b.dataset.url, '_blank', 'noopener');
    else if (act === 'analytics') navigate(`/dashboard/links/${b.dataset.id}/analytics`);
    else if (act === 'edit') openEditLinkModal(b.dataset.id);
    else if (act === 'toggle') { await api(`/api/links/${b.dataset.id}/toggle`, { method: 'POST' }); toast('Link updated', 'success'); renderLinksTable(); }
    else if (act === 'more') linkMenu(b.dataset.id);
  }));
}

function linkMenu(id) {
  openModal(`
    <h2>Link actions</h2>
    <div class="m-sub">What would you like to do?</div>
    <div class="row wrap">
      <button class="btn" data-go="analytics">📊 Analytics</button>
      <button class="btn" data-go="duplicate">📑 Duplicate</button>
      <button class="btn danger" data-go="delete">🗑 Delete</button>
    </div>`, { onMount: (m) => {
      $$('[data-go]', m).forEach((b) => b.addEventListener('click', async () => {
        closeModal();
        const go = b.dataset.go;
        if (go === 'analytics') navigate(`/dashboard/links/${id}/analytics`);
        if (go === 'duplicate') { const d = await api(`/api/links/${id}/duplicate`, { method: 'POST' }); toast(`Duplicated → ${d.slug}`, 'success'); renderLinksTable(); }
        if (go === 'delete') {
          if (!confirm('Delete this link permanently? This cannot be undone.')) return;
          await api(`/api/links/${id}`, { method: 'DELETE' }); toast('Link deleted', 'success'); renderLinksTable();
        }
      }));
    } });
}

async function pageCreateLink(content) {
  content.innerHTML = '<div class="boot page-boot"><div class="spinner"></div><p>Preparing link builder…</p></div>';

  if (!state.campaigns.length) {
    const campaigns = await api('/api/campaigns', { silent: true }).catch(() => ({ items: [] }));
    state.campaigns = campaigns.items || [];
  }

  content.innerHTML = `
    <div class="create-head">
      <div>
        <a class="back-link" href="/dashboard/links">← Back to links</a>
        <h1>Create a new link</h1>
        <p>Choose how your link behaves, then publish it in one step.</p>
      </div>
      <div class="create-step"><span>1</span> Configure <i></i><span>2</span> Publish</div>
    </div>

    <form id="create-link-form" class="create-layout" novalidate>
      <div class="create-main">
        <section class="builder-card">
          <div class="section-kicker">Link type</div>
          <h2>How should this link open?</h2>
          <div class="type-picker" role="radiogroup" aria-label="Link type">
            <label class="type-option selected">
              <input type="radio" name="linkType" value="track" checked>
              <span class="type-icon blue">↗</span>
              <span><b>Tracked redirect</b><small>Redirect instantly and collect full click analytics.</small><code>/track/</code></span>
              <em>✓</em>
            </label>
            <label class="type-option">
              <input type="radio" name="linkType" value="short">
              <span class="type-icon cyan">⚡</span>
              <span><b>Short link</b><small>A compact redirect for sharing anywhere.</small><code>/r/</code></span>
              <em>✓</em>
            </label>
            <label class="type-option">
              <input type="radio" name="linkType" value="landing">
              <span class="type-icon violet">▣</span>
              <span><b>Landing page</b><small>Show a branded page before visitors continue.</small><code>/go/</code></span>
              <em>✓</em>
            </label>
          </div>
        </section>

        <section class="builder-card">
          <div class="section-kicker">Destination</div>
          <h2>Where should visitors go?</h2>
          <div class="field">
            <label for="cl-dest">Destination URL <strong>*</strong></label>
            <div class="input-with-icon"><span>🌐</span><input type="url" id="cl-dest" placeholder="https://example.com/your-page" autocomplete="url" required></div>
            <div class="err" id="cl-dest-error"></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="cl-slug">Custom slug</label><div class="slug-input"><span id="cl-prefix">/track/</span><input type="text" id="cl-slug" placeholder="auto-generated" maxlength="64"></div><div class="hint">Leave blank for a secure random slug.</div><div class="err" id="cl-slug-error"></div></div>
            <div class="field"><label for="cl-title">Internal title</label><input type="text" id="cl-title" placeholder="e.g. Summer campaign" maxlength="200"><div class="hint">Only visible inside your dashboard.</div></div>
          </div>
        </section>

        <section class="builder-card landing-fields" id="cl-landing" hidden>
          <div class="section-kicker">Landing page</div>
          <h2>Customize the visitor experience</h2>
          <div class="field"><label for="cl-desc">Description</label><textarea id="cl-desc" placeholder="Tell visitors what they will find after continuing…" maxlength="1000"></textarea></div>
          <div class="form-row">
            <div class="field"><label for="cl-btn">Button text</label><input type="text" id="cl-btn" value="Continue" maxlength="80"></div>
            <div class="field"><label for="cl-delay">Automatic redirect delay</label><div class="input-suffix"><input type="number" id="cl-delay" value="0" min="0" max="300"><span>seconds</span></div></div>
          </div>
        </section>

        <section class="builder-card">
          <div class="section-kicker">Options</div>
          <h2>Organize and control</h2>
          <div class="form-row">
            <div class="field"><label for="cl-campaign">Campaign</label><select id="cl-campaign"><option value="">No campaign</option>${state.campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
            <div class="field"><label for="cl-exp">Expiration</label><input type="datetime-local" id="cl-exp"><div class="hint">Optional — the link stops working after this time.</div></div>
          </div>
          <label class="status-switch"><input type="checkbox" id="cl-active" checked><span></span><b>Publish as active</b><small>Visitors can use the link immediately.</small></label>
        </section>
      </div>

      <aside class="create-side">
        <div class="preview-card">
          <div class="preview-top"><span>Live preview</span><span class="live-dot">● Ready</span></div>
          <div class="preview-icon" id="preview-icon">↗</div>
          <h3 id="preview-title">Tracked redirect</h3>
          <p id="preview-description">Visitors go straight to your destination while every click is measured.</p>
          <div class="preview-url"><small>Your new link</small><div><span id="preview-base">${esc(location.origin)}/track/</span><b id="preview-slug">random-slug</b></div></div>
          <div class="preview-destination"><span>→</span><div><small>Redirects to</small><strong id="preview-dest">Add a destination URL</strong></div></div>
        </div>
        <div class="publish-card">
          <div class="form-error" id="cl-form-error" hidden></div>
          <button class="btn primary lg publish-btn" id="cl-submit" type="submit"><span>＋</span> Create link</button>
          <p>You can edit, pause, or delete this link anytime.</p>
        </div>
      </aside>
    </form>`;

  const form = $('#create-link-form', content);
  const typeInfo = {
    track: { prefix: '/track/', icon: '↗', title: 'Tracked redirect', description: 'Visitors go straight to your destination while every click is measured.' },
    short: { prefix: '/r/', icon: '⚡', title: 'Short link', description: 'A clean, compact URL that redirects visitors instantly.' },
    landing: { prefix: '/go/', icon: '▣', title: 'Landing page', description: 'Visitors see your custom landing page before continuing.' },
  };

  const selectedType = () => $('input[name="linkType"]:checked', form).value;
  const updatePreview = () => {
    const type = selectedType();
    const info = typeInfo[type];
    $$('.type-option', form).forEach((option) => option.classList.toggle('selected', $('input', option).checked));
    $('#cl-prefix', form).textContent = info.prefix;
    $('#preview-base', form).textContent = location.origin + info.prefix;
    $('#preview-icon', form).textContent = info.icon;
    $('#preview-title', form).textContent = info.title;
    $('#preview-description', form).textContent = info.description;
    $('#preview-slug', form).textContent = $('#cl-slug', form).value.trim() || 'random-slug';
    $('#cl-landing', form).hidden = type !== 'landing';
  };

  $$('input[name="linkType"]', form).forEach((radio) => radio.addEventListener('change', updatePreview));
  $('#cl-slug', form).addEventListener('input', updatePreview);
  $('#cl-dest', form).addEventListener('input', () => {
    const value = $('#cl-dest', form).value.trim();
    $('#preview-dest', form).textContent = value ? shortUrl(value) : 'Add a destination URL';
    $('#cl-dest-error', form).textContent = '';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const destinationUrl = $('#cl-dest', form).value.trim();
    const slug = $('#cl-slug', form).value.trim();
    const destinationError = $('#cl-dest-error', form);
    const slugError = $('#cl-slug-error', form);
    const formError = $('#cl-form-error', form);
    destinationError.textContent = '';
    slugError.textContent = '';
    formError.hidden = true;

    try {
      const parsed = new URL(destinationUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      destinationError.textContent = 'Enter a complete URL beginning with http:// or https://';
      $('#cl-dest', form).focus();
      return;
    }
    if (slug && !/^[A-Za-z0-9_-]{2,64}$/.test(slug)) {
      slugError.textContent = 'Use 2–64 letters, numbers, hyphens, or underscores.';
      $('#cl-slug', form).focus();
      return;
    }

    const body = {
      destinationUrl,
      type: selectedType(),
      slug,
      title: $('#cl-title', form).value.trim() || null,
      campaignId: $('#cl-campaign', form).value || null,
      status: $('#cl-active', form).checked ? 'active' : 'disabled',
    };
    if (body.type === 'landing') {
      body.description = $('#cl-desc', form).value.trim() || null;
      body.buttonText = $('#cl-btn', form).value.trim() || null;
      body.delaySeconds = Number($('#cl-delay', form).value || 0);
    }
    const expires = $('#cl-exp', form).value;
    if (expires) body.expiresAt = Math.floor(new Date(expires).getTime() / 1000);

    const button = $('#cl-submit', form);
    button.disabled = true;
    button.innerHTML = '<span class="mini-spinner"></span> Creating link…';
    try {
      const link = await api('/api/links', { method: 'POST', body, silent: true });
      showCreatedLink(content, link);
    } catch (error) {
      const message = error?.message || 'Could not create the link. Please try again.';
      formError.textContent = message;
      formError.hidden = false;
      if (error?.status === 409) {
        slugError.textContent = message;
        $('#cl-slug', form).focus();
      }
      button.disabled = false;
      button.innerHTML = '<span>＋</span> Create link';
    }
  });

  updatePreview();
  $('#cl-dest', form).focus();
}

function showCreatedLink(content, link) {
  content.innerHTML = `
    <div class="created-wrap">
      <div class="created-card">
        <div class="success-mark"><span>✓</span></div>
        <div class="success-kicker">Link published</div>
        <h1>Your link is ready!</h1>
        <p>Copy it now or open it to make sure everything looks right.</p>
        <div class="created-url">
          <div><small>Public URL</small><strong>${esc(link.publicUrl)}</strong></div>
          <button class="btn primary" id="created-copy">📋 Copy link</button>
        </div>
        <div class="created-route"><span class="pill ${esc(link.type)}">${esc(link.type)}</span><span>Redirects to</span><b>${esc(shortUrl(link.destination_url))}</b></div>
        <div class="created-actions">
          <a class="btn" href="/dashboard/links">View all links</a>
          <a class="btn" href="/dashboard/links/${esc(link.id)}/analytics">View analytics</a>
          <button class="btn primary" id="created-open">Open link ↗</button>
        </div>
        <a class="create-another" href="/dashboard/links/new">＋ Create another link</a>
      </div>
    </div>`;
  $('#created-copy', content).addEventListener('click', async () => {
    await navigator.clipboard.writeText(link.publicUrl).catch(() => {});
    $('#created-copy', content).textContent = '✓ Copied';
    toast('Link copied to clipboard', 'success');
  });
  $('#created-open', content).addEventListener('click', () => window.open(link.publicUrl, '_blank', 'noopener'));
}

async function openEditLinkModal(id) {
  const l = await api(`/api/links/${id}`);
  openModal(`
    <h2>Edit link</h2>
    <div class="m-sub"><span class="mono">/${esc(l.type)}/${esc(l.slug)}</span></div>
    <div class="field"><label>Destination URL</label><input type="url" id="el-dest" value="${esc(l.destination_url)}"></div>
    <div class="form-row">
      <div class="field"><label>Title</label><input type="text" id="el-title" value="${esc(l.title || '')}"></div>
      <div class="field"><label>Campaign</label><select id="el-campaign"><option value="">— None —</option>${state.campaigns.map((c) => `<option value="${esc(c.id)}" ${l.campaign_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    </div>
    ${l.type === 'landing' ? `<div class="form-row">
      <div class="field"><label>Button text</label><input type="text" id="el-btn" value="${esc(l.button_text || '')}"></div>
      <div class="field"><label>Delay (s)</label><input type="number" id="el-delay" value="${esc(l.delay_seconds || 0)}" min="0" max="300"></div>
    </div>` : ''}
    <div class="form-row">
      <div class="field"><label>Expiration</label><input type="datetime-local" id="el-exp" value="${l.expires_at ? toLocalInput(l.expires_at) : ''}"></div>
      <div class="field"><label>Status</label><select id="el-status">
        <option value="active" ${l.status === 'active' ? 'selected' : ''}>Active</option>
        <option value="disabled" ${l.status === 'disabled' ? 'selected' : ''}>Disabled</option>
        <option value="archived" ${l.status === 'archived' ? 'selected' : ''}>Archived</option>
      </select></div>
    </div>
    <div class="m-foot">
      <button class="btn ghost" id="el-cancel">Cancel</button>
      <button class="btn primary" id="el-submit">Save</button>
    </div>`, { onMount: (m) => {
      $('#el-cancel', m).addEventListener('click', closeModal);
      $('#el-submit', m).addEventListener('click', async () => {
        const body = {
          destinationUrl: $('#el-dest', m).value.trim(),
          title: $('#el-title', m).value.trim() || null,
          campaignId: $('#el-campaign', m).value || null,
          status: $('#el-status', m).value,
        };
        if (l.type === 'landing') { body.buttonText = $('#el-btn', m).value.trim() || null; body.delaySeconds = Number($('#el-delay', m).value || 0); }
        const exp = $('#el-exp', m).value;
        body.expiresAt = exp ? Math.floor(new Date(exp).getTime() / 1000) : null;
        const btn = $('#el-submit', m);
        btn.disabled = true; btn.textContent = 'Saving…';
        try { await api(`/api/links/${id}`, { method: 'PUT', body }); closeModal(); toast('Link updated', 'success'); renderLinksTable(); }
        catch { btn.disabled = false; btn.textContent = 'Save'; }
      });
    } });
}

function toLocalInput(ts) {
  const d = new Date(Number(ts) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- page: link analytics ---------------- */
async function pageLinkAnalytics(content, id) {
  content.innerHTML = '<div class="boot"><div class="spinner"></div><p>Loading analytics…</p></div>';
  const ranges = [
    ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time'],
  ];
  let range = '30d';
  let data = null;

  async function load() {
    const d = await api(`/api/links/${id}/analytics?range=${range}`);
    data = d;
    render();
  }

  function render() {
    const l = data.link;
    content.innerHTML = `
      <div class="row between wrap">
        <div style="min-width:0">
          <h2 style="margin:0 0 4px">${esc(l.title || `${l.type}/${l.slug}`)}</h2>
          <div class="muted mono" style="word-break:break-all">${esc(l.destination_url)}</div>
        </div>
        <div class="row wrap">
          <div class="seg">${ranges.map(([k, lab]) => `<button data-r="${k}" class="${range === k ? 'active' : ''}">${lab}</button>`).join('')}</div>
          <a class="btn" href="/dashboard/links">← Links</a>
        </div>
      </div>
      <div class="grid stats mt-16">
        <div class="stat"><div class="label">Clicks (range)</div><div class="value">${fmtN(data.totals.clicks)}</div></div>
        <div class="stat"><div class="label">Unique (range)</div><div class="value">${fmtN(data.totals.uniques)}</div></div>
        <div class="stat"><div class="label">All-time clicks</div><div class="value">${fmtN(l.click_count)}</div></div>
        <div class="stat"><div class="label">All-time unique</div><div class="value">${fmtN(l.unique_visitors)}</div></div>
      </div>
      <div class="card mt-16">
        <h3>Clicks over time</h3>
        ${lineChart(data.series)}
      </div>
      <div class="grid cols-2 mt-16">
        <div class="card"><h3>Clicks by hour (UTC)</h3>${barChart(data.hourly.map((h) => ({ label: h.label, value: h.clicks })), { height: 130 })}</div>
        <div class="card"><h3>Devices</h3>${hbars(data.devices)}</div>
      </div>
      <div class="grid cols-2 mt-16">
        <div class="card"><h3>Browsers</h3>${hbars(data.browsers)}</div>
        <div class="card"><h3>Operating systems</h3>${hbars(data.os)}</div>
      </div>
      <div class="grid cols-2 mt-16">
        <div class="card"><h3>Countries</h3>${hbars(data.countries)}</div>
        <div class="card"><h3>Referrers</h3>${hbars(data.referrers)}</div>
      </div>
      <div class="card mt-16">
        <h3>Recent events</h3>
        ${data.recent.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Time</th><th>Country</th><th>Device</th><th>Browser</th><th>OS</th><th>Referrer</th></tr></thead>
          <tbody>${data.recent.map((r) => `<tr><td class="muted">${fmtTimeAgo(r.timestamp)}</td><td>${esc(r.country || '—')}</td><td>${esc(r.device || '—')}</td><td>${esc(r.browser || '—')}</td><td>${esc(r.os || '—')}</td><td class="muted">${esc(r.referrer || '—')}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty">No clicks in this range yet.</div>'}
      </div>`;
    $$('[data-r]', content).forEach((b) => b.addEventListener('click', () => { range = b.dataset.r; load(); }));
  }

  await load();
}

/* ---------------- page: campaigns ---------------- */
async function pageCampaigns(content) {
  const createOpen = new URLSearchParams(location.search).get('new') === '1';
  content.innerHTML = `
    <div class="row between">
      <h2 style="margin:0">Campaigns</h2>
      <button class="btn primary" id="newCampaign">＋ Create Campaign</button>
    </div>
    <div class="card mt-16" id="campList"><div class="boot"><div class="spinner"></div></div></div>`;
  $('#newCampaign').addEventListener('click', openCreateCampaignModal);

  const d = await api('/api/campaigns');
  state.campaigns = d.items || [];
  const list = $('#campList');
  list.innerHTML = d.items.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Status</th><th>Emails</th><th>Sent</th><th>Delivered</th><th>Opened</th><th>Clicked</th><th>Bounced</th><th>Link clicks</th><th>Created</th><th></th></tr></thead>
      <tbody>${d.items.map((c) => `
        <tr data-id="${esc(c.id)}" style="cursor:pointer">
          <td><b>${esc(c.name)}</b>${c.description ? `<div class="muted">${esc(c.description)}</div>` : ''}</td>
          <td><span class="pill ${esc(c.status)}">${esc(c.status)}</span></td>
          <td>${fmtN(c.stats.emailsSent)}</td>
          <td>${fmtN(c.stats.emailsSent)}</td>
          <td>${fmtN(c.stats.delivered)}</td>
          <td>${fmtN(c.stats.opened)}</td>
          <td>${fmtN(c.stats.clicked)}</td>
          <td>${fmtN(c.stats.bounced)}</td>
          <td><b>${fmtN(c.stats.linkClicks)}</b></td>
          <td class="muted">${fmtDay(c.created_at)}</td>
          <td><button class="icon-btn" data-act="del" title="Delete">🗑</button></td>
        </tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty"><div class="big">📣</div><h3>No campaigns yet</h3><p>Group links and emails into campaigns.</p></div>';

  $$('tr[data-id]', list).forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="del"]')) return;
    navigate(`/dashboard/campaigns/${tr.dataset.id}`);
  }));
  $$('[data-act="del"]', list).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this campaign? Its links and emails are kept.')) return;
    await api(`/api/campaigns/${b.closest('tr').dataset.id}`, { method: 'DELETE' });
    toast('Campaign deleted', 'success');
    pageCampaigns(content);
  }));

  if (createOpen) openCreateCampaignModal();
}

function openCreateCampaignModal() {
  openModal(`
    <h2>Create campaign</h2>
    <div class="m-sub">Group emails and links into a campaign.</div>
    <div class="field"><label>Name</label><input type="text" id="c-name" placeholder="School Update"></div>
    <div class="field"><label>Description</label><textarea id="c-desc" placeholder="Optional"></textarea></div>
    <div class="m-foot">
      <button class="btn ghost" id="c-cancel">Cancel</button>
      <button class="btn primary" id="c-submit">Create</button>
    </div>`, { onMount: (m) => {
      $('#c-cancel', m).addEventListener('click', closeModal);
      $('#c-submit', m).addEventListener('click', async () => {
        const name = $('#c-name', m).value.trim();
        if (!name) { toast('Name is required', 'warn'); return; }
        await api('/api/campaigns', { method: 'POST', body: { name, description: $('#c-desc', m).value.trim() || null } });
        closeModal();
        toast('Campaign created', 'success');
        navigate('/dashboard/campaigns');
      });
    } });
}

async function pageCampaignDetail(content, id) {
  content.innerHTML = '<div class="boot"><div class="spinner"></div><p>Loading campaign…</p></div>';
  const d = await api(`/api/campaigns/${id}`);
  const s = d.stats;
  content.innerHTML = `
    <div class="row between wrap">
      <div><h2 style="margin:0 0 4px">${esc(d.name)}</h2>
      <div class="muted">${esc(d.description || 'No description')}</div></div>
      <a class="btn" href="/dashboard/campaigns">← Campaigns</a>
    </div>
    <div class="grid stats mt-16">
      <div class="stat"><div class="label">Emails</div><div class="value">${fmtN(s.emailsSent)}</div></div>
      <div class="stat"><div class="label">Delivered</div><div class="value green">${fmtN(s.delivered)}</div></div>
      <div class="stat"><div class="label">Opened</div><div class="value amber">${fmtN(s.opened)}</div></div>
      <div class="stat"><div class="label">Clicked</div><div class="value violet">${fmtN(s.clicked)}</div></div>
      <div class="stat"><div class="label">Bounced</div><div class="value" style="color:var(--red)">${fmtN(s.bounced)}</div></div>
      <div class="stat"><div class="label">Tracked-link clicks</div><div class="value cyan">${fmtN(s.linkClicks)}</div></div>
    </div>
    <div class="card mt-16">
      <h3>Links in campaign</h3>
      ${d.links.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Slug</th><th>Type</th><th>Destination</th><th>Clicks</th><th>Unique</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.links.map((l) => `<tr>
          <td><span class="mono">${esc(l.slug)}</span></td>
          <td><span class="pill ${esc(l.type)}">${esc(l.type)}</span></td>
          <td><div class="dest" title="${esc(l.destination_url)}">${esc(shortUrl(l.destination_url))}</div></td>
          <td><b>${fmtN(l.click_count)}</b></td><td class="muted">${fmtN(l.unique_visitors)}</td>
          <td><span class="pill ${esc(l.status)}">${esc(l.status)}</span></td>
          <td><a href="/dashboard/links/${esc(l.id)}/analytics">Analytics</a></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No links in this campaign yet.</div>'}
    </div>
    <div class="card mt-16">
      <h3>Emails</h3>
      ${d.emails.length ? `<div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>Recipient</th><th>Subject</th><th>Status</th><th>Sent</th><th></th></tr></thead>
        <tbody>${d.emails.map((e) => `<tr>
          <td><span class="mono">#${esc(e.id)}</span></td>
          <td>${esc(e.recipient)}</td>
          <td><div class="dest">${esc(e.subject)}</div></td>
          <td><span class="pill ${esc(e.status)}">${esc(e.status)}</span></td>
          <td class="muted">${e.sent_at ? fmtDate(e.sent_at) : '—'}</td>
          <td><a href="/dashboard/mail/${esc(e.id)}">Detail</a></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No emails in this campaign yet.</div>'}
    </div>`;
}

/* ---------------- page: mail compose ---------------- */
async function pageMailCompose(content) {
  const [settings, campaigns] = await Promise.all([api('/api/settings'), api('/api/campaigns').catch(() => ({ items: [] }))]);
  state.settings = settings;
  state.campaigns = campaigns.items || [];
  content.innerHTML = `
    <h2 style="margin:0 0 4px">Compose email</h2>
    <div class="muted" style="margin-bottom:16px">Transactional email via Brevo — content stays server-side, nothing is exposed to the browser.</div>
    <div class="grid cols-2">
      <div>
        <div class="card">
          <div class="field"><label>To (comma or newline separated)</label><textarea id="m-to" rows="2" placeholder="parent@example.com&#10;teacher@example.com"></textarea></div>
          <div class="field"><label>Subject</label><input type="text" id="m-subject" placeholder="School Update — Week 1"></div>
          <div class="form-row">
            <div class="field"><label>Sender email</label><input type="email" id="m-sender" value="${esc(settings.brevoSenderEmail)}" placeholder="no-reply@…"></div>
            <div class="field"><label>Sender name</label><input type="text" id="m-sender-name" value="${esc(settings.brevoSenderName)}"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Reply-to</label><input type="email" id="m-reply" placeholder="Optional"></div>
            <div class="field"><label>Campaign</label><select id="m-campaign"><option value="">— None —</option>${state.campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Schedule (optional)</label><input type="datetime-local" id="m-schedule"></div>
          <div class="field"><label class="check"><input type="checkbox" id="m-track" ${settings.defaultTracking ? 'checked' : ''}> Track links — rewrite URLs into /track/:slug links</label></div>
        </div>
        <div class="card mt-16">
          <div class="row between"><h3>HTML body</h3><button class="btn sm" id="m-html-help">HTML quick help</button></div>
          <textarea class="html" id="m-html" rows="12" placeholder="<p>Hello,</p><p>See <a href='https://example.com/notice'>the notice</a>.</p>"></textarea>
          <div class="field mt-8"><label>Plain-text fallback</label><textarea id="m-text" rows="3" placeholder="Hello, see the notice: https://example.com/notice"></textarea></div>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Preview</h3>
          <div class="m-sub">Click "Preview" to render the email with tracked links.</div>
          <div id="m-preview"><div class="empty"><div class="big">👁️</div><p>Nothing to preview yet.</p></div></div>
        </div>
        <div class="card mt-16">
          <h3>Actions</h3>
          <div class="row wrap">
            <button class="btn primary" id="m-send">🚀 Send</button>
            <button class="btn" id="m-test">🧪 Send test</button>
            <button class="btn" id="m-preview-btn">👁️ Preview</button>
            <button class="btn" id="m-draft">💾 Save draft</button>
          </div>
          <div class="muted mt-8" id="m-draft-info"></div>
        </div>
      </div>
    </div>`;

  let draftId = null;

  function payload() {
    return {
      to: $('#m-to').value,
      subject: $('#m-subject').value,
      htmlContent: $('#m-html').value,
      textContent: $('#m-text').value,
      senderEmail: $('#m-sender').value.trim() || undefined,
      senderName: $('#m-sender-name').value.trim() || undefined,
      replyTo: $('#m-reply').value.trim() || undefined,
      campaignId: $('#m-campaign').value || null,
      trackLinks: $('#m-track').checked,
      scheduledAt: $('#m-schedule').value ? new Date($('#m-schedule').value).toISOString() : undefined,
      draftId,
    };
  }

  $('#m-html-help').addEventListener('click', () => toast('Tip: use <a href="URL">text</a> for links — tracked links only apply to http(s) URLs.', 'info', 5000));

  $('#m-preview-btn').addEventListener('click', async () => {
    const btn = $('#m-preview-btn');
    btn.disabled = true;
    try {
      const d = await api('/api/mail/preview', { method: 'POST', body: payload() });
      draftId = d.email.id;
      $('#m-draft-info').textContent = `Draft #${d.email.id} — ${d.trackedLinks.length} URL(s) tracked.`;
      $('#m-preview').innerHTML = `
        <div class="m-sub" style="margin-bottom:10px">#${esc(d.email.id)} → ${esc(d.email.recipient)} · ${esc(d.email.subject)}</div>
        <div class="card" style="background:var(--bg);border-radius:8px;padding:14px;max-height:420px;overflow:auto">
          ${d.transformedHtml || d.email.html_content || '<p class="muted">No HTML content.</p>'}
        </div>
        ${d.trackedLinks.length ? `<div class="m-sub mt-8">Tracked links:</div>${d.trackedLinks.map((t) => `<div class="url-box mt-8" data-copy="${esc(t.finalUrl)}">${esc(t.finalUrl)}<button class="copy icon-btn">📋</button></div>`).join('')}` : ''}`;
      $$('[data-copy]', content).forEach((box) => box.addEventListener('click', async () => { await navigator.clipboard.writeText(box.dataset.copy).catch(() => {}); toast('Copied', 'success'); }));
      toast('Preview ready — draft saved', 'success');
    } catch { /* toast shown by api() */ }
    btn.disabled = false;
  });

  $('#m-draft').addEventListener('click', async () => {
    const btn = $('#m-draft');
    btn.disabled = true;
    try {
      const d = await api('/api/mail/drafts', { method: 'POST', body: payload() });
      draftId = d.email.id;
      $('#m-draft-info').textContent = `Draft #${d.email.id} saved (${d.trackedLinks.length} tracked links).`;
      toast('Draft saved', 'success');
    } catch { /* shown */ }
    btn.disabled = false;
  });

  $('#m-send').addEventListener('click', async () => {
    const btn = $('#m-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const d = await api('/api/mail/send', { method: 'POST', body: payload() });
      if (d.scheduled) toast(`Scheduled for ${new Date($('#m-schedule').value).toLocaleString()}`, 'success', 6000);
      else toast(`Sent to ${d.emails.length} recipient(s) — ${d.trackedLinks.length} tracked links`, 'success', 6000);
      setTimeout(() => { navigate('/dashboard/mail/history'); }, 900);
    } catch (err) {
      if (err.status === 502) { $('#m-draft-info').textContent = 'Brevo rejected the send — see Mail History for the failed record.'; }
      btn.disabled = false; btn.textContent = '🚀 Send';
    }
  });

  $('#m-test').addEventListener('click', async () => {
    const btn = $('#m-test');
    btn.disabled = true;
    try {
      const d = await api('/api/mail/test', { method: 'POST', body: payload() });
      toast(`Test email sent (${d.messageIds.length} message id(s))`, 'success');
    } catch { /* shown */ }
    btn.disabled = false;
  });
}

/* ---------------- page: mail history ---------------- */
let mailState = { page: 1, search: '', status: '', perPage: 20 };

async function pageMailHistory(content) {
  content.innerHTML = `
    <h2 style="margin:0 0 14px">Mail history</h2>
    <div class="row wrap">
      <input type="search" id="mh-s" placeholder="Search subject, recipient, id…" value="${esc(mailState.search)}" style="max-width:260px">
      <select id="mh-st"><option value="">All statuses</option>
        ${['draft','queued','scheduled','sent','delivered','opened','clicked','hard_bounce','soft_bounce','blocked','invalid','error','unsubscribed','failed'].map((s) => `<option value="${s}" ${mailState.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="card mt-16" id="mh-list"><div class="boot"><div class="spinner"></div></div></div>`;
  $('#mh-s').addEventListener('input', debounce(() => { mailState.search = $('#mh-s').value.trim(); mailState.page = 1; renderMailHistory(); }, 300));
  $('#mh-st').addEventListener('change', () => { mailState.status = $('#mh-st').value; mailState.page = 1; renderMailHistory(); });
  await renderMailHistory();
}

async function renderMailHistory() {
  const box = $('#mh-list');
  box.innerHTML = '<div class="boot"><div class="spinner"></div></div>';
  const sp = new URLSearchParams({ page: mailState.page, perPage: mailState.perPage });
  if (mailState.search) sp.set('search', mailState.search);
  if (mailState.status) sp.set('status', mailState.status);
  const d = await api('/api/mail/history?' + sp.toString());
  box.innerHTML = `
    ${d.items.length ? `<div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Recipient</th><th>Subject</th><th>Status</th><th>Opens</th><th>Clicks</th><th>Sent</th><th></th></tr></thead>
      <tbody>${d.items.map((e) => `
        <tr data-id="${esc(e.id)}" style="cursor:pointer">
          <td><span class="mono">#${esc(e.id)}</span></td>
          <td>${esc(e.recipient)}</td>
          <td><div class="dest">${esc(e.subject)}</div>${e.campaign_name ? `<div class="muted">📣 ${esc(e.campaign_name)}</div>` : ''}</td>
          <td><span class="pill ${esc(e.status)}">${esc(e.status)}</span></td>
          <td>${fmtN(e.opens)}</td><td>${fmtN(e.clicks)}</td>
          <td class="muted">${e.sent_at ? fmtTimeAgo(e.sent_at) : '—'}</td>
          <td>${e.status === 'draft' ? `<button class="icon-btn" data-act="del" title="Delete draft">🗑</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><div class="big">🗂️</div><h3>No emails yet</h3><p>Compose your first email to see delivery history here.</p><a class="btn primary" href="/dashboard/mail">Compose Email</a></div>'}
    ${d.meta.totalPages > 1 ? `<div class="pagination">
      <button class="btn sm" data-page="${d.meta.page - 1}" ${d.meta.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${d.meta.page} of ${d.meta.totalPages}</span>
      <button class="btn sm" data-page="${d.meta.page + 1}" ${d.meta.page >= d.meta.totalPages ? 'disabled' : ''}>Next →</button>
    </div>` : ''}`;
  $$('tr[data-id]', box).forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="del"]')) return;
    navigate(`/dashboard/mail/${tr.dataset.id}`);
  }));
  $$('[data-act="del"]', box).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this draft and its tracked links?')) return;
    await api(`/api/mail/${b.closest('tr').dataset.id}`, { method: 'DELETE' });
    toast('Draft deleted', 'success');
    renderMailHistory();
  }));
  $$('[data-page]', box).forEach((b) => b.addEventListener('click', () => { mailState.page = Number(b.dataset.page); renderMailHistory(); }));
}

/* ---------------- page: mail detail ---------------- */
async function pageMailDetail(content, id) {
  content.innerHTML = '<div class="boot"><div class="spinner"></div><p>Loading email…</p></div>';
  const d = await api(`/api/mail/${id}`);
  const e = d.email;
  const EVENTS = { sent: '📤', delivered: '✅', opened: '👁️', click: '🖱️', uniqueOpened: '👁️', softBounce: '⚠️', hardBounce: '❌', blocked: '🚫', spam: '🚫', invalid: '❌', deferred: '⏳', unsubscribed: '🚷', error: '💥', request: '📤' };
  content.innerHTML = `
    <a class="btn ghost" href="/dashboard/mail/history">← Mail history</a>
    <div class="card mt-16">
      <div class="row between wrap">
        <div style="min-width:0">
          <h2 style="margin:0 0 4px">${esc(e.subject)}</h2>
          <div class="muted mono">#${esc(e.id)}</div>
        </div>
        <span class="pill ${esc(e.status)}">${esc(e.status)}</span>
      </div>
      <dl class="kv mt-16">
        <dt>Recipient</dt><dd>${esc(e.recipient)}</dd>
        <dt>Sender</dt><dd>${esc(e.sender_name ? `${e.sender_name} <${e.sender_email}>` : e.sender_email)}</dd>
        <dt>Reply-to</dt><dd>${esc(e.reply_to || '—')}</dd>
        <dt>Campaign</dt><dd>${e.campaign_name ? esc(e.campaign_name) : '—'}</dd>
        <dt>Brevo message ID</dt><dd class="mono">${esc(e.brevo_message_id || '—')}</dd>
        <dt>Created</dt><dd>${fmtDate(e.created_at)}</dd>
        <dt>Sent</dt><dd>${e.sent_at ? fmtDate(e.sent_at) : '—'}</dd>
        <dt>Error</dt><dd>${e.error ? esc(e.error) : '—'}</dd>
      </dl>
    </div>
    <div class="grid cols-2 mt-16">
      <div class="card">
        <h3>Event timeline</h3>
        ${d.events.length ? `<ul class="timeline">${d.events.map((ev) => `
          <li><div class="t-title">${esc(EVENTS[ev.event_type] || '🔔')} ${esc(ev.event_type)}</div>
          <div class="t-time">${fmtDate(ev.event_timestamp)}${ev.url ? ` · <span class="mono">${esc(shortUrl(ev.url))}</span>` : ''}</div></li>`).join('')}</ul>`
          : '<div class="empty">No events received yet. Webhooks will appear here.</div>'}
      </div>
      <div>
        <div class="card">
          <h3>Tracked links</h3>
          ${d.trackedLinks.length ? d.trackedLinks.map((l) => `
            <div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border)">
              <div style="min-width:0">
                <div class="mono" style="word-break:break-all">/track/${esc(l.slug)}</div>
                <div class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shortUrl(l.destination_url))}</div>
              </div>
              <div class="row"><span class="muted">${fmtN(l.click_count)} clicks</span>
              <a class="icon-btn" href="/dashboard/links/${esc(l.id)}/analytics">📊</a></div>
            </div>`).join('') : '<div class="empty">No tracked links.</div>'}
        </div>
        <div class="card mt-16">
          <h3>HTML content</h3>
          <div class="card" style="background:var(--bg);max-height:300px;overflow:auto;padding:14px">${e.html_content || '<p class="muted">No HTML content.</p>'}</div>
        </div>
      </div>
    </div>`;
}

/* ---------------- page: global analytics ---------------- */
async function pageAnalytics(content) {
  content.innerHTML = '<div class="boot"><div class="spinner"></div><p>Loading analytics…</p></div>';
  let range = '30d';
  const ranges = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']];
  async function load() {
    const d = await api(`/api/analytics?range=${range}`);
    content.innerHTML = `
      <div class="row between wrap">
        <h2 style="margin:0">Analytics</h2>
        <div class="seg">${ranges.map(([k, lab]) => `<button data-r="${k}" class="${range === k ? 'active' : ''}">${lab}</button>`).join('')}</div>
      </div>
      <div class="grid stats mt-16">
        <div class="stat"><div class="label">Clicks</div><div class="value">${fmtN(d.totals.clicks)}</div></div>
        <div class="stat"><div class="label">Unique visitors</div><div class="value">${fmtN(d.totals.uniques)}</div></div>
        <div class="stat"><div class="label">Emails sent</div><div class="value">${fmtN(d.email.sent)}</div></div>
        <div class="stat"><div class="label">Delivery</div><div class="value green">${fmtN(d.email.delivered)}</div></div>
        <div class="stat"><div class="label">Opened</div><div class="value amber">${fmtN(d.email.opened)}</div></div>
        <div class="stat"><div class="label">Clicked</div><div class="value violet">${fmtN(d.email.clicked)}</div></div>
      </div>
      <div class="card mt-16"><h3>Click activity</h3>${lineChart(d.series)}</div>
      <div class="card mt-16">
        <h3>Top links</h3>
        ${d.topLinks.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Slug</th><th>Type</th><th>Destination</th><th>Clicks</th><th>Unique</th><th>Campaign</th><th></th></tr></thead>
          <tbody>${d.topLinks.map((l) => `<tr>
            <td><span class="mono">${esc(l.slug)}</span></td>
            <td><span class="pill ${esc(l.type)}">${esc(l.type)}</span></td>
            <td><div class="dest" title="${esc(l.destination_url)}">${esc(shortUrl(l.destination_url))}</div></td>
            <td><b>${fmtN(l.click_count)}</b></td><td class="muted">${fmtN(l.unique_visitors)}</td>
            <td class="muted">${esc(l.campaign_name || '—')}</td>
            <td><a href="/dashboard/links/${esc(l.id)}/analytics">📊</a></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No links with clicks yet.</div>'}
      </div>
      <div class="grid cols-2 mt-16">
        <div class="card"><h3>Devices</h3>${hbars(d.devices)}</div>
        <div class="card"><h3>Browsers</h3>${hbars(d.browsers)}</div>
      </div>
      <div class="grid cols-2 mt-16">
        <div class="card"><h3>Operating systems</h3>${hbars(d.os)}</div>
        <div class="card"><h3>Countries</h3>${hbars(d.countries)}</div>
      </div>`;
    $$('[data-r]', content).forEach((b) => b.addEventListener('click', () => { range = b.dataset.r; load(); }));
  }
  await load();
}

/* ---------------- page: settings ---------------- */
async function pageSettings(content) {
  content.innerHTML = '<div class="boot"><div class="spinner"></div><p>Loading settings…</p></div>';
  const [s, brevo] = await Promise.all([api('/api/settings'), api('/api/settings/brevo/status')]);
  content.innerHTML = `
    <h2 style="margin:0 0 16px">Settings</h2>

    <div class="card">
      <h3>General</h3>
      <div class="form-row">
        <div class="field"><label>Site name</label><input type="text" id="s-name" value="${esc(s.siteName)}"></div>
        <div class="field"><label>Default redirect status</label><select id="s-redirect">
          <option value="302" ${s.defaultRedirectStatus === '302' ? 'selected' : ''}>302 Found (temporary, recommended)</option>
          <option value="301" ${s.defaultRedirectStatus === '301' ? 'selected' : ''}>301 Moved Permanently</option>
        </select></div>
      </div>
      <div class="field"><label>Timezone</label><input type="text" id="s-tz" value="${esc(s.timezone)}"><div class="hint">IANA name, e.g. Asia/Ho_Chi_Minh (used for charts and reports).</div></div>
    </div>

    <div class="card mt-16">
      <h3>Brevo</h3>
      <div class="row wrap">
        <span class="chip">API: <b>${brevo.configured ? 'configured' : 'not configured'}</b> ${brevo.keyMasked ? `· ${esc(brevo.keyMasked)}` : ''}</span>
        <span class="chip">Connection: <b style="color:${brevo.account?.connected ? 'var(--green)' : 'var(--red)'}">${brevo.account?.connected ? 'connected' : 'offline'}</b></span>
        <span class="chip">Webhook secret: <b style="color:${brevo.webhookSecretSet ? 'var(--green)' : 'var(--red)'}">${brevo.webhookSecretSet ? 'set' : 'missing'}</b></span>
      </div>
      ${brevo.account?.error ? `<div class="muted mt-8">${esc(brevo.account.error)}</div>` : ''}
      <div class="form-row mt-16">
        <div class="field"><label>Sender email (default)</label><input type="email" id="s-sender" value="${esc(s.brevoSenderEmail)}"></div>
        <div class="field"><label>Sender name (default)</label><input type="text" id="s-sender-name" value="${esc(s.brevoSenderName)}"></div>
      </div>
      <div class="field"><label>Webhook URL</label>
        <div class="url-box" data-copy="${esc(brevo.webhookUrl)}?secret=…">${esc(brevo.webhookUrl)}?secret=<i>your-secret</i><button class="copy icon-btn">📋</button></div>
        <div class="hint">Create a transactional webhook in Brevo with this URL and events: sent, delivered, opened, click, softBounce, hardBounce, blocked, spam, invalid, deferred, unsubscribed.</div>
      </div>
    </div>

    <div class="card mt-16">
      <h3>Tracking &amp; privacy</h3>
      <div class="field"><label class="check"><input type="checkbox" id="s-track" ${s.defaultTracking ? 'checked' : ''}> Track links by default when composing emails</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="s-privacy" ${s.privacyAggregateOnly ? 'checked' : ''}> Aggregate-only mode (never keep recent event detail)</label></div>
      <div class="field"><label>Analytics retention (days)</label><input type="number" id="s-retention" value="${s.analyticsRetentionDays}" min="1" max="3650">
        <div class="hint">Raw click events older than this are pruned automatically. Counters and daily aggregates are kept.</div></div>
    </div>

    <div class="card mt-16">
      <h3>Security</h3>
      <dl class="kv">
        <dt>Session lifetime</dt><dd>${s.sessionDays} days</dd>
        <dt>Login rate limit</dt><dd>${s.loginRateLimit} attempts / window</dd>
        <dt>API rate limit</dt><dd>${s.apiRateLimit} requests / minute per IP</dd>
        <dt>Cookies</dt><dd>HttpOnly · SameSite=Lax · Secure (HTTPS)</dd>
        <dt>CSRF</dt><dd>Per-session token required for all mutations</dd>
        <dt>Password hashing</dt><dd>PBKDF2-SHA256 (100k iterations)</dd>
      </dl>
      <div class="muted">Session and rate-limit values come from environment variables (see README).</div>
    </div>

    <div class="row mt-16" style="justify-content:flex-end">
      <button class="btn primary" id="s-save">Save settings</button>
    </div>`;

  $$('[data-copy]', content).forEach((box) => box.addEventListener('click', async () => { await navigator.clipboard.writeText(box.dataset.copy).catch(() => {}); toast('Copied', 'success'); }));

  $('#s-save').addEventListener('click', async () => {
    const btn = $('#s-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          siteName: $('#s-name').value.trim(),
          defaultRedirectStatus: $('#s-redirect').value,
          timezone: $('#s-tz').value.trim(),
          brevoSenderEmail: $('#s-sender').value.trim(),
          brevoSenderName: $('#s-sender-name').value.trim(),
          defaultTracking: $('#s-track').checked,
          privacyAggregateOnly: $('#s-privacy').checked,
          analyticsRetentionDays: Number($('#s-retention').value || 365),
        },
      });
      toast('Settings saved', 'success');
    } catch { /* shown */ }
    btn.disabled = false; btn.textContent = 'Save settings';
  });
}

/* ---------------- page: login ---------------- */
function pageLogin(content) {
  content.innerHTML = `
    <div style="max-width:380px;margin:8vh auto">
      <div class="card">
        <div class="logo" style="font-size:30px">🔗</div>
        <h2 style="margin:6px 0 4px">Sign in to Link Center</h2>
        <div class="muted" style="margin-bottom:18px">Manage links, analytics and transactional email.</div>
        <div class="field"><label>Username</label><input type="text" id="lg-u" autocomplete="username"></div>
        <div class="field"><label>Password</label><input type="password" id="lg-p" autocomplete="current-password"></div>
        <div class="row"><button class="btn primary lg" id="lg-b" style="flex:1">Sign in</button></div>
        <div class="err" id="lg-e" style="color:var(--red);font-size:12.5px;margin-top:12px;min-height:16px"></div>
      </div>
    </div>`;
  const submit = async () => {
    const err = $('#lg-e');
    err.textContent = '';
    try {
      const d = await api('/api/auth/login', { method: 'POST', body: { username: $('#lg-u').value.trim(), password: $('#lg-p').value }, silent: true });
      state.me = d.user; state.csrf = d.csrfToken;
      navigate('/dashboard');
    } catch (e) { err.textContent = e.message || 'Sign-in failed.'; }
  };
  $('#lg-b').addEventListener('click', submit);
  $('#lg-p').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function navigate(url) {
  const next = url.startsWith('/') ? url : '/' + url;
  const current = location.pathname + location.search;
  if (current !== next) {
    history.pushState(null, '', next);
  }
  route();
}

/* ---------------- router ---------------- */
const routes = [
  { match: (p) => p === '/dashboard' || p === '/dashboard/overview', page: pageOverview },
  { match: (p) => p === '/dashboard/links/new', page: pageCreateLink },
  { match: (p) => p === '/dashboard/links', page: pageLinks },
  { match: (p) => { const m = p.match(/^\/dashboard\/links\/([^/]+)\/analytics$/); return m ? { id: m[1] } : null; }, page: pageLinkAnalytics },
  { match: (p) => p === '/dashboard/campaigns', page: pageCampaigns },
  { match: (p) => { const m = p.match(/^\/dashboard\/campaigns\/([^/]+)$/); return m ? { id: m[1] } : null; }, page: pageCampaignDetail },
  { match: (p) => p === '/dashboard/mail', page: pageMailCompose },
  { match: (p) => p === '/dashboard/mail/history', page: pageMailHistory },
  { match: (p) => { const m = p.match(/^\/dashboard\/mail\/([^/]+)$/); return m ? { id: m[1] } : null; }, page: pageMailDetail },
  { match: (p) => p === '/dashboard/analytics', page: pageAnalytics },
  { match: (p) => p === '/dashboard/settings', page: pageSettings },
];

async function route() {
  const rawPath = location.pathname;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;

  if (path === '/login') {
    $('#app').innerHTML = '<div class="layout"><div class="main"><div class="content" id="content"></div></div></div>';
    pageLogin($('#content'));
    return;
  }
  const content = renderShell(path);
  for (const r of routes) {
    const match = r.match(path);
    // Exact-path matchers return a boolean while parameterized matchers return
    // an object. A false boolean must not select the first (Overview) route.
    if (!match) continue;
    const params = typeof match === 'object' ? match : {};
    try {
      await r.page(content, params.id);
    } catch (err) {
      if (err?.message === 'unauthorized') return;
      content.innerHTML = `<div class="card mt-16" style="border-color:var(--red)"><h3 style="color:var(--red)">Failed to load page</h3><p class="muted">${esc(err?.message || 'An unexpected error occurred.')}</p><button class="btn mt-8" id="route-retry">Retry</button></div>`;
      const retryBtn = $('#route-retry', content);
      if (retryBtn) retryBtn.addEventListener('click', () => route());
    }
    return;
  }
  content.innerHTML = '<div class="empty"><div class="big">404</div><h3>Page not found</h3><a class="btn" href="/dashboard">Back to dashboard</a></div>';
}

/* ---------------- init ---------------- */
async function init() {
  // Only the shell pages need auth; login page works anonymously.
  if (location.pathname === '/login') { await route(); return; }
  try {
    const me = await api('/api/auth/me', { silent: true });
    state.me = me.user;
    state.csrf = me.csrfToken;
  } catch {
    navigate('/login');
    return;
  }
  api('/api/settings', { silent: true }).then((s) => { state.settings = s; }).catch(() => {});
  await route();
}

window.addEventListener('popstate', () => route());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a && a.origin === location.origin && !a.target) {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('/dashboard') || a.pathname.startsWith('/dashboard') || href === '/login') {
      e.preventDefault();
      const next = a.pathname + a.search;
      navigate(next);
    }
  }
});
init();
