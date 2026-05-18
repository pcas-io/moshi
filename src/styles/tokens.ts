export const CSS = `
:root {
  --color-ink: #111;
  --color-body: #222;
  --color-mid: #444;
  --color-muted: #666;
  --color-subtle: #888;
  --color-light: #999;
  --color-ghost: #ccc;
  --color-border: #e0e0e0;
  --color-divider: #eee;
  --color-surface: #fafafa;
  --color-page: #fff;
  --color-accent: #444;
  --color-link: #222;

  --color-status-active-bg: #e8ede9;  --color-status-active-text: #4a6b50;
  --color-status-planning-bg: #f2ece4; --color-status-planning-text: #7a6840;
  --color-status-paused-bg: #ececec;   --color-status-paused-text: #777;
  --color-status-done-bg: #e8edf2;     --color-status-done-text: #4a5f6b;
  --color-status-archived-bg: #ececec; --color-status-archived-text: #777;

  --font-sans: -apple-system, "system-ui", "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji";
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", monospace;
  --font-active: var(--font-sans);
}

*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; font-size: 20px; }
body {
  font-family: var(--font-active);
  background: var(--color-page);
  color: var(--color-body);
  line-height: 1.6;
  font-size: 1rem;
}
a { color: var(--color-link); text-decoration: none; }
a:hover { text-decoration: underline; }
.container { max-width: 1200px; margin: 0 auto; padding: 1.85rem 2.5rem; min-height: calc(100vh - 3rem); }

/* Navigation */
nav {
  background: var(--color-page);
  border-bottom: 1px solid var(--color-border);
  padding: 0.77rem 1.85rem;
  display: flex; gap: 0.3rem; align-items: center;
  position: sticky; top: 0; z-index: 40;
}
nav .brand {
  font-family: var(--font-mono);
  font-size: 1.08rem; font-weight: 700;
  color: var(--color-ink); margin-right: 1.23rem;
  letter-spacing: -0.02em;
}
nav a {
  color: var(--color-subtle);
  font-size: 0.85rem; font-weight: 500;
  padding: 0.31rem 0.54rem; border-radius: 0.46rem;
  transition: all 0.12s;
}
nav a:hover { color: var(--color-body); background: var(--color-surface); text-decoration: none; }
nav a.active { color: var(--color-ink); background: var(--color-surface); }

/* Stats Bar */
.stats-bar {
  display: flex; gap: 1.54rem; padding: 1.08rem 0;
  font-size: 0.85rem; color: var(--color-muted); font-weight: 500;
  flex-wrap: wrap;
}
.stats-bar strong {
  font-family: var(--font-mono); color: var(--color-ink);
  font-size: 1.15rem; font-weight: 700; letter-spacing: -0.02em;
}
.stat-box {
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: 0.46rem; padding: 0.92rem 1.23rem; display: flex;
  flex-direction: column; gap: 0.23rem; min-width: 120px;
}
.stat-box .stat-value {
  font-family: var(--font-mono); font-size: 1.54rem; font-weight: 700;
  color: var(--color-ink); letter-spacing: -0.03em;
}
.stat-box .stat-label {
  font-size: 0.77rem; color: var(--color-subtle); text-transform: uppercase;
  letter-spacing: 0.05em; font-weight: 600;
}

/* Badges */
.badge {
  font-size: 0.77rem; font-weight: 600;
  padding: 0.23rem 0.69rem; border-radius: 0.46rem;
  display: inline-block; letter-spacing: 0.04em;
}
.badge-active-status { background: #e8ede9; color: #4a7a4a; }
.badge-inactive-status { background: #f5e4e4; color: #904040; }
.badge-high { background: #fdecea; color: #c0392b; }
.badge-normal { background: #e8ede9; color: #4a7a4a; }
.badge-low { background: #ececec; color: #666; }

/* Tags */
.tag {
  font-size: 0.69rem; background: var(--color-surface); color: var(--color-muted);
  border: 1px solid var(--color-border); border-radius: 0.31rem;
  padding: 0.1rem 0.46rem; display: inline-block;
}

/* Activity List */
.activity-list { list-style: none; }
.activity-list li { padding: 0.46rem 0; border-bottom: 1px solid var(--color-divider); font-size: 0.92rem; color: var(--color-muted); }
.activity-list time { font-family: var(--font-mono); font-size: 0.77rem; color: var(--color-light); margin-right: 0.62rem; }

/* Headings */
h1 { font-weight: 700; color: var(--color-ink); letter-spacing: -0.02em; }
h2 { font-size: 0.69rem; font-weight: 700; margin-bottom: 0.77rem; color: var(--color-subtle); text-transform: uppercase; letter-spacing: 0.1em; }

/* Login */
.login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--color-surface); }
.login-box { background: var(--color-page); border: 1px solid var(--color-border); padding: 2.46rem; border-radius: 0.62rem; width: 100%; max-width: 340px; box-shadow: 0 12px 32px rgba(0,0,0,0.06); }
.login-box h1 { font-family: var(--font-mono); font-size: 1.38rem; text-align: center; margin-bottom: 1.85rem; color: var(--color-ink); }
.login-box input { width: 100%; padding: 0.69rem 0.92rem; background: var(--color-page); border: 1px solid var(--color-border); border-radius: 0.46rem; color: var(--color-body); font-family: var(--font-mono); font-size: 1rem; margin-bottom: 1.08rem; transition: border-color 0.12s; }
.login-box input:focus { outline: none; border-color: var(--color-mid); }
.login-box button { width: 100%; padding: 0.69rem 0.92rem; background: var(--color-ink); color: var(--color-page); border: none; border-radius: 0.46rem; font-weight: 600; cursor: pointer; font-size: 0.92rem; transition: background 0.12s; }
.login-box button:hover { background: var(--color-body); }
.login-box .error { color: #904040; font-size: 0.92rem; margin-bottom: 0.62rem; text-align: center; background: #fdf5f5; padding: 0.46rem; border-radius: 0.46rem; border: 1px solid #c08080; }

/* Empty state */
.empty { color: var(--color-light); font-size: 0.92rem; padding: 1.23rem 0; }

/* Table */
table { width: 100%; border-collapse: collapse; }
thead tr { border-bottom: 2px solid var(--color-border); }
th { padding: 0.62rem; font-size: 0.69rem; font-weight: 700; color: var(--color-subtle); text-align: left; text-transform: uppercase; letter-spacing: 0.1em; font-family: var(--font-mono); }
tbody tr { border-bottom: 1px solid var(--color-divider); transition: background 0.1s; }
tbody tr:hover { background: var(--color-surface); }
td { padding: 0.77rem 0.62rem; font-size: 0.92rem; }

/* Table wrapper for horizontal scroll on mobile */
.table-wrapper { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-ghost); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--color-subtle); }

/* Filter bar */
.filter-bar { display: flex; gap: 0.46rem; margin-bottom: 1rem; flex-wrap: wrap; align-items: center; }
.filter-bar input, .filter-bar select {
  padding: 0.31rem 0.62rem; font-size: 0.85rem; border: 1px solid var(--color-border);
  border-radius: 0.46rem; background: var(--color-page); color: var(--color-body);
  font-family: var(--font-active);
}
.filter-bar input:focus, .filter-bar select:focus { outline: none; border-color: var(--color-mid); }

/* Pagination */
.pagination { display: flex; align-items: center; gap: 0.77rem; padding: 1.23rem 0; font-size: 0.85rem; color: var(--color-muted); }
.pagination a { padding: 0.31rem 0.77rem; border: 1px solid var(--color-border); border-radius: 0.46rem; color: var(--color-body); }
.pagination a:hover { background: var(--color-surface); text-decoration: none; }
.pagination .current { font-family: var(--font-mono); font-weight: 600; color: var(--color-ink); }

/* Controls */
.controls { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.ctrl-group { display: flex; gap: 2px; margin-right: 8px; }
.ctrl-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid var(--color-border);
  background: none; color: var(--color-subtle);
  cursor: pointer; transition: all 0.12s;
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
}
.ctrl-btn:hover { color: var(--color-body); border-color: var(--color-ghost); }
.ctrl-btn.active { background: var(--color-ink); color: var(--color-page); border-color: var(--color-ink); }
/* Hamburger menu button - hidden on desktop */
.nav-toggle {
  display: none; width: 28px; height: 28px;
  align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid var(--color-border);
  background: none; color: var(--color-subtle);
  cursor: pointer; margin-left: auto; font-size: 16px; line-height: 1;
}
.nav-links { display: contents; }

/* Dark Theme */
[data-theme="dark"] {
  --color-ink: #eee; --color-body: #ddd; --color-mid: #bbb;
  --color-muted: #999; --color-subtle: #888; --color-light: #777;
  --color-ghost: #555; --color-border: #383838; --color-divider: #2a2a2a;
  --color-surface: #1e1e1e; --color-page: #161616;
  --color-accent: #bbb; --color-link: #ddd;
  --color-status-active-bg: #1e2a20; --color-status-active-text: #7aab80;
  --color-status-planning-bg: #2a2618; --color-status-planning-text: #d0b070;
  --color-status-paused-bg: #222; --color-status-paused-text: #888;
  --color-status-done-bg: #1e2228; --color-status-done-text: #7a9ab0;
  --color-status-archived-bg: #222; --color-status-archived-text: #888;
}
[data-theme="dark"] .stat-box { background: var(--color-surface); }
[data-theme="dark"] .login-box .error { background: #2a1e1e; color: #d09090; border-color: #804040; }
[data-theme="dark"] .login-page { background: var(--color-page); }
[data-theme="dark"] .login-box { box-shadow: 0 12px 32px rgba(0,0,0,0.3); }
[data-theme="dark"] input, [data-theme="dark"] select, [data-theme="dark"] textarea { color-scheme: dark; }
[data-theme="dark"] .badge-active-status { background: #1e2a20; color: #7aab80; }
[data-theme="dark"] .badge-inactive-status { background: #2a1e1e; color: #d09090; }
[data-theme="dark"] .badge-high { background: #2a1e1e; color: #d09090; }
[data-theme="dark"] .badge-normal { background: #1e2a20; color: #7aab80; }
[data-theme="dark"] .badge-low { background: #222; color: #888; }

/* ---- Mobile Responsive ---- */
@media (max-width: 640px) {
  nav { flex-wrap: wrap; padding: 0.62rem 1rem; gap: 0; }
  .nav-toggle { display: flex; }
  .nav-links { display: none; width: 100%; flex-direction: column; gap: 2px; padding-top: 0.5rem; }
  .nav-links.open { display: flex; }
  nav a:not(.brand) { padding: 0.46rem 0.62rem; font-size: 0.85rem; }
  nav .brand { margin-right: auto; }
  .controls { width: 100%; justify-content: flex-end; padding-top: 0.38rem; margin-left: 0; }
  .ctrl-group { display: none; }
  .container { padding: 1rem 0.77rem; }
  .stats-bar { flex-wrap: wrap; gap: 0.77rem; }
  table { min-width: 540px; }
  .login-box { width: 100%; max-width: 100%; margin: 0 1rem; padding: 1.85rem 1.23rem; }
  .login-page { padding: 1rem; }
  h1 { font-size: 1.15rem; }
}
`;
