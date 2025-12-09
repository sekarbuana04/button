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
    card.innerHTML = `
      <div class="machine-header">
        <div class="machine-title">${m.machine}</div>
        <div class="status-dot status-${m.status}"></div>
      </div>
      <div class="machine-job">${m.job}</div>
      <div class="counts">
        <div class="count-box"><div class="count-title">GOOD</div><div class="count-good" data-type="good">${m.good}</div></div>
        <div class="count-box"><div class="count-title">REJECT</div><div class="count-reject" data-type="reject">${m.reject}</div></div>
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
    statusDot.className = `status-dot status-${m.status}`;

    const goodEl = card.querySelector('.count-good');
    const rejectEl = card.querySelector('.count-reject');

    const prevGood = parseInt(goodEl.textContent) || 0;
    const prevReject = parseInt(rejectEl.textContent) || 0;
    const goodInc = m.good - prevGood;
    const rejectInc = m.reject - prevReject;

    goodEl.textContent = m.good;
    rejectEl.textContent = m.reject;

    if (goodInc > 0) card.classList.add('blink-good');
    if (rejectInc > 0) card.classList.add('blink-reject');
    setTimeout(() => { card.classList.remove('blink-good'); card.classList.remove('blink-reject'); }, 350);
  });
}

function labelsFor(machines) {
  return machines.map(m => `${m.machine} (${m.job})`);
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
        animation: { duration: 300 }
      }
    });
  } else {
    chartRef.data.labels = labelsFor(machines);
    chartRef.data.datasets[0].data = valuesFor(machines, 'good');
    chartRef.data.datasets[1].data = valuesFor(machines, 'reject');
    chartRef.update();
  }
}

function renderSelected() {
  if (!latestState || !currentLine) return;
  const machines = sortMachines(latestState.lines[currentLine] || []);
  const panelTitle = document.getElementById('panelTitle');
  panelTitle.textContent = `Status Mesin – ${currentLine}`;
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  buildGrid(machines);
  ensureChart(machines);
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
  const allowed = currentUser && currentUser.role === 'line_admin' ? (currentUser.lines || []) : (latestState.list || []);
  if (currentUser && currentUser.role === 'line_admin') {
    if (label) label.classList.add('d-none');
    if (select) select.classList.add('d-none');
  } else {
    if (label) label.classList.remove('d-none');
    if (select) select.classList.remove('d-none');
  }
  if (currentUser && currentUser.role === 'line_admin') {
    if (!currentLine || !allowed.includes(currentLine)) {
      currentLine = allowed[0] || null;
    }
  }
  if (select.options.length === 0 && allowed && allowed.length) {
    allowed.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l;
      opt.textContent = l;
      select.appendChild(opt);
    });
    currentLine = allowed[0];
    select.value = currentLine;
  }
  const styleName = latestState.meta && latestState.meta[currentLine] ? latestState.meta[currentLine].style : null;
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

const lineSelect = document.getElementById('lineSelect');
lineSelect.addEventListener('change', () => {
  currentLine = lineSelect.value;
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const styleName = latestState.meta && latestState.meta[currentLine] ? latestState.meta[currentLine].style : null;
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
    const res = await fetch('/api/auth/me', { headers });
    if (res.ok) {
      currentUser = await res.json();
      enforceRoleUI();
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
    if (currentUser && currentUser.role === 'line_admin') return;
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
  if (v === 'master-line') { showMasterLine(); setRouteIndicator('master-line'); try { sessionStorage.setItem('route', 'master-line'); } catch {} }
  if (v === 'master-style') { showMasterStyle(); setRouteIndicator('master-style'); try { sessionStorage.setItem('route', 'master-style'); } catch {} }
});

const logoutLink = document.getElementById('logoutLink');
if (logoutLink) {
  logoutLink.addEventListener('click', async (e) => {
    e.preventDefault();
    try { sessionStorage.removeItem('sid'); } catch {}
    location.href = '/login';
  });
}

const logoutInline = document.getElementById('logoutInline');
if (logoutInline) {
  logoutInline.addEventListener('click', async (e) => {
    e.preventDefault();
    try { sessionStorage.removeItem('sid'); } catch {}
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
    applySidebar();
    if (sidebar) sidebar.classList.add('d-none');
    if (burger) burger.classList.add('d-none');
    if (sidebarLogout) sidebarLogout.classList.add('d-none');
    if (logoutInlineBtn) logoutInlineBtn.classList.remove('d-none');
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
      const tab = sessionStorage.getItem('mmTab');
      if (route === 'master-mesin') {
        showMasterMesin();
        setMmTab(tab || 'kategori');
        setRouteIndicator('master-mesin');
      } else if (route === 'master-line') {
        showMasterLine();
        setRouteIndicator('master-line');
      } else if (route === 'master-style') {
        showMasterStyle();
        setRouteIndicator('master-style');
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

let mmTab = 'kategori';
let mmRows = [];
let mmJenisIndex = [];
let mmModalAction = null;
let mmModalEditId = null;

let mlRows = [];
let mlModalAction = null;
let mlModalEditId = null;

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
  setMmTab('kategori');
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
}

function hideMasterStyle() {
  const section = document.getElementById('masterStyleSection');
  if (section) section.classList.add('d-none');
}

function showSectionOnly(id) {
  const linePanel = document.querySelector('.line-panel');
  const controlsBar = document.querySelector('.controls-bar');
  if (linePanel) linePanel.classList.add('d-none');
  if (controlsBar) controlsBar.classList.add('d-none');
  ['masterMesinSection','masterLineSection','masterStyleSection'].forEach(s => {
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
  ['masterMesinSection','masterLineSection','masterStyleSection'].forEach(s => {
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

function setMmTab(tab) {
  mmTab = tab;
  const tabs = document.querySelectorAll('[data-mm-tab]');
  tabs.forEach(el => el.classList.toggle('active', el.getAttribute('data-mm-tab') === tab));
  const crumb = document.getElementById('mmCrumb');
  if (crumb) {
    crumb.textContent = tab === 'kategori' ? 'Kategori Mesin' : (tab === 'jenis' ? 'Jenis Mesin' : 'Merk Mesin');
  }
  const addBtn = document.getElementById('mmAddBtn');
  if (addBtn) addBtn.classList.toggle('d-none', currentUser && currentUser.role === 'line_admin');
  try { sessionStorage.setItem('mmTab', mmTab); } catch {}
  fetchMmData();
}

async function fetchMmData() {
  try {
    if (mmTab === 'kategori') {
      const res = await fetch('/api/master/kategori', { headers: authHeaders() });
      const data = await res.json();
      mmRows = (data && data.data) || [];
      mmJenisIndex = await fetchJenisIndex();
      renderMmTable();
    } else if (mmTab === 'jenis') {
      const res = await fetch('/api/master/jenis', { headers: authHeaders() });
      const data = await res.json();
      mmRows = (data && data.data) || [];
      mmJenisIndex = mmRows.slice();
      renderMmTable();
    } else {
      const res = await fetch('/api/master/merk', { headers: authHeaders() });
      const data = await res.json();
      mmRows = (data && data.data) || [];
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
  if (mmTab === 'kategori') {
    thead.innerHTML = '<tr><th>ID</th><th>Nama</th><th style="width:120px">Aksi</th></tr>';
    const rows = mmRows.filter(r => !q || String(r.name).toLowerCase().includes(q));
    tbody.innerHTML = rows.map(r => `<tr data-id="${r.id_kategori}"><td>${r.id_kategori}</td><td>${r.name}</td><td>
      ${currentUser && currentUser.role === 'tech_admin' ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-mm-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-mm-act="delete"><i class="bi bi-trash fs-5"></i></button>` : ''}
    </td></tr>`).join('');
  } else if (mmTab === 'jenis') {
    thead.innerHTML = '<tr><th>ID</th><th>Nama</th><th style="width:120px">Aksi</th></tr>';
    const rows = mmRows.filter(r => !q || String(r.name).toLowerCase().includes(q));
    tbody.innerHTML = rows.map(r => `<tr data-id="${r.id_jnsmesin}"><td>${r.id_jnsmesin}</td><td>${r.name}</td><td>
      ${currentUser && currentUser.role === 'tech_admin' ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-mm-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-mm-act="delete"><i class="bi bi-trash fs-5"></i></button>` : ''}
    </td></tr>`).join('');
  } else {
    thead.innerHTML = '<tr><th>ID</th><th>Nama</th><th>Jenis Mesin</th><th style="width:120px">Aksi</th></tr>';
    const rows = mmRows.filter(r => {
      const jm = r.jenis_mesin || '';
      return !q || String(r.name).toLowerCase().includes(q) || String(jm).toLowerCase().includes(q);
    });
    tbody.innerHTML = rows.map(r => `<tr data-id="${r.id_merk}"><td>${r.id_merk}</td><td>${r.name}</td><td>${r.jenis_mesin || '-'} </td><td>
      ${currentUser && currentUser.role === 'tech_admin' ? `<button class="btn btn-link p-0 me-2 text-warning" title="Edit" data-mm-act="edit"><i class="bi bi-pencil-square fs-5"></i></button><button class="btn btn-link p-0 text-danger" title="Hapus" data-mm-act="delete"><i class="bi bi-trash fs-5"></i></button>` : ''}
    </td></tr>`).join('');
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
  if (mmTab === 'kategori') {
    if (act === 'edit') {
      const row = mmRows.find(r => String(r.id_kategori) === String(id));
      openMmModal('edit', 'kategori', { id, name: row ? row.name : '' });
      return;
    } else if (act === 'delete') {
      if (!confirm('Hapus kategori?')) return;
      await fetch(`/api/master/kategori/${id}`, { method: 'DELETE', headers: authHeaders() });
    }
  } else if (mmTab === 'jenis') {
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
  if (entity === 'kategori') t = action === 'add' ? 'Tambah Kategori Mesin' : 'Edit Kategori Mesin';
  else if (entity === 'jenis') t = action === 'add' ? 'Tambah Jenis Mesin' : 'Edit Jenis Mesin';
  else t = action === 'add' ? 'Tambah Merk Mesin' : 'Edit Merk Mesin';
  title.textContent = t;
  if (entity === 'kategori') {
    form.innerHTML = `<div><label class="form-label">Nama</label><input type="text" class="form-control" id="mmName" value="${data && data.name ? String(data.name) : ''}"></div>`;
  } else if (entity === 'jenis') {
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
  if (entity === 'kategori') {
    if (mmModalAction === 'add') {
      await fetch('/api/master/kategori', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name }) });
    } else {
      await fetch(`/api/master/kategori/${mmModalEditId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name }) });
    }
  } else if (entity === 'jenis') {
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
