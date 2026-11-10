/* Hours & Invoices — browser app. Plain JavaScript, no build step. */
(function () {
  'use strict';
  const PP = window.PayPeriod;
  const app = document.getElementById('app');
  const modal = document.getElementById('modal');
  const S = { user: null, csrf: null, settings: null, today: null };

  // ---------------------------------------------------------------- helpers
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const D = (s) => new Date(PP.toMs(s));
  const fmt = (s, o) => D(s).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  const fmtDay = (s) => fmt(s, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtLong = (s) => fmt(s, { weekday: 'long', month: 'long', day: 'numeric' });
  const fmtMD = (s) => fmt(s, { month: 'short', day: 'numeric' });
  const fmtMDY = (s) => fmt(s, { month: 'short', day: 'numeric', year: 'numeric' });
  const mdy = (s) => (s ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(2, 4)}` : '');
  const range = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? `${fmtMD(a)} – ${fmtMDY(b)}` : `${fmtMDY(a)} – ${fmtMDY(b)}`);
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hrs = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Day cells: 0, 0.5, 1, 7.25 (no trailing zeros)
  const dayHrs = (n) => String(Math.round(Number(n || 0) * 100) / 100);
  const first = (name) => String(name || '').split(' ')[0];
  const isOwner = () => S.user && S.user.role === 'owner';
  const daysUntil = (d) => PP.diffDays(S.today, d);
  const ICON_CAL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';

  const ICON_LOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const ICON_UP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  const ICON_DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  function whenText(d) {
    const n = daysUntil(d);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? `in ${n} days` : `${-n} days ago`;
  }
  function paydayPill(due, label = 'Payday', late = false) {
    return `<span class="payday${late ? ' late' : ''}">${ICON_CAL}${esc(label)}: ${esc(fmtDay(due))}</span>`;
  }
  function invoiceBadge(inv) {
    if (!inv) return '<span class="badge b-none">Not sent yet</span>';
    if (inv.status === 'paid') return `<span class="badge b-paid">Paid ${esc(mdy(inv.processDate))}</span>`;
    if (daysUntil(inv.dueDate) < 0) return '<span class="badge b-late">Overdue</span>';
    return '<span class="badge b-sent">Sent · waiting for payment</span>';
  }

  function toast(msg, type) {
    const box = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, type === 'error' ? 5000 : 2600);
  }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (method !== 'GET' && S.csrf) opts.headers['X-CSRF-Token'] = S.csrf;
    let res;
    try { res = await fetch(url, opts); } catch { throw new Error('Can’t reach the server. Check your connection and try again.'); }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && !url.endsWith('/login')) { S.user = null; go('#/login'); throw new Error(data.error || 'Please sign in.'); }
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
    return data;
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
    }
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1600); }
  }

  function openModal(html, onReady) {
    modal.innerHTML = `<div class="modal-body">${html}</div>`;
    if (!modal.open) modal.showModal();
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => modal.close()));
    if (onReady) onReady(modal);
    const f = modal.querySelector('input, textarea');
    if (f) f.focus();
  }

  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  window.addEventListener('hashchange', () => route());

  // ---------------------------------------------------------------- layout
  function shell(active, inner) {
    const links = isOwner()
      ? [['home', '#/home', 'Home'], ['invoices', '#/invoices', 'Invoices'], ['people', '#/people', 'People'], ['settings', '#/settings', 'Settings']]
      : [['hours', '#/hours', 'My hours'], ['history', '#/history', 'History'], ['account', '#/account', 'Account']];
    app.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/"><img class="brand-logo" src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyByb2xlPSJpbWciIGFyaWEtbGFiZWw9IkFsbHltYXIgSGVhbHRoIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iODM1LjgzOCIgaGVpZ2h0PSIxNjAiIHZpZXdCb3g9IjAgMCA4MzUuODM4IDE2MCI+CjxkZWZzPgo8Y2xpcFBhdGggaWQ9ImNsaXAtMCI+CjxwYXRoIGNsaXAtcnVsZT0ibm9uemVybyIgZD0iTSAwIDAuMDE1NjI1IEwgODM1LjY3NTc4MSAwLjAxNTYyNSBMIDgzNS42NzU3ODEgMTU5Ljk4NDM3NSBMIDAgMTU5Ljk4NDM3NSBaIE0gMCAwLjAxNTYyNSAiLz4KPC9jbGlwUGF0aD4KPGNsaXBQYXRoIGlkPSJjbGlwLTEiPgo8cGF0aCBjbGlwLXJ1bGU9Im5vbnplcm8iIGQ9Ik0gMCAwLjAxNTYyNSBMIDE2MCAwLjAxNTYyNSBMIDE2MCAxNTkuOTg0Mzc1IEwgMCAxNTkuOTg0Mzc1IFogTSAwIDAuMDE1NjI1ICIvPgo8L2NsaXBQYXRoPgo8Y2xpcFBhdGggaWQ9ImNsaXAtMiI+CjxwYXRoIGNsaXAtcnVsZT0ibm9uemVybyIgZD0iTSAwIDAuMDE1NjI1IEwgMTM0IDAuMDE1NjI1IEwgMTM0IDE1OS45ODQzNzUgTCAwIDE1OS45ODQzNzUgWiBNIDAgMC4wMTU2MjUgIi8+CjwvY2xpcFBhdGg+CjxjbGlwUGF0aCBpZD0iY2xpcC0zIj4KPHBhdGggY2xpcC1ydWxlPSJub256ZXJvIiBkPSJNIDE4IDAuMDE1NjI1IEwgMTU3IDAuMDE1NjI1IEwgMTU3IDE0NyBMIDE4IDE0NyBaIE0gMTggMC4wMTU2MjUgIi8+CjwvY2xpcFBhdGg+CjxjbGlwUGF0aCBpZD0iY2xpcC00Ij4KPHBhdGggY2xpcC1ydWxlPSJub256ZXJvIiBkPSJNIDc5MSA0MyBMIDgzNS42NzU3ODEgNDMgTCA4MzUuNjc1NzgxIDExMiBMIDc5MSAxMTIgWiBNIDc5MSA0MyAiLz4KPC9jbGlwUGF0aD4KPC9kZWZzPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYig5MC41ODgzNzklLCA1MC41ODg5ODklLCA1MC4xOTY4MzglKSIgc3Ryb2tlLW9wYWNpdHk9IjEiIHN0cm9rZS1taXRlcmxpbWl0PSI0LjYiIGQ9Ik0gLTAuMDAxNDM3ODkgMC4wMDA2MDc0NjIgTCA3OS4yMDE0MSAwLjAwMDYwNzQ2MiAiIHRyYW5zZm9ybT0ibWF0cml4KDAuOTk5ODA2LCAwLCAwLCAtMC45OTk4MDYsIDUyLjg4NDI1LCA5NC42MDIxNykiLz4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAtMikiPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYigzNy4yNTQzMzMlLCA3Ny42NDc0JSwgNzguODIzODUzJSkiIHN0cm9rZS1vcGFjaXR5PSIxIiBzdHJva2UtbWl0ZXJsaW1pdD0iNC42IiBkPSJNIC0wLjAwMTE4MDQxIC0wLjAwMTA1Nzc4IEwgNDQuNjg3MTY3IDc5LjA2MTEzOCAiIHRyYW5zZm9ybT0ibWF0cml4KDAuOTk5ODA2LCAwLCAwLCAtMC45OTk4MDYsIDM2LjYzNzg5OSwgMTIzLjM0NjU5OSkiLz4KPC9nPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcC0zKSI+CjxwYXRoIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iOC4wNSIgc3Ryb2tlLWxpbmVjYXA9ImJ1dHQiIHN0cm9rZS1saW5lam9pbj0ibWl0ZXIiIHN0cm9rZT0icmdiKDkyLjE1Njk4MiUsIDgzLjEzNzUxMiUsIDU4LjgyNDE1OCUpIiBzdHJva2Utb3BhY2l0eT0iMSIgc3Ryb2tlLW1pdGVybGltaXQ9IjQuNiIgZD0iTSAwLjAwMTU5OTI4IC0wLjAwMTc1OTg5IEwgMzMuMzUxODEyIC03Mi40NDkzOTMgIiB0cmFuc2Zvcm09Im1hdHJpeCgwLjk5OTgwNiwgMCwgMCwgLTAuOTk5ODA2LCA3MS4xMzEyMTQsIDIyLjE2NjIwOSkiLz4KPC9nPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYig5MC41ODgzNzklLCA1MC41ODg5ODklLCA1MC4xOTY4MzglKSIgc3Ryb2tlLW9wYWNpdHk9IjEiIHN0cm9rZS1taXRlcmxpbWl0PSI0LjYiIGQ9Ik0gLTAuMDAwNDE3MDE5IDAuMDAwNjA3NDYyIEwgMjMuMDAwMTM0IDAuMDAwNjA3NDYyICIgdHJhbnNmb3JtPSJtYXRyaXgoMC45OTk4MDYsIDAsIDAsIC0wLjk5OTgwNiwgOTIuOTc2OTc5LCA5NC42MDIxNykiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoOTIuMTU2OTgyJSwgODMuMTM3NTEyJSwgNTguODI0MTU4JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSA3MS4xMzI4MTIgOC4xNDA2MjUgQyA3OC44Nzg5MDYgOC4xNDA2MjUgODUuMTYwMTU2IDE0LjQxNzk2OSA4NS4xNjAxNTYgMjIuMTY3OTY5IEMgODUuMTYwMTU2IDI5LjkxNDA2MiA3OC44Nzg5MDYgMzYuMTk1MzEyIDcxLjEzMjgxMiAzNi4xOTUzMTIgQyA2My4zODI4MTIgMzYuMTk1MzEyIDU3LjEwNTQ2OSAyOS45MTQwNjIgNTcuMTA1NDY5IDIyLjE2Nzk2OSBDIDU3LjEwNTQ2OSAxNC40MTc5NjkgNjMuMzgyODEyIDguMTQwNjI1IDcxLjEzMjgxMiA4LjE0MDYyNSAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoOTAuNTg4Mzc5JSwgNTAuNTg4OTg5JSwgNTAuMTk2ODM4JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSAxMzIuMDcwMzEyIDgwLjU3NDIxOSBDIDEzOS44MTY0MDYgODAuNTc0MjE5IDE0Ni4wOTc2NTYgODYuODU1NDY5IDE0Ni4wOTc2NTYgOTQuNjAxNTYyIEMgMTQ2LjA5NzY1NiAxMDIuMzUxNTYyIDEzOS44MTY0MDYgMTA4LjYyODkwNiAxMzIuMDcwMzEyIDEwOC42Mjg5MDYgQyAxMjQuMzIwMzEyIDEwOC42Mjg5MDYgMTE4LjA0Mjk2OSAxMDIuMzUxNTYyIDExOC4wNDI5NjkgOTQuNjAxNTYyIEMgMTE4LjA0Mjk2OSA4Ni44NTU0NjkgMTI0LjMyMDMxMiA4MC41NzQyMTkgMTMyLjA3MDMxMiA4MC41NzQyMTkgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDM3LjI1NDMzMyUsIDc3LjY0NzQlLCA3OC44MjM4NTMlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDM2LjYzNjcxOSAxMDkuMzIwMzEyIEMgNDQuMzg2NzE5IDEwOS4zMjAzMTIgNTAuNjY0MDYyIDExNS41OTc2NTYgNTAuNjY0MDYyIDEyMy4zNDc2NTYgQyA1MC42NjQwNjIgMTMxLjA5Mzc1IDQ0LjM4NjcxOSAxMzcuMzc1IDM2LjYzNjcxOSAxMzcuMzc1IEMgMjguODkwNjI1IDEzNy4zNzUgMjIuNjA5Mzc1IDEzMS4wOTM3NSAyMi42MDkzNzUgMTIzLjM0NzY1NiBDIDIyLjYwOTM3NSAxMTUuNTk3NjU2IDI4Ljg5MDYyNSAxMDkuMzIwMzEyIDM2LjYzNjcxOSAxMDkuMzIwMzEyICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxMDAlLCAxMDAlLCAxMDAlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDIyMi40NzY1NjIgODYuNjIxMDk0IEwgMjEyLjI1IDYyLjAxOTUzMSBMIDIwMS45Mjk2ODggODYuNjIxMDk0IFogTSAyMDQuOTY4NzUgNDcuMjc3MzQ0IEwgMjE5LjcxMDkzOCA0Ny4yNzczNDQgTCAyNDguNTU0Njg4IDExMS43NzczNDQgTCAyMzIuODkwNjI1IDExMS43NzczNDQgTCAyMjcuMTc1NzgxIDk3Ljk1NzAzMSBMIDE5Ny4yMzA0NjkgOTcuOTU3MDMxIEwgMTkxLjUxNTYyNSAxMTEuNzc3MzQ0IEwgMTc2LjIxODc1IDExMS43NzczNDQgWiBNIDIwNC45Njg3NSA0Ny4yNzczNDQgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMjUyLjg4MjgxMiA0My40MDYyNSBMIDI2Ny4yNTM5MDYgNDMuNDA2MjUgTCAyNjcuMjUzOTA2IDExMS43NzczNDQgTCAyNTIuODgyODEyIDExMS43NzczNDQgWiBNIDI1Mi44ODI4MTIgNDMuNDA2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMjc5LjIzNDM3NSA0My40MDYyNSBMIDI5My42MDkzNzUgNDMuNDA2MjUgTCAyOTMuNjA5Mzc1IDExMS43NzczNDQgTCAyNzkuMjM0Mzc1IDExMS43NzczNDQgWiBNIDI3OS4yMzQzNzUgNDMuNDA2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMjk4LjAzMTI1IDEyNS44NzUgTCAzMDMuMjgxMjUgMTE1LjY0ODQzOCBDIDMwNS40OTIxODggMTE3LjU4MjAzMSAzMDguNTM1MTU2IDExOC43ODEyNSAzMTEuMzkwNjI1IDExOC43ODEyNSBDIDMxNS4zNTE1NjIgMTE4Ljc4MTI1IDMxNy41NjI1IDExNy4wMzEyNSAzMTkuNSAxMTIuNjA5Mzc1IEwgMzE5LjY4MzU5NCAxMTIuMTQ4NDM4IEwgMjk4LjIxNDg0NCA2Mi4yMDMxMjUgTCAzMTMuMDUwNzgxIDYyLjIwMzEyNSBMIDMyNi45NjQ4NDQgOTUuOTI5Njg4IEwgMzQwLjk2ODc1IDYyLjIwMzEyNSBMIDM1NC43ODkwNjIgNjIuMjAzMTI1IEwgMzMyLjM5ODQzOCAxMTQuODE2NDA2IEMgMzI3LjYwOTM3NSAxMjYuNzk2ODc1IDMyMC43ODkwNjIgMTMwLjM5MDYyNSAzMTEuODUxNTYyIDEzMC4zOTA2MjUgQyAzMDYuNzgxMjUgMTMwLjM5MDYyNSAzMDEuMjUzOTA2IDEyOC43MzA0NjkgMjk4LjAzMTI1IDEyNS44NzUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMzU5LjMwNDY4OCA2Mi4yMDMxMjUgTCAzNzMuMDMxMjUgNjIuMjAzMTI1IEwgMzczLjAzMTI1IDY3LjkxNzk2OSBDIDM3Ni43MTg3NSA2My42Nzk2ODggMzgyLjI1IDYxLjQ2NDg0NCAzODguNjA1NDY5IDYxLjQ2NDg0NCBDIDM5NS41MTU2MjUgNjEuNDY0ODQ0IDQwMS41MDM5MDYgNjQuMTQwNjI1IDQwNC45MTQwNjIgNjkuNTc0MjE5IEMgNDA4Ljg3ODkwNiA2NC41MDc4MTIgNDE1LjMyODEyNSA2MS40NjQ4NDQgNDIyLjc5Mjk2OSA2MS40NjQ4NDQgQyA0MzQuNTg1OTM4IDYxLjQ2NDg0NCA0NDMuMDYyNSA2OC4yODUxNTYgNDQzLjA2MjUgODMuMzk4NDM4IEwgNDQzLjA2MjUgMTExLjc3NzM0NCBMIDQyOC42ODc1IDExMS43NzczNDQgTCA0MjguNjg3NSA4NS42MDkzNzUgQyA0MjguNjg3NSA3Ny41OTM3NSA0MjUuMDkzNzUgNzMuOTA2MjUgNDE5LjI5Mjk2OSA3My45MDYyNSBDIDQxMi44Mzk4NDQgNzMuOTA2MjUgNDA4LjMyNDIxOSA3OC4wNTQ2ODggNDA4LjMyNDIxOSA4Ni44OTg0MzggTCA0MDguMzI0MjE5IDExMS43NzczNDQgTCAzOTMuOTQ5MjE5IDExMS43NzczNDQgTCAzOTMuOTQ5MjE5IDg1LjYwOTM3NSBDIDM5My45NDkyMTkgNzcuNTkzNzUgMzkwLjU0Mjk2OSA3My45MDYyNSAzODQuNTUwNzgxIDczLjkwNjI1IEMgMzc4LjE5NTMxMiA3My45MDYyNSAzNzMuNjc5Njg4IDc4LjA1NDY4OCAzNzMuNjc5Njg4IDg2Ljg5ODQzOCBMIDM3My42Nzk2ODggMTExLjc3NzM0NCBMIDM1OS4zMDQ2ODggMTExLjc3NzM0NCBaIE0gMzU5LjMwNDY4OCA2Mi4yMDMxMjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNDg0LjA2NjQwNiA5MS4wNDY4NzUgTCA0NzQuMjA3MDMxIDkxLjA0Njg3NSBDIDQ2Ny40ODA0NjkgOTEuMDQ2ODc1IDQ2NS4zNTkzNzUgOTMuNTM1MTU2IDQ2NS4zNTkzNzUgOTYuODUxNTYyIEMgNDY1LjM1OTM3NSAxMDAuNDQ1MzEyIDQ2OC4zOTg0MzggMTAyLjgzOTg0NCA0NzMuNDY4NzUgMTAyLjgzOTg0NCBDIDQ3OC4yNTc4MTIgMTAyLjgzOTg0NCA0ODIuNDA2MjUgMTAwLjYyODkwNiA0ODQuMDY2NDA2IDk2LjExMzI4MSBaIE0gNDg0Ljk4ODI4MSAxMDUuNjk1MzEyIEMgNDgyLjIyMjY1NiAxMTAuMTE3MTg4IDQ3Ny4xNTYyNSAxMTIuNTE1NjI1IDQ2OS44NzUgMTEyLjUxNTYyNSBDIDQ1OC4yNjU2MjUgMTEyLjUxNTYyNSA0NTEuMzUxNTYyIDEwNi4wNjY0MDYgNDUxLjM1MTU2MiA5Ny40OTYwOTQgQyA0NTEuMzUxNTYyIDg4Ljc0MjE4OCA0NTcuNTI3MzQ0IDgyLjY2MDE1NiA0NzIuNjM2NzE5IDgyLjY2MDE1NiBMIDQ4NC4wNjY0MDYgODIuNjYwMTU2IEMgNDg0LjA2NjQwNiA3Ni40ODQzNzUgNDgwLjM3ODkwNiA3Mi44OTQ1MzEgNDcyLjYzNjcxOSA3Mi44OTQ1MzEgQyA0NjcuMzg2NzE5IDcyLjg5NDUzMSA0NjEuOTQ5MjE5IDc0LjY0NDUzMSA0NTguMzU1NDY5IDc3LjUgTCA0NTMuMTk1MzEyIDY3LjQ1NzAzMSBDIDQ1OC42MzI4MTIgNjMuNTg1OTM4IDQ2Ni42NDg0MzggNjEuNDY0ODQ0IDQ3NC41NzQyMTkgNjEuNDY0ODQ0IEMgNDg5LjY4NzUgNjEuNDY0ODQ0IDQ5OC40NDE0MDYgNjguNDY4NzUgNDk4LjQ0MTQwNiA4My40ODgyODEgTCA0OTguNDQxNDA2IDExMS43NzczNDQgTCA0ODQuOTg4MjgxIDExMS43NzczNDQgWiBNIDQ4NC45ODgyODEgMTA1LjY5NTMxMiAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTAwJSwgMTAwJSwgMTAwJSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSA1MTAuMDQ2ODc1IDYyLjIwMzEyNSBMIDUyMy43NzczNDQgNjIuMjAzMTI1IEwgNTIzLjc3NzM0NCA2OC43NDYwOTQgQyA1MjcuMjc3MzQ0IDYzLjk1MzEyNSA1MzMuMTc1NzgxIDYxLjQ2NDg0NCA1NDAuODI0MjE5IDYxLjQ2NDg0NCBMIDU0MC44MjQyMTkgNzQuNzM0Mzc1IEMgNTM5LjYyNSA3NC42NDQ1MzEgNTM4LjcwMzEyNSA3NC41NTA3ODEgNTM3LjU5NzY1NiA3NC41NTA3ODEgQyA1MjkuNjc1NzgxIDc0LjU1MDc4MSA1MjQuNDIxODc1IDc4Ljg4MjgxMiA1MjQuNDIxODc1IDg4LjM3NSBMIDUyNC40MjE4NzUgMTExLjc3NzM0NCBMIDUxMC4wNDY4NzUgMTExLjc3NzM0NCBaIE0gNTEwLjA0Njg3NSA2Mi4yMDMxMjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNTk5LjQyNTc4MSA4Mi4wMTU2MjUgTCA1NTkuMDY2NDA2IDgyLjAxNTYyNSBMIDU1OS4wNjY0MDYgMTExLjc3NzM0NCBMIDU1Mi4yNDYwOTQgMTExLjc3NzM0NCBMIDU1Mi4yNDYwOTQgNDcuMjc3MzQ0IEwgNTU5LjA2NjQwNiA0Ny4yNzczNDQgTCA1NTkuMDY2NDA2IDc2LjAyNzM0NCBMIDU5OS40MjU3ODEgNzYuMDI3MzQ0IEwgNTk5LjQyNTc4MSA0Ny4yNzczNDQgTCA2MDYuMTUyMzQ0IDQ3LjI3NzM0NCBMIDYwNi4xNTIzNDQgMTExLjc3NzM0NCBMIDU5OS40MjU3ODEgMTExLjc3NzM0NCBaIE0gNTk5LjQyNTc4MSA4Mi4wMTU2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNjYwLjQyMTg3NSA4NC42ODc1IEMgNjU5LjU5Mzc1IDc1LjE5NTMxMiA2NTIuNjgzNTk0IDY4LjU2MjUgNjQzLjE5MTQwNiA2OC41NjI1IEMgNjMzLjc5Mjk2OSA2OC41NjI1IDYyNi44ODI4MTIgNzUuMTk1MzEyIDYyNi4wNTQ2ODggODQuNjg3NSBaIE0gNjE5LjUxMTcxOSA4Ny41NDI5NjkgQyA2MTkuNTExNzE5IDczLjE2Nzk2OSA2MjkuNTU0Njg4IDYyLjk0MTQwNiA2NDMuMTkxNDA2IDYyLjk0MTQwNiBDIDY1Ni44MjgxMjUgNjIuOTQxNDA2IDY2Ni42ODc1IDcyLjk4NDM3NSA2NjYuNjg3NSA4Ny41NDI5NjkgQyA2NjYuNjg3NSA4OC4wOTc2NTYgNjY2LjU5NzY1NiA4OC44MzIwMzEgNjY2LjU5NzY1NiA4OS41NzAzMTIgTCA2MjUuOTYwOTM4IDg5LjU3MDMxMiBDIDYyNi42OTkyMTkgOTkuNjE3MTg4IDYzNC40Mzc1IDEwNi40MzM1OTQgNjQ1LjEyNSAxMDYuNDMzNTk0IEMgNjUxLjAyMzQzOCAxMDYuNDMzNTk0IDY1Ni4yNzczNDQgMTA0LjMxNjQwNiA2NTkuOTYwOTM4IDEwMC4wNzQyMTkgTCA2NjMuNjQ4NDM4IDEwNC4zMTY0MDYgQyA2NTkuMzE2NDA2IDEwOS40NzY1NjIgNjUyLjU4OTg0NCAxMTIuMjM4MjgxIDY0NC45NDUzMTIgMTEyLjIzODI4MSBDIDYyOS44MzIwMzEgMTEyLjIzODI4MSA2MTkuNTExNzE5IDEwMS45MTc5NjkgNjE5LjUxMTcxOSA4Ny41NDI5NjkgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzA4LjcwMzEyNSA4OS4yOTY4NzUgTCA2OTMuNSA4OS4yOTY4NzUgQyA2ODQuMTAxNTYyIDg5LjI5Njg3NSA2ODEuMDYyNSA5Mi45ODA0NjkgNjgxLjA2MjUgOTcuOTU3MDMxIEMgNjgxLjA2MjUgMTAzLjU3ODEyNSA2ODUuNTc0MjE5IDEwNy4wNzgxMjUgNjkzLjMxNjQwNiAxMDcuMDc4MTI1IEMgNzAwLjY4NzUgMTA3LjA3ODEyNSA3MDYuMTI1IDEwMy41NzgxMjUgNzA4LjcwMzEyNSA5Ny4yMTg3NSBaIE0gNzA4Ljk4MDQ2OSAxMDQuMjIyNjU2IEMgNzA2LjAzMTI1IDEwOS4xOTUzMTIgNzAwLjMyMDMxMiAxMTIuMjM4MjgxIDY5Mi4zMDQ2ODggMTEyLjIzODI4MSBDIDY4MS4zMzU5MzggMTEyLjIzODI4MSA2NzQuNjA5Mzc1IDEwNi41MjczNDQgNjc0LjYwOTM3NSA5OC4xNDA2MjUgQyA2NzQuNjA5Mzc1IDkwLjY3NTc4MSA2NzkuNDAyMzQ0IDg0LjQxMDE1NiA2OTMuMzE2NDA2IDg0LjQxMDE1NiBMIDcwOC43MDMxMjUgODQuNDEwMTU2IEwgNzA4LjcwMzEyNSA4MS40NjA5MzggQyA3MDguNzAzMTI1IDczLjE2Nzk2OSA3MDQuMDAzOTA2IDY4LjY1MjM0NCA2OTQuOTc2NTYyIDY4LjY1MjM0NCBDIDY4OC43MTA5MzggNjguNjUyMzQ0IDY4Mi44MTI1IDcwLjg2NzE4OCA2NzguODUxNTYyIDc0LjM2NzE4OCBMIDY3NS45MDIzNDQgNjkuNDg0Mzc1IEMgNjgwLjc4NTE1NiA2NS4zMzU5MzggNjg3Ljk3MjY1NiA2Mi45NDE0MDYgNjk1LjYyMTA5NCA2Mi45NDE0MDYgQyA3MDguMTUyMzQ0IDYyLjk0MTQwNiA3MTUuMjQ2MDk0IDY5LjIwNzAzMSA3MTUuMjQ2MDk0IDgxLjczODI4MSBMIDcxNS4yNDYwOTQgMTExLjc3NzM0NCBMIDcwOC45ODA0NjkgMTExLjc3NzM0NCBaIE0gNzA4Ljk4MDQ2OSAxMDQuMjIyNjU2ICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxMDAlLCAxMDAlLCAxMDAlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDczMS42NDQ1MzEgNDMuNDA2MjUgTCA3MzguMTg3NSA0My40MDYyNSBMIDczOC4xODc1IDExMS43NzczNDQgTCA3MzEuNjQ0NTMxIDExMS43NzczNDQgWiBNIDczMS42NDQ1MzEgNDMuNDA2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzU2LjE1NjI1IDk4LjE0MDYyNSBMIDc1Ni4xNTYyNSA2OC44MzU5MzggTCA3NDcuNDkyMTg4IDY4LjgzNTkzOCBMIDc0Ny40OTIxODggNjMuMzA4NTk0IEwgNzU2LjE1NjI1IDYzLjMwODU5NCBMIDc1Ni4xNTYyNSA1Mi43MTA5MzggTCA3NjIuNjk5MjE5IDUyLjcxMDkzOCBMIDc2Mi42OTkyMTkgNjMuMzA4NTk0IEwgNzc3LjQ0MTQwNiA2My4zMDg1OTQgTCA3NzcuNDQxNDA2IDY4LjgzNTkzOCBMIDc2Mi42OTkyMTkgNjguODM1OTM4IEwgNzYyLjY5OTIxOSA5Ny43NzM0MzggQyA3NjIuNjk5MjE5IDEwMy40ODQzNzUgNzY1LjY0NDUzMSAxMDYuNjE3MTg4IDc3MS4wODIwMzEgMTA2LjYxNzE4OCBDIDc3My43NTM5MDYgMTA2LjYxNzE4OCA3NzYuNDI1NzgxIDEwNS43ODkwNjIgNzc4LjI2OTUzMSAxMDQuMTI4OTA2IEwgNzgwLjU3NDIxOSAxMDguODI4MTI1IEMgNzc3Ljk5MjE4OCAxMTEuMTMyODEyIDc3NC4xMjUgMTEyLjIzODI4MSA3NzAuMzQzNzUgMTEyLjIzODI4MSBDIDc2MS4yMjI2NTYgMTEyLjIzODI4MSA3NTYuMTU2MjUgMTA3LjA3ODEyNSA3NTYuMTU2MjUgOTguMTQwNjI1ICIvPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcC00KSI+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzkxLjA3ODEyNSA0My40MDYyNSBMIDc5Ny42MjEwOTQgNDMuNDA2MjUgTCA3OTcuNjIxMDk0IDcxLjc4NTE1NiBDIDgwMS4xMjEwOTQgNjYuMTY3OTY5IDgwNy41NzAzMTIgNjIuOTQxNDA2IDgxNS43NzM0MzggNjIuOTQxNDA2IEMgODI3LjU2NjQwNiA2Mi45NDE0MDYgODM1LjY3NTc4MSA2OS43NTc4MTIgODM1LjY3NTc4MSA4My42NzE4NzUgTCA4MzUuNjc1NzgxIDExMS43NzczNDQgTCA4MjkuMTMyODEyIDExMS43NzczNDQgTCA4MjkuMTMyODEyIDg0LjMyMDMxMiBDIDgyOS4xMzI4MTIgNzQuMDg5ODQ0IDgyMy43ODkwNjIgNjguODM5ODQ0IDgxNC41NzQyMTkgNjguODM5ODQ0IEMgODA0LjE2MDE1NiA2OC44Mzk4NDQgNzk3LjYyMTA5NCA3NS4yODkwNjIgNzk3LjYyMTA5NCA4Ni4zNDc2NTYgTCA3OTcuNjIxMDk0IDExMS43NzczNDQgTCA3OTEuMDc4MTI1IDExMS43NzczNDQgWiBNIDc5MS4wNzgxMjUgNDMuNDA2MjUgIi8+CjwvZz4KPC9zdmc+Cg==" alt="Allymar Health"></a>
        <nav class="nav">${links.map(([k, h, t]) => `<a href="${h}" class="${k === active ? 'active' : ''}">${t}</a>`).join('')}</nav>
        <div class="who"><span class="who-name">${esc(S.user.name)}</span><button class="btn sm" id="signout">Sign out</button></div>
      </div></header>
      <main class="container">${inner}</main>`;
    document.getElementById('signout').addEventListener('click', async () => {
      try { await api('POST', '/api/logout'); } catch { /* ignore */ }
      S.user = null; S.csrf = null; go('#/login');
    });
    return app.querySelector('main');
  }
  const loading = (active) => shell(active, '<p class="boot">Loading…</p>');
  const failed = (main, err) => { main.innerHTML = `<div class="card pad"><p class="form-error">${esc(err.message)}</p></div>`; };

  // ---------------------------------------------------------------- sign in
  function renderLogin() {
    app.innerHTML = `
      <div class="auth-wrap"><div class="card auth-card">
        <div class="brand"><img class="brand-logo lg" src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyByb2xlPSJpbWciIGFyaWEtbGFiZWw9IkFsbHltYXIgSGVhbHRoIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iODM1LjgzOCIgaGVpZ2h0PSIxNjAiIHZpZXdCb3g9IjAgMCA4MzUuODM4IDE2MCI+CjxkZWZzPgo8Y2xpcFBhdGggaWQ9ImNsaXAtMCI+CjxwYXRoIGNsaXAtcnVsZT0ibm9uemVybyIgZD0iTSAwIDAuMDE1NjI1IEwgODM1LjY3NTc4MSAwLjAxNTYyNSBMIDgzNS42NzU3ODEgMTU5Ljk4NDM3NSBMIDAgMTU5Ljk4NDM3NSBaIE0gMCAwLjAxNTYyNSAiLz4KPC9jbGlwUGF0aD4KPGNsaXBQYXRoIGlkPSJjbGlwLTEiPgo8cGF0aCBjbGlwLXJ1bGU9Im5vbnplcm8iIGQ9Ik0gMCAwLjAxNTYyNSBMIDE2MCAwLjAxNTYyNSBMIDE2MCAxNTkuOTg0Mzc1IEwgMCAxNTkuOTg0Mzc1IFogTSAwIDAuMDE1NjI1ICIvPgo8L2NsaXBQYXRoPgo8Y2xpcFBhdGggaWQ9ImNsaXAtMiI+CjxwYXRoIGNsaXAtcnVsZT0ibm9uemVybyIgZD0iTSAwIDAuMDE1NjI1IEwgMTM0IDAuMDE1NjI1IEwgMTM0IDE1OS45ODQzNzUgTCAwIDE1OS45ODQzNzUgWiBNIDAgMC4wMTU2MjUgIi8+CjwvY2xpcFBhdGg+CjxjbGlwUGF0aCBpZD0iY2xpcC0zIj4KPHBhdGggY2xpcC1ydWxlPSJub256ZXJvIiBkPSJNIDE4IDAuMDE1NjI1IEwgMTU3IDAuMDE1NjI1IEwgMTU3IDE0NyBMIDE4IDE0NyBaIE0gMTggMC4wMTU2MjUgIi8+CjwvY2xpcFBhdGg+CjxjbGlwUGF0aCBpZD0iY2xpcC00Ij4KPHBhdGggY2xpcC1ydWxlPSJub256ZXJvIiBkPSJNIDc5MSA0MyBMIDgzNS42NzU3ODEgNDMgTCA4MzUuNjc1NzgxIDExMiBMIDc5MSAxMTIgWiBNIDc5MSA0MyAiLz4KPC9jbGlwUGF0aD4KPC9kZWZzPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYig5MC41ODgzNzklLCA1MC41ODg5ODklLCA1MC4xOTY4MzglKSIgc3Ryb2tlLW9wYWNpdHk9IjEiIHN0cm9rZS1taXRlcmxpbWl0PSI0LjYiIGQ9Ik0gLTAuMDAxNDM3ODkgMC4wMDA2MDc0NjIgTCA3OS4yMDE0MSAwLjAwMDYwNzQ2MiAiIHRyYW5zZm9ybT0ibWF0cml4KDAuOTk5ODA2LCAwLCAwLCAtMC45OTk4MDYsIDUyLjg4NDI1LCA5NC42MDIxNykiLz4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAtMikiPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYigzNy4yNTQzMzMlLCA3Ny42NDc0JSwgNzguODIzODUzJSkiIHN0cm9rZS1vcGFjaXR5PSIxIiBzdHJva2UtbWl0ZXJsaW1pdD0iNC42IiBkPSJNIC0wLjAwMTE4MDQxIC0wLjAwMTA1Nzc4IEwgNDQuNjg3MTY3IDc5LjA2MTEzOCAiIHRyYW5zZm9ybT0ibWF0cml4KDAuOTk5ODA2LCAwLCAwLCAtMC45OTk4MDYsIDM2LjYzNzg5OSwgMTIzLjM0NjU5OSkiLz4KPC9nPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcC0zKSI+CjxwYXRoIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iOC4wNSIgc3Ryb2tlLWxpbmVjYXA9ImJ1dHQiIHN0cm9rZS1saW5lam9pbj0ibWl0ZXIiIHN0cm9rZT0icmdiKDkyLjE1Njk4MiUsIDgzLjEzNzUxMiUsIDU4LjgyNDE1OCUpIiBzdHJva2Utb3BhY2l0eT0iMSIgc3Ryb2tlLW1pdGVybGltaXQ9IjQuNiIgZD0iTSAwLjAwMTU5OTI4IC0wLjAwMTc1OTg5IEwgMzMuMzUxODEyIC03Mi40NDkzOTMgIiB0cmFuc2Zvcm09Im1hdHJpeCgwLjk5OTgwNiwgMCwgMCwgLTAuOTk5ODA2LCA3MS4xMzEyMTQsIDIyLjE2NjIwOSkiLz4KPC9nPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYig5MC41ODgzNzklLCA1MC41ODg5ODklLCA1MC4xOTY4MzglKSIgc3Ryb2tlLW9wYWNpdHk9IjEiIHN0cm9rZS1taXRlcmxpbWl0PSI0LjYiIGQ9Ik0gLTAuMDAwNDE3MDE5IDAuMDAwNjA3NDYyIEwgMjMuMDAwMTM0IDAuMDAwNjA3NDYyICIgdHJhbnNmb3JtPSJtYXRyaXgoMC45OTk4MDYsIDAsIDAsIC0wLjk5OTgwNiwgOTIuOTc2OTc5LCA5NC42MDIxNykiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoOTIuMTU2OTgyJSwgODMuMTM3NTEyJSwgNTguODI0MTU4JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSA3MS4xMzI4MTIgOC4xNDA2MjUgQyA3OC44Nzg5MDYgOC4xNDA2MjUgODUuMTYwMTU2IDE0LjQxNzk2OSA4NS4xNjAxNTYgMjIuMTY3OTY5IEMgODUuMTYwMTU2IDI5LjkxNDA2MiA3OC44Nzg5MDYgMzYuMTk1MzEyIDcxLjEzMjgxMiAzNi4xOTUzMTIgQyA2My4zODI4MTIgMzYuMTk1MzEyIDU3LjEwNTQ2OSAyOS45MTQwNjIgNTcuMTA1NDY5IDIyLjE2Nzk2OSBDIDU3LjEwNTQ2OSAxNC40MTc5NjkgNjMuMzgyODEyIDguMTQwNjI1IDcxLjEzMjgxMiA4LjE0MDYyNSAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoOTAuNTg4Mzc5JSwgNTAuNTg4OTg5JSwgNTAuMTk2ODM4JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSAxMzIuMDcwMzEyIDgwLjU3NDIxOSBDIDEzOS44MTY0MDYgODAuNTc0MjE5IDE0Ni4wOTc2NTYgODYuODU1NDY5IDE0Ni4wOTc2NTYgOTQuNjAxNTYyIEMgMTQ2LjA5NzY1NiAxMDIuMzUxNTYyIDEzOS44MTY0MDYgMTA4LjYyODkwNiAxMzIuMDcwMzEyIDEwOC42Mjg5MDYgQyAxMjQuMzIwMzEyIDEwOC42Mjg5MDYgMTE4LjA0Mjk2OSAxMDIuMzUxNTYyIDExOC4wNDI5NjkgOTQuNjAxNTYyIEMgMTE4LjA0Mjk2OSA4Ni44NTU0NjkgMTI0LjMyMDMxMiA4MC41NzQyMTkgMTMyLjA3MDMxMiA4MC41NzQyMTkgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDM3LjI1NDMzMyUsIDc3LjY0NzQlLCA3OC44MjM4NTMlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDM2LjYzNjcxOSAxMDkuMzIwMzEyIEMgNDQuMzg2NzE5IDEwOS4zMjAzMTIgNTAuNjY0MDYyIDExNS41OTc2NTYgNTAuNjY0MDYyIDEyMy4zNDc2NTYgQyA1MC42NjQwNjIgMTMxLjA5Mzc1IDQ0LjM4NjcxOSAxMzcuMzc1IDM2LjYzNjcxOSAxMzcuMzc1IEMgMjguODkwNjI1IDEzNy4zNzUgMjIuNjA5Mzc1IDEzMS4wOTM3NSAyMi42MDkzNzUgMTIzLjM0NzY1NiBDIDIyLjYwOTM3NSAxMTUuNTk3NjU2IDI4Ljg5MDYyNSAxMDkuMzIwMzEyIDM2LjYzNjcxOSAxMDkuMzIwMzEyICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxMDAlLCAxMDAlLCAxMDAlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDIyMi40NzY1NjIgODYuNjIxMDk0IEwgMjEyLjI1IDYyLjAxOTUzMSBMIDIwMS45Mjk2ODggODYuNjIxMDk0IFogTSAyMDQuOTY4NzUgNDcuMjc3MzQ0IEwgMjE5LjcxMDkzOCA0Ny4yNzczNDQgTCAyNDguNTU0Njg4IDExMS43NzczNDQgTCAyMzIuODkwNjI1IDExMS43NzczNDQgTCAyMjcuMTc1NzgxIDk3Ljk1NzAzMSBMIDE5Ny4yMzA0NjkgOTcuOTU3MDMxIEwgMTkxLjUxNTYyNSAxMTEuNzc3MzQ0IEwgMTc2LjIxODc1IDExMS43NzczNDQgWiBNIDIwNC45Njg3NSA0Ny4yNzczNDQgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMjUyLjg4MjgxMiA0My40MDYyNSBMIDI2Ny4yNTM5MDYgNDMuNDA2MjUgTCAyNjcuMjUzOTA2IDExMS43NzczNDQgTCAyNTIuODgyODEyIDExMS43NzczNDQgWiBNIDI1Mi44ODI4MTIgNDMuNDA2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMjc5LjIzNDM3NSA0My40MDYyNSBMIDI5My42MDkzNzUgNDMuNDA2MjUgTCAyOTMuNjA5Mzc1IDExMS43NzczNDQgTCAyNzkuMjM0Mzc1IDExMS43NzczNDQgWiBNIDI3OS4yMzQzNzUgNDMuNDA2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMjk4LjAzMTI1IDEyNS44NzUgTCAzMDMuMjgxMjUgMTE1LjY0ODQzOCBDIDMwNS40OTIxODggMTE3LjU4MjAzMSAzMDguNTM1MTU2IDExOC43ODEyNSAzMTEuMzkwNjI1IDExOC43ODEyNSBDIDMxNS4zNTE1NjIgMTE4Ljc4MTI1IDMxNy41NjI1IDExNy4wMzEyNSAzMTkuNSAxMTIuNjA5Mzc1IEwgMzE5LjY4MzU5NCAxMTIuMTQ4NDM4IEwgMjk4LjIxNDg0NCA2Mi4yMDMxMjUgTCAzMTMuMDUwNzgxIDYyLjIwMzEyNSBMIDMyNi45NjQ4NDQgOTUuOTI5Njg4IEwgMzQwLjk2ODc1IDYyLjIwMzEyNSBMIDM1NC43ODkwNjIgNjIuMjAzMTI1IEwgMzMyLjM5ODQzOCAxMTQuODE2NDA2IEMgMzI3LjYwOTM3NSAxMjYuNzk2ODc1IDMyMC43ODkwNjIgMTMwLjM5MDYyNSAzMTEuODUxNTYyIDEzMC4zOTA2MjUgQyAzMDYuNzgxMjUgMTMwLjM5MDYyNSAzMDEuMjUzOTA2IDEyOC43MzA0NjkgMjk4LjAzMTI1IDEyNS44NzUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMzU5LjMwNDY4OCA2Mi4yMDMxMjUgTCAzNzMuMDMxMjUgNjIuMjAzMTI1IEwgMzczLjAzMTI1IDY3LjkxNzk2OSBDIDM3Ni43MTg3NSA2My42Nzk2ODggMzgyLjI1IDYxLjQ2NDg0NCAzODguNjA1NDY5IDYxLjQ2NDg0NCBDIDM5NS41MTU2MjUgNjEuNDY0ODQ0IDQwMS41MDM5MDYgNjQuMTQwNjI1IDQwNC45MTQwNjIgNjkuNTc0MjE5IEMgNDA4Ljg3ODkwNiA2NC41MDc4MTIgNDE1LjMyODEyNSA2MS40NjQ4NDQgNDIyLjc5Mjk2OSA2MS40NjQ4NDQgQyA0MzQuNTg1OTM4IDYxLjQ2NDg0NCA0NDMuMDYyNSA2OC4yODUxNTYgNDQzLjA2MjUgODMuMzk4NDM4IEwgNDQzLjA2MjUgMTExLjc3NzM0NCBMIDQyOC42ODc1IDExMS43NzczNDQgTCA0MjguNjg3NSA4NS42MDkzNzUgQyA0MjguNjg3NSA3Ny41OTM3NSA0MjUuMDkzNzUgNzMuOTA2MjUgNDE5LjI5Mjk2OSA3My45MDYyNSBDIDQxMi44Mzk4NDQgNzMuOTA2MjUgNDA4LjMyNDIxOSA3OC4wNTQ2ODggNDA4LjMyNDIxOSA4Ni44OTg0MzggTCA0MDguMzI0MjE5IDExMS43NzczNDQgTCAzOTMuOTQ5MjE5IDExMS43NzczNDQgTCAzOTMuOTQ5MjE5IDg1LjYwOTM3NSBDIDM5My45NDkyMTkgNzcuNTkzNzUgMzkwLjU0Mjk2OSA3My45MDYyNSAzODQuNTUwNzgxIDczLjkwNjI1IEMgMzc4LjE5NTMxMiA3My45MDYyNSAzNzMuNjc5Njg4IDc4LjA1NDY4OCAzNzMuNjc5Njg4IDg2Ljg5ODQzOCBMIDM3My42Nzk2ODggMTExLjc3NzM0NCBMIDM1OS4zMDQ2ODggMTExLjc3NzM0NCBaIE0gMzU5LjMwNDY4OCA2Mi4yMDMxMjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNDg0LjA2NjQwNiA5MS4wNDY4NzUgTCA0NzQuMjA3MDMxIDkxLjA0Njg3NSBDIDQ2Ny40ODA0NjkgOTEuMDQ2ODc1IDQ2NS4zNTkzNzUgOTMuNTM1MTU2IDQ2NS4zNTkzNzUgOTYuODUxNTYyIEMgNDY1LjM1OTM3NSAxMDAuNDQ1MzEyIDQ2OC4zOTg0MzggMTAyLjgzOTg0NCA0NzMuNDY4NzUgMTAyLjgzOTg0NCBDIDQ3OC4yNTc4MTIgMTAyLjgzOTg0NCA0ODIuNDA2MjUgMTAwLjYyODkwNiA0ODQuMDY2NDA2IDk2LjExMzI4MSBaIE0gNDg0Ljk4ODI4MSAxMDUuNjk1MzEyIEMgNDgyLjIyMjY1NiAxMTAuMTE3MTg4IDQ3Ny4xNTYyNSAxMTIuNTE1NjI1IDQ2OS44NzUgMTEyLjUxNTYyNSBDIDQ1OC4yNjU2MjUgMTEyLjUxNTYyNSA0NTEuMzUxNTYyIDEwNi4wNjY0MDYgNDUxLjM1MTU2MiA5Ny40OTYwOTQgQyA0NTEuMzUxNTYyIDg4Ljc0MjE4OCA0NTcuNTI3MzQ0IDgyLjY2MDE1NiA0NzIuNjM2NzE5IDgyLjY2MDE1NiBMIDQ4NC4wNjY0MDYgODIuNjYwMTU2IEMgNDg0LjA2NjQwNiA3Ni40ODQzNzUgNDgwLjM3ODkwNiA3Mi44OTQ1MzEgNDcyLjYzNjcxOSA3Mi44OTQ1MzEgQyA0NjcuMzg2NzE5IDcyLjg5NDUzMSA0NjEuOTQ5MjE5IDc0LjY0NDUzMSA0NTguMzU1NDY5IDc3LjUgTCA0NTMuMTk1MzEyIDY3LjQ1NzAzMSBDIDQ1OC42MzI4MTIgNjMuNTg1OTM4IDQ2Ni42NDg0MzggNjEuNDY0ODQ0IDQ3NC41NzQyMTkgNjEuNDY0ODQ0IEMgNDg5LjY4NzUgNjEuNDY0ODQ0IDQ5OC40NDE0MDYgNjguNDY4NzUgNDk4LjQ0MTQwNiA4My40ODgyODEgTCA0OTguNDQxNDA2IDExMS43NzczNDQgTCA0ODQuOTg4MjgxIDExMS43NzczNDQgWiBNIDQ4NC45ODgyODEgMTA1LjY5NTMxMiAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTAwJSwgMTAwJSwgMTAwJSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSA1MTAuMDQ2ODc1IDYyLjIwMzEyNSBMIDUyMy43NzczNDQgNjIuMjAzMTI1IEwgNTIzLjc3NzM0NCA2OC43NDYwOTQgQyA1MjcuMjc3MzQ0IDYzLjk1MzEyNSA1MzMuMTc1NzgxIDYxLjQ2NDg0NCA1NDAuODI0MjE5IDYxLjQ2NDg0NCBMIDU0MC44MjQyMTkgNzQuNzM0Mzc1IEMgNTM5LjYyNSA3NC42NDQ1MzEgNTM4LjcwMzEyNSA3NC41NTA3ODEgNTM3LjU5NzY1NiA3NC41NTA3ODEgQyA1MjkuNjc1NzgxIDc0LjU1MDc4MSA1MjQuNDIxODc1IDc4Ljg4MjgxMiA1MjQuNDIxODc1IDg4LjM3NSBMIDUyNC40MjE4NzUgMTExLjc3NzM0NCBMIDUxMC4wNDY4NzUgMTExLjc3NzM0NCBaIE0gNTEwLjA0Njg3NSA2Mi4yMDMxMjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNTk5LjQyNTc4MSA4Mi4wMTU2MjUgTCA1NTkuMDY2NDA2IDgyLjAxNTYyNSBMIDU1OS4wNjY0MDYgMTExLjc3NzM0NCBMIDU1Mi4yNDYwOTQgMTExLjc3NzM0NCBMIDU1Mi4yNDYwOTQgNDcuMjc3MzQ0IEwgNTU5LjA2NjQwNiA0Ny4yNzczNDQgTCA1NTkuMDY2NDA2IDc2LjAyNzM0NCBMIDU5OS40MjU3ODEgNzYuMDI3MzQ0IEwgNTk5LjQyNTc4MSA0Ny4yNzczNDQgTCA2MDYuMTUyMzQ0IDQ3LjI3NzM0NCBMIDYwNi4xNTIzNDQgMTExLjc3NzM0NCBMIDU5OS40MjU3ODEgMTExLjc3NzM0NCBaIE0gNTk5LjQyNTc4MSA4Mi4wMTU2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNjYwLjQyMTg3NSA4NC42ODc1IEMgNjU5LjU5Mzc1IDc1LjE5NTMxMiA2NTIuNjgzNTk0IDY4LjU2MjUgNjQzLjE5MTQwNiA2OC41NjI1IEMgNjMzLjc5Mjk2OSA2OC41NjI1IDYyNi44ODI4MTIgNzUuMTk1MzEyIDYyNi4wNTQ2ODggODQuNjg3NSBaIE0gNjE5LjUxMTcxOSA4Ny41NDI5NjkgQyA2MTkuNTExNzE5IDczLjE2Nzk2OSA2MjkuNTU0Njg4IDYyLjk0MTQwNiA2NDMuMTkxNDA2IDYyLjk0MTQwNiBDIDY1Ni44MjgxMjUgNjIuOTQxNDA2IDY2Ni42ODc1IDcyLjk4NDM3NSA2NjYuNjg3NSA4Ny41NDI5NjkgQyA2NjYuNjg3NSA4OC4wOTc2NTYgNjY2LjU5NzY1NiA4OC44MzIwMzEgNjY2LjU5NzY1NiA4OS41NzAzMTIgTCA2MjUuOTYwOTM4IDg5LjU3MDMxMiBDIDYyNi42OTkyMTkgOTkuNjE3MTg4IDYzNC40Mzc1IDEwNi40MzM1OTQgNjQ1LjEyNSAxMDYuNDMzNTk0IEMgNjUxLjAyMzQzOCAxMDYuNDMzNTk0IDY1Ni4yNzczNDQgMTA0LjMxNjQwNiA2NTkuOTYwOTM4IDEwMC4wNzQyMTkgTCA2NjMuNjQ4NDM4IDEwNC4zMTY0MDYgQyA2NTkuMzE2NDA2IDEwOS40NzY1NjIgNjUyLjU4OTg0NCAxMTIuMjM4MjgxIDY0NC45NDUzMTIgMTEyLjIzODI4MSBDIDYyOS44MzIwMzEgMTEyLjIzODI4MSA2MTkuNTExNzE5IDEwMS45MTc5NjkgNjE5LjUxMTcxOSA4Ny41NDI5NjkgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzA4LjcwMzEyNSA4OS4yOTY4NzUgTCA2OTMuNSA4OS4yOTY4NzUgQyA2ODQuMTAxNTYyIDg5LjI5Njg3NSA2ODEuMDYyNSA5Mi45ODA0NjkgNjgxLjA2MjUgOTcuOTU3MDMxIEMgNjgxLjA2MjUgMTAzLjU3ODEyNSA2ODUuNTc0MjE5IDEwNy4wNzgxMjUgNjkzLjMxNjQwNiAxMDcuMDc4MTI1IEMgNzAwLjY4NzUgMTA3LjA3ODEyNSA3MDYuMTI1IDEwMy41NzgxMjUgNzA4LjcwMzEyNSA5Ny4yMTg3NSBaIE0gNzA4Ljk4MDQ2OSAxMDQuMjIyNjU2IEMgNzA2LjAzMTI1IDEwOS4xOTUzMTIgNzAwLjMyMDMxMiAxMTIuMjM4MjgxIDY5Mi4zMDQ2ODggMTEyLjIzODI4MSBDIDY4MS4zMzU5MzggMTEyLjIzODI4MSA2NzQuNjA5Mzc1IDEwNi41MjczNDQgNjc0LjYwOTM3NSA5OC4xNDA2MjUgQyA2NzQuNjA5Mzc1IDkwLjY3NTc4MSA2NzkuNDAyMzQ0IDg0LjQxMDE1NiA2OTMuMzE2NDA2IDg0LjQxMDE1NiBMIDcwOC43MDMxMjUgODQuNDEwMTU2IEwgNzA4LjcwMzEyNSA4MS40NjA5MzggQyA3MDguNzAzMTI1IDczLjE2Nzk2OSA3MDQuMDAzOTA2IDY4LjY1MjM0NCA2OTQuOTc2NTYyIDY4LjY1MjM0NCBDIDY4OC43MTA5MzggNjguNjUyMzQ0IDY4Mi44MTI1IDcwLjg2NzE4OCA2NzguODUxNTYyIDc0LjM2NzE4OCBMIDY3NS45MDIzNDQgNjkuNDg0Mzc1IEMgNjgwLjc4NTE1NiA2NS4zMzU5MzggNjg3Ljk3MjY1NiA2Mi45NDE0MDYgNjk1LjYyMTA5NCA2Mi45NDE0MDYgQyA3MDguMTUyMzQ0IDYyLjk0MTQwNiA3MTUuMjQ2MDk0IDY5LjIwNzAzMSA3MTUuMjQ2MDk0IDgxLjczODI4MSBMIDcxNS4yNDYwOTQgMTExLjc3NzM0NCBMIDcwOC45ODA0NjkgMTExLjc3NzM0NCBaIE0gNzA4Ljk4MDQ2OSAxMDQuMjIyNjU2ICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxMDAlLCAxMDAlLCAxMDAlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDczMS42NDQ1MzEgNDMuNDA2MjUgTCA3MzguMTg3NSA0My40MDYyNSBMIDczOC4xODc1IDExMS43NzczNDQgTCA3MzEuNjQ0NTMxIDExMS43NzczNDQgWiBNIDczMS42NDQ1MzEgNDMuNDA2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzU2LjE1NjI1IDk4LjE0MDYyNSBMIDc1Ni4xNTYyNSA2OC44MzU5MzggTCA3NDcuNDkyMTg4IDY4LjgzNTkzOCBMIDc0Ny40OTIxODggNjMuMzA4NTk0IEwgNzU2LjE1NjI1IDYzLjMwODU5NCBMIDc1Ni4xNTYyNSA1Mi43MTA5MzggTCA3NjIuNjk5MjE5IDUyLjcxMDkzOCBMIDc2Mi42OTkyMTkgNjMuMzA4NTk0IEwgNzc3LjQ0MTQwNiA2My4zMDg1OTQgTCA3NzcuNDQxNDA2IDY4LjgzNTkzOCBMIDc2Mi42OTkyMTkgNjguODM1OTM4IEwgNzYyLjY5OTIxOSA5Ny43NzM0MzggQyA3NjIuNjk5MjE5IDEwMy40ODQzNzUgNzY1LjY0NDUzMSAxMDYuNjE3MTg4IDc3MS4wODIwMzEgMTA2LjYxNzE4OCBDIDc3My43NTM5MDYgMTA2LjYxNzE4OCA3NzYuNDI1NzgxIDEwNS43ODkwNjIgNzc4LjI2OTUzMSAxMDQuMTI4OTA2IEwgNzgwLjU3NDIxOSAxMDguODI4MTI1IEMgNzc3Ljk5MjE4OCAxMTEuMTMyODEyIDc3NC4xMjUgMTEyLjIzODI4MSA3NzAuMzQzNzUgMTEyLjIzODI4MSBDIDc2MS4yMjI2NTYgMTEyLjIzODI4MSA3NTYuMTU2MjUgMTA3LjA3ODEyNSA3NTYuMTU2MjUgOTguMTQwNjI1ICIvPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcC00KSI+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDEwMCUsIDEwMCUsIDEwMCUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzkxLjA3ODEyNSA0My40MDYyNSBMIDc5Ny42MjEwOTQgNDMuNDA2MjUgTCA3OTcuNjIxMDk0IDcxLjc4NTE1NiBDIDgwMS4xMjEwOTQgNjYuMTY3OTY5IDgwNy41NzAzMTIgNjIuOTQxNDA2IDgxNS43NzM0MzggNjIuOTQxNDA2IEMgODI3LjU2NjQwNiA2Mi45NDE0MDYgODM1LjY3NTc4MSA2OS43NTc4MTIgODM1LjY3NTc4MSA4My42NzE4NzUgTCA4MzUuNjc1NzgxIDExMS43NzczNDQgTCA4MjkuMTMyODEyIDExMS43NzczNDQgTCA4MjkuMTMyODEyIDg0LjMyMDMxMiBDIDgyOS4xMzI4MTIgNzQuMDg5ODQ0IDgyMy43ODkwNjIgNjguODM5ODQ0IDgxNC41NzQyMTkgNjguODM5ODQ0IEMgODA0LjE2MDE1NiA2OC44Mzk4NDQgNzk3LjYyMTA5NCA3NS4yODkwNjIgNzk3LjYyMTA5NCA4Ni4zNDc2NTYgTCA3OTcuNjIxMDk0IDExMS43NzczNDQgTCA3OTEuMDc4MTI1IDExMS43NzczNDQgWiBNIDc5MS4wNzgxMjUgNDMuNDA2MjUgIi8+CjwvZz4KPC9zdmc+Cg==" alt="Allymar Health"></div>
        <h1>Welcome <span>back.</span></h1>
        <p class="muted">Log your hours and send invoices.</p>
        <form class="form" id="login" novalidate>
          <label class="field">Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
          <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
          <p class="form-error" id="err"></p>
          <button class="btn primary big block">Sign in</button>
        </form>
        <p class="hint mt">Forgot your password? Ask ${esc(S.settings.ownerName)} for a new one.</p>
      </div></div>`;
    const form = document.getElementById('login');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/login', { username: form.username.value, password: form.password.value });
        S.csrf = r.csrf;
        await loadMe();
        go('#/');
      } catch (err) {
        document.getElementById('err').textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- hours: one pay period at a time
  // Every 2 weeks -> a two-week calendar. Once a month -> the whole month.
  // The arrows step to the previous/next pay period with no end in either direction.
  async function renderHours(start, personId) {
    const owner = isOwner();
    const main = loading(owner ? 'people' : 'hours');
    let v;
    try {
      v = await api('GET', (owner ? `/api/owner/people/${personId}/period` : '/api/my/period') + (start ? `?start=${start}` : ''));
    } catch (err) { return failed(main, err); }
    const p = v.period;
    const base = owner ? `#/people/${personId}/` : '#/hours/';
    const entries = Object.fromEntries(v.entries.map((e) => [e.date, e]));
    const locked = !!v.invoice || owner;
    const isCurrent = p.start <= v.today && v.today <= p.end;
    const sched = v.schedule;
    const monthly = sched.type === 'monthly';
    const ownerName = S.settings.ownerName;
    const cur = PP.periodFor(v.today, sched);
    const state = !v.invoice ? '' : v.invoice.status === 'paid' ? 'paid' : 'sent';
    const title = monthly && p.start.slice(8) === '01' ? fmt(p.start, { month: 'long', year: 'numeric' }) : range(p.start, p.end);

    main.innerHTML = `
      ${owner ? `<a class="back" href="#/people">← People</a>` : ''}
      <div class="page-head">
        <div><h1>${owner ? esc(v.person.name) : 'My hours'}</h1>
        <p class="muted">${owner ? `${esc(v.person.email)} · ${money(v.person.rate)}/hr` : `Tap the arrows to add time (30 minutes each), or tap the number to type it. Then send your hours to ${esc(first(S.settings.ownerName))}.`}</p></div>
      </div>
      <section class="card period ${state ? 'is-' + state : ''}">
        <div class="period-top">
          <div class="period-nav">
            <a class="icon-btn" href="${base}${v.prevStart}" aria-label="Previous pay period">‹</a>
            <div class="period-title"><span class="period-kicker">${isCurrent ? 'This pay period' : 'Pay period'} · ${esc(PP.label(sched).toLowerCase())}</span>
              <span class="period-dates">${esc(title)}</span></div>
            <a class="icon-btn" href="${base}${v.nextStart}" aria-label="Next pay period">›</a>
            ${!isCurrent ? `<a class="btn sm" href="${base}${cur.start}">Back to today</a>` : ''}
          </div>
          ${paydayPill(p.due, 'Payday', v.invoice && v.invoice.status !== 'paid' && daysUntil(p.due) < 0)}
        </div>
        <dl class="totals">
          <div class="total"><dt>Hours</dt><dd id="t-hours">${hrs(v.hours)}</dd></div>
          <div class="total"><dt>Rate</dt><dd>${money(v.rate)}<span class="unit">/hr</span></dd></div>
          <div class="total big"><dt>Amount</dt><dd id="t-amount">${money(v.amount)}</dd></div>
        </dl>
        ${owner ? '' : stepsHtml(state)}
        <div class="period-action" id="action"></div>
      </section>
      <section class="card cal mt ${state ? 'is-' + state : ''}">
        ${state ? `<div class="lock-bar">${ICON_LOCK}<span>${state === 'paid'
          ? `Paid ${money(v.invoice.paymentAmount)} on ${esc(fmtMDY(v.invoice.processDate))}. These days are locked.`
          : `Sent to ${esc(ownerName)} on ${esc(fmtMDY(v.invoice.sentAt.slice(0, 10)))}. These days are locked${owner ? '' : ' while it waits for payment'}.`}</span></div>` : ''}
        <div class="cal-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div>${d}</div>`).join('')}</div>
        <div class="cal-grid" id="grid"></div>
      </section>
      <div class="legend"><span><i class="sw due"></i>Payday</span><span><i class="sw today"></i>Today</span><span><i class="sw sent"></i>Sent, locked</span><span><i class="sw paid"></i>Paid</span><span><i class="sw out"></i>Not in this pay period</span></div>`;

    const action = main.querySelector('#action');
    if (v.invoice && owner) {
      const inv = v.invoice;
      action.innerHTML = `
        <div class="status-line">${invoiceBadge(inv)}<span>Invoice <strong>${esc(inv.number)}</strong></span></div>
        <a class="btn" href="#/invoice/${inv.id}">View invoice</a>`;
    } else if (v.invoice) {
      const inv = v.invoice;
      action.innerHTML = inv.status === 'paid'
        ? `<div class="status-line"><span class="badge b-paid">Paid</span><span>${esc(ownerName)} paid you <strong>${money(inv.paymentAmount)}</strong> on ${esc(fmtMDY(inv.processDate))}.</span></div>`
        : `<div class="status-line"><span class="badge b-sent">Sent · locked</span><span>${esc(ownerName)} has your hours. Payday is ${esc(fmtLong(inv.dueDate))}.</span></div>`;
    } else if (owner) {
      action.innerHTML = `<div class="status-line">${invoiceBadge(null)}<span class="muted">${esc(first(v.person.name))} hasn’t sent an invoice for this pay period.</span></div>`;
    } else {
      action.innerHTML = `
        <p class="hint">When your hours are done, send them to ${esc(ownerName)}. The days lock after you send.</p>
        <button class="btn primary big" id="send" ${v.hours > 0 && p.start <= v.today ? '' : 'disabled'}>Send my hours to ${esc(first(ownerName))}</button>`;
      main.querySelector('#send').addEventListener('click', () => confirmSend({ ...p, hours: v.hours, rate: v.rate, amount: v.amount }));
    }

    // Full weeks from the Monday on/before the first day through the payday.
    const lastShown = p.due > p.end ? p.due : p.end;
    const gStart = PP.addDays(p.start, -((PP.weekday(p.start) + 6) % 7));
    const gEnd = PP.addDays(lastShown, (7 - PP.weekday(lastShown)) % 7);
    const grid = main.querySelector('#grid');
    grid.innerHTML = PP.eachDay(gStart, gEnd).map((d) => {
      const inP = d >= p.start && d <= p.end;
      const e = entries[d];
      const isDue = d === p.due;
      const cls = ['day', inP ? '' : 'out', d === v.today ? 'today' : '', isDue ? 'is-due' : '', e && e.hours > 0 ? 'has' : ''].join(' ');
      const tags = (isDue ? '<span class="d-tag">Payday</span>' : '') + (d === v.today ? '<span class="d-tag today-tag">Today</span>' : '');
      const showMonth = d === gStart || d.slice(8) === '01';
      const top = `<div class="d-top"><span><span class="d-dow">${fmt(d, { weekday: 'short' })}</span><span class="d-num">${fmt(d, { month: showMonth ? 'short' : undefined, day: 'numeric' })}</span></span>${tags}</div>`;
      if (!inP) return `<div class="${cls}">${top}</div>`;
      const h = e ? e.hours : 0;
      if (locked) {
        return `<div class="${cls}">${top}<div class="hours-ro">${dayHrs(h)}<span class="hrs-unit"> hrs</span></div>${e && e.notes ? `<div class="note-ro" title="${esc(e.notes)}">${esc(e.notes)}</div>` : ''}</div>`;
      }
      return `<div class="${cls}" data-date="${d}">${top}
        <div class="stepper">
          <button class="step down" data-step="-0.5" aria-label="30 minutes less on ${fmtDay(d)}">${ICON_DOWN}</button>
          <label class="hours-box"><input class="hours" inputmode="decimal" value="${dayHrs(h)}" aria-label="Hours on ${fmtDay(d)}"><span class="hrs-unit">hrs</span></label>
          <button class="step up" data-step="0.5" aria-label="30 minutes more on ${fmtDay(d)}">${ICON_UP}</button>
        </div>
        <button class="note-btn${e && e.notes ? ' has-note' : ''}" data-note>${e && e.notes ? esc(e.notes) : '+ Note'}</button>
      </div>`;
    }).join('');

    if (locked) return;
    const timers = {};
    const refreshTotals = () => {
      const total = Object.values(entries).reduce((a, e) => a + (e.date >= p.start && e.date <= p.end ? e.hours : 0), 0);
      v.hours = total; v.amount = Math.round(total * v.rate * 100) / 100;
      main.querySelector('#t-hours').textContent = hrs(total);
      main.querySelector('#t-amount').textContent = money(v.amount);
      const send = main.querySelector('#send');
      if (send) send.disabled = !(total > 0);
    };
    const save = (date) => {
      clearTimeout(timers[date]);
      timers[date] = setTimeout(async () => {
        const e = entries[date] || { date, hours: 0, notes: '' };
        try { await api('PUT', `/api/my/entries/${date}`, { hours: e.hours, notes: e.notes }); } catch (err) { toast(err.message, 'error'); }
      }, 350);
    };
    const setHours = (cell, val) => {
      const date = cell.dataset.date;
      const h = Math.min(24, Math.max(0, Math.round(val * 4) / 4));
      entries[date] = { ...(entries[date] || { date, notes: '' }), hours: h };
      cell.querySelector('.hours').value = dayHrs(h);
      cell.classList.toggle('has', h > 0);
      refreshTotals();
      save(date);
    };
    const parseHours = (s) => {
      s = String(s).trim();
      const m = s.match(/^(\d{1,2}):(\d{2})$/);
      if (m) return +m[1] + +m[2] / 60;
      const n = parseFloat(s.replace(',', '.'));
      return Number.isFinite(n) ? n : 0;
    };
    grid.addEventListener('click', (ev) => {
      const cell = ev.target.closest('.day[data-date]');
      if (!cell) return;
      const step = ev.target.closest('[data-step]');
      if (step) { const c = entries[cell.dataset.date]?.hours || 0; setHours(cell, c + Number(step.dataset.step)); return; }
      if (ev.target.closest('[data-note]')) editNote(cell.dataset.date, entries, (notes) => {
        entries[cell.dataset.date] = { ...(entries[cell.dataset.date] || { date: cell.dataset.date, hours: 0 }), notes };
        const b = cell.querySelector('.note-btn');
        b.textContent = notes || '+ Note'; b.classList.toggle('has-note', !!notes);
        save(cell.dataset.date);
      });
    });
    grid.addEventListener('focusin', (ev) => { if (ev.target.classList.contains('hours')) ev.target.select(); });
    grid.addEventListener('change', (ev) => {
      if (ev.target.classList.contains('hours')) setHours(ev.target.closest('.day'), parseHours(ev.target.value));
    });
    grid.addEventListener('keydown', (ev) => {
      if (ev.target.classList.contains('hours') && ev.key === 'Enter') ev.target.blur();
    });
  }

  /** The three things a person does each pay period, with where they are now. */
  function stepsHtml(state) {
    const at = state === 'paid' ? 3 : state === 'sent' ? 2 : 0;
    const steps = ['Add your hours', `Send them to ${first(S.settings.ownerName)}`, 'Get paid on payday'];
    return `<ol class="steps">${steps.map((t, i) => {
      const cls = i < at ? 'done' : i === at ? 'now' : '';
      return `<li class="${cls}"><span class="n">${i < at ? '✓' : i + 1}</span>${esc(t)}</li>`;
    }).join('')}</ol>`;
  }

  function editNote(date, entries, done) {
    const cur = entries[date]?.notes || '';
    openModal(`
      <h2>Note for ${esc(fmtLong(date))}</h2>
      <form id="nf" class="form">
        <label class="field">What did you work on? <small>Optional. Shows on your invoice.</small>
          <textarea name="notes" maxlength="500">${esc(cur)}</textarea></label>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save note</button></div>
      </form>`, (m) => {
      m.querySelector('#nf').addEventListener('submit', (e) => { e.preventDefault(); done(e.target.notes.value.trim()); modal.close(); });
    });
  }

  function confirmSend(p) {
    const early = S.today < p.end;
    const ownerName = S.settings.ownerName;
    openModal(`
      <h2>Send your hours?</h2>
      <p class="muted">This sends ${esc(S.settings.ownerName)} your hours for:</p>
      <ul class="sum-list">
        <li><span>Pay period</span><span>${esc(range(p.start, p.end))}</span></li>
        <li><span>Hours</span><span>${hrs(p.hours)}</span></li>
        <li><span>Rate</span><span>${money(p.rate)}/hr</span></li>
        <li><span>Amount due</span><span>${money(p.amount)}</span></li>
      </ul>
      <p>${paydayPill(p.due, 'Due')}</p>
      ${early ? `<p class="notice">Your pay period isn’t over until ${esc(fmtLong(p.end))}. If you send now, you can’t add more hours for this period.</p>` : ''}
      <p class="form-error" id="err"></p>
      <div class="modal-actions"><button class="btn" data-close>Not yet</button><button class="btn primary" id="go">Send my hours</button></div>`, (m) => {
      m.querySelector('#go').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await api('POST', '/api/my/invoices', { start: p.start });
          modal.close();
          toast(`Sent to ${S.settings.ownerName}`);
          renderHours(p.start);
        } catch (err) { m.querySelector('#err').textContent = err.message; e.target.disabled = false; }
      });
    });
  }

  // ---------------------------------------------------------------- invoice list (both roles)
  async function renderInvoices(filter) {
    const owner = isOwner();
    const main = loading('invoices');
    let list;
    try { list = (await api('GET', owner ? '/api/owner/invoices' : '/api/my/invoices')).invoices; } catch (err) { return failed(main, err); }
    filter = filter || (owner ? 'unpaid' : 'all');
    const shown = list.filter((i) => filter === 'all' || (filter === 'paid' ? i.status === 'paid' : i.status !== 'paid'));
    const count = (f) => list.filter((i) => f === 'all' || (f === 'paid' ? i.status === 'paid' : i.status !== 'paid')).length;
    const totalAmt = shown.reduce((a, i) => a + i.amount, 0);
    const totalPaid = shown.reduce((a, i) => a + (i.paymentAmount || 0), 0);

    main.innerHTML = `
      <div class="page-head"><div><h1>${owner ? 'Invoices' : 'My invoices'}</h1>
        <p class="muted">${owner ? 'Invoices your people have sent you. The due date is highlighted.' : `Invoices you’ve sent to ${esc(S.settings.ownerName)}.`}</p></div></div>
      <section class="card">
        <div class="chips">${[['unpaid', 'Waiting for payment'], ['paid', 'Paid'], ['all', 'All']].map(([k, t]) =>
          `<a class="chip ${k === filter ? 'on' : ''}" href="#/invoices/${k}">${t} (${count(k)})</a>`).join('')}</div>
        <div class="table-wrap"><table class="table cards">
          <thead><tr>${owner ? '<th>Person</th>' : ''}<th>Invoice #</th><th>Due Date</th><th class="r">Amount</th><th class="r">Payment Amount</th><th>Process Date</th><th>Status</th></tr></thead>
          <tbody>${shown.length ? shown.map((i) => {
            const late = i.status !== 'paid' && daysUntil(i.dueDate) < 0;
            return `<tr class="click" data-id="${i.id}">
              ${owner ? `<td class="first" data-label="Person"><span class="pname">${esc(i.personName)}</span></td>` : ''}
              <td class="${owner ? '' : 'first'}" data-label="Invoice #"><a class="pname" href="#/invoice/${i.id}">${esc(i.number)}</a></td>
              <td data-label="Due Date">${i.status !== 'paid' ? `<span class="payday sm${late ? ' late' : ''}">${esc(mdy(i.dueDate))}</span>` : esc(mdy(i.dueDate))}</td>
              <td class="r" data-label="Amount">${money(i.amount)}</td>
              <td class="r" data-label="Payment Amount">${i.paymentAmount != null ? money(i.paymentAmount) : ''}</td>
              <td data-label="Process Date">${esc(mdy(i.processDate))}</td>
              <td data-label="Status">${invoiceBadge(i)}</td></tr>`;
          }).join('') : `<tr><td class="empty" colspan="7">${filter === 'unpaid' ? 'Nothing waiting for payment.' : 'No invoices yet.'}</td></tr>`}</tbody>
          ${shown.length ? `<tfoot><tr><td>Total:</td>${owner ? '<td></td>' : ''}<td></td><td class="r">${money(totalAmt)}</td><td class="r">${totalPaid ? money(totalPaid) : ''}</td><td></td><td></td></tr></tfoot>` : ''}
        </table></div>
      </section>`;
    main.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
      if (!e.target.closest('a')) go(`#/invoice/${tr.dataset.id}`);
    }));
  }

  // ---------------------------------------------------------------- one invoice
  async function renderInvoice(id) {
    const owner = isOwner();
    const main = loading('invoices');
    let r;
    try { r = await api('GET', `/api/invoices/${id}`); } catch (err) { return failed(main, err); }
    const inv = r.invoice;
    const st = r.settings;
    const paid = inv.status === 'paid';
    const late = !paid && PP.diffDays(r.today, inv.dueDate) < 0;

    main.innerHTML = `
      <div class="inv-actions no-print">
        <a class="back flush" href="#/invoices">← ${owner ? 'Invoices' : 'My invoices'}</a>
        <div class="btn-row">
          ${owner && !paid ? '<button class="btn primary" id="pay">Mark as paid</button>' : ''}
          ${owner && paid ? '<button class="btn" id="unpay">Mark as not paid</button>' : ''}
          ${owner && !paid ? '<button class="btn danger" id="sendback">Send back for changes</button>' : ''}
          
        </div>
      </div>
      <div class="inv-status no-print">${invoiceBadge(inv)} ${!paid ? `<span class="muted gap-l">Due ${esc(fmtLong(inv.dueDate))} · ${whenText(inv.dueDate)}</span>` : ''}</div>
      <article class="invoice">
        <img class="inv-logo" src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyByb2xlPSJpbWciIGFyaWEtbGFiZWw9IkFsbHltYXIgSGVhbHRoIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iODM1LjgzOCIgaGVpZ2h0PSIxNjAiIHZpZXdCb3g9IjAgMCA4MzUuODM4IDE2MCI+CjxkZWZzPgo8Y2xpcFBhdGggaWQ9ImNsaXAtMCI+CjxwYXRoIGNsaXAtcnVsZT0ibm9uemVybyIgZD0iTSAwIDAuMDE1NjI1IEwgMTYwIDAuMDE1NjI1IEwgMTYwIDE1OS45ODQzNzUgTCAwIDE1OS45ODQzNzUgWiBNIDAgMC4wMTU2MjUgIi8+CjwvY2xpcFBhdGg+CjxjbGlwUGF0aCBpZD0iY2xpcC0xIj4KPHBhdGggY2xpcC1ydWxlPSJub256ZXJvIiBkPSJNIDAgMC4wMTU2MjUgTCAxMzQgMC4wMTU2MjUgTCAxMzQgMTU5Ljk4NDM3NSBMIDAgMTU5Ljk4NDM3NSBaIE0gMCAwLjAxNTYyNSAiLz4KPC9jbGlwUGF0aD4KPGNsaXBQYXRoIGlkPSJjbGlwLTIiPgo8cGF0aCBjbGlwLXJ1bGU9Im5vbnplcm8iIGQ9Ik0gMTggMC4wMTU2MjUgTCAxNTcgMC4wMTU2MjUgTCAxNTcgMTQ3IEwgMTggMTQ3IFogTSAxOCAwLjAxNTYyNSAiLz4KPC9jbGlwUGF0aD4KPGNsaXBQYXRoIGlkPSJjbGlwLTMiPgo8cGF0aCBjbGlwLXJ1bGU9Im5vbnplcm8iIGQ9Ik0gNzkxIDQzIEwgODM1LjY3NTc4MSA0MyBMIDgzNS42NzU3ODEgMTEyIEwgNzkxIDExMiBaIE0gNzkxIDQzICIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+CjxnIGNsaXAtcGF0aD0idXJsKCNjbGlwLTApIj4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTcuNjQ2NzklLCAxOC4wMzg5NCUsIDI0LjcwNTUwNSUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzkuOTg0Mzc1IDAuMDE1NjI1IEMgMTI0LjE2MDE1NiAwLjAxNTYyNSAxNTkuOTY4NzUgMzUuODI0MjE5IDE1OS45Njg3NSA4MCBDIDE1OS45Njg3NSAxMjQuMTc1NzgxIDEyNC4xNjAxNTYgMTU5Ljk4NDM3NSA3OS45ODQzNzUgMTU5Ljk4NDM3NSBDIDM1LjgwODU5NCAxNTkuOTg0Mzc1IDAgMTI0LjE3NTc4MSAwIDgwIEMgMCAzNS44MjQyMTkgMzUuODA4NTk0IDAuMDE1NjI1IDc5Ljk4NDM3NSAwLjAxNTYyNSAiLz4KPC9nPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYig5MC41ODgzNzklLCA1MC41ODg5ODklLCA1MC4xOTY4MzglKSIgc3Ryb2tlLW9wYWNpdHk9IjEiIHN0cm9rZS1taXRlcmxpbWl0PSI0LjYiIGQ9Ik0gLTAuMDAxNDM3ODkgMC4wMDA2MDc0NjIgTCA3OS4yMDE0MSAwLjAwMDYwNzQ2MiAiIHRyYW5zZm9ybT0ibWF0cml4KDAuOTk5ODA2LCAwLCAwLCAtMC45OTk4MDYsIDUyLjg4NDI1LCA5NC42MDIxNykiLz4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAtMSkiPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYigzNy4yNTQzMzMlLCA3Ny42NDc0JSwgNzguODIzODUzJSkiIHN0cm9rZS1vcGFjaXR5PSIxIiBzdHJva2UtbWl0ZXJsaW1pdD0iNC42IiBkPSJNIC0wLjAwMTE4MDQxIC0wLjAwMTA1Nzc4IEwgNDQuNjg3MTY3IDc5LjA2MTEzOCAiIHRyYW5zZm9ybT0ibWF0cml4KDAuOTk5ODA2LCAwLCAwLCAtMC45OTk4MDYsIDM2LjYzNzg5OSwgMTIzLjM0NjU5OSkiLz4KPC9nPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcC0yKSI+CjxwYXRoIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iOC4wNSIgc3Ryb2tlLWxpbmVjYXA9ImJ1dHQiIHN0cm9rZS1saW5lam9pbj0ibWl0ZXIiIHN0cm9rZT0icmdiKDkyLjE1Njk4MiUsIDgzLjEzNzUxMiUsIDU4LjgyNDE1OCUpIiBzdHJva2Utb3BhY2l0eT0iMSIgc3Ryb2tlLW1pdGVybGltaXQ9IjQuNiIgZD0iTSAwLjAwMTU5OTI4IC0wLjAwMTc1OTg5IEwgMzMuMzUxODEyIC03Mi40NDkzOTMgIiB0cmFuc2Zvcm09Im1hdHJpeCgwLjk5OTgwNiwgMCwgMCwgLTAuOTk5ODA2LCA3MS4xMzEyMTQsIDIyLjE2NjIwOSkiLz4KPC9nPgo8cGF0aCBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjguMDUiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2U9InJnYig5MC41ODgzNzklLCA1MC41ODg5ODklLCA1MC4xOTY4MzglKSIgc3Ryb2tlLW9wYWNpdHk9IjEiIHN0cm9rZS1taXRlcmxpbWl0PSI0LjYiIGQ9Ik0gLTAuMDAwNDE3MDE5IDAuMDAwNjA3NDYyIEwgMjMuMDAwMTM0IDAuMDAwNjA3NDYyICIgdHJhbnNmb3JtPSJtYXRyaXgoMC45OTk4MDYsIDAsIDAsIC0wLjk5OTgwNiwgOTIuOTc2OTc5LCA5NC42MDIxNykiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoOTIuMTU2OTgyJSwgODMuMTM3NTEyJSwgNTguODI0MTU4JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSA3MS4xMzI4MTIgOC4xNDA2MjUgQyA3OC44Nzg5MDYgOC4xNDA2MjUgODUuMTYwMTU2IDE0LjQxNzk2OSA4NS4xNjAxNTYgMjIuMTY3OTY5IEMgODUuMTYwMTU2IDI5LjkxNDA2MiA3OC44Nzg5MDYgMzYuMTk1MzEyIDcxLjEzMjgxMiAzNi4xOTUzMTIgQyA2My4zODI4MTIgMzYuMTk1MzEyIDU3LjEwNTQ2OSAyOS45MTQwNjIgNTcuMTA1NDY5IDIyLjE2Nzk2OSBDIDU3LjEwNTQ2OSAxNC40MTc5NjkgNjMuMzgyODEyIDguMTQwNjI1IDcxLjEzMjgxMiA4LjE0MDYyNSAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoOTAuNTg4Mzc5JSwgNTAuNTg4OTg5JSwgNTAuMTk2ODM4JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSAxMzIuMDcwMzEyIDgwLjU3NDIxOSBDIDEzOS44MTY0MDYgODAuNTc0MjE5IDE0Ni4wOTc2NTYgODYuODU1NDY5IDE0Ni4wOTc2NTYgOTQuNjAxNTYyIEMgMTQ2LjA5NzY1NiAxMDIuMzUxNTYyIDEzOS44MTY0MDYgMTA4LjYyODkwNiAxMzIuMDcwMzEyIDEwOC42Mjg5MDYgQyAxMjQuMzIwMzEyIDEwOC42Mjg5MDYgMTE4LjA0Mjk2OSAxMDIuMzUxNTYyIDExOC4wNDI5NjkgOTQuNjAxNTYyIEMgMTE4LjA0Mjk2OSA4Ni44NTU0NjkgMTI0LjMyMDMxMiA4MC41NzQyMTkgMTMyLjA3MDMxMiA4MC41NzQyMTkgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDM3LjI1NDMzMyUsIDc3LjY0NzQlLCA3OC44MjM4NTMlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDM2LjYzNjcxOSAxMDkuMzIwMzEyIEMgNDQuMzg2NzE5IDEwOS4zMjAzMTIgNTAuNjY0MDYyIDExNS41OTc2NTYgNTAuNjY0MDYyIDEyMy4zNDc2NTYgQyA1MC42NjQwNjIgMTMxLjA5Mzc1IDQ0LjM4NjcxOSAxMzcuMzc1IDM2LjYzNjcxOSAxMzcuMzc1IEMgMjguODkwNjI1IDEzNy4zNzUgMjIuNjA5Mzc1IDEzMS4wOTM3NSAyMi42MDkzNzUgMTIzLjM0NzY1NiBDIDIyLjYwOTM3NSAxMTUuNTk3NjU2IDI4Ljg5MDYyNSAxMDkuMzIwMzEyIDM2LjYzNjcxOSAxMDkuMzIwMzEyICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxNy42NDY3OSUsIDE4LjAzODk0JSwgMjQuNzA1NTA1JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSAyMjIuNDc2NTYyIDg2LjYyMTA5NCBMIDIxMi4yNSA2Mi4wMTk1MzEgTCAyMDEuOTI5Njg4IDg2LjYyMTA5NCBaIE0gMjA0Ljk2ODc1IDQ3LjI3NzM0NCBMIDIxOS43MTA5MzggNDcuMjc3MzQ0IEwgMjQ4LjU1NDY4OCAxMTEuNzc3MzQ0IEwgMjMyLjg5MDYyNSAxMTEuNzc3MzQ0IEwgMjI3LjE3NTc4MSA5Ny45NTcwMzEgTCAxOTcuMjMwNDY5IDk3Ljk1NzAzMSBMIDE5MS41MTU2MjUgMTExLjc3NzM0NCBMIDE3Ni4yMTg3NSAxMTEuNzc3MzQ0IFogTSAyMDQuOTY4NzUgNDcuMjc3MzQ0ICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxNy42NDY3OSUsIDE4LjAzODk0JSwgMjQuNzA1NTA1JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSAyNTIuODgyODEyIDQzLjQwNjI1IEwgMjY3LjI1MzkwNiA0My40MDYyNSBMIDI2Ny4yNTM5MDYgMTExLjc3NzM0NCBMIDI1Mi44ODI4MTIgMTExLjc3NzM0NCBaIE0gMjUyLjg4MjgxMiA0My40MDYyNSAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTcuNjQ2NzklLCAxOC4wMzg5NCUsIDI0LjcwNTUwNSUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gMjc5LjIzNDM3NSA0My40MDYyNSBMIDI5My42MDkzNzUgNDMuNDA2MjUgTCAyOTMuNjA5Mzc1IDExMS43NzczNDQgTCAyNzkuMjM0Mzc1IDExMS43NzczNDQgWiBNIDI3OS4yMzQzNzUgNDMuNDA2MjUgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDE3LjY0Njc5JSwgMTguMDM4OTQlLCAyNC43MDU1MDUlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDI5OC4wMzEyNSAxMjUuODc1IEwgMzAzLjI4MTI1IDExNS42NDg0MzggQyAzMDUuNDkyMTg4IDExNy41ODIwMzEgMzA4LjUzNTE1NiAxMTguNzgxMjUgMzExLjM5MDYyNSAxMTguNzgxMjUgQyAzMTUuMzUxNTYyIDExOC43ODEyNSAzMTcuNTYyNSAxMTcuMDMxMjUgMzE5LjUgMTEyLjYwOTM3NSBMIDMxOS42ODM1OTQgMTEyLjE0ODQzOCBMIDI5OC4yMTQ4NDQgNjIuMjAzMTI1IEwgMzEzLjA1MDc4MSA2Mi4yMDMxMjUgTCAzMjYuOTY0ODQ0IDk1LjkyOTY4OCBMIDM0MC45Njg3NSA2Mi4yMDMxMjUgTCAzNTQuNzg5MDYyIDYyLjIwMzEyNSBMIDMzMi4zOTg0MzggMTE0LjgxNjQwNiBDIDMyNy42MDkzNzUgMTI2Ljc5Njg3NSAzMjAuNzg5MDYyIDEzMC4zOTA2MjUgMzExLjg1MTU2MiAxMzAuMzkwNjI1IEMgMzA2Ljc4MTI1IDEzMC4zOTA2MjUgMzAxLjI1MzkwNiAxMjguNzMwNDY5IDI5OC4wMzEyNSAxMjUuODc1ICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxNy42NDY3OSUsIDE4LjAzODk0JSwgMjQuNzA1NTA1JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSAzNTkuMzA0Njg4IDYyLjIwMzEyNSBMIDM3My4wMzEyNSA2Mi4yMDMxMjUgTCAzNzMuMDMxMjUgNjcuOTE3OTY5IEMgMzc2LjcxODc1IDYzLjY3OTY4OCAzODIuMjUgNjEuNDY0ODQ0IDM4OC42MDU0NjkgNjEuNDY0ODQ0IEMgMzk1LjUxNTYyNSA2MS40NjQ4NDQgNDAxLjUwMzkwNiA2NC4xNDA2MjUgNDA0LjkxNDA2MiA2OS41NzQyMTkgQyA0MDguODc4OTA2IDY0LjUwNzgxMiA0MTUuMzI4MTI1IDYxLjQ2NDg0NCA0MjIuNzkyOTY5IDYxLjQ2NDg0NCBDIDQzNC41ODU5MzggNjEuNDY0ODQ0IDQ0My4wNjI1IDY4LjI4NTE1NiA0NDMuMDYyNSA4My4zOTg0MzggTCA0NDMuMDYyNSAxMTEuNzc3MzQ0IEwgNDI4LjY4NzUgMTExLjc3NzM0NCBMIDQyOC42ODc1IDg1LjYwOTM3NSBDIDQyOC42ODc1IDc3LjU5Mzc1IDQyNS4wOTM3NSA3My45MDYyNSA0MTkuMjkyOTY5IDczLjkwNjI1IEMgNDEyLjgzOTg0NCA3My45MDYyNSA0MDguMzI0MjE5IDc4LjA1NDY4OCA0MDguMzI0MjE5IDg2Ljg5ODQzOCBMIDQwOC4zMjQyMTkgMTExLjc3NzM0NCBMIDM5My45NDkyMTkgMTExLjc3NzM0NCBMIDM5My45NDkyMTkgODUuNjA5Mzc1IEMgMzkzLjk0OTIxOSA3Ny41OTM3NSAzOTAuNTQyOTY5IDczLjkwNjI1IDM4NC41NTA3ODEgNzMuOTA2MjUgQyAzNzguMTk1MzEyIDczLjkwNjI1IDM3My42Nzk2ODggNzguMDU0Njg4IDM3My42Nzk2ODggODYuODk4NDM4IEwgMzczLjY3OTY4OCAxMTEuNzc3MzQ0IEwgMzU5LjMwNDY4OCAxMTEuNzc3MzQ0IFogTSAzNTkuMzA0Njg4IDYyLjIwMzEyNSAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTcuNjQ2NzklLCAxOC4wMzg5NCUsIDI0LjcwNTUwNSUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNDg0LjA2NjQwNiA5MS4wNDY4NzUgTCA0NzQuMjA3MDMxIDkxLjA0Njg3NSBDIDQ2Ny40ODA0NjkgOTEuMDQ2ODc1IDQ2NS4zNTkzNzUgOTMuNTM1MTU2IDQ2NS4zNTkzNzUgOTYuODUxNTYyIEMgNDY1LjM1OTM3NSAxMDAuNDQ1MzEyIDQ2OC4zOTg0MzggMTAyLjgzOTg0NCA0NzMuNDY4NzUgMTAyLjgzOTg0NCBDIDQ3OC4yNTc4MTIgMTAyLjgzOTg0NCA0ODIuNDA2MjUgMTAwLjYyODkwNiA0ODQuMDY2NDA2IDk2LjExMzI4MSBaIE0gNDg0Ljk4ODI4MSAxMDUuNjk1MzEyIEMgNDgyLjIyMjY1NiAxMTAuMTE3MTg4IDQ3Ny4xNTYyNSAxMTIuNTE1NjI1IDQ2OS44NzUgMTEyLjUxNTYyNSBDIDQ1OC4yNjU2MjUgMTEyLjUxNTYyNSA0NTEuMzUxNTYyIDEwNi4wNjY0MDYgNDUxLjM1MTU2MiA5Ny40OTYwOTQgQyA0NTEuMzUxNTYyIDg4Ljc0MjE4OCA0NTcuNTI3MzQ0IDgyLjY2MDE1NiA0NzIuNjM2NzE5IDgyLjY2MDE1NiBMIDQ4NC4wNjY0MDYgODIuNjYwMTU2IEMgNDg0LjA2NjQwNiA3Ni40ODQzNzUgNDgwLjM3ODkwNiA3Mi44OTQ1MzEgNDcyLjYzNjcxOSA3Mi44OTQ1MzEgQyA0NjcuMzg2NzE5IDcyLjg5NDUzMSA0NjEuOTQ5MjE5IDc0LjY0NDUzMSA0NTguMzU1NDY5IDc3LjUgTCA0NTMuMTk1MzEyIDY3LjQ1NzAzMSBDIDQ1OC42MzI4MTIgNjMuNTg1OTM4IDQ2Ni42NDg0MzggNjEuNDY0ODQ0IDQ3NC41NzQyMTkgNjEuNDY0ODQ0IEMgNDg5LjY4NzUgNjEuNDY0ODQ0IDQ5OC40NDE0MDYgNjguNDY4NzUgNDk4LjQ0MTQwNiA4My40ODgyODEgTCA0OTguNDQxNDA2IDExMS43NzczNDQgTCA0ODQuOTg4MjgxIDExMS43NzczNDQgWiBNIDQ4NC45ODgyODEgMTA1LjY5NTMxMiAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTcuNjQ2NzklLCAxOC4wMzg5NCUsIDI0LjcwNTUwNSUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNTEwLjA0Njg3NSA2Mi4yMDMxMjUgTCA1MjMuNzc3MzQ0IDYyLjIwMzEyNSBMIDUyMy43NzczNDQgNjguNzQ2MDk0IEMgNTI3LjI3NzM0NCA2My45NTMxMjUgNTMzLjE3NTc4MSA2MS40NjQ4NDQgNTQwLjgyNDIxOSA2MS40NjQ4NDQgTCA1NDAuODI0MjE5IDc0LjczNDM3NSBDIDUzOS42MjUgNzQuNjQ0NTMxIDUzOC43MDMxMjUgNzQuNTUwNzgxIDUzNy41OTc2NTYgNzQuNTUwNzgxIEMgNTI5LjY3NTc4MSA3NC41NTA3ODEgNTI0LjQyMTg3NSA3OC44ODI4MTIgNTI0LjQyMTg3NSA4OC4zNzUgTCA1MjQuNDIxODc1IDExMS43NzczNDQgTCA1MTAuMDQ2ODc1IDExMS43NzczNDQgWiBNIDUxMC4wNDY4NzUgNjIuMjAzMTI1ICIvPgo8cGF0aCBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9InJnYigxNy42NDY3OSUsIDE4LjAzODk0JSwgMjQuNzA1NTA1JSkiIGZpbGwtb3BhY2l0eT0iMSIgZD0iTSA1OTkuNDI1NzgxIDgyLjAxNTYyNSBMIDU1OS4wNjY0MDYgODIuMDE1NjI1IEwgNTU5LjA2NjQwNiAxMTEuNzc3MzQ0IEwgNTUyLjI0NjA5NCAxMTEuNzc3MzQ0IEwgNTUyLjI0NjA5NCA0Ny4yNzczNDQgTCA1NTkuMDY2NDA2IDQ3LjI3NzM0NCBMIDU1OS4wNjY0MDYgNzYuMDI3MzQ0IEwgNTk5LjQyNTc4MSA3Ni4wMjczNDQgTCA1OTkuNDI1NzgxIDQ3LjI3NzM0NCBMIDYwNi4xNTIzNDQgNDcuMjc3MzQ0IEwgNjA2LjE1MjM0NCAxMTEuNzc3MzQ0IEwgNTk5LjQyNTc4MSAxMTEuNzc3MzQ0IFogTSA1OTkuNDI1NzgxIDgyLjAxNTYyNSAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTcuNjQ2NzklLCAxOC4wMzg5NCUsIDI0LjcwNTUwNSUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNjYwLjQyMTg3NSA4NC42ODc1IEMgNjU5LjU5Mzc1IDc1LjE5NTMxMiA2NTIuNjgzNTk0IDY4LjU2MjUgNjQzLjE5MTQwNiA2OC41NjI1IEMgNjMzLjc5Mjk2OSA2OC41NjI1IDYyNi44ODI4MTIgNzUuMTk1MzEyIDYyNi4wNTQ2ODggODQuNjg3NSBaIE0gNjE5LjUxMTcxOSA4Ny41NDI5NjkgQyA2MTkuNTExNzE5IDczLjE2Nzk2OSA2MjkuNTU0Njg4IDYyLjk0MTQwNiA2NDMuMTkxNDA2IDYyLjk0MTQwNiBDIDY1Ni44MjgxMjUgNjIuOTQxNDA2IDY2Ni42ODc1IDcyLjk4NDM3NSA2NjYuNjg3NSA4Ny41NDI5NjkgQyA2NjYuNjg3NSA4OC4wOTc2NTYgNjY2LjU5NzY1NiA4OC44MzIwMzEgNjY2LjU5NzY1NiA4OS41NzAzMTIgTCA2MjUuOTYwOTM4IDg5LjU3MDMxMiBDIDYyNi42OTkyMTkgOTkuNjE3MTg4IDYzNC40Mzc1IDEwNi40MzM1OTQgNjQ1LjEyNSAxMDYuNDMzNTk0IEMgNjUxLjAyMzQzOCAxMDYuNDMzNTk0IDY1Ni4yNzczNDQgMTA0LjMxNjQwNiA2NTkuOTYwOTM4IDEwMC4wNzQyMTkgTCA2NjMuNjQ4NDM4IDEwNC4zMTY0MDYgQyA2NTkuMzE2NDA2IDEwOS40NzY1NjIgNjUyLjU4OTg0NCAxMTIuMjM4MjgxIDY0NC45NDUzMTIgMTEyLjIzODI4MSBDIDYyOS44MzIwMzEgMTEyLjIzODI4MSA2MTkuNTExNzE5IDEwMS45MTc5NjkgNjE5LjUxMTcxOSA4Ny41NDI5NjkgIi8+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDE3LjY0Njc5JSwgMTguMDM4OTQlLCAyNC43MDU1MDUlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDcwOC43MDMxMjUgODkuMjk2ODc1IEwgNjkzLjUgODkuMjk2ODc1IEMgNjg0LjEwMTU2MiA4OS4yOTY4NzUgNjgxLjA2MjUgOTIuOTgwNDY5IDY4MS4wNjI1IDk3Ljk1NzAzMSBDIDY4MS4wNjI1IDEwMy41NzgxMjUgNjg1LjU3NDIxOSAxMDcuMDc4MTI1IDY5My4zMTY0MDYgMTA3LjA3ODEyNSBDIDcwMC42ODc1IDEwNy4wNzgxMjUgNzA2LjEyNSAxMDMuNTc4MTI1IDcwOC43MDMxMjUgOTcuMjE4NzUgWiBNIDcwOC45ODA0NjkgMTA0LjIyMjY1NiBDIDcwNi4wMzEyNSAxMDkuMTk1MzEyIDcwMC4zMjAzMTIgMTEyLjIzODI4MSA2OTIuMzA0Njg4IDExMi4yMzgyODEgQyA2ODEuMzM1OTM4IDExMi4yMzgyODEgNjc0LjYwOTM3NSAxMDYuNTI3MzQ0IDY3NC42MDkzNzUgOTguMTQwNjI1IEMgNjc0LjYwOTM3NSA5MC42NzU3ODEgNjc5LjQwMjM0NCA4NC40MTAxNTYgNjkzLjMxNjQwNiA4NC40MTAxNTYgTCA3MDguNzAzMTI1IDg0LjQxMDE1NiBMIDcwOC43MDMxMjUgODEuNDYwOTM4IEMgNzA4LjcwMzEyNSA3My4xNjc5NjkgNzA0LjAwMzkwNiA2OC42NTIzNDQgNjk0Ljk3NjU2MiA2OC42NTIzNDQgQyA2ODguNzEwOTM4IDY4LjY1MjM0NCA2ODIuODEyNSA3MC44NjcxODggNjc4Ljg1MTU2MiA3NC4zNjcxODggTCA2NzUuOTAyMzQ0IDY5LjQ4NDM3NSBDIDY4MC43ODUxNTYgNjUuMzM1OTM4IDY4Ny45NzI2NTYgNjIuOTQxNDA2IDY5NS42MjEwOTQgNjIuOTQxNDA2IEMgNzA4LjE1MjM0NCA2Mi45NDE0MDYgNzE1LjI0NjA5NCA2OS4yMDcwMzEgNzE1LjI0NjA5NCA4MS43MzgyODEgTCA3MTUuMjQ2MDk0IDExMS43NzczNDQgTCA3MDguOTgwNDY5IDExMS43NzczNDQgWiBNIDcwOC45ODA0NjkgMTA0LjIyMjY1NiAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTcuNjQ2NzklLCAxOC4wMzg5NCUsIDI0LjcwNTUwNSUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzMxLjY0NDUzMSA0My40MDYyNSBMIDczOC4xODc1IDQzLjQwNjI1IEwgNzM4LjE4NzUgMTExLjc3NzM0NCBMIDczMS42NDQ1MzEgMTExLjc3NzM0NCBaIE0gNzMxLjY0NDUzMSA0My40MDYyNSAiLz4KPHBhdGggZmlsbC1ydWxlPSJub256ZXJvIiBmaWxsPSJyZ2IoMTcuNjQ2NzklLCAxOC4wMzg5NCUsIDI0LjcwNTUwNSUpIiBmaWxsLW9wYWNpdHk9IjEiIGQ9Ik0gNzU2LjE1NjI1IDk4LjE0MDYyNSBMIDc1Ni4xNTYyNSA2OC44MzU5MzggTCA3NDcuNDkyMTg4IDY4LjgzNTkzOCBMIDc0Ny40OTIxODggNjMuMzA4NTk0IEwgNzU2LjE1NjI1IDYzLjMwODU5NCBMIDc1Ni4xNTYyNSA1Mi43MTA5MzggTCA3NjIuNjk5MjE5IDUyLjcxMDkzOCBMIDc2Mi42OTkyMTkgNjMuMzA4NTk0IEwgNzc3LjQ0MTQwNiA2My4zMDg1OTQgTCA3NzcuNDQxNDA2IDY4LjgzNTkzOCBMIDc2Mi42OTkyMTkgNjguODM1OTM4IEwgNzYyLjY5OTIxOSA5Ny43NzM0MzggQyA3NjIuNjk5MjE5IDEwMy40ODQzNzUgNzY1LjY0NDUzMSAxMDYuNjE3MTg4IDc3MS4wODIwMzEgMTA2LjYxNzE4OCBDIDc3My43NTM5MDYgMTA2LjYxNzE4OCA3NzYuNDI1NzgxIDEwNS43ODkwNjIgNzc4LjI2OTUzMSAxMDQuMTI4OTA2IEwgNzgwLjU3NDIxOSAxMDguODI4MTI1IEMgNzc3Ljk5MjE4OCAxMTEuMTMyODEyIDc3NC4xMjUgMTEyLjIzODI4MSA3NzAuMzQzNzUgMTEyLjIzODI4MSBDIDc2MS4yMjI2NTYgMTEyLjIzODI4MSA3NTYuMTU2MjUgMTA3LjA3ODEyNSA3NTYuMTU2MjUgOTguMTQwNjI1ICIvPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcC0zKSI+CjxwYXRoIGZpbGwtcnVsZT0ibm9uemVybyIgZmlsbD0icmdiKDE3LjY0Njc5JSwgMTguMDM4OTQlLCAyNC43MDU1MDUlKSIgZmlsbC1vcGFjaXR5PSIxIiBkPSJNIDc5MS4wNzgxMjUgNDMuNDA2MjUgTCA3OTcuNjIxMDk0IDQzLjQwNjI1IEwgNzk3LjYyMTA5NCA3MS43ODUxNTYgQyA4MDEuMTIxMDk0IDY2LjE2Nzk2OSA4MDcuNTcwMzEyIDYyLjk0MTQwNiA4MTUuNzczNDM4IDYyLjk0MTQwNiBDIDgyNy41NjY0MDYgNjIuOTQxNDA2IDgzNS42NzU3ODEgNjkuNzU3ODEyIDgzNS42NzU3ODEgODMuNjcxODc1IEwgODM1LjY3NTc4MSAxMTEuNzc3MzQ0IEwgODI5LjEzMjgxMiAxMTEuNzc3MzQ0IEwgODI5LjEzMjgxMiA4NC4zMjAzMTIgQyA4MjkuMTMyODEyIDc0LjA4OTg0NCA4MjMuNzg5MDYyIDY4LjgzOTg0NCA4MTQuNTc0MjE5IDY4LjgzOTg0NCBDIDgwNC4xNjAxNTYgNjguODM5ODQ0IDc5Ny42MjEwOTQgNzUuMjg5MDYyIDc5Ny42MjEwOTQgODYuMzQ3NjU2IEwgNzk3LjYyMTA5NCAxMTEuNzc3MzQ0IEwgNzkxLjA3ODEyNSAxMTEuNzc3MzQ0IFogTSA3OTEuMDc4MTI1IDQzLjQwNjI1ICIvPgo8L2c+Cjwvc3ZnPgo=" alt="Allymar Health">
        <h1 class="inv-business">${esc(st.business)}</h1>
        <div class="inv-meta">
          <div><p class="lbl">From</p><p><strong>${esc(r.person.name)}</strong></p><p>${esc(r.person.email)}</p></div>
          <div><p class="lbl">Bill to</p><p><strong>${esc(st.ownerName)}</strong></p><p>${esc(st.business)}</p></div>
          <div><p class="lbl">Sent</p><p>${esc(mdy(inv.sentAt.slice(0, 10)))}</p></div>
        </div>
        <table class="inv-table">
          <thead><tr><th>Invoice #</th><th>Due Date</th><th>Amount</th><th>Payment Amount</th><th>Process Date</th><th>Description</th></tr></thead>
          <tbody><tr>
            <td>${esc(inv.number)}</td>
            <td class="${paid ? '' : 'inv-due' + (late ? ' late' : '')}">${esc(mdy(inv.dueDate))}</td>
            <td>${money(inv.amount)}</td>
            <td>${inv.paymentAmount != null ? money(inv.paymentAmount) : ''}</td>
            <td>${esc(mdy(inv.processDate))}</td>
            <td>${esc(inv.description)}</td>
          </tr></tbody>
          <tfoot><tr><td>Total:</td><td></td><td>${paid ? '' : money(inv.amount)}</td><td>${paid ? money(inv.paymentAmount) : ''}</td><td></td><td></td></tr></tfoot>
        </table>
        <p class="inv-sub">Hours worked</p>
        <table class="inv-days">
          <thead><tr><th>Date</th><th>Note</th><th class="r">Hours</th></tr></thead>
          <tbody>${r.entries.filter((e) => e.hours > 0 || e.notes).map((e) => `<tr><td>${esc(fmtDay(e.date))}</td><td>${esc(e.notes)}</td><td class="r">${hrs(e.hours)}</td></tr>`).join('')
            || '<tr><td colspan="3">No hours logged.</td></tr>'}</tbody>
          <tfoot><tr><td>Total</td><td>${hrs(inv.hours)} hrs × ${money(inv.rate)}/hr</td><td class="r">${hrs(inv.hours)}</td></tr></tfoot>
        </table>
        ${st.phone ? `<p class="inv-foot">Have questions about this invoice? Contact ${esc(st.business)} at ${esc(st.phone)}.</p>` : ''}
        <p class="inv-foot">Thank you,<br>${esc(r.person.name)}</p>
      </article>`;

    
    if (!owner) return;
    const pay = main.querySelector('#pay');
    if (pay) pay.addEventListener('click', () => openModal(`
      <h2>Mark ${esc(inv.number)} as paid</h2>
      <p class="muted">${esc(r.person.name)} · ${money(inv.amount)} due ${esc(mdy(inv.dueDate))}</p>
      <form class="form" id="pf">
        <label class="field">Payment amount<div class="money-input"><span>$</span><input name="amount" inputmode="decimal" value="${inv.amount.toFixed(2)}"></div></label>
        <label class="field">Process date<input name="date" type="date" value="${esc(r.today)}"></label>
        <p class="form-error" id="err"></p>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Mark as paid</button></div>
      </form>`, (m) => {
      m.querySelector('#pf').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('POST', `/api/owner/invoices/${inv.id}/pay`, { paymentAmount: e.target.amount.value, processDate: e.target.date.value });
          modal.close(); toast('Marked as paid'); renderInvoice(id);
        } catch (err) { m.querySelector('#err').textContent = err.message; }
      });
    }));
    const unpay = main.querySelector('#unpay');
    if (unpay) unpay.addEventListener('click', async () => {
      try { await api('POST', `/api/owner/invoices/${inv.id}/unpay`); toast('Marked as not paid'); renderInvoice(id); } catch (err) { toast(err.message, 'error'); }
    });
    const sb = main.querySelector('#sendback');
    if (sb) sb.addEventListener('click', () => openModal(`
      <h2>Send this invoice back?</h2>
      <p>${esc(first(r.person.name))} will be able to fix their hours for ${esc(range(inv.periodStart, inv.periodEnd))} and send a new invoice. This invoice will be removed.</p>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Send back</button></div>`, (m) => {
      m.querySelector('#go').addEventListener('click', async () => {
        try { await api('DELETE', `/api/owner/invoices/${inv.id}`); modal.close(); toast('Sent back for changes'); go('#/invoices'); } catch (err) { toast(err.message, 'error'); }
      });
    }));
  }

  // ---------------------------------------------------------------- owner: everyone's current pay period
  async function renderOwnerHome() {
    const main = loading('home');
    let v;
    try { v = await api('GET', '/api/owner/overview'); } catch (err) { return failed(main, err); }
    const rows = v.rows;
    const dues = rows.map((r) => r.period.due).filter((d) => d >= v.today).sort();
    const nextDue = dues[0];
    const dueNames = rows.filter((r) => r.period.due === nextDue).map((r) => first(r.name));
    const totA = rows.reduce((a, r) => a + r.amount, 0);
    const sent = rows.filter((r) => r.invoice).length;

    main.innerHTML = `
      ${nextDue ? `<div class="reminder">
        <div class="ico">${ICON_CAL}</div>
        <div><strong>Next payday: ${esc(fmtLong(nextDue))}</strong>
        <span>${whenText(nextDue).replace(/^./, (c) => c.toUpperCase())} · ${esc(dueNames.join(', '))}</span></div>
      </div>` : ''}
      <div class="page-head mt"><div><h1>This pay period</h1>
        <p class="muted">Each person’s current pay period, on their own schedule.</p></div>
        <dl class="totals"><div class="total"><dt>Invoices in</dt><dd>${sent} of ${rows.length}</dd></div>
          <div class="total big"><dt>Total so far</dt><dd>${money(totA)}</dd></div></dl></div>
      <section class="card"><div class="table-wrap"><table class="table cards">
        <thead><tr><th>Person</th><th>Schedule</th><th>Pay period</th><th>Payday</th><th class="r">Hours</th><th class="r">Amount</th><th>Invoice</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `<tr>
          <td class="first" data-label="Person"><a class="pname" href="#/people/${r.id}/${r.period.start}">${esc(r.name)}</a></td>
          <td data-label="Schedule">${esc(PP.label(r.schedule))}</td>
          <td data-label="Pay period">${esc(range(r.period.start, r.period.end))}</td>
          <td data-label="Payday"><span class="payday sm">${esc(fmtDay(r.period.due))}</span></td>
          <td class="r" data-label="Hours">${hrs(r.hours)}</td>
          <td class="r" data-label="Amount"><strong>${money(r.amount)}</strong></td>
          <td data-label="Invoice">${invoiceBadge(r.invoice)}</td>
          <td class="actions r">${r.invoice ? `<a class="btn sm" href="#/invoice/${r.invoice.id}">View invoice</a>` : `<a class="btn sm ghost" href="#/people/${r.id}/${r.period.start}">See hours</a>`}</td>
        </tr>`).join('') : `<tr><td class="empty" colspan="8">No one here yet. <a href="#/people">Add your first person</a>.</td></tr>`}</tbody>
      </table></div></section>`;
  }

  // ---------------------------------------------------------------- worker: pay history
  async function renderHistory() {
    const main = loading('history');
    let h;
    try { h = await api('GET', '/api/my/history'); } catch (err) { return failed(main, err); }
    main.innerHTML = `
      <div class="page-head"><div><h1>History</h1><p class="muted">What you’ve earned for each pay period you’ve sent.</p></div></div>
      <div class="tiles">
        <div class="card tile"><span class="tile-l">Paid in ${esc(h.year)}</span><span class="tile-v">${money(h.paidThisYear)}</span></div>
        <div class="card tile"><span class="tile-l">Waiting for payment</span><span class="tile-v gold">${money(h.waiting)}</span></div>
        <div class="card tile"><span class="tile-l">Paid all time</span><span class="tile-v">${money(h.paidAllTime)}</span></div>
      </div>
      <section class="card mt"><div class="table-wrap"><table class="table cards">
        <thead><tr><th>Pay period</th><th>Payday</th><th class="r">Hours</th><th class="r">Rate</th><th class="r">Amount</th><th>Status</th></tr></thead>
        <tbody>${h.rows.length ? h.rows.map((r) => `<tr class="click" data-start="${r.periodStart}">
          <td class="first" data-label="Pay period"><a class="pname" href="#/hours/${r.periodStart}">${esc(range(r.periodStart, r.periodEnd))}</a></td>
          <td data-label="Payday">${r.status === 'paid' ? esc(fmtDay(r.payday)) : `<span class="payday sm">${esc(fmtDay(r.payday))}</span>`}</td>
          <td class="r" data-label="Hours">${hrs(r.hours)}</td>
          <td class="r" data-label="Rate">${money(r.rate)}/hr</td>
          <td class="r" data-label="Amount"><strong>${money(r.status === 'paid' ? r.paidAmount : r.amount)}</strong></td>
          <td data-label="Status">${r.status === 'paid' ? `<span class="badge b-paid">Paid ${esc(mdy(r.paidOn))}</span>` : '<span class="badge b-sent">Waiting for payment</span>'}</td>
        </tr>`).join('') : '<tr><td class="empty" colspan="6">Nothing yet. After you send your hours for a pay period, it shows up here.</td></tr>'}</tbody>
      </table></div></section>`;
    main.querySelectorAll('tr[data-start]').forEach((tr) => tr.addEventListener('click', (e) => {
      if (!e.target.closest('a')) go(`#/hours/${tr.dataset.start}`);
    }));
  }

  // ---------------------------------------------------------------- owner: people
  function showLogin(person, username, password, isNew) {
    const url = location.origin + '/';
    const msg = `Hi ${first(person.name)},\n\nHere's your login for ${S.settings.business} hours and invoices:\n\n${url}\nUsername: ${username}\nPassword: ${password}`;
    openModal(`
      <h2>${isNew ? `${esc(person.name)} is added` : `New password for ${esc(person.name)}`}</h2>
      <p class="muted">Give ${esc(first(person.name))} these sign-in details.</p>
      <div class="cred"><span class="cred-label">Website</span><code>${esc(url)}</code><button class="btn sm" data-copy="${esc(url)}">Copy</button></div>
      <div class="cred"><span class="cred-label">Username</span><code>${esc(username)}</code><button class="btn sm" data-copy="${esc(username)}">Copy</button></div>
      <div class="cred"><span class="cred-label">Password</span><code>${esc(password)}</code><button class="btn sm" data-copy="${esc(password)}">Copy</button></div>
      <p class="notice">Save or send this now. For safety, the password won’t be shown again. You can always make a new one.</p>
      <div class="modal-actions">
        <button class="btn" id="copyall">Copy message</button><button class="btn primary" data-close>Done</button>
      </div>`, (m) => {
      m.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
      m.querySelector('#copyall').addEventListener('click', (e) => copy(msg, e.target));
    });
  }

  function personForm(person) {
    const edit = !!person;
    const sch = PP.normalize(person ? person.schedule : PP.DEFAULT_SCHEDULE);
    openModal(`
      <h2>${edit ? `Edit ${esc(person.name)}` : 'Add a person'}</h2>
      ${edit ? '' : '<p class="muted">We’ll make a username and password for them.</p>'}
      <form class="form" id="pf" novalidate>
        <label class="field">Full name<input name="name" autocomplete="off" value="${esc(person?.name || '')}" placeholder="Lou Sirard"></label>
        <label class="field">Email<input name="email" type="email" autocomplete="off" value="${esc(person?.email || '')}" placeholder="name@example.com"></label>
        <label class="field">Hourly rate<div class="money-input"><span>$</span><input name="rate" inputmode="decimal" value="${person ? person.rate.toFixed(2) : ''}" placeholder="45.00"></div>
          ${edit ? '<small>A new rate applies to invoices sent from now on.</small>' : ''}</label>
        <div class="field"><span>How often are they paid?</span>
          <div class="choice-group three">
            ${[['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Once a month']].map(([k, t]) =>
              `<label class="choice"><input type="radio" name="type" value="${k}" ${sch.type === k ? 'checked' : ''}><div><strong>${t}</strong></div></label>`).join('')}
          </div></div>
        <label class="field" id="pdField">Pick one of their paydays<input name="payday" type="date" value="${esc(sch.payday || PP.DEFAULT_SCHEDULE.payday)}"></label>
        <div><p class="hint" id="pdHint"></p><div class="upcoming" id="upcoming"></div></div>
        <p class="form-error" id="err"></p>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${edit ? 'Save' : 'Add person'}</button></div>
      </form>`, (m) => {
      const f0 = m.querySelector('#pf');
      const preview = () => {
        const type = f0.type.value;
        m.querySelector('#pdField').hidden = type === 'monthly';
        const s2 = type === 'monthly' ? { type } : { type, payday: f0.payday.value };
        m.querySelector('#pdHint').textContent = type === 'monthly' ? 'Paid on the last day of each month. Coming paydays:' : 'Coming paydays:';
        if (type !== 'monthly' && !PP.isValidDate(f0.payday.value)) { m.querySelector('#upcoming').innerHTML = ''; return; }
        let pp = PP.periodFor(S.today, s2);
        if (pp.due < S.today) pp = PP.nextPeriod(pp, s2);
        const out = [];
        for (let i = 0; i < 3; i++) { out.push(`<span class="payday">${ICON_CAL}${esc(fmtDay(pp.due))}</span>`); pp = PP.nextPeriod(pp, s2); }
        m.querySelector('#upcoming').innerHTML = out.join('');
      };
      f0.addEventListener('change', preview);
      f0.payday.addEventListener('input', preview);
      preview();
      m.querySelector('#pf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, email: f.email.value, rate: f.rate.value, schedule: { type: f.type.value, payday: f.payday.value } };
        const btn = f.querySelector('.btn.primary'); btn.disabled = true;
        try {
          if (edit) {
            await api('PATCH', `/api/owner/people/${person.id}`, body);
            modal.close(); toast('Saved'); renderPeople();
          } else {
            const r = await api('POST', '/api/owner/people', body);
            renderPeople();
            showLogin(r.person, r.username, r.password, true);
          }
        } catch (err) { m.querySelector('#err').textContent = err.message; btn.disabled = false; }
      });
    });
  }

  async function renderPeople() {
    const main = loading('people');
    let people;
    try { people = (await api('GET', '/api/owner/people')).people; } catch (err) { return failed(main, err); }
    main.innerHTML = `
      <div class="page-head"><div><h1>People</h1><p class="muted">Everyone who logs hours and sends you invoices.</p></div>
        <button class="btn primary big" id="add">+ Add person</button></div>
      <section class="card"><div class="table-wrap"><table class="table cards">
        <thead><tr><th>Name</th><th>Email</th><th>Username</th><th>Paid</th><th class="r">Rate</th><th></th></tr></thead>
        <tbody>${people.length ? people.map((u) => `<tr>
          <td class="first" data-label="Name"><a class="pname" href="#/people/${u.id}">${esc(u.name)}</a> ${u.active ? '' : '<span class="badge b-off">Turned off</span>'}</td>
          <td data-label="Email">${esc(u.email)}</td>
          <td data-label="Username">${esc(u.username)}</td>
          <td data-label="Paid">${esc(PP.label(u.schedule))}</td>
          <td class="r" data-label="Rate">${money(u.rate)}/hr</td>
          <td class="actions r"><div class="btn-row end">
            <a class="btn sm" href="#/people/${u.id}">Hours</a>
            <button class="btn sm" data-edit="${u.id}">Edit</button>
            <button class="btn sm" data-pw="${u.id}">New password</button>
            <button class="btn sm ${u.active ? 'danger' : ''}" data-active="${u.id}">${u.active ? 'Turn off' : 'Turn on'}</button>
          </div></td></tr>`).join('') : '<tr><td class="empty" colspan="6">No one yet. Select <strong>Add person</strong> to get started.</td></tr>'}</tbody>
      </table></div></section>`;
    const byId = (id) => people.find((u) => u.id === Number(id));
    main.querySelector('#add').addEventListener('click', () => personForm(null));
    main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => personForm(byId(b.dataset.edit))));
    main.querySelectorAll('[data-pw]').forEach((b) => b.addEventListener('click', () => {
      const u = byId(b.dataset.pw);
      openModal(`<h2>Make a new password for ${esc(u.name)}?</h2><p>Their old password will stop working.</p>
        <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Make new password</button></div>`, (m) => {
        m.querySelector('#go').addEventListener('click', async () => {
          try { const r = await api('POST', `/api/owner/people/${u.id}/new-password`); showLogin(u, r.username, r.password, false); } catch (err) { toast(err.message, 'error'); }
        });
      });
    }));
    main.querySelectorAll('[data-active]').forEach((b) => b.addEventListener('click', async () => {
      const u = byId(b.dataset.active);
      try { await api('PATCH', `/api/owner/people/${u.id}`, { active: !u.active }); toast(u.active ? `${first(u.name)} is turned off` : `${first(u.name)} is turned on`); renderPeople(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  // ---------------------------------------------------------------- settings / account
  function passwordCard() {
    return `<section class="card pad">
      <h2>Your password</h2>
      <p class="muted">You sign in as <strong>${esc(S.user.username)}</strong>.</p>
      <form class="form" id="pwf" novalidate>
        <label class="field">Current password<input name="current" type="password" autocomplete="current-password"></label>
        <label class="field">New password <small>At least 10 characters.</small><input name="next" type="password" autocomplete="new-password"></label>
        <p class="form-error" id="pwerr"></p>
        <div><button class="btn">Change password</button></div>
      </form></section>`;
  }
  function wirePassword(main) {
    main.querySelector('#pwf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', '/api/account/password', { current: f.current.value, next: f.next.value });
        f.reset(); main.querySelector('#pwerr').textContent = ''; toast('Password changed');
      } catch (err) { main.querySelector('#pwerr').textContent = err.message; }
    });
  }

  function renderAccount() {
    const main = shell('account', `<div class="narrow stack"><h1>Account</h1>${passwordCard()}</div>`);
    wirePassword(main);
  }

  function renderSettings() {
    const st = S.settings;
    const main = shell('settings', `
      <div class="narrow stack">
        <h1>Settings</h1>
        <section class="card pad">
          <h2>Business details</h2>
          <form class="form" id="sf" novalidate>
            <label class="field">Business name <small>Shown at the top of every invoice.</small><input name="business" value="${esc(st.business)}"></label>
            <label class="field">Phone number <small>Shown on invoices for questions.</small><input name="phone" value="${esc(st.phone)}"></label>
            <p class="form-error" id="err"></p>
            <div><button class="btn primary">Save settings</button></div>
          </form>
          <p class="hint mt">Pay schedules are set for each person. Open <a href="#/people">People</a> and select <strong>Edit</strong>.</p>
        </section>
        ${passwordCard()}
      </div>`);
    const f = main.querySelector('#sf');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('PUT', '/api/owner/settings', { business: f.business.value, phone: f.phone.value });
        S.settings = r.settings; toast('Settings saved'); renderSettings();
      } catch (err) { main.querySelector('#err').textContent = err.message; }
    });
    wirePassword(main);
  }

  // ---------------------------------------------------------------- router
  async function loadMe() {
    const r = await api('GET', '/api/me');
    S.user = r.user; S.settings = r.settings; S.today = r.today;
    if (r.csrf) S.csrf = r.csrf;
    document.title = `${r.settings.business} · Hours & Invoices`;
  }

  async function route() {
    if (modal.open) modal.close();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const [page, a, b] = parts;
    if (!S.user) return page === 'login' ? renderLogin() : go('#/login');
    if (page === 'login' || !page) return go(isOwner() ? '#/home' : '#/hours');
    window.scrollTo(0, 0);
    if (isOwner()) {
      if (page === 'invoices') return renderInvoices(a);
      if (page === 'invoice') return renderInvoice(a);
      if (page === 'home') return renderOwnerHome();
      if (page === 'people') return a ? renderHours(b, a) : renderPeople();
      if (page === 'settings') return renderSettings();
      return go('#/home');
    }
    if (page === 'hours') return renderHours(a);
    if (page === 'history') return renderHistory();
    if (page === 'account') return renderAccount();
    return go('#/hours');
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a) return;
    e.preventDefault(); go(a.getAttribute('href'));
  });
  (async () => {
    try { await loadMe(); } catch (err) { app.innerHTML = `<p class="boot">${esc(err.message)}</p>`; return; }
    route();
  })();
})();
