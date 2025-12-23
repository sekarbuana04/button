const socket = io();

const elDate = document.getElementById('dateText');
const elTime = document.getElementById('timeText');

function formatClock(ts) {
  const d = ts ? new Date(ts) : new Date();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const day = days[d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth()+1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  const SS = String(d.getSeconds()).padStart(2, '0');
  return { date: `${day}, ${dd}-${mm}-${yyyy}`, time: `${HH}:${MM}:${SS}` };
}

function tickClock() {
  const { date, time } = formatClock();
  elDate.textContent = ` ${date}`;
  elTime.textContent = ` ${time}`;
}
setInterval(tickClock, 1000);
tickClock();

let chartRef = null;
let currentLine = null;
let latestState = null;
let currentView = 'task';
let currentUser = null;
let gridBuilt = false;
let effectsEnabled = false;
let lastGridSig = '';
let lastTxFetchAt = 0;
let sidebarOpen = true;
try {
  const sv = sessionStorage.getItem('sb');
  if (sv === '0') sidebarOpen = false; else if (sv === '1') sidebarOpen = true;
} catch {}

function buildGrid(machines) {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  machines.forEach(m => {
    const card = document.createElement('div');
    card.className = 'machine-card';
    card.dataset.machine = m.machine;
    const cls = (String(m.status) === 'offline') ? 'status-offline' : 'status-active';
    const parts = String(m.machine).split('-');
    const machineType = parts.length >= 2 ? parts[parts.length - 2] : '';
    const goodVal = m.good;
    const rejectVal = m.reject;
    card.innerHTML = `
      <div class="machine-header">
        <div class="machine-title">${m.job}</div>
        <div class="status-dot ${cls}"></div>
      </div>
      <div class="machine-job">${machineType}</div>
      <div class="counts">
        <div class="count-box"><div class="count-title">GOOD</div><div class="count-good" data-type="good">${goodVal}</div></div>
        <div class="count-box"><div class="count-title">REJECT</div><div class="count-reject" data-type="reject">${rejectVal}</div></div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function buildGridFor(targetId, machines) {
  const grid = document.getElementById(targetId);
  if (!grid) return;
  grid.innerHTML = '';
  machines.forEach(m => {
    const card = document.createElement('div');
    card.className = 'machine-card';
    card.dataset.machine = m.machine;
    const cls = (String(m.status) === 'offline') ? 'status-offline' : 'status-active';
    const parts = String(m.machine).split('-');
    const machineType = parts.length >= 2 ? parts[parts.length - 2] : '';
    const goodVal = m.good;
    const rejectVal = m.reject;
    card.innerHTML = `
      <div class="machine-header">
        <div class="machine-title">${m.job}</div>
        <div class="status-dot ${cls}"></div>
      </div>
      <div class="machine-job">${machineType}</div>
      <div class="counts">
        <div class="count-box"><div class="count-title">GOOD</div><div class="count-good" data-type="good">${goodVal}</div></div>
        <div class="count-box"><div class="count-title">REJECT</div><div class="count-reject" data-type="reject">${rejectVal}</div></div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function updateGrid(machines) {
  const grid = document.getElementById('grid');
  machines.forEach(m => {
    const card = grid.querySelector(`.machine-card[data-machine="${m.machine}"]`);
    if (!card) return;
    const statusDot = card.querySelector('.status-dot');
    const cls = (String(m.status) === 'offline') ? 'status-offline' : 'status-active';
    const prevHasCls = statusDot && statusDot.classList && statusDot.classList.contains(cls);

    const goodEl = card.querySelector('.count-good');
    const rejectEl = card.querySelector('.count-reject');

    const displayGood = m.good;
    const displayReject = m.reject;
    const prevGood = parseInt(goodEl.textContent) || 0;
    const prevReject = parseInt(rejectEl.textContent) || 0;
    const goodInc = displayGood - prevGood;
    const rejectInc = displayReject - prevReject;

    if (goodInc === 0 && rejectInc === 0 && prevHasCls) return;

    statusDot.className = `status-dot ${cls}`;
    goodEl.textContent = displayGood;
    rejectEl.textContent = displayReject;

    if (effectsEnabled && goodInc > 0) card.classList.add('blink-good');
    if (effectsEnabled && rejectInc > 0) card.classList.add('blink-reject');
    if (effectsEnabled) setTimeout(() => { card.classList.remove('blink-good'); card.classList.remove('blink-reject'); }, 350);
  });
}

function labelsFor(machines) {
  return machines.map(m => String(m.job || '').trim());
}

function valuesFor(machines, key) {
  return machines.map(m => m[key]);
}

function sortMachines(machines) {
  const a = [];
  const b = [];
  machines.forEach(m => { if (String(m.status) === 'offline') b.push(m); else a.push(m); });
  return a.concat(b);
}

function ensureChart(machines) {
  const ctx = document.getElementById('chart').getContext('2d');
  if (!chartRef) {
    chartRef = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labelsFor(machines),
        datasets: [
          { label: 'Good', backgroundColor: '#2ECC71', data: valuesFor(machines, 'good') },
          { label: 'Reject', backgroundColor: '#E74C3C', data: valuesFor(machines, 'reject') }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: '#333', autoSkip: true, maxRotation: 0 } },
          y: { beginAtZero: true, ticks: { color: '#333', stepSize: 1, callback: (v) => Number(v).toFixed(0) } }
        },
        animation: { duration: 0 }
      }
    });
  } else {
    chartRef.data.labels = labelsFor(machines);
    chartRef.data.datasets[0].data = valuesFor(machines, 'good');
    chartRef.data.datasets[1].data = valuesFor(machines, 'reject');
    chartRef.update();
  }
}

async function fetchTxMapIfStale(line) {
  latestTxMap = {};
  lastTxFetchAt = Date.now();
}

function renderSelected() {
  if (!latestState || !currentLine) return;
  const machines = sortMachines(latestState.lines[currentLine] || []);
  const panelTitle = document.getElementById('panelTitle');
  panelTitle.textContent = `Status Mesin – ${currentLine}`;
  const grid = document.getElementById('grid');
 
  const styleFromMeta = latestState.meta && latestState.meta[currentLine] ? latestState.meta[currentLine].style : null;
  const notice = document.getElementById('noOrderNotice');
  const hasOrder = !!styleFromMeta && machines.length > 0;
  const styleName = hasOrder ? styleFromMeta : null;
  if (notice) notice.classList.toggle('d-none', hasOrder);
  (async () => {
    await fetchTxMapIfStale(currentLine);
    const sig = machines.map(m => `${m.machine}|${m.good}|${m.reject}|${m.status}`).join(';');
    if (sig === lastGridSig) return;
    if (!gridBuilt || !grid || grid.children.length === 0) { buildGrid(machines); gridBuilt = true; } else { updateGrid(machines); }
    lastGridSig = sig;
  })();
  if (currentView === 'grafik') ensureChart(machines);
  const gridSection = document.getElementById('gridSection');
  const chartSection = document.getElementById('chartSection');
  const gridOn = currentView === 'task';
  gridSection.classList.toggle('d-none', !gridOn);
  chartSection.classList.toggle('d-none', gridOn);
}

socket.on('updateData', (payload) => {
  latestState = payload;
  const select = document.getElementById('lineSelect');
  const label = document.querySelector('label[for="lineSelect"]');
  const allLines = Array.isArray(latestState.list) ? latestState.list : [];
  const isLineAdmin = currentUser && currentUser.role === 'line_admin';
  const userLines = Array.isArray(currentUser && currentUser.lines) ? currentUser.lines : [];
  if (isLineAdmin) {
    if (label) label.classList.add('d-none');
    if (select) { select.classList.add('d-none'); select.disabled = true; }
  } else {
    if (label) label.classList.remove('d-none');
    if (select) { select.classList.remove('d-none'); select.disabled = false; }
  }
  if (isLineAdmin) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-]+/g,'').trim();
    const allowed = allLines.filter(L => userLines.some(u => norm(L) === norm(u)));
    let preferred = allowed[0] || userLines.find(u => allLines.includes(u)) || null;
    if (!preferred) {
      const uname = String(currentUser && currentUser.username || '').toUpperCase();
      let tok = uname.replace(/^ADM[_\-]?/,'').replace(/^ADMLINE[_\-]?/,'').trim();
      tok = tok.replace(/^LINE[_\- ]?/,'').trim();
      if (tok) {
        const candExact = allLines.find(L => String(L).toUpperCase() === `LINE ${tok}`.replace(/\s+/g,' ').trim());
        const candIncl = allLines.find(L => String(L).toUpperCase().includes(`LINE ${tok}`.toUpperCase()));
        preferred = candExact || candIncl || null;
      }
    }
    currentLine = preferred || currentLine;
  }
  if (!isLineAdmin && select.options.length === 0 && allLines && allLines.length) {
    allLines.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l;
      opt.textContent = l;
      select.appendChild(opt);
    });
    currentLine = allLines[0];
    select.value = currentLine;
  }
  const machines = Array.isArray(latestState.lines[currentLine]) ? latestState.lines[currentLine] : [];
  const styleFromMeta = latestState.meta && latestState.meta[currentLine] ? latestState.meta[currentLine].style : null;
  const hasOrder = !!styleFromMeta && machines.length > 0;
  const styleName = hasOrder ? styleFromMeta : null;
  const badge = document.getElementById('lineStyleBadge');
  const toClass = (s) => s ? s.toLowerCase() : '';
  const mapClass = (s) => s === 'kemeja' ? 'style-kemeja' : s === 'celana' ? 'style-celana' : s === 'rok' ? 'style-rok' : s === 'sweater' ? 'style-sweater' : '';
  badge.textContent = styleName || '—';
  badge.className = `style-badge ${mapClass(toClass(styleName))}`;
  if (!styleName && currentLine) {
    (async () => {
      try {
        const r = await fetch(`/api/lines/${encodeURIComponent(currentLine)}/style`, { headers: authHeaders() });
        const d = await r.json();
        const s2 = (d && d.style) || null;
        badge.textContent = s2 || '—';
        badge.className = `style-badge ${mapClass(toClass(s2))}`;
      } catch {}
    })();
  }
  const lineStatus = latestState.meta && latestState.meta[currentLine] ? (latestState.meta[currentLine].status || 'active') : 'active';
  const dot = document.getElementById('lineStatusDot');
  if (dot) dot.className = `status-dot status-${lineStatus}`;
  renderSelected();
});

const lineSelect = document.getElementById('lineSelect');
lineSelect.addEventListener('change', () => {
  if (currentUser && currentUser.role === 'line_admin') return;
  currentLine = lineSelect.value;
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  gridBuilt = false;
  lastGridSig = '';
  const machines = Array.isArray(latestState.lines[currentLine]) ? latestState.lines[currentLine] : [];
  const styleFromMeta = latestState.meta && latestState.meta[currentLine] ? latestState.meta[currentLine].style : null;
  const hasOrder = !!styleFromMeta && machines.length > 0;
  const styleName = hasOrder ? styleFromMeta : null;
  const badge = document.getElementById('lineStyleBadge');
  const toClass = (s) => s ? s.toLowerCase() : '';
  const mapClass = (s) => s === 'kemeja' ? 'style-kemeja' : s === 'celana' ? 'style-celana' : s === 'rok' ? 'style-rok' : s === 'sweater' ? 'style-sweater' : '';
  badge.textContent = styleName || '—';
  badge.className = `style-badge ${mapClass(toClass(styleName))}`;
  const lineStatus = latestState.meta && latestState.meta[currentLine] ? (latestState.meta[currentLine].status || 'active') : 'active';
  const dot = document.getElementById('lineStatusDot');
  if (dot) dot.className = `status-dot status-${lineStatus}`;
  renderSelected();
});

const btnTask = document.getElementById('btnTask');
const btnGrafik = document.getElementById('btnGrafik');

function setView(view) {
  currentView = view;
  if (btnTask) btnTask.classList.toggle('active', view === 'task');
  if (btnGrafik) btnGrafik.classList.toggle('active', view === 'grafik');
  renderSelected();
}

if (btnTask) btnTask.addEventListener('click', () => setView('task'));
if (btnGrafik) btnGrafik.addEventListener('click', () => setView('grafik'));

// merged below

(async () => {
  try {
    const headers = {};
    try {
      const tok = sessionStorage.getItem('sid');
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
    } catch {}
    if (!headers['Authorization']) { location.href = '/login'; return; }
    const res = await fetch('/api/auth/me', { headers });
    if (res.ok) {
      currentUser = await res.json();
      enforceRoleUI();
      try {
        const n = sessionStorage.getItem('notify_login');
        if (n === '1') { alert('Login berhasil'); sessionStorage.removeItem('notify_login'); }
      } catch {}
      if (currentUser && currentUser.role === 'line_admin') {
        try {
          const lr = await fetch('/api/lines', { headers: authHeaders() });
          const ld = await lr.json();
          const lines = Array.isArray(ld && ld.lines) ? ld.lines : [];
          if (lines.length) {
            currentLine = lines[0];
            const labelEl = document.querySelector('label[for="lineSelect"]');
            const selectEl = document.getElementById('lineSelect');
            if (labelEl) labelEl.classList.add('d-none');
            if (selectEl) { selectEl.classList.add('d-none'); selectEl.disabled = true; }
          }
        } catch {}
      }
    } else {
      location.href = '/login';
      return;
    }
  } catch {}
})();

function applySidebar() {
  document.body.classList.toggle('sidebar-open', sidebarOpen);
  document.body.classList.toggle('sidebar-collapsed', !sidebarOpen);
}

applySidebar();

const btnSidebar = document.getElementById('sidebarToggle');
if (btnSidebar) {
  btnSidebar.addEventListener('click', () => {
    sidebarOpen = !sidebarOpen;
    applySidebar();
    try { sessionStorage.setItem('sb', sidebarOpen ? '1' : '0'); } catch {}
  });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-nav]');
  if (!t) return;
  if (t.tagName && t.tagName.toLowerCase() === 'a') e.preventDefault();
  const v = t.getAttribute('data-nav');
  if (v === 'task' || v === 'grafik') setView(v);
  if (v === 'dashboard') { setView('task'); restoreDashboard(); setRouteIndicator('dashboard'); try { sessionStorage.setItem('route', 'dashboard'); } catch {} }
  if (v === 'master-mesin') { showMasterMesin(); setRouteIndicator('master-mesin'); try { sessionStorage.setItem('route', 'master-mesin'); } catch {} }
  if (v === 'master-order') { showMasterOrder(); setRouteIndicator('master-order'); try { sessionStorage.setItem('route', 'master-order'); } catch {} }
  if (v === 'master-button') { showMasterCounter(); setRouteIndicator('master-button'); try { sessionStorage.setItem('route', 'master-button'); } catch {} }
  if (v === 'master-line') { showMasterLine(); setRouteIndicator('master-line'); try { sessionStorage.setItem('route', 'master-line'); } catch {} }
  if (v === 'master-style') { showMasterStyle(); setRouteIndicator('master-style'); try { sessionStorage.setItem('route', 'master-style'); } catch {} }
  if (v === 'master-proses') { showMasterProses(); setRouteIndicator('master-proses'); try { sessionStorage.setItem('route', 'master-proses'); } catch {} }
  if (v === 'master-color') { showMasterColor(); setRouteIndicator('master-color'); try { sessionStorage.setItem('route', 'master-color'); } catch {} }
});

const logoutLink = document.getElementById('logoutLink');
if (logoutLink) {
  logoutLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const ok = confirm('Keluar dari dashboard admin?');
    if (!ok) return;
    try { sessionStorage.removeItem('sid'); sessionStorage.setItem('notify_logout','1'); } catch {}
    location.href = '/login';
  });
}

const logoutInline = document.getElementById('logoutInline');
if (logoutInline) {
  logoutInline.addEventListener('click', async (e) => {
    e.preventDefault();
    const ok = confirm('Keluar dari dashboard admin?');
    if (!ok) return;
    try { sessionStorage.removeItem('sid'); sessionStorage.setItem('notify_logout','1'); } catch {}
    location.href = '/login';
  });
}

function enforceRoleUI() {
  const sidebar = document.getElementById('sidebar');
  const burger = document.getElementById('sidebarToggle');
  const sidebarLogout = document.getElementById('logoutLink');
  const logoutInlineBtn = document.getElementById('logoutInline');
  if (currentUser && currentUser.role === 'line_admin') {
    sidebarOpen = false;
    try { sessionStorage.setItem('sb', '0'); } catch {}
    applySidebar();
    if (sidebar) sidebar.classList.add('d-none');
    if (burger) burger.classList.add('d-none');
    if (sidebarLogout) sidebarLogout.classList.add('d-none');
    if (logoutInlineBtn) logoutInlineBtn.classList.remove('d-none');
    const lineLabel = document.querySelector('label[for="lineSelect"]');
    const lineSelect = document.getElementById('lineSelect');
    if (lineLabel) lineLabel.classList.add('d-none');
    if (lineSelect) { lineSelect.classList.add('d-none'); lineSelect.disabled = true; }
    setView('task');
    restoreDashboard();
    setRouteIndicator('dashboard');
  } else if (currentUser && currentUser.role === 'tech_admin') {
    if (sidebar) sidebar.classList.remove('d-none');
    if (burger) burger.classList.remove('d-none');
    if (sidebarLogout) {
      sidebarLogout.classList.remove('d-none');
      sidebarLogout.classList.add('logout-red');
    }
    if (logoutInlineBtn) logoutInlineBtn.classList.add('d-none');
    applySidebar();
    try {
      const route = sessionStorage.getItem('route');
      const mmStored = sessionStorage.getItem('mmTab');
      const mcStored = sessionStorage.getItem('mcTab');
      if (route === 'master-mesin') {
        showMasterMesin();
        setMmTab(mmStored === 'merk' ? 'merk' : 'jenis');
        setRouteIndicator('master-mesin');
      } else if (route === 'master-button') {
        showMasterCounter();
        setMcTab(mcStored || 'receiver');
        setRouteIndicator('master-button');
      } else if (route === 'master-order') {
        showMasterOrder();
        setRouteIndicator('master-order');
      } else if (route === 'master-line') {
        showMasterLine();
        setRouteIndicator('master-line');
      } else if (route === 'master-style') {
        showMasterStyle();
        setRouteIndicator('master-style');
  } else if (route === 'master-proses') {
    showMasterProses();
    setRouteIndicator('master-proses');
  } else if (route === 'master-color') {
    showMasterColor();
    setRouteIndicator('master-color');
  } else {
        setView('task');
        restoreDashboard();
        setRouteIndicator('dashboard');
      }
    } catch {}
  } else {
    if (sidebar) sidebar.classList.remove('d-none');
    if (burger) burger.classList.remove('d-none');
    if (sidebarLogout) {
      sidebarLogout.classList.remove('d-none');
      sidebarLogout.classList.remove('logout-red');
    }
    if (logoutInlineBtn) logoutInlineBtn.classList.remove('d-none');
    applySidebar();
  }
}

function applyTheme(name) {
  document.body.classList.remove('theme-midnight');
  if (name === 'midnight') document.body.classList.add('theme-midnight');
}

let mmTab = 'jenis';
let mmRows = [];
let mmJenisIndex = [];
let mmModalAction = null;
let mmModalEditId = null;

let mcTab = 'receiver';
let mcRows = [];
let mcRefreshTimer = null;
let mcLogFilter = 'all';
let mcTxFilter = '';
let mcTxList = [];

let mlRows = [];
let mlModalAction = null;
let mlModalEditId = null;
let latestTxMap = {};
let mcolRows = [];
let msRows = [];
let mpRows = [];

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const tok = sessionStorage.getItem('sid');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
  } catch {}
  return headers;
}

function showMasterMesin() {
  showSectionOnly('masterMesinSection');
  setMmTab('jenis');
}

function hideMasterMesin() {
  const section = document.getElementById('masterMesinSection');
  if (section) section.classList.add('d-none');
}

function showMasterLine() {
  showSectionOnly('masterLineSection');
  fetchMlData();
}

function hideMasterLine() {
  const section = document.getElementById('masterLineSection');
  if (section) section.classList.add('d-none');
}

function showMasterStyle() {
  showSectionOnly('masterStyleSection');
  const msThead = document.getElementById('msThead');
  const msTbody = document.getElementById('msTbody');
  if (msThead && msTbody) { fetchMsData(); return; }
  const msCategory = document.getElementById('msCategory');
  const msType = document.getElementById('msType');
  const msTypeSelected = document.getElementById('msTypeSelected');
  const msLineSelect = document.getElementById('msLineSelect');
  const msLineDesc = document.getElementById('msLineDesc');
  const msReview = document.getElementById('msReview');
  const msSubmitOrder = document.getElementById('msSubmitOrder');

  const TOP_TYPES = ['Kemeja','Kaos','Sweater','Hoodie','Jaket','Blazer','Polo','Cardigan'];
  const BOTTOM_TYPES = ['Celana Panjang','Celana Pendek','Rok Pendek','Rok Panjang','Jeans','Legging','Jogger'];
  const msOrder = { category: '', type: '', line: '' };

  function fillTypeOptions() {
    if (!msType) return;
    const list = msOrder.category === 'TOP' ? TOP_TYPES : msOrder.category === 'BOTTOM' ? BOTTOM_TYPES : [];
    msType.innerHTML = '<option value="">Pilih jenis</option>' + list.map(n => `<option value="${n}">${n}</option>`).join('');
  }

  // proses dan mesin dipindahkan ke Master Proses

  async function loadLines() {
    try {
      const res = await fetch('/api/master/line', { headers: authHeaders() });
      const data = await res.json();
      const rows = Array.isArray(data.data) ? data.data : [];
      if (msLineSelect) {
        msLineSelect.innerHTML = '<option value="">Pilih line</option>' + rows.map(r => `<option value="${r.nama_line}">${r.nama_line}</option>`).join('');
      }
    } catch {}
  }

  function renderReview() {
    if (!msReview) return;
    msReview.innerHTML = `<div class="row g-3"><div class="col-md-4"><div class="border rounded p-3"><div class="text-muted">Jenis Pakaian</div><div class="fw-semibold">${msOrder.type || '—'}</div></div></div><div class="col-md-4"><div class="border rounded p-3"><div class="text-muted">Line Produksi</div><div class="fw-semibold">${msOrder.line || '—'}</div></div></div><div class="col-md-4"><div class="border rounded p-3"><div class="text-muted">Kategori</div><div class="fw-semibold">${msOrder.category || '—'}</div></div></div></div>`;
  }

  // tidak ada aksi proses di Master Style

  if (msCategory) msCategory.addEventListener('change', () => { msOrder.category = msCategory.value; fillTypeOptions(); msOrder.type = ''; msTypeSelected.textContent = '—'; renderReview(); });
  if (msType) msType.addEventListener('change', () => { msOrder.type = msType.value; msTypeSelected.textContent = msOrder.type || '—'; renderReview(); });
  if (msLineSelect) msLineSelect.addEventListener('change', () => { msOrder.line = msLineSelect.value; msLineDesc.textContent = msOrder.line ? `Line terpilih: ${msOrder.line}` : '—'; renderReview(); });
  if (msSubmitOrder) msSubmitOrder.addEventListener('click', async () => {
    const payload = { category: msOrder.category, type: msOrder.type, processes: [], line: msOrder.line };
    if (!payload.line || !payload.type || !payload.category) { alert('Lengkapi kategori, jenis, dan line.'); return; }
    try {
      const res = await fetch('/api/style/order', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
      const data = await res.json();
      if (data && data.ok) { alert('Order style disimpan. Tambahkan proses & mesin di Master Proses.'); }
      else { alert('Gagal menyimpan order style'); }
    } catch { alert('Gagal menyimpan order style'); }
  });

  loadLines();
  fillTypeOptions();
  renderReview();
}

function hideMasterStyle() {
  const section = document.getElementById('masterStyleSection');
  if (section) section.classList.add('d-none');
}

function showMasterProses() {
  showSectionOnly('masterProsesSection');
  const mpThead = document.getElementById('mpThead');
  const mpTbody = document.getElementById('mpTbody');
  if (mpThead && mpTbody) { fetchMpData(); return; }
  const mpLineSelect = document.getElementById('mpLineSelect');
  const mpLineDesc = document.getElementById('mpLineDesc');
  const mpOrderCategory = document.getElementById('mpOrderCategory');
  const mpOrderType = document.getElementById('mpOrderType');
  const mpOrderProcCount = document.getElementById('mpOrderProcCount');
  const mpProcessSections = document.getElementById('mpProcessSections');
  const mpProcessSelect = document.getElementById('mpProcessSelect');
  const mpAddProcess = document.getElementById('mpAddProcess');
  const mpProcessList = document.getElementById('mpProcessList');
  const mpSaveProcs = document.getElementById('mpSaveProcs');
  const mpOrderCard = document.getElementById('mpOrderCard');
  const mpAddProcCard = document.getElementById('mpAddProcCard');
  const mpManageMachinesCard = document.getElementById('mpManageMachinesCard');

  let currentOrder = { category: '', type: '' };
  let mpProcs = [];
  const mpLastSel = {};
  let jenisList = [];
  async function mpLoadJenis() {
    try {
      const res = await fetch('/api/master/jenis', { headers: authHeaders() });
      const data = await res.json();
      jenisList = Array.isArray(data.data) ? data.data.map(r => r.name) : [];
    } catch { jenisList = []; }
  }

  async function mpLoadLines() {
    try {
      const res = await fetch('/api/master/line', { headers: authHeaders() });
      const data = await res.json();
      const rows = Array.isArray(data.data) ? data.data : [];
      if (mpLineSelect) {
        mpLineSelect.innerHTML = '<option value="">Pilih line</option>' + rows.map(r => `<option value="${r.nama_line}">${r.nama_line}</option>`).join('');
        try {
          const focus = sessionStorage.getItem('mpLineFocus');
          if (focus) {
            mpLineSelect.value = focus;
            mpLineSelect.dispatchEvent(new Event('change'));
            sessionStorage.removeItem('mpLineFocus');
          }
        } catch {}
      }
    } catch {}
  }

  async function mpLoadProsesProduksi() {
    try {
      const res = await fetch('/api/master/proses_produksi', { headers: authHeaders() });
      const data = await res.json();
      const rows = Array.isArray(data && data.data) ? data.data : [];
      const list = rows.map(r => r.nama).filter(Boolean);
      if (mpProcessSelect) {
        if (list.length) {
          mpProcessSelect.innerHTML = '<option value="">Pilih proses</option>' + list.map(n => `<option value="${n}">${n}</option>`).join('');
          mpProcessSelect.removeAttribute('disabled');
        } else {
          mpProcessSelect.innerHTML = '<option value=\"\">Tidak ada data</option>';
          mpProcessSelect.setAttribute('disabled','true');
        }
      }
    } catch {}
  }

  async function mpRefresh(line) {
    if (!line) {
      mpLineDesc.textContent = '—';
      if (mpOrderCategory) mpOrderCategory.textContent = '—';
      if (mpOrderType) mpOrderType.textContent = '—';
      if (mpOrderProcCount) mpOrderProcCount.textContent = '0';
      if (mpProcessSections) mpProcessSections.innerHTML = '';
      if (mpProcessList) mpProcessList.innerHTML = '';
      if (mpAddProcCard) mpAddProcCard.classList.add('d-none');
      if (mpManageMachinesCard) mpManageMachinesCard.classList.add('d-none');
      if (mpProcessSelect) mpProcessSelect.setAttribute('disabled','true');
      if (mpAddProcess) mpAddProcess.setAttribute('disabled','true');
      return;
    }
    mpLineDesc.textContent = `Line terpilih: ${line}`;
    try {
      const res = await fetch(`/api/style/order/${encodeURIComponent(line)}`, { headers: authHeaders() });
      const data = await res.json();
      const order = data && data.order ? data.order : null;
      currentOrder = order ? { category: order.category || '', type: order.type || '' } : { category: '', type: '' };
      const serverProcs = Array.isArray(data && data.processes) ? data.processes.slice() : [];
      if (serverProcs.length > 0) mpProcs = serverProcs;
      const defs = (data && data.defaults) || {};
      Object.keys(defs).forEach(name => {
        const d = defs[name] || {};
        mpLastSel[`${line}|${name}`] = { type: d.type || '', qty: Number(d.qty || 1) };
      });
      if (mpOrderCategory) mpOrderCategory.textContent = currentOrder.category || '—';
      if (mpOrderType) mpOrderType.textContent = currentOrder.type || '—';
      if (mpOrderProcCount) mpOrderProcCount.textContent = String(mpProcs.length);
      if (mpAddProcCard) mpAddProcCard.classList.remove('d-none');
      if (mpManageMachinesCard) mpManageMachinesCard.classList.remove('d-none');
      if (mpProcessSelect) mpProcessSelect.removeAttribute('disabled');
      if (mpAddProcess) mpAddProcess.removeAttribute('disabled');
      const opts = jenisList.map(n => `<option value="${n}">${n}</option>`).join('');
      const machinesRes = await fetch(`/api/lines/${encodeURIComponent(line)}`, { headers: authHeaders() });
      const machData = await machinesRes.json();
      const machines = Array.isArray(machData && machData.data) ? machData.data : [];
      mpProcessSections.innerHTML = mpProcs.map((p, idx) => {
        const tableId = `mpMachineTable-${idx}`;
        const selId = `mpJenis-${idx}`;
        const qtyId = `mpQty-${idx}`;
        const tgtId = `mpTarget-${idx}`;
        const addId = `mpAdd-${idx}`;
        const rows = machines.filter(m => String(m.job) === String(p.name)).map((m, j) => {
          const btnText = String(m.status) === 'active' ? 'Nonaktifkan' : 'Aktifkan';
          const btnClass = String(m.status) === 'active' ? 'text-danger' : 'text-success';
          const tval = typeof m.target === 'number' ? m.target : 0;
          return `<tr data-idx="${j}"><td>${m.machine}</td><td>${tval}</td><td>${m.status}</td><td><button class="btn btn-link p-0 ${btnClass}" data-mp-toggle="1" data-machine="${m.machine}" data-status="${m.status}">${btnText}</button></td></tr>`;
        }).join('');
        return `<div class="border rounded p-3"><div class="d-flex justify-content-between align-items-center mb-2"><div class="fw-semibold">${p.name}</div><i class="bi bi-cpu"></i></div><div class="row g-2 align-items-end"><div class="col-md-4"><label class="form-label">Jenis Mesin</label><select id="${selId}" class="form-select"><option value="">Pilih jenis mesin</option>${opts}</select></div><div class="col-md-3"><label class="form-label">Jumlah Mesin</label><input type="number" id="${qtyId}" class="form-control" min="1" value="1" /></div><div class="col-md-3"><label class="form-label">Target</label><input type="number" id="${tgtId}" class="form-control" min="0" value="0" /></div><div class="col-md-2"><button id="${addId}" class="btn btn-accent w-100">Tambah Mesin</button></div></div><div class="table-responsive mt-3"><table class="table table-sm table-striped text-center"><thead><tr><th>Mesin</th><th>Target</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="${tableId}">${rows || ''}</tbody></table></div></div>`;
      }).join('');
      applyLastSelections(line);
      renderMpProcessList();
    } catch {}
  }

  async function renderMpSectionsLocal(line) {
    if (!line) { mpProcessSections.innerHTML = ''; return; }
    try {
      const machinesRes = await fetch(`/api/lines/${encodeURIComponent(line)}`, { headers: authHeaders() });
      const machData = await machinesRes.json();
      const machines = Array.isArray(machData && machData.data) ? machData.data : [];
      const opts = jenisList.map(n => `<option value="${n}">${n}</option>`).join('');
      mpProcessSections.innerHTML = mpProcs.map((p, idx) => {
        const tableId = `mpMachineTable-${idx}`;
        const selId = `mpJenis-${idx}`;
        const qtyId = `mpQty-${idx}`;
        const tgtId = `mpTarget-${idx}`;
        const addId = `mpAdd-${idx}`;
        const rows = machines.filter(m => String(m.job) === String(p.name)).map((m, j) => {
          const btnText = String(m.status) === 'active' ? 'Nonaktifkan' : 'Aktifkan';
          const btnClass = String(m.status) === 'active' ? 'text-danger' : 'text-success';
          const tval = typeof m.target === 'number' ? m.target : 0;
          return `<tr data-idx="${j}"><td>${m.machine}</td><td>${tval}</td><td>${m.status}</td><td><button class="btn btn-link p-0 ${btnClass}" data-mp-toggle="1" data-machine="${m.machine}" data-status="${m.status}">${btnText}</button></td></tr>`;
        }).join('');
        return `<div class="border rounded p-3"><div class="d-flex justify-content-between align-items-center mb-2"><div class="fw-semibold">${p.name}</div><i class="bi bi-cpu"></i></div><div class="row g-2 align-items-end"><div class="col-md-4"><label class="form-label">Jenis Mesin</label><select id="${selId}" class="form-select"><option value="">Pilih jenis mesin</option>${opts}</select></div><div class="col-md-3"><label class="form-label">Jumlah Mesin</label><input type="number" id="${qtyId}" class="form-control" min="1" value="1" /></div><div class="col-md-3"><label class="form-label">Target</label><input type="number" id="${tgtId}" class="form-control" min="0" value="0" /></div><div class="col-md-2"><button id="${addId}" class="btn btn-accent w-100">Tambah Mesin</button></div></div><div class="table-responsive mt-3"><table class="table table-sm table-striped text-center"><thead><tr><th>Mesin</th><th>Target</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="${tableId}">${rows || ''}</tbody></table></div></div>`;
      }).join('');
      applyLastSelections(line);
    } catch { mpProcessSections.innerHTML = ''; }
  }

  function applyLastSelections(line) {
    mpProcs.forEach((p, idx) => {
      const k = `${line}|${p.name}`;
      const prev = mpLastSel[k];
      const sel = document.getElementById(`mpJenis-${idx}`);
      const qtyEl = document.getElementById(`mpQty-${idx}`);
      const tgtEl = document.getElementById(`mpTarget-${idx}`);
      if (!sel || !qtyEl) return;
      if (prev && prev.type) {
        if (!sel.querySelector(`option[value="${prev.type}"]`)) {
          const opt = document.createElement('option');
          opt.value = prev.type;
          opt.textContent = prev.type;
          sel.appendChild(opt);
        }
        sel.value = prev.type;
      }
      if (prev && prev.qty) qtyEl.value = String(prev.qty);
      if (tgtEl && typeof prev?.target === 'number') tgtEl.value = String(prev.target);
    });
  }
  function renderMpProcessList() {
    if (!mpProcessList) return;
    mpProcessList.innerHTML = mpProcs.map((p, idx) => {
      return `<div class="card p-2" data-mp-proc="${idx}"><div class="d-flex justify-content-between align-items-center"><div class="fw-semibold">${p.name}</div><div class="d-flex gap-2"><button class="btn btn-link p-0 text-warning" data-mp-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" data-mp-act="delete"><i class="bi bi-trash fs-5"></i></button></div></div></div>`;
    }).join('');
    if (mpOrderProcCount) mpOrderProcCount.textContent = String(mpProcs.length);
    const line = mpLineSelect && mpLineSelect.value ? mpLineSelect.value : '';
    renderMpSectionsLocal(line);
  }

  if (mpLineSelect) mpLineSelect.addEventListener('change', () => { const v = mpLineSelect.value; mpRefresh(v); });
  if (mpSaveProcs) { try { mpSaveProcs.classList.add('d-none'); } catch {} }
  if (mpAddProcess) mpAddProcess.addEventListener('click', async () => {
    const name = mpProcessSelect && mpProcessSelect.value ? mpProcessSelect.value.trim() : '';
    if (!name) return;
    mpProcs.push({ name });
    if (mpProcessSelect) mpProcessSelect.value = '';
    renderMpProcessList();
    const line = mpLineSelect && mpLineSelect.value ? mpLineSelect.value : '';
    if (!line) return;
    try {
      await fetch('/api/style/process', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, name }) });
      renderMpSectionsLocal(line);
    } catch {}
  });
  if (mpSaveProcs) mpSaveProcs.addEventListener('click', async () => {
    const line = mpLineSelect && mpLineSelect.value ? mpLineSelect.value : '';
    if (!line) { alert('Pilih line terlebih dahulu.'); return; }
    try {
      await fetch('/api/style/order', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, category: currentOrder.category, type: currentOrder.type, processes: mpProcs }) });
      await mpRefresh(line);
      alert('Daftar proses disimpan.');
    } catch { alert('Gagal menyimpan daftar proses'); }
  });
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[id^="mpAdd-"]');
    const actBtn = e.target.closest('[data-mp-act]');
    const togBtn = e.target.closest('[data-mp-toggle]');
    if (actBtn) {
      const card = actBtn.closest('[data-mp-proc]');
      const pidx = card ? parseInt(card.getAttribute('data-mp-proc'), 10) : -1;
      if (pidx < 0) return;
      const act = actBtn.getAttribute('data-mp-act');
      if (act === 'delete') {
        const oldName = mpProcs[pidx] ? mpProcs[pidx].name : '';
        mpProcs.splice(pidx, 1);
        renderMpProcessList();
        const line = mpLineSelect && mpLineSelect.value ? mpLineSelect.value : '';
        if (line) {
          try {
            await fetch('/api/style/process', { method: 'DELETE', headers: authHeaders(), body: JSON.stringify({ line, name: oldName }) });
            await mpRefresh(line);
          } catch {}
        }
      }
      if (act === 'edit') {
        const name = prompt('Edit nama proses', mpProcs[pidx].name || '');
        if (name) {
          const oldName = mpProcs[pidx].name || '';
          const newName = name.trim();
          mpProcs[pidx].name = newName;
          renderMpProcessList();
          const line = mpLineSelect && mpLineSelect.value ? mpLineSelect.value : '';
          if (line) {
            try {
              await fetch('/api/style/process', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ line, oldName, newName }) });
              await mpRefresh(line);
            } catch {}
          }
        }
      }
      return;
    }
    if (togBtn) {
      const machine = togBtn.getAttribute('data-machine') || '';
      const curStatus = togBtn.getAttribute('data-status') || '';
      const next = curStatus === 'active' ? 'inactive' : 'active';
      const line = mpLineSelect && mpLineSelect.value ? mpLineSelect.value : '';
      if (!line || !machine) return;
      try {
        await fetch('/api/machines/increment', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, machine, goodDelta: 0, rejectDelta: 0, status: next }) });
        await renderMpSectionsLocal(line);
      } catch {}
      return;
    }
    if (!btn) return;
    const idx = parseInt(btn.id.split('-')[1], 10);
    const sel = document.getElementById(`mpJenis-${idx}`);
    const qtyEl = document.getElementById(`mpQty-${idx}`);
    const tgtEl = document.getElementById(`mpTarget-${idx}`);
    const line = mpLineSelect && mpLineSelect.value ? mpLineSelect.value : '';
    const machineType = sel && sel.value ? sel.value : '';
    const qty = qtyEl && qtyEl.value ? parseInt(qtyEl.value, 10) : 1;
    const target = tgtEl && tgtEl.value ? parseInt(tgtEl.value, 10) : 0;
    const procCards = mpProcessSections.querySelectorAll('.border.rounded.p-3');
    const titleEl = procCards[idx].querySelector('.fw-semibold');
    const processName = titleEl ? titleEl.textContent : '';
    if (!line) { alert('Pilih line terlebih dahulu.'); return; }
    if (!processName) { alert('Nama proses tidak ditemukan.'); return; }
    if (!machineType) { alert('Pilih jenis mesin terlebih dahulu.'); return; }
    try {
      await fetch('/api/process/machines', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, processName, machineType, qty, target }) });
      const prevType = machineType;
      const prevQty = qty;
      const prevTarget = target;
      mpLastSel[`${line}|${processName}`] = { type: prevType, qty: prevQty, target: prevTarget };
      await renderMpSectionsLocal(line);
      try {
        const sel2 = document.getElementById(`mpJenis-${idx}`);
        const qty2 = document.getElementById(`mpQty-${idx}`);
        const tgt2 = document.getElementById(`mpTarget-${idx}`);
        if (sel2 && !sel2.querySelector(`option[value="${prevType}"]`)) {
          const opt = document.createElement('option');
          opt.value = prevType;
          opt.textContent = prevType;
          sel2.appendChild(opt);
        }
        if (sel2) sel2.value = prevType;
        if (qty2) qty2.value = String(prevQty);
        if (tgt2) tgt2.value = String(prevTarget);
      } catch {}
      alert('Mesin ditambahkan');
    } catch { alert('Gagal menambahkan mesin'); }
  });

  mpLoadJenis().then(() => { mpLoadLines(); mpLoadProsesProduksi(); });
}

function hideMasterProses() {
  const section = document.getElementById('masterProsesSection');
  if (section) section.classList.add('d-none');
}

function showSectionOnly(id) {
  const linePanel = document.querySelector('.line-panel');
  const controlsBar = document.querySelector('.controls-bar');
  if (linePanel) linePanel.classList.add('d-none');
  if (controlsBar) controlsBar.classList.add('d-none');
  ['masterMesinSection','masterLineSection','masterStyleSection','masterProsesSection','masterOrderSection','masterCounterSection','masterColorSection'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('d-none');
  });
  const target = document.getElementById(id);
  if (target) target.classList.remove('d-none');
}

function restoreDashboard() {
  const linePanel = document.querySelector('.line-panel');
  const controlsBar = document.querySelector('.controls-bar');
  if (linePanel) linePanel.classList.remove('d-none');
  if (controlsBar) controlsBar.classList.remove('d-none');
  ['masterMesinSection','masterLineSection','masterStyleSection','masterProsesSection','masterOrderSection','masterCounterSection','masterColorSection'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('d-none');
  });
  const gridSection = document.getElementById('gridSection');
  const chartSection = document.getElementById('chartSection');
  if (gridSection && chartSection) {
    const gridOn = currentView === 'task';
    gridSection.classList.toggle('d-none', !gridOn);
    chartSection.classList.toggle('d-none', gridOn);
  }
}

function showMasterOrder() {
  showSectionOnly('masterOrderSection');
  try {
    const stored = sessionStorage.getItem('moTab');
    setMoTab(stored === 'summary' ? 'summary' : 'order');
  } catch { setMoTab('order'); }
}

const moTabs = document.getElementById('moTabs');
if (moTabs) {
  moTabs.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mo-tab]');
    if (!t) return;
    setMoTab(t.getAttribute('data-mo-tab'));
  });
}
let moTab = 'summary';
function setMoTab(tab) {
  moTab = tab;
  const tabs = document.querySelectorAll('[data-mo-tab]');
  tabs.forEach(el => el.classList.toggle('active', el.getAttribute('data-mo-tab') === tab));
  const orderPanel = document.getElementById('moOrderPanel');
  const summaryPanel = document.getElementById('moSummaryPanel');
  if (orderPanel) orderPanel.classList.toggle('d-none', tab !== 'order');
  if (summaryPanel) summaryPanel.classList.toggle('d-none', tab !== 'summary');
  try { sessionStorage.setItem('moTab', moTab); } catch {}
  if (tab === 'summary') { renderMoSummary(); }
  else { setupMoOrderPanel(); }
}

async function renderMoSummary() {
  const tbody = document.getElementById('moTbody');
  try {
    const res = await fetch('/api/master/order', { headers: authHeaders() });
    const data = await res.json();
    const rows = Array.isArray(data && data.data) ? data.data : [];
    if (tbody) {
      tbody.innerHTML = rows.map(r => {
        const hasOrder = !!(r && r.type && String(r.type).trim());
        const det = hasOrder && Array.isArray(r.processes) ? r.processes.map(p => `${p.name} (${p.machines})`).join(', ') : '';
        const acts = `<button class="btn btn-link p-0 me-2 text-warning" data-mo-act="edit" title="Edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" data-mo-act="delete" title="Hapus"><i class="bi bi-trash fs-5"></i></button>`;
        return `<tr data-line="${r.line}"><td>${r.line}</td><td>${r.category || ''}</td><td>${r.type || ''}</td><td>${r.totalProcesses || 0}</td><td>${r.totalMachines || 0}</td><td>${det}</td><td>${acts}</td></tr>`;
      }).join('');
    }
    try {
      const stored = sessionStorage.getItem('moSummaryLine') || '';
      const preferred = stored && rows.find(r => String(r.line) === String(stored)) ? stored : (rows[0] ? rows[0].line : '');
      if (preferred) {
        const tr = document.querySelector(`#moTbody tr[data-line="${CSS.escape(preferred)}"]`);
        if (tr) tr.classList.add('table-active');
        await renderMoSummaryDetail(preferred);
      } else {
        const detail = document.getElementById('moSummaryDetail');
        if (detail) detail.innerHTML = '<div class="text-muted">Pilih line untuk melihat rincian.</div>';
      }
    } catch {}
  } catch {}
}

function setupMoOrderPanel() {
  const catSel = document.getElementById('moCategory');
  const typeSel = document.getElementById('moType');
  const typeSelected = document.getElementById('moTypeSelected');
  const lineSel = document.getElementById('moLineSelect');
  const lineDesc = document.getElementById('moLineDesc');
  const finalReviewEl = document.getElementById('moFinalReview');
  const finalSubmitBtn = document.getElementById('moFinalSubmit');
  const order = { category: '', type: '', line: '' };
  const TOP_TYPES = ['Kemeja','Kaos','Sweater','Hoodie','Jaket','Blazer','Polo','Cardigan'];
  const BOTTOM_TYPES = ['Celana Panjang','Celana Pendek','Rok Pendek','Rok Panjang','Jeans','Legging','Jogger'];
  function fillTypeOptions() {
    if (!typeSel) return;
    const list = order.category === 'TOP' ? TOP_TYPES : order.category === 'BOTTOM' ? BOTTOM_TYPES : [];
    typeSel.innerHTML = '<option value="">Pilih jenis</option>' + list.map(n => `<option value="${n}">${n}</option>`).join('');
  }
  async function loadLines() {
    try {
      const res = await fetch('/api/master/line', { headers: authHeaders() });
      const data = await res.json();
      const rows = Array.isArray(data.data) ? data.data : [];
      if (lineSel) {
        lineSel.innerHTML = '<option value="">Pilih line</option>' + rows.map(r => `<option value="${r.nama_line}">${r.nama_line}</option>`).join('');
        try {
          const focus = sessionStorage.getItem('moLineFocus');
          if (focus) {
            lineSel.value = focus;
            lineSel.dispatchEvent(new Event('change'));
            sessionStorage.removeItem('moLineFocus');
          }
        } catch {}
      }
    } catch {}
  }
  function renderReview() {
    if (!finalReviewEl) return;
    finalReviewEl.innerHTML = `<div class="row g-3"><div class="col-md-4"><div class="border rounded p-3"><div class="text-muted">Jenis Pakaian</div><div class="fw-semibold">${order.type || '—'}</div></div></div><div class="col-md-4"><div class="border rounded p-3"><div class="text-muted">Line Produksi</div><div class="fw-semibold">${order.line || '—'}</div></div></div><div class="col-md-4"><div class="border rounded p-3"><div class="text-muted">Kategori</div><div class="fw-semibold">${order.category || '—'}</div></div></div></div><div id="moReviewDetails"></div>`;
  }
  if (catSel) catSel.onchange = () => { order.category = catSel.value; fillTypeOptions(); order.type = ''; if (typeSelected) typeSelected.textContent = '—'; renderReview(); };
  if (typeSel) typeSel.onchange = () => { order.type = typeSel.value; if (typeSelected) typeSelected.textContent = order.type || '—'; renderReview(); };
  if (lineSel) lineSel.onchange = () => { order.line = lineSel.value; if (lineDesc) lineDesc.textContent = order.line ? `Line terpilih: ${order.line}` : '—'; renderReview(); moRefresh(order.line); };
  if (finalSubmitBtn) finalSubmitBtn.onclick = async () => {
    const payload = { category: order.category, type: order.type, processes: [], line: order.line };
    if (!payload.line || !payload.type || !payload.category) { alert('Lengkapi kategori, jenis, dan line.'); return; }
    try {
      const res = await fetch('/api/style/order', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
      const data = await res.json();
      if (data && data.ok) { alert('Order style disimpan. Tambahkan proses & mesin di Master Proses.'); setMoTab('summary'); }
      else { alert('Gagal menyimpan order style'); }
    } catch { alert('Gagal menyimpan order style'); }
  };
  loadLines();
  fillTypeOptions();
  renderReview();

  const panel = document.getElementById('moOrderPanel');
  const moOrderCategory = document.getElementById('moProcOrderCategory');
  const moOrderType = document.getElementById('moProcOrderType');
  const moOrderProcCount = document.getElementById('moProcOrderProcCount');
  const moProcessSections = document.getElementById('moProcProcessSections');
  const moProcessSelect = document.getElementById('moProcProcessSelect');
  const moAddProcess = document.getElementById('moProcAddProcess');
  const moProcessList = document.getElementById('moProcProcessList');
  const moOrderCard = document.getElementById('moProcOrderCard');
  const moAddProcCard = document.getElementById('moProcAddProcCard');
  const moManageMachinesCard = document.getElementById('moProcManageMachinesCard');
  let moCurrentOrder = { category: '', type: '' };
  let moProcs = [];
  const moLastSel = {};
  let moJenisList = [];
  async function moLoadJenis() {
    try {
      const res = await fetch('/api/master/jenis', { headers: authHeaders() });
      const data = await res.json();
      moJenisList = Array.isArray(data.data) ? data.data.map(r => r.name) : [];
    } catch { moJenisList = []; }
  }
  async function moLoadProsesProduksi() {
    try {
      const res = await fetch('/api/master/proses_produksi', { headers: authHeaders() });
      const data = await res.json();
      const rows = Array.isArray(data && data.data) ? data.data : [];
      const list = rows.map(r => r.nama).filter(Boolean);
      if (moProcessSelect) {
        if (list.length) {
          moProcessSelect.innerHTML = '<option value="">Pilih proses</option>' + list.map(n => `<option value="${n}">${n}</option>`).join('');
          moProcessSelect.removeAttribute('disabled');
        } else {
          moProcessSelect.innerHTML = '<option value=\"\">Tidak ada data</option>';
          moProcessSelect.setAttribute('disabled','true');
        }
      }
    } catch {}
  }
  async function moRefresh(line) {
    if (!line) {
      if (moOrderCategory) moOrderCategory.textContent = '—';
      if (moOrderType) moOrderType.textContent = '—';
      if (moOrderProcCount) moOrderProcCount.textContent = '0';
      if (moProcessSections) moProcessSections.innerHTML = '';
      if (moProcessList) moProcessList.innerHTML = '';
      if (moAddProcCard) moAddProcCard.classList.add('d-none');
      if (moManageMachinesCard) moManageMachinesCard.classList.add('d-none');
      if (moProcessSelect) moProcessSelect.setAttribute('disabled','true');
      if (moAddProcess) moAddProcess.setAttribute('disabled','true');
      return;
    }
    try {
      const res = await fetch(`/api/style/order/${encodeURIComponent(line)}`, { headers: authHeaders() });
      const data = await res.json();
      const orderObj = data && data.order ? data.order : null;
      moCurrentOrder = orderObj ? { category: orderObj.category || '', type: orderObj.type || '' } : { category: '', type: '' };
      const serverProcs = Array.isArray(data && data.processes) ? data.processes.slice() : [];
      if (serverProcs.length > 0) moProcs = serverProcs;
      const defs = (data && data.defaults) || {};
      Object.keys(defs).forEach(name => {
        const d = defs[name] || {};
        moLastSel[`${line}|${name}`] = { type: d.type || '', qty: Number(d.qty || 1), target: Number(d.target || 0) };
      });
      if (moOrderCategory) moOrderCategory.textContent = moCurrentOrder.category || '—';
      if (moOrderType) moOrderType.textContent = moCurrentOrder.type || '—';
      if (moOrderProcCount) moOrderProcCount.textContent = String(moProcs.length);
      if (moAddProcCard) moAddProcCard.classList.remove('d-none');
      if (moManageMachinesCard) moManageMachinesCard.classList.remove('d-none');
      if (moProcessSelect) moProcessSelect.removeAttribute('disabled');
      if (moAddProcess) moAddProcess.removeAttribute('disabled');
      const opts = moJenisList.map(n => `<option value="${n}">${n}</option>`).join('');
      const machinesRes = await fetch(`/api/lines/${encodeURIComponent(line)}`, { headers: authHeaders() });
      const machData = await machinesRes.json();
      const machines = Array.isArray(machData && machData.data) ? machData.data : [];
      if (moProcessSections) {
        moProcessSections.innerHTML = moProcs.map((p, idx) => {
          const tableId = `moMachineTable-${idx}`;
          const selId = `moJenis-${idx}`;
          const qtyId = `moQty-${idx}`;
          const tgtId = `moTarget-${idx}`;
          const addId = `moAdd-${idx}`;
          const delId = `moDel-${idx}`;
          const rows = machines.filter(m => String(m.job) === String(p.name)).map((m, j) => {
            const btnText = String(m.status) === 'active' ? 'Nonaktifkan' : 'Aktifkan';
            const btnClass = String(m.status) === 'active' ? 'text-danger' : 'text-success';
            return `<tr data-idx="${j}"><td>${m.machine}</td><td>${m.status}</td><td><button class="btn btn-link p-0 ${btnClass}" data-mo-toggle="1" data-machine="${m.machine}" data-status="${m.status}">${btnText}</button></td></tr>`;
          }).join('');
          return `<div class="border rounded p-3"><div class="d-flex justify-content-between align-items-center mb-2"><div class="fw-semibold">${p.name}</div><i class="bi bi-cpu"></i></div><div class="row g-2 align-items-end"><div class="col-md-4"><label class="form-label">Jenis Mesin</label><select id="${selId}" class="form-select"><option value="">Pilih jenis mesin</option>${opts}</select></div><div class="col-md-3"><label class="form-label">Jumlah Mesin</label><input type="number" id="${qtyId}" class="form-control" min="1" value="1" /></div><div class="col-md-3"><label class="form-label">Target</label><input type="number" id="${tgtId}" class="form-control" min="0" value="0" /></div><div class="col-md-2 d-grid gap-2"><button id="${addId}" class="btn btn-accent w-100">Simpan</button><button id="${delId}" class="btn btn-outline-danger w-100">Hapus</button></div></div><div class="table-responsive mt-3"><table class="table table-sm table-striped text-center"><thead><tr><th>Mesin</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="${tableId}">${rows || ''}</tbody></table></div></div>`;
        }).join('');
      }
      moApplyLastSelections(line);
      moRenderProcessList();
      renderFinalDetails();
    } catch {}
  }
  async function moRenderSectionsLocal(line) {
    if (!line) { if (moProcessSections) moProcessSections.innerHTML = ''; return; }
    try {
      const machinesRes = await fetch(`/api/lines/${encodeURIComponent(line)}`, { headers: authHeaders() });
      const machData = await machinesRes.json();
      const machines = Array.isArray(machData && machData.data) ? machData.data : [];
      const opts = moJenisList.map(n => `<option value="${n}">${n}</option>`).join('');
      if (moProcessSections) {
        moProcessSections.innerHTML = moProcs.map((p, idx) => {
          const tableId = `moMachineTable-${idx}`;
          const selId = `moJenis-${idx}`;
          const qtyId = `moQty-${idx}`;
          const tgtId = `moTarget-${idx}`;
          const addId = `moAdd-${idx}`;
          const delId = `moDel-${idx}`;
          const rows = machines.filter(m => String(m.job) === String(p.name)).map((m, j) => {
            const btnText = String(m.status) === 'active' ? 'Nonaktifkan' : 'Aktifkan';
            const btnClass = String(m.status) === 'active' ? 'text-danger' : 'text-success';
            return `<tr data-idx="${j}"><td>${m.machine}</td><td>${m.status}</td><td><button class="btn btn-link p-0 ${btnClass}" data-mo-toggle="1" data-machine="${m.machine}" data-status="${m.status}">${btnText}</button></td></tr>`;
          }).join('');
          return `<div class="border rounded p-3"><div class="d-flex justify-content-between align-items-center mb-2"><div class="fw-semibold">${p.name}</div><i class="bi bi-cpu"></i></div><div class="row g-2 align-items-end"><div class="col-md-4"><label class="form-label">Jenis Mesin</label><select id="${selId}" class="form-select"><option value="">Pilih jenis mesin</option>${opts}</select></div><div class="col-md-3"><label class="form-label">Jumlah Mesin</label><input type="number" id="${qtyId}" class="form-control" min="1" value="1" /></div><div class="col-md-3"><label class="form-label">Target</label><input type="number" id="${tgtId}" class="form-control" min="0" value="0" /></div><div class="col-md-2 d-grid gap-2"><button id="${addId}" class="btn btn-accent w-100">Simpan</button><button id="${delId}" class="btn btn-outline-danger w-100">Hapus</button></div></div><div class="table-responsive mt-3"><table class="table table-sm table-striped text-center"><thead><tr><th>Mesin</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="${tableId}">${rows || ''}</tbody></table></div></div>`;
        }).join('');
      }
      moApplyLastSelections(line);
      renderFinalDetails();
    } catch { if (moProcessSections) moProcessSections.innerHTML = ''; }
  }
  function moApplyLastSelections(line) {
    moProcs.forEach((p, idx) => {
      const k = `${line}|${p.name}`;
      const prev = moLastSel[k];
      const sel = document.getElementById(`moJenis-${idx}`);
      const qtyEl = document.getElementById(`moQty-${idx}`);
      const tgtEl = document.getElementById(`moTarget-${idx}`);
      if (!sel || !qtyEl) return;
      if (prev && prev.type) {
        if (!sel.querySelector(`option[value="${prev.type}"]`)) {
          const opt = document.createElement('option');
          opt.value = prev.type;
          opt.textContent = prev.type;
          sel.appendChild(opt);
        }
        sel.value = prev.type;
      }
      if (prev && prev.qty) qtyEl.value = String(prev.qty);
      if (tgtEl && typeof prev?.target === 'number') tgtEl.value = String(prev.target);
    });
  }
  function renderFinalDetails() {
    const detailsEl = document.getElementById('moReviewDetails');
    if (!detailsEl) return;
    const line = order.line || '';
    if (!line) { detailsEl.innerHTML = ''; return; }
    (async () => {
      let machines = [];
      try {
        const res = await fetch(`/api/lines/${encodeURIComponent(line)}`, { headers: authHeaders() });
        const js = await res.json();
        machines = Array.isArray(js && js.data) ? js.data : [];
      } catch {}
      const rows = (moProcs || []).map(p => {
        const k = `${line}|${p.name}`;
        const sel = moLastSel[k] || {};
        const list = machines.filter(m => String(m.job) === String(p.name));
        const ids = list.map(m => m.machine).join(', ');
        const cnt = list.length;
        return `<tr><td>${p.name}</td><td>${sel.type || ''}</td><td>${Number(sel.qty || 0)}</td><td>${Number(sel.target || 0)}</td><td>${cnt}</td><td>${ids}</td></tr>`;
      }).join('');
      detailsEl.innerHTML = `<div class="mt-3"><div class="fw-semibold mb-2">Rincian Order</div><div class="table-responsive"><table class="table table-sm table-striped text-center"><thead><tr><th>Proses</th><th>Jenis Mesin</th><th>Jumlah</th><th>Target</th><th>Total Mesin</th><th>Daftar Mesin</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    })();
  }
  function moRenderProcessList() {
    if (!moProcessList) return;
    moProcessList.innerHTML = moProcs.map((p, idx) => {
      return `<div class="card p-2" data-mo-proc="${idx}"><div class="d-flex justify-content-between align-items-center"><div class="fw-semibold">${p.name}</div><div class="d-flex gap-2"><button class="btn btn-link p-0 text-warning" data-mo-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" data-mo-act="delete"><i class="bi bi-trash fs-5"></i></button></div></div></div>`;
    }).join('');
    if (moOrderProcCount) moOrderProcCount.textContent = String(moProcs.length);
    const line = order.line || '';
    moRenderSectionsLocal(line);
    renderFinalDetails();
  }
  if (moAddProcess) moAddProcess.addEventListener('click', async () => {
    const name = moProcessSelect && moProcessSelect.value ? moProcessSelect.value.trim() : '';
    if (!name) return;
    moProcs.push({ name });
    if (moProcessSelect) moProcessSelect.value = '';
    moRenderProcessList();
    const line = order.line || '';
    if (!line) return;
    try {
      await fetch('/api/style/process', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, name }) });
      moRenderSectionsLocal(line);
      renderFinalDetails();
    } catch {}
  });
  if (panel) panel.addEventListener('click', async (e) => {
    const addBtn = e.target.closest('[id^="moAdd-"]');
    const delBtn = e.target.closest('[id^="moDel-"]');
    const actBtn = e.target.closest('[data-mo-act]');
    const togBtn = e.target.closest('[data-mo-toggle]');
    if (actBtn) {
      const card = actBtn.closest('[data-mo-proc]');
      const pidx = card ? parseInt(card.getAttribute('data-mo-proc'), 10) : -1;
      if (pidx < 0) return;
      const act = actBtn.getAttribute('data-mo-act');
      if (act === 'delete') {
        const oldName = moProcs[pidx] ? moProcs[pidx].name : '';
        moProcs.splice(pidx, 1);
        moRenderProcessList();
        const line = order.line || '';
        if (line) {
          try {
            await fetch('/api/style/process', { method: 'DELETE', headers: authHeaders(), body: JSON.stringify({ line, name: oldName }) });
            await moRefresh(line);
            renderFinalDetails();
          } catch {}
        }
      }
      if (act === 'edit') {
        const name = prompt('Edit nama proses', moProcs[pidx].name || '');
        if (name) {
          const oldName = moProcs[pidx].name || '';
          const newName = name.trim();
          moProcs[pidx].name = newName;
          moRenderProcessList();
          const line = order.line || '';
          if (line) {
            try {
              await fetch('/api/style/process', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ line, oldName, newName }) });
              await moRefresh(line);
              renderFinalDetails();
            } catch {}
          }
        }
      }
      return;
    }
    if (togBtn) {
      const machine = togBtn.getAttribute('data-machine') || '';
      const curStatus = togBtn.getAttribute('data-status') || '';
      const next = curStatus === 'active' ? 'inactive' : 'active';
      const line = order.line || '';
      if (!line || !machine) return;
    try {
      await fetch('/api/machines/increment', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, machine, goodDelta: 0, rejectDelta: 0, status: next }) });
      await moRenderSectionsLocal(line);
      renderFinalDetails();
    } catch {}
    return;
  }
    if (delBtn) {
      const idx = parseInt(delBtn.id.split('-')[1], 10);
      const line = order.line || '';
      if (!line) { alert('Pilih line terlebih dahulu.'); return; }
      const procCards = moProcessSections.querySelectorAll('.border.rounded.p-3');
      const titleEl = procCards[idx] ? procCards[idx].querySelector('.fw-semibold') : null;
      const processName = titleEl ? titleEl.textContent : '';
      if (!processName) { alert('Nama proses tidak ditemukan.'); return; }
      if (!confirm(`Hapus semua mesin untuk proses ${processName}?`)) return;
      try {
        await fetch('/api/process/machines', { method: 'DELETE', headers: authHeaders(), body: JSON.stringify({ line, processName }) });
      } catch {}
      try { delete moLastSel[`${line}|${processName}`]; } catch {}
      await moRenderSectionsLocal(line);
      renderFinalDetails();
      return;
    }
    if (!addBtn) return;
    const idx = parseInt(addBtn.id.split('-')[1], 10);
    const sel = document.getElementById(`moJenis-${idx}`);
    const qtyEl = document.getElementById(`moQty-${idx}`);
    const tgtEl = document.getElementById(`moTarget-${idx}`);
    const line = order.line || '';
    const machineType = sel && sel.value ? sel.value : '';
    const qty = qtyEl && qtyEl.value ? parseInt(qtyEl.value, 10) : 1;
    const target = tgtEl && tgtEl.value ? parseInt(tgtEl.value, 10) : 0;
    const procCards = moProcessSections.querySelectorAll('.border.rounded.p-3');
    const titleEl = procCards[idx].querySelector('.fw-semibold');
    const processName = titleEl ? titleEl.textContent : '';
    if (!line) { alert('Pilih line terlebih dahulu.'); return; }
    if (!processName) { alert('Nama proses tidak ditemukan.'); return; }
    if (!machineType) { alert('Pilih jenis mesin terlebih dahulu.'); return; }
    try {
      await fetch('/api/process/machines', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, processName, machineType, qty, target }) });
      const prevType = machineType;
      const prevQty = qty;
      const prevTarget = target;
      moLastSel[`${line}|${processName}`] = { type: prevType, qty: prevQty, target: prevTarget };
      await moRenderSectionsLocal(line);
      renderFinalDetails();
      try {
        const sel2 = document.getElementById(`moJenis-${idx}`);
        const qty2 = document.getElementById(`moQty-${idx}`);
        const tgt2 = document.getElementById(`moTarget-${idx}`);
        if (sel2 && !sel2.querySelector(`option[value="${prevType}"]`)) {
          const opt = document.createElement('option');
          opt.value = prevType;
          opt.textContent = prevType;
          sel2.appendChild(opt);
        }
        if (sel2) sel2.value = prevType;
        if (qty2) qty2.value = String(prevQty);
        if (tgt2) tgt2.value = String(prevTarget);
      } catch {}
    } catch {}
  });
  moLoadJenis();
  moLoadProsesProduksi();
  moRefresh(order.line || '');
}

async function renderMoSummaryDetail(line) {
  const detail = document.getElementById('moSummaryDetail');
  if (!detail) return;
  if (!line) { detail.innerHTML = '<div class="text-muted">Pilih line untuk melihat rincian.</div>'; return; }
  detail.innerHTML = '<div class="text-muted">Memuat rincian...</div>';
  try {
    const [orderRes, machinesRes] = await Promise.all([
      fetch(`/api/style/order/${encodeURIComponent(line)}`, { headers: authHeaders() }),
      fetch(`/api/lines/${encodeURIComponent(line)}`, { headers: authHeaders() })
    ]);
    const orderJson = await orderRes.json();
    const machinesJson = await machinesRes.json();
    const order = orderJson && orderJson.order ? orderJson.order : null;
    const processes = Array.isArray(orderJson && orderJson.processes) ? orderJson.processes : [];
    const defaults = (orderJson && orderJson.defaults) ? orderJson.defaults : {};
    const machines = Array.isArray(machinesJson && machinesJson.data) ? machinesJson.data : [];
    if (!order) {
      detail.innerHTML = `<div class="border rounded p-3"><div class="fw-semibold">Line: ${line}</div><div class="text-muted mt-1">Belum ada order.</div></div>`;
      return;
    }
    const rows = processes.map(p => {
      const name = String(p && p.name || '');
      const def = defaults && defaults[name] ? defaults[name] : {};
      const type = def.type || '';
      const qty = Number(def.qty || 0);
      const target = Number(def.target || 0);
      const list = machines.filter(m => String(m.job) === String(name));
      const ids = list.map(m => m.machine).join(', ');
      const cnt = list.length;
      return `<tr><td>${name}</td><td>${type}</td><td>${qty}</td><td>${target}</td><td>${cnt}</td><td>${ids}</td></tr>`;
    }).join('');
    detail.innerHTML = `<div class="border rounded p-3"><div class="row g-3"><div class="col-md-3"><div class="text-muted">Line</div><div class="fw-semibold">${line}</div></div><div class="col-md-3"><div class="text-muted">Kategori</div><div class="fw-semibold">${order.category || '—'}</div></div><div class="col-md-3"><div class="text-muted">Style</div><div class="fw-semibold">${order.type || '—'}</div></div><div class="col-md-3"><div class="text-muted">Total Proses</div><div class="fw-semibold">${processes.length}</div></div></div><div class="table-responsive mt-3"><table class="table table-sm table-striped text-center"><thead><tr><th>Proses</th><th>Jenis Mesin</th><th>Jumlah</th><th>Target</th><th>Total Mesin</th><th>Daftar Mesin</th></tr></thead><tbody>${rows || ''}</tbody></table></div></div>`;
  } catch {
    detail.innerHTML = '<div class="text-danger">Gagal memuat rincian.</div>';
  }
}

const moTbody = document.getElementById('moTbody');
if (moTbody) {
  moTbody.addEventListener('click', async (e) => {
    if (e.target.closest('[data-mo-act]')) return;
    const tr = e.target.closest('tr[data-line]');
    if (!tr) return;
    const line = tr.getAttribute('data-line') || '';
    if (!line) return;
    try { sessionStorage.setItem('moSummaryLine', line); } catch {}
    try {
      moTbody.querySelectorAll('tr').forEach(r => r.classList.remove('table-active'));
      tr.classList.add('table-active');
    } catch {}
    await renderMoSummaryDetail(line);
  });
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-mo-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const line = tr ? tr.getAttribute('data-line') : null;
  const act = btn.getAttribute('data-mo-act');
  if (!line) return;
  if (act === 'edit') {
    try {
      sessionStorage.setItem('route', 'master-order');
      sessionStorage.setItem('moTab', 'order');
      sessionStorage.setItem('moLineFocus', line);
    } catch {}
    showMasterOrder();
    setRouteIndicator('master-order');
    return;
  }
  if (act === 'delete') {
    if (!currentUser || currentUser.role !== 'tech_admin') return;
    if (!confirm(`Hapus order untuk line ${line}?`)) return;
    try {
      await fetch('/api/master/order', { method: 'DELETE', headers: authHeaders(), body: JSON.stringify({ line }) });
      renderMoSummary();
    } catch {}
  }
});
function setMmTab(tab) {
  mmTab = tab;
  const tabs = document.querySelectorAll('[data-mm-tab]');
  tabs.forEach(el => el.classList.toggle('active', el.getAttribute('data-mm-tab') === tab));
  const crumb = document.getElementById('mmCrumb');
  if (crumb) {
    crumb.textContent = tab === 'jenis' ? 'Jenis Mesin' : tab === 'kategori' ? 'Kategori Mesin' : 'Merk Mesin';
  }
  const addBtn = document.getElementById('mmAddBtn');
  if (addBtn) addBtn.classList.toggle('d-none', (currentUser && currentUser.role === 'line_admin') || tab === 'kategori');
  try { sessionStorage.setItem('mmTab', mmTab); } catch {}
  fetchMmData();
}

function showMasterCounter() {
  showSectionOnly('masterCounterSection');
  setMcTab('receiver');
}

function setMcTab(tab) {
  mcTab = tab;
  const tabs = document.querySelectorAll('[data-mc-tab]');
  tabs.forEach(el => el.classList.toggle('active', el.getAttribute('data-mc-tab') === tab));
  const crumb = document.getElementById('mcCrumb');
  if (crumb) {
    crumb.textContent = tab === 'receiver' ? 'Receiver' : tab === 'transmitter' ? 'Transmitter' : tab === 'log' ? 'Log' : 'Task';
  }
  const addBtn = document.getElementById('mcAddBtn');
  if (addBtn) addBtn.classList.toggle('d-none', true);
  try { sessionStorage.setItem('mcTab', mcTab); } catch {}
  fetchMcData();
  setupMcRefresh();
}

function fetchMcData() {
  const thead = document.getElementById('mcThead');
  const tbody = document.getElementById('mcTbody');
  const panel = document.getElementById('mcTaskPanel');
  const toolbar = document.getElementById('mcToolbar');
  if (toolbar) toolbar.classList.toggle('d-none', mcTab === 'task');
  const search = document.getElementById('mcSearch');
  if (search) search.classList.toggle('d-none', mcTab === 'task' || mcTab === 'log');
  if (toolbar) {
    let filters = document.getElementById('mcLogFilters');
    if (mcTab === 'log') {
      if (!filters) {
        filters = document.createElement('div');
        filters.id = 'mcLogFilters';
        filters.className = 'segmented-toggle';
        filters.innerHTML = `
          <button class="toggle-btn" data-log-filter="output">Output</button>
          <button class="toggle-btn" data-log-filter="reject">Reject</button>
          <button class="toggle-btn" data-log-filter="reset">Reset</button>
        `;
        toolbar.appendChild(filters);
        filters.addEventListener('click', (e) => {
          const b = e.target.closest('[data-log-filter]');
          if (!b) return;
          mcLogFilter = b.getAttribute('data-log-filter') || 'all';
          const btns = filters.querySelectorAll('[data-log-filter]');
          btns.forEach(el => el.classList.toggle('active', el === b));
          fetchMcData();
        });
      }
      filters.classList.remove('d-none');
    } else if (filters) {
      filters.classList.add('d-none');
    }
    let txSel = document.getElementById('mcTxSelect');
    if (mcTab === 'log') {
      if (!txSel) {
        txSel = document.createElement('select');
        txSel.id = 'mcTxSelect';
        txSel.className = 'form-select';
        txSel.style.maxWidth = '220px';
        toolbar.appendChild(txSel);
        txSel.addEventListener('change', () => {
          mcTxFilter = txSel.value || '';
          fetchMcData();
        });
      }
      txSel.classList.remove('d-none');
      (async () => {
        try {
          const res = await fetch('/api/transmitters', { headers: authHeaders() });
          const js = await res.json();
          mcTxList = Array.isArray(js && js.data) ? js.data : [];
          const opts = ['<option value=\"\">Pilih Transmitter</option>'].concat(
            mcTxList.map(r => `<option value=\"${String(r.tx || r.transmitter_id || '')}\">${String(r.tx || r.transmitter_id || '')}</option>`)
          );
          txSel.innerHTML = opts.join('');
          txSel.value = mcTxFilter || '';
        } catch {}
      })();
    } else if (txSel) {
      txSel.classList.add('d-none');
    }
  }
  if (toolbar) {
    let pingAllBtn = toolbar.querySelector('#mcPingAllBtn');
    if (mcTab === 'receiver') {
      if (!pingAllBtn) {
        pingAllBtn = document.createElement('button');
        pingAllBtn.id = 'mcPingAllBtn';
        pingAllBtn.className = 'btn btn-outline-primary';
        pingAllBtn.textContent = 'Ping Semua';
        toolbar.appendChild(pingAllBtn);
        pingAllBtn.addEventListener('click', async () => {
          const macs = Array.isArray(mcRows) ? mcRows.map(r => r.mac_address).filter(Boolean) : [];
          for (const mac of macs) {
            try { await fetch(`/api/receivers/${encodeURIComponent(mac)}/ping`, { method: 'POST', headers: authHeaders() }); } catch {}
          }
          try { fetchMcData(); } catch {}
        });
      }
      pingAllBtn.classList.remove('d-none');
    } else if (pingAllBtn) {
      pingAllBtn.classList.add('d-none');
    }
  }
  if (mcTab === 'task') {
    if (panel) panel.classList.remove('d-none');
    if (thead) thead.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
    populateMcTaskLines();
    return;
  }
  if (panel) panel.classList.add('d-none');
  if (!thead || !tbody) return;
  thead.innerHTML = '';
  tbody.innerHTML = '';
  (async () => {
    try {
      const q = (search && search.value ? search.value.toLowerCase() : '').trim();
      if (mcTab === 'receiver') {
        const res = await fetch('/api/iot/status?threshold_ms=10000', { headers: authHeaders() });
        const json = await res.json();
        const rows = Array.isArray(json && json.data) ? json.data : [];
        mcRows = rows;
        thead.innerHTML = '<tr><th>MAC</th><th>Nama</th><th>Last Seen</th><th>Status</th><th>Aksi</th></tr>';
        const filtered = rows.filter(r => !q || String(r.mac_address || '').toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q));
        tbody.innerHTML = filtered.map(r => {
          const last = r.last_seen ? new Date(r.last_seen).toLocaleString() : '-';
          const st = r.connected ? '<span class="badge bg-success">Connected</span>' : '<span class="badge bg-secondary">Offline</span>';
          return `<tr data-row="${r.mac_address}">
            <td>${r.mac_address}</td>
            <td><span data-name-label>${r.name || '-'}</span></td>
            <td>${last}</td>
            <td>${st}</td>
            <td>
              <button class="btn btn-link p-0 me-2 text-primary" data-action="ping" data-mac="${r.mac_address}" title="Ping"><i class="bi bi-broadcast fs-5"></i></button>
              <button class="btn btn-link p-0 me-2 text-warning" data-action="edit" data-mac="${r.mac_address}" title="Edit"><i class="bi bi-pencil-square fs-5"></i></button>
              <button class="btn btn-link p-0 text-danger" data-action="delete" data-mac="${r.mac_address}" title="Hapus"><i class="bi bi-trash fs-5"></i></button>
            </td>
          </tr>`;
        }).join('');
      } else if (mcTab === 'transmitter') {
        const res = await fetch('/api/transmitters?threshold_ms=10000', { headers: authHeaders() });
        const json = await res.json();
        const rows = Array.isArray(json && json.data) ? json.data : [];
        thead.innerHTML = '<tr><th>TX</th><th>Nama</th><th>Last Seen</th><th>Status</th><th>Receiver</th><th style="width:120px">Aksi</th></tr>';
        const filtered = rows.filter(r => {
          const tx = String(r.tx || '').toLowerCase();
          const name = String(r.name || '').toLowerCase();
          const mac = String(r.mac_address || '').toLowerCase();
          return !q || tx.includes(q) || name.includes(q) || mac.includes(q);
        });
        tbody.innerHTML = filtered.map(r => {
          const mac = r.mac_address || '-';
          const name = r.name || r.tx || '-';
          const last = r.last_seen ? new Date(r.last_seen).toLocaleString() : '-';
          const st = r.connected ? '<span class="badge bg-success">Online</span>' : '<span class="badge bg-secondary">Offline</span>';
          const canEditTx = currentUser && currentUser.role === 'tech_admin';
          const pingBtn = `<button class="btn btn-link p-0 me-2 text-primary" data-action="tx-ping" data-tx="${r.tx}" title="Ping"><i class="bi bi-broadcast fs-5"></i></button>`;
          const editBtn = canEditTx ? `<button class="btn btn-link p-0 me-2 text-warning" data-action="tx-edit" data-tx="${r.tx}" title="Edit"><i class="bi bi-pencil-square fs-5"></i></button>` : '';
          const delBtn = canEditTx ? `<button class="btn btn-link p-0 text-danger" data-action="tx-delete" data-tx="${r.tx}" title="Hapus"><i class="bi bi-trash fs-5"></i></button>` : '';
          const unbindBtn = (canEditTx && r.mac_address) ? `<button class="btn btn-link p-0 ms-2 text-danger" data-action="unbind" data-tx="${r.tx}" title="Putus"><i class="bi bi-link-slash fs-5"></i></button>` : '';
          return `<tr data-row="${r.tx}"><td>${r.tx || '-'}</td><td>${name}</td><td>${last}</td><td>${st}</td><td>${mac}</td><td>${pingBtn}${editBtn}${delBtn}${unbindBtn}</td></tr>`;
        }).join('');
      } else if (mcTab === 'log') {
        const res = await fetch('/api/iot/logs?limit=200', { headers: authHeaders() });
        const json = await res.json();
        const rows = Array.isArray(json && json.data) ? json.data : [];
        thead.innerHTML = '<tr><th>ID</th><th>RX MAC</th><th>Type</th><th>Out</th><th>Reject</th><th>Timestamp</th></tr>';
        let filtered = rows.filter(r => {
          const mac = String(r.rx || '').toLowerCase();
          const tx = String(r.tx || '').toLowerCase();
          const type = String(r.type || '').toLowerCase();
          return !q || mac.includes(q) || tx.includes(q) || type.includes(q);
        });
        if (mcTxFilter) filtered = filtered.filter(r => String(r.tx || '').toLowerCase() === String(mcTxFilter).toLowerCase());
        if (mcLogFilter === 'output') filtered = filtered.filter(r => String(r.type || '').toLowerCase() === 'output');
        else if (mcLogFilter === 'reject') filtered = filtered.filter(r => String(r.type || '').toLowerCase() === 'reject');
        else if (mcLogFilter === 'reset') filtered = filtered.filter(r => String(r.type || '').toLowerCase() === 'reset');
        tbody.innerHTML = filtered.map(r => {
          const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : '-';
          return `<tr><td>${r.id}</td><td>${r.rx || '-'}</td><td>${r.type}</td><td>${r.value_output || 0}</td><td>${r.value_reject || 0}</td><td>${ts}</td></tr>`;
        }).join('');
      }
    } catch {}
  })();
}

function setupMcRefresh() {
  if (mcRefreshTimer) { clearInterval(mcRefreshTimer); mcRefreshTimer = null; }
  if (mcTab === 'task') return;
  mcRefreshTimer = setInterval(() => {
    try { fetchMcData(); } catch {}
  }, 5000);
}

const mcTabs = document.getElementById('mcTabs');
if (mcTabs) {
  mcTabs.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mc-tab]');
    if (!t) return;
    setMcTab(t.getAttribute('data-mc-tab'));
  });
}
const mcSearch = document.getElementById('mcSearch');
if (mcSearch) {
  mcSearch.addEventListener('input', () => {
    if (mcTab === 'task') {
      const sel = document.getElementById('mcTaskLineSelect');
      const v = sel && sel.value ? sel.value : '';
      if (v) renderMcTask(v);
    } else {
      fetchMcData();
    }
  });
}

async function populateMcTaskLines() {
  try {
    const sel = document.getElementById('mcTaskLineSelect');
    if (!sel) return;
    if (sel.options.length === 0) {
      const res = await fetch('/api/master/line', { headers: authHeaders() });
      const data = await res.json();
      const rows = Array.isArray(data.data) ? data.data : [];
      sel.innerHTML = rows.map(r => `<option value="${r.nama_line}">${r.nama_line}</option>`).join('');
    }
    const v = sel.value || (sel.options[0] ? sel.options[0].value : '');
    if (v) renderMcTask(v);
  } catch {}
}

async function renderMcTask(line) {
  try {
    const res = await fetch(`/api/lines/${encodeURIComponent(line)}`, { headers: authHeaders() });
    const data = await res.json();
    let machines = sortMachines(Array.isArray(data && data.data) ? data.data : []);
    const qEl = document.getElementById('mcSearch');
    const qRaw = qEl && qEl.value ? qEl.value : '';
    const q = String(qRaw || '').trim().toLowerCase();
    if (q) {
      const tokens = q.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
      machines = machines.filter(m => {
        const name = String(m.machine || '').toLowerCase();
        const job = String(m.job || '').toLowerCase();
        if (tokens.length === 0) return name.includes(q) || job.includes(q);
        return tokens.some(tok => name.includes(tok) || job.includes(tok));
      });
    }
    buildMcTaskGrid(machines);
  } catch {}
}

const mcTaskSel = document.getElementById('mcTaskLineSelect');
if (mcTaskSel) {
  mcTaskSel.addEventListener('change', () => {
    const v = mcTaskSel.value;
    if (v) renderMcTask(v);
  });
}

const mcTbodyEl = document.getElementById('mcTbody');
if (mcTbodyEl) {
  mcTbodyEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const act = btn.getAttribute('data-action');
    if (act === 'ping') {
      const mac = btn.getAttribute('data-mac');
      try {
        await fetch(`/api/receivers/${encodeURIComponent(mac)}/ping`, { method: 'POST', headers: authHeaders() });
      } catch {}
      try { fetchMcData(); } catch {}
    } else if (act === 'edit') {
      const mac = btn.getAttribute('data-mac');
      const row = document.querySelector(`tr[data-row="${CSS.escape(mac)}"]`);
      const curLabel = row ? row.querySelector('[data-name-label]') : null;
      const current = curLabel ? curLabel.textContent : '';
      const name = prompt('Nama Receiver:', current === '-' ? '' : current || '');
      try {
        const res = await fetch(`/api/receivers/${encodeURIComponent(mac)}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name }) });
        const ok = res.ok;
        if (!ok) { alert('Gagal menyimpan nama'); return; }
        fetchMcData();
      } catch { alert('Gagal menyimpan nama'); }
    } else if (act === 'delete') {
      const mac = btn.getAttribute('data-mac');
      if (!confirm(`Hapus receiver ${mac}?`)) return;
      try {
        const res = await fetch(`/api/receivers/${encodeURIComponent(mac)}`, { method: 'DELETE', headers: authHeaders() });
        const ok = res.ok;
        if (!ok) { alert('Gagal menghapus receiver'); return; }
        fetchMcData();
      } catch { alert('Gagal menghapus receiver'); }
    } else if (act === 'unbind') {
      const tx = btn.getAttribute('data-tx');
      if (!tx) return;
      if (!confirm(`Putus TX ${tx} dari receiver?`)) return;
      try {
        const res = await fetch(`/api/transmitters/${encodeURIComponent(tx)}/unbind`, { method: 'POST', headers: authHeaders() });
        if (!res.ok) { alert('Gagal memutus'); return; }
        fetchMcData();
      } catch { alert('Gagal memutus'); }
    } else if (act === 'tx-ping') {
      const tx = btn.getAttribute('data-tx');
      try {
        await fetch(`/api/transmitters/${encodeURIComponent(tx)}/ping`, { method: 'POST', headers: authHeaders() });
      } catch {}
      try { fetchMcData(); } catch {}
    } else if (act === 'tx-edit') {
      const tx = btn.getAttribute('data-tx');
      const name = prompt('Nama Transmitter:', '');
      if (name == null) return;
      try {
        const res = await fetch(`/api/transmitters/${encodeURIComponent(tx)}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name }) });
        const ok = res.ok;
        if (!ok) { alert('Gagal menyimpan nama'); return; }
        fetchMcData();
      } catch { alert('Gagal menyimpan nama'); }
    } else if (act === 'tx-delete') {
      const tx = btn.getAttribute('data-tx');
      if (!confirm(`Hapus transmitter ${tx}?`)) return;
      try {
        const res = await fetch(`/api/transmitters/${encodeURIComponent(tx)}`, { method: 'DELETE', headers: authHeaders() });
        const ok = res.ok;
        if (!ok) { alert('Gagal menghapus transmitter'); return; }
        fetchMcData();
      } catch { alert('Gagal menghapus transmitter'); }
    }
  });
}



function buildMcTaskGrid(machines) {
  const grid = document.getElementById('mcTaskGrid');
  if (!grid) return;
  grid.innerHTML = '';
  machines.forEach(m => {
    const card = document.createElement('div');
    card.className = 'machine-card';
    card.dataset.machine = m.machine;
    const dotCls = (String(m.status) === 'offline') ? 'status-offline' : 'status-active';
    const parts = String(m.machine).split('-');
    const machineType = parts.length >= 2 ? parts[parts.length - 2] : '';
    card.innerHTML = `
      <div class=\"machine-header\">
        <div class=\"machine-title\">${m.job}</div>
        <div class=\"status-dot ${dotCls}\"></div>
      </div>
      <div class=\"machine-job\">${machineType}</div>
      <div class=\"mt-2\">
        <div class=\"text-muted\">Transmitter</div>
        <div class=\"d-flex align-items-center gap-2\">
          <span class=\"fw-semibold\" data-tx-label>${m.tx || '—'}</span>
          <button class=\"btn btn-sm btn-outline-primary\" data-action=\"assign-tx\">Pilih Transmitter</button>
          ${m.tx ? '<button class=\"btn btn-sm btn-outline-danger\" data-action=\"unassign-tx\">Hapus</button>' : ''}
        </div>
      </div>
    `;
    grid.appendChild(card);
    card.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      const lineSel = document.getElementById('mcTaskLineSelect');
      const line = lineSel && lineSel.value ? lineSel.value : '';
      const machine = card.dataset.machine;
      if (!line || !machine) return;
      if (act === 'assign-tx') {
        try {
          const txRes = await fetch('/api/transmitters/available?threshold_ms=10000', { headers: authHeaders() });
          const txJson = await txRes.json();
          const availableAll = Array.isArray(txJson && txJson.data) ? txJson.data : [];
          const list = availableAll.filter(r => r && r.connected);
          if (!list.length) { alert('Tidak ada TX tersedia'); return; }
          const menu = list.map(r => {
            const tx = String(r.tx || '');
            const name = String(r.name || tx || '');
            const st = r.connected ? 'Online' : 'Offline';
            return `${tx} | ${name} | ${st}`;
          }).join('\n');
          const choice = prompt('Masukkan TX dari daftar:\n' + menu);
          if (!choice) return;
          const tx = String(choice).split('|')[0].trim();
          if (!list.find(r => String(r.tx) === tx)) { alert('TX tidak tersedia'); return; }
          const r2 = await fetch('/api/machine/tx', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ line, machine, tx }) });
          if (r2.status === 409) { alert('TX sudah dipakai'); return; }
          const d2 = await r2.json();
          if (d2 && d2.ok) { renderMcTask(line); } else { alert('Gagal assign TX'); }
        } catch { alert('Gagal assign TX'); }
      } else if (act === 'unassign-tx') {
        if (!confirm('Hapus TX dari mesin ini?')) return;
        try {
          const r3 = await fetch('/api/machine/tx', { method: 'DELETE', headers: authHeaders(), body: JSON.stringify({ line, machine }) });
          const d3 = await r3.json();
          if (d3 && d3.ok) { renderMcTask(line); } else { alert('Gagal hapus TX'); }
        } catch { alert('Gagal hapus TX'); }
      }
    });
  });
}

async function fetchMmData() {
  try {
    if (mmTab === 'jenis') {
      const res = await fetch('/api/master/jenis', { headers: authHeaders() });
      const data = await res.json();
      mmRows = (data && data.data) || [];
      mmJenisIndex = mmRows.slice();
      renderMmTable();
    } else if (mmTab === 'merk') {
      const res = await fetch('/api/master/merk', { headers: authHeaders() });
      const data = await res.json();
      mmRows = (data && data.data) || [];
      mmJenisIndex = await fetchJenisIndex();
      renderMmTable();
    } else {
      mmRows = [];
      mmJenisIndex = await fetchJenisIndex();
      renderMmTable();
    }
  } catch {}
}

async function fetchJenisIndex() {
  try {
    const res = await fetch('/api/master/jenis', { headers: authHeaders() });
    const data = await res.json();
    return (data && data.data) || [];
  } catch { return []; }
}

async function fetchMlData() {
  try {
    const thead = document.getElementById('mlThead');
    const tbody = document.getElementById('mlTbody');
    if (thead && tbody) {
      thead.innerHTML = '<tr><th>ID Line</th><th>Nama Line</th><th style="width:120px">Aksi</th></tr>';
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Memuat data...</td></tr>';
    }
    const res = await fetch('/api/master/line', { headers: authHeaders() });
    const data = await res.json();
    mlRows = (data && data.data) || [];
    renderMlTable();
  } catch {
    const tbody = document.getElementById('mlTbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-danger">Gagal memuat data</td></tr>';
  }
}

function renderMlTable() {
  const thead = document.getElementById('mlThead');
  const tbody = document.getElementById('mlTbody');
  const search = document.getElementById('mlSearch');
  const q = (search && search.value ? search.value.toLowerCase() : '').trim();
  if (!thead || !tbody) return;
  thead.innerHTML = '<tr><th>ID Line</th><th>Nama Line</th><th style="width:120px">Aksi</th></tr>';
  const rows = mlRows.filter(r => !q || String(r.nama_line).toLowerCase().includes(q));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Tidak ada data</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr data-id="${r.id_line}"><td>${r.id_line}</td><td>${r.nama_line}</td><td>
    ${currentUser && currentUser.role === 'tech_admin' ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-ml-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-ml-act="delete"><i class="bi bi-trash fs-5"></i></button>` : ''}
  </td></tr>`).join('');
}

async function fetchMsData() {
  try {
    const thead = document.getElementById('msThead');
    const tbody = document.getElementById('msTbody');
    if (thead && tbody) {
      thead.innerHTML = '<tr><th>ID</th><th>Style</th><th style="width:120px">Aksi</th></tr>';
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Memuat data...</td></tr>';
    }
    const res = await fetch('/api/master/style', { headers: authHeaders() });
    const data = await res.json();
    msRows = (data && data.data) || [];
    renderMsTable();
  } catch {
    const tbody = document.getElementById('msTbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-danger">Gagal memuat data</td></tr>';
  }
}

function renderMsTable() {
  const thead = document.getElementById('msThead');
  const tbody = document.getElementById('msTbody');
  const search = document.getElementById('msSearch');
  const q = (search && search.value ? search.value.toLowerCase() : '').trim();
  if (!thead || !tbody) return;
  thead.innerHTML = '<tr><th>ID</th><th>Style</th><th style="width:120px">Aksi</th></tr>';
  const rows = msRows.filter(r => !q || String(r && r.style_nama || '').toLowerCase().includes(q));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Tidak ada data</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const id = r && r.id_style != null ? r.id_style : '';
    const name = r && r.style_nama ? String(r.style_nama) : '';
    const aksi = (currentUser && currentUser.role === 'tech_admin')
      ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-ms-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-ms-act="delete"><i class="bi bi-trash fs-5"></i></button>`
      : '';
    return `<tr data-id="${id}"><td>${id}</td><td>${name}</td><td>${aksi}</td></tr>`;
  }).join('');
}

async function fetchMpData() {
  try {
    const thead = document.getElementById('mpThead');
    const tbody = document.getElementById('mpTbody');
    if (thead && tbody) {
      thead.innerHTML = '<tr><th>ID</th><th>Proses</th><th style="width:120px">Aksi</th></tr>';
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Memuat data...</td></tr>';
    }
    const res = await fetch('/api/master/proses_produksi', { headers: authHeaders() });
    const data = await res.json();
    mpRows = (data && data.data) || [];
    renderMpTable();
  } catch {
    const tbody = document.getElementById('mpTbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-danger">Gagal memuat data</td></tr>';
  }
}

function renderMpTable() {
  const thead = document.getElementById('mpThead');
  const tbody = document.getElementById('mpTbody');
  const search = document.getElementById('mpSearch');
  const q = (search && search.value ? search.value.toLowerCase() : '').trim();
  if (!thead || !tbody) return;
  thead.innerHTML = '<tr><th>ID</th><th>Proses</th><th style="width:120px">Aksi</th></tr>';
  const rows = mpRows.filter(r => !q || String(r && r.nama || '').toLowerCase().includes(q));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Tidak ada data</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const aksi = (currentUser && currentUser.role === 'tech_admin')
      ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-mp-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-mp-act="delete"><i class="bi bi-trash fs-5"></i></button>`
      : '';
    return `<tr data-id="${r.id}"><td>${r.id}</td><td>${r.nama}</td><td>${aksi}</td></tr>`;
  }).join('');
}

function showMasterColor() {
  showSectionOnly('masterColorSection');
  fetchMcolData();
}

async function fetchMcolData() {
  try {
    const thead = document.getElementById('mcolThead');
    const tbody = document.getElementById('mcolTbody');
    if (thead && tbody) {
      thead.innerHTML = '<tr><th>ID</th><th>Color</th><th style="width:120px">Aksi</th></tr>';
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Memuat data...</td></tr>';
    }
    const res = await fetch('/api/master/color', { headers: authHeaders() });
    const data = await res.json();
    mcolRows = (data && data.data) || [];
    renderMcolTable();
  } catch {
    const tbody = document.getElementById('mcolTbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-danger">Gagal memuat data</td></tr>';
  }
}

function renderMcolTable() {
  const thead = document.getElementById('mcolThead');
  const tbody = document.getElementById('mcolTbody');
  const search = document.getElementById('mcolSearch');
  const q = (search && search.value ? search.value.toLowerCase() : '').trim();
  if (!thead || !tbody) return;
  thead.innerHTML = '<tr><th>ID</th><th>Color</th><th style="width:120px">Aksi</th></tr>';
  const rows = mcolRows.filter(r => !q || String(r.color).toLowerCase().includes(q));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Tidak ada data</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr data-id="${r.id}"><td>${r.id}</td><td>${r.color}</td><td>
    ${currentUser && currentUser.role === 'tech_admin' ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-mcol-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-mcol-act="delete"><i class="bi bi-trash fs-5"></i></button>` : ''}
  </td></tr>`).join('');
}

document.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-mcol-act]');
  if (!actBtn) return;
  if (!currentUser || currentUser.role !== 'tech_admin') return;
  const tr = actBtn.closest('tr');
  const id = tr ? tr.getAttribute('data-id') : null;
  const act = actBtn.getAttribute('data-mcol-act');
  if (act === 'edit') {
    const row = mcolRows.find(r => String(r.id) === String(id));
    const current = row ? row.color : '';
    const color = prompt('Nama Color:', current || '');
    if (!color) return;
    await fetch(`/api/master/color/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ color }) });
    await fetchMcolData();
    return;
  } else if (act === 'delete') {
    if (!confirm('Hapus color?')) return;
    await fetch(`/api/master/color/${id}`, { method: 'DELETE', headers: authHeaders() });
    await fetchMcolData();
  }
});

const mcolAddBtn = document.getElementById('mcolAddBtn');
if (mcolAddBtn) {
  mcolAddBtn.addEventListener('click', async () => {
    if (!currentUser || currentUser.role !== 'tech_admin') return;
    const color = prompt('Nama Color:');
    if (!color) return;
    await fetch('/api/master/color', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ color }) });
    await fetchMcolData();
  });
}

const mcolSearch = document.getElementById('mcolSearch');
if (mcolSearch) {
  mcolSearch.addEventListener('input', () => renderMcolTable());
}

const msSearch = document.getElementById('msSearch');
if (msSearch) {
  msSearch.addEventListener('input', () => renderMsTable());
}

const mpSearch = document.getElementById('mpSearch');
if (mpSearch) {
  mpSearch.addEventListener('input', () => renderMpTable());
}

document.addEventListener('click', (e) => {
  const actBtn = e.target.closest('[data-ms-act]');
  if (!actBtn) return;
  if (!currentUser || currentUser.role !== 'tech_admin') return;
  const tr = actBtn.closest('tr');
  const id = tr ? tr.getAttribute('data-id') : null;
  if (!id) return;
  const act = actBtn.getAttribute('data-ms-act');
  if (act === 'edit') {
    const row = msRows.find(r => String(r.id_style) === String(id));
    const current = row ? row.style_nama : '';
    const style_nama = prompt('Nama Style:', current || '');
    if (style_nama == null) return;
    if (!String(style_nama).trim()) return;
    fetch(`/api/master/style/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ style_nama }) })
      .then(() => fetchMsData())
      .catch(() => {});
    return;
  } else if (act === 'delete') {
    if (!confirm('Hapus style?')) return;
    fetch(`/api/master/style/${id}`, { method: 'DELETE', headers: authHeaders() })
      .then(() => fetchMsData())
      .catch(() => {});
  }
});

document.addEventListener('click', (e) => {
  const actBtn = e.target.closest('[data-mp-act]');
  if (!actBtn) return;
  if (!currentUser || currentUser.role !== 'tech_admin') return;
  const tr = actBtn.closest('tr');
  const id = tr ? tr.getAttribute('data-id') : null;
  if (!id) return;
  const act = actBtn.getAttribute('data-mp-act');
  if (act === 'edit') {
    const row = mpRows.find(r => String(r.id) === String(id));
    const current = row ? row.nama : '';
    const nama = prompt('Nama Proses:', current || '');
    if (nama == null) return;
    if (!String(nama).trim()) return;
    fetch(`/api/master/proses_produksi/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ nama }) })
      .then(() => fetchMpData())
      .catch(() => {});
    return;
  } else if (act === 'delete') {
    if (!confirm('Hapus proses?')) return;
    fetch(`/api/master/proses_produksi/${id}`, { method: 'DELETE', headers: authHeaders() })
      .then(() => fetchMpData())
      .catch(() => {});
  }
});

document.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-ml-act]');
  if (!actBtn) return;
  if (!currentUser || currentUser.role !== 'tech_admin') return;
  const tr = actBtn.closest('tr');
  const id = tr ? tr.getAttribute('data-id') : null;
  const act = actBtn.getAttribute('data-ml-act');
  if (act === 'edit') {
    const row = mlRows.find(r => String(r.id_line) === String(id));
    openMlModal('edit', { id, nama_line: row ? row.nama_line : '' });
    return;
  } else if (act === 'delete') {
    if (!confirm('Hapus line?')) return;
    await fetch(`/api/master/line/${id}`, { method: 'DELETE', headers: authHeaders() });
    await fetchMlData();
  }
});

const mlAddBtn = document.getElementById('mlAddBtn');
if (mlAddBtn) {
  mlAddBtn.addEventListener('click', async () => {
    if (!currentUser || currentUser.role !== 'tech_admin') return;
    openMlModal('add', {});
  });
}

const mlSearch = document.getElementById('mlSearch');
if (mlSearch) {
  mlSearch.addEventListener('input', () => renderMlTable());
}

function openMlModal(action, data) {
  mlModalAction = action;
  mlModalEditId = action === 'edit' ? (data && data.id) : null;
  const modal = document.getElementById('mlModal');
  const title = document.getElementById('mlModalTitle');
  const form = document.getElementById('mlForm');
  if (!modal || !title || !form) return;
  title.textContent = action === 'add' ? 'Tambah Line' : 'Edit Line';
  form.innerHTML = `<div><label class="form-label">Nama Line</label><input type="text" class="form-control" id="mlName" value="${data && data.nama_line ? String(data.nama_line) : ''}"></div>`;
  modal.classList.remove('d-none');
}

function closeMlModal() {
  const modal = document.getElementById('mlModal');
  if (modal) modal.classList.add('d-none');
  mlModalAction = null;
  mlModalEditId = null;
}

const mlModalClose = document.getElementById('mlModalClose');
const mlModalCancel = document.getElementById('mlModalCancel');
const mlModalSave = document.getElementById('mlModalSave');
if (mlModalClose) mlModalClose.addEventListener('click', closeMlModal);
if (mlModalCancel) mlModalCancel.addEventListener('click', closeMlModal);
if (mlModalSave) mlModalSave.addEventListener('click', async () => {
  const modal = document.getElementById('mlModal');
  if (!modal || !mlModalAction) return;
  const nameEl = document.getElementById('mlName');
  const nama_line = nameEl ? nameEl.value.trim() : '';
  if (!nama_line) return;
  if (mlModalAction === 'add') {
    await fetch('/api/master/line', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ nama_line }) });
  } else {
    await fetch(`/api/master/line/${mlModalEditId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ nama_line }) });
  }
  closeMlModal();
  await fetchMlData();
});

function renderMmTable() {
  const thead = document.getElementById('mmThead');
  const tbody = document.getElementById('mmTbody');
  const search = document.getElementById('mmSearch');
  const q = (search && search.value ? search.value.toLowerCase() : '').trim();
  if (!thead || !tbody) return;
  if (mmTab === 'jenis') {
    thead.innerHTML = '<tr><th>ID</th><th>Nama</th><th style="width:120px">Aksi</th></tr>';
    const rows = mmRows.filter(r => !q || String(r.name).toLowerCase().includes(q));
    tbody.innerHTML = rows.map(r => `<tr data-id="${r.id_jnsmesin}"><td>${r.id_jnsmesin}</td><td>${r.name}</td><td>
      ${currentUser && currentUser.role === 'tech_admin' ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-mm-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-mm-act="delete"><i class="bi bi-trash fs-5"></i></button>` : ''}
    </td></tr>`).join('');
  } else if (mmTab === 'merk') {
    thead.innerHTML = '<tr><th>ID</th><th>Nama</th><th>Jenis Mesin</th><th style="width:120px">Aksi</th></tr>';
    const rows = mmRows.filter(r => {
      const jm = r.jenis_mesin || '';
      return !q || String(r.name).toLowerCase().includes(q) || String(jm).toLowerCase().includes(q);
    });
    tbody.innerHTML = rows.map(r => `<tr data-id="${r.id_merk}"><td>${r.id_merk}</td><td>${r.name}</td><td>${r.jenis_mesin || '-'} </td><td>
      ${currentUser && currentUser.role === 'tech_admin' ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-mm-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-mm-act="delete"><i class="bi bi-trash fs-5"></i></button>` : ''}
    </td></tr>`).join('');
  } else {
    thead.innerHTML = '<tr><th>ID</th><th>Kategori</th><th style="width:120px">Aksi</th></tr>';
    const rows = mmRows;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted">Tidak ada data</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `<tr data-id="${r.id_kategori || ''}"><td>${r.id_kategori || ''}</td><td>${r.name || ''}</td><td></td></tr>`).join('');
  }
}

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-mm-tab]');
  if (tabBtn) { setMmTab(tabBtn.getAttribute('data-mm-tab')); return; }
  const actBtn = e.target.closest('[data-mm-act]');
  if (!actBtn) return;
  if (!currentUser || currentUser.role !== 'tech_admin') return;
  const tr = actBtn.closest('tr');
  const id = tr ? tr.getAttribute('data-id') : null;
  const act = actBtn.getAttribute('data-mm-act');
  if (mmTab === 'jenis') {
    if (act === 'edit') {
      const row = mmRows.find(r => String(r.id_jnsmesin) === String(id));
      openMmModal('edit', 'jenis', { id, name: row ? row.name : '' });
      return;
    } else if (act === 'delete') {
      if (!confirm('Hapus jenis mesin?')) return;
      await fetch(`/api/master/jenis/${id}`, { method: 'DELETE', headers: authHeaders() });
    }
  } else {
    if (act === 'edit') {
      const row = mmRows.find(r => String(r.id_merk) === String(id));
      openMmModal('edit', 'merk', { id, name: row ? row.name : '', id_jnsmesin: row ? row.id_jnsmesin : null });
      return;
    } else if (act === 'delete') {
      if (!confirm('Hapus merk?')) return;
      await fetch(`/api/master/merk/${id}`, { method: 'DELETE', headers: authHeaders() });
    }
  }
  await fetchMmData();
});

const mmAddBtn = document.getElementById('mmAddBtn');
if (mmAddBtn) {
  mmAddBtn.addEventListener('click', async () => {
    if (!currentUser || currentUser.role !== 'tech_admin') return;
    openMmModal('add', mmTab, {});
  });
}

const mmSearch = document.getElementById('mmSearch');
if (mmSearch) {
  mmSearch.addEventListener('input', () => renderMmTable());
}

function openMmModal(action, entity, data) {
  mmModalAction = action;
  mmModalEditId = action === 'edit' ? (data && data.id) : null;
  const modal = document.getElementById('mmModal');
  const title = document.getElementById('mmModalTitle');
  const form = document.getElementById('mmForm');
  if (!modal || !title || !form) return;
  let t = '';
  if (entity === 'jenis') t = action === 'add' ? 'Tambah Jenis Mesin' : 'Edit Jenis Mesin';
  else t = action === 'add' ? 'Tambah Merk Mesin' : 'Edit Merk Mesin';
  title.textContent = t;
  if (entity === 'jenis') {
    form.innerHTML = `<div><label class="form-label">Nama</label><input type="text" class="form-control" id="mmName" value="${data && data.name ? String(data.name) : ''}"></div>`;
  } else {
    const opts = (mmJenisIndex || []).map(j => `<option value="${j.id_jnsmesin}" ${data && data.id_jnsmesin == j.id_jnsmesin ? 'selected' : ''}>${j.name}</option>`).join('');
    form.innerHTML = `<div class="vstack gap-3"><div><label class="form-label">Nama</label><input type="text" class="form-control" id="mmName" value="${data && data.name ? String(data.name) : ''}"></div><div><label class="form-label">Jenis Mesin</label><select id="mmJenisSelect" class="form-select"><option value="">Tidak ada</option>${opts}</select></div></div>`;
  }
  modal.classList.remove('d-none');
  modal.dataset.entity = entity;
}

function closeMmModal() {
  const modal = document.getElementById('mmModal');
  if (modal) modal.classList.add('d-none');
  mmModalAction = null;
  mmModalEditId = null;
}

const mmModalClose = document.getElementById('mmModalClose');
const mmModalCancel = document.getElementById('mmModalCancel');
const mmModalSave = document.getElementById('mmModalSave');
if (mmModalClose) mmModalClose.addEventListener('click', closeMmModal);
if (mmModalCancel) mmModalCancel.addEventListener('click', closeMmModal);
if (mmModalSave) mmModalSave.addEventListener('click', async () => {
  const modal = document.getElementById('mmModal');
  if (!modal || !mmModalAction) return;
  const entity = modal.dataset.entity;
  const nameEl = document.getElementById('mmName');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) return;
  if (entity === 'jenis') {
    if (mmModalAction === 'add') {
      await fetch('/api/master/jenis', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name }) });
    } else {
      await fetch(`/api/master/jenis/${mmModalEditId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name }) });
    }
  } else {
    const jenisEl = document.getElementById('mmJenisSelect');
    const idj = jenisEl && jenisEl.value ? parseInt(jenisEl.value, 10) : null;
    if (mmModalAction === 'add') {
      await fetch('/api/master/merk', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name, id_jnsmesin: idj }) });
    } else {
      await fetch(`/api/master/merk/${mmModalEditId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name, id_jnsmesin: idj }) });
    }
  }
  closeMmModal();
  await fetchMmData();
});
function setRouteIndicator(route) {
  const links = document.querySelectorAll('[data-nav]');
  links.forEach(el => {
    const nav = el.getAttribute('data-nav');
    el.classList.toggle('active', nav === route);
  });
}
