/**
 * Project Storage Helper - Frontend Logic
 */

const CATEGORIES = {
  node: { label: 'Node-Pakete', short: 'Node' },
  python: { label: 'Python-Umgebungen', short: 'Python' },
  build: { label: 'Build-Ausgaben', short: 'Build' },
  cache: { label: 'Caches', short: 'Cache' },
};

const state = {
  projects: [],              // list of ProjectInfo objects
  selectedPaths: new Set(),  // folder paths marked for removal
  modalSelectedPaths: new Set(), // temporary selection inside confirmation modal
  removedPaths: new Set(),   // folders removed during the current deletion run
  activeFilter: 'all',
  searchQuery: '',
  sortBy: 'size',            // 'size' | 'name' | 'ecosystem' | 'files'
  sortDir: 'desc',           // 'desc' | 'asc'
  busy: false,
  busyType: 'idle',          // 'scan' | 'delete' | 'idle'
  stopStage: 0,              // 0: running, 1: stop after project, 2: hard stop
  lastReportData: null,      // payload for PDF report export
};

const $ = (id) => document.getElementById(id);

// DOM Elements
const folderInput = $('folderInput');
const scanBtn = $('scanBtn');
const stopBtn = $('stopBtn');
const progressContainer = $('progressContainer');
const overallProgressBar = $('overallProgressBar');
const overallProgressText = $('overallProgressText');
const itemProgressBar = $('itemProgressBar');
const itemProgressLabel = $('itemProgressLabel');
const itemProgressText = $('itemProgressText');
const progressMessage = $('progressMessage');

const projectList = $('projectList');
const emptyState = $('emptyState');
const meter = $('meter');
const legend = $('legend');

const confirmModal = $('confirmModal');
const modalTrashCheckbox = $('modalTrashCheckbox');
const modalItemsList = $('modalItemsList');
const modalSummaryCount = $('modalSummaryCount');
const modalSummaryProjects = $('modalSummaryProjects');
const modalFreedSpace = $('modalFreedSpace');
const modalCancelBtn = $('modalCancelBtn');
const modalConfirmBtn = $('modalConfirmBtn');

const reportModal = $('reportModal');
const reportExportPdfBtn = $('reportExportPdfBtn');
const reportCloseBtn = $('reportCloseBtn');

const themeToggleBtn = $('themeToggleBtn');
const fullscreenToggleBtn = $('fullscreenToggleBtn');
const sortBySelect = $('sortBySelect');
const sortDirBtn = $('sortDirBtn');
const expandAllBtn = $('expandAllBtn');
const collapseAllBtn = $('collapseAllBtn');

const api = () => window.pywebview?.api;

// ---------- Formatting Helpers ----------

const nf = (digits) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF = [nf(0), nf(1), nf(2)];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  if (i === 0) return `${bytes} B`;
  const digits = val < 10 ? 2 : val < 100 ? 1 : 0;
  return `${NF[digits].format(val)} ${units[i]}`;
}

const plural = (n, one, many) => `${NF[0].format(n)} ${n === 1 ? one : many}`;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[c]);
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('toastContainer').appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, type === 'error' ? 6000 : 3500);
}

// ---------- Theme Management ----------

function initTheme() {
  const saved = localStorage.getItem('psh_theme') || 'auto';
  document.documentElement.dataset.theme = saved;
  updateThemeIcon(saved);
}

function updateThemeIcon(theme) {
  const isDark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  themeToggleBtn.querySelector('.icon-sun').hidden = isDark;
  themeToggleBtn.querySelector('.icon-moon').hidden = !isDark;
}

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const isCurrentlyDark = current === 'dark' || (current === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next = isCurrentlyDark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('psh_theme', next);
  updateThemeIcon(next);
});

// ---------- Fullscreen Mode ----------

async function toggleFullscreen() {
  try {
    if (api()) {
      await api().toggle_fullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.warn('Fullscreen toggle failed:', err);
  }
  updateFullscreenIcon();
}

function updateFullscreenIcon() {
  const isFs = !!document.fullscreenElement;
  fullscreenToggleBtn.querySelector('.icon-expand').hidden = isFs;
  fullscreenToggleBtn.querySelector('.icon-compress').hidden = !isFs;
}

fullscreenToggleBtn.addEventListener('click', toggleFullscreen);

window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    e.preventDefault();
    toggleFullscreen();
  }
});

// ---------- Busy & Stop States ----------

function setBusy(busy, label, type = 'idle') {
  state.busy = busy;
  state.busyType = busy ? type : 'idle';
  $('status').dataset.state = busy ? 'busy' : 'idle';
  $('statusText').textContent = label;
  progressContainer.hidden = !busy;

  // Stop button visibility and reset
  if (busy) {
    stopBtn.hidden = false;
    setStopStage(0);
  } else {
    stopBtn.hidden = true;
    setStopStage(0);
  }

  $('bottomDeleteBtn').disabled = busy;
  scanBtn.disabled = busy && type !== 'scan';
}

function setStopStage(stage) {
  state.stopStage = stage;
  stopBtn.dataset.stage = String(stage);
  const label = stopBtn.querySelector('.stop-text');
  if (stage === 0) {
    label.textContent = 'Stoppen';
  } else if (stage === 1) {
    label.textContent = 'Hält nach Projekt an (Klick für Sofort-Abbruch)';
  } else {
    label.textContent = 'Wird sofort abgebrochen …';
  }
}

stopBtn.addEventListener('click', async () => {
  if (!api() || !state.busy) return;

  if (state.busyType === 'scan') {
    const res = await api().stop_scan();
    if (res?.level) {
      setStopStage(res.level);
      progressMessage.textContent = res.message;
      showToast(res.message, res.level === 2 ? 'error' : 'info');
    }
  } else if (state.busyType === 'delete') {
    const res = await api().stop_delete();
    if (res?.level) {
      setStopStage(res.level);
      progressMessage.textContent = res.message;
      showToast(res.message, res.level === 2 ? 'error' : 'info');
    }
  }
});

function showEmpty(title, desc) {
  emptyState.hidden = false;
  emptyState.querySelector('.empty-title').textContent = title;
  emptyState.querySelector('.empty-desc').textContent = desc;
}

// ---------- Selection & Helpers ----------

const allFolders = () => state.projects.flatMap(p => p.disposable_folders);

function selectedTotals() {
  const selected = allFolders().filter(f => state.selectedPaths.has(f.path));
  return { count: selected.length, bytes: selected.reduce((sum, f) => sum + f.size_bytes, 0) };
}

const matchesSearch = (project) => !state.searchQuery ||
  project.name.toLowerCase().includes(state.searchQuery) ||
  project.relative_path.toLowerCase().includes(state.searchQuery) ||
  (project.ecosystem && project.ecosystem.toLowerCase().includes(state.searchQuery));

const matchesFilter = (folderDataset) => state.activeFilter === 'all' || folderDataset.category === state.activeFilter;

// ---------- Overview: Total, Meter & Legend ----------

function buildOverview() {
  meter.innerHTML = Object.keys(CATEGORIES).map(cat =>
    `<div class="seg cat-${cat}" data-filter="${cat}" hidden><div class="seg-marked"></div></div>`).join('');

  legend.innerHTML = `<button type="button" class="legend-item" data-filter="all" aria-pressed="true">Alle</button>` +
    Object.entries(CATEGORIES).map(([cat, { label }]) =>
      `<button type="button" class="legend-item cat-${cat}" data-filter="${cat}" aria-pressed="false" hidden>
         <span>${label}</span><span class="legend-size"></span>
       </button>`).join('');
}

function renderOverview() {
  const totals = {};
  for (const f of allFolders()) {
    const t = totals[f.category] ??= { bytes: 0, marked: 0 };
    t.bytes += f.size_bytes;
    if (state.selectedPaths.has(f.path)) t.marked += f.size_bytes;
  }
  const totalBytes = Object.values(totals).reduce((sum, t) => sum + t.bytes, 0);
  document.body.classList.toggle('has-results', state.projects.length > 0);

  $('totalSize').textContent = formatBytes(totalBytes);
  $('totalText').textContent = state.projects.length
    ? `freigebbar in ${plural(state.projects.length, 'Projekt', 'Projekten')}`
    : 'freigebbar';

  for (const cat of Object.keys(CATEGORIES)) {
    const t = totals[cat];
    const seg = meter.querySelector(`.seg[data-filter="${cat}"]`);
    const item = legend.querySelector(`[data-filter="${cat}"]`);
    seg.hidden = item.hidden = !t;
    if (!t) continue;
    seg.style.flexGrow = t.bytes;
    seg.style.setProperty('--marked', `${(t.marked / (t.bytes || 1)) * 100}%`);
    seg.classList.toggle('dimmed', state.activeFilter !== 'all' && state.activeFilter !== cat);
    item.querySelector('.legend-size').textContent = formatBytes(t.bytes);
  }
  legend.querySelectorAll('.legend-item').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.filter === state.activeFilter)));
}

function setFilter(filter) {
  state.activeFilter = filter === state.activeFilter ? 'all' : filter;
  applyFilterAndSearch();
  renderOverview();
}

legend.addEventListener('click', (e) => {
  const item = e.target.closest('.legend-item');
  if (item) setFilter(item.dataset.filter);
});

meter.addEventListener('click', (e) => {
  const seg = e.target.closest('.seg');
  if (seg) setFilter(seg.dataset.filter);
});

// ---------- Sorting & Filtering ----------

function sortProjects() {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  state.projects.sort((a, b) => {
    if (state.sortBy === 'name') {
      return dir * a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
    } else if (state.sortBy === 'ecosystem') {
      const ecoA = `${a.ecosystem || ''} ${a.dominant_category || ''}`;
      const ecoB = `${b.ecosystem || ''} ${b.dominant_category || ''}`;
      return dir * ecoA.localeCompare(ecoB, 'de', { sensitivity: 'base' });
    } else if (state.sortBy === 'files') {
      return dir * ((a.total_file_count || 0) - (b.total_file_count || 0));
    } else {
      // Default: size
      return dir * (a.total_disposable_size - b.total_disposable_size);
    }
  });

  renderProjectList();
}

sortBySelect.addEventListener('change', (e) => {
  state.sortBy = e.target.value;
  sortProjects();
});

sortDirBtn.addEventListener('click', () => {
  state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  sortDirBtn.querySelector('.icon-desc').hidden = state.sortDir === 'asc';
  sortDirBtn.querySelector('.icon-asc').hidden = state.sortDir !== 'asc';
  sortProjects();
});

// ---------- Accordion Bulk Controls ----------

expandAllBtn.addEventListener('click', () => {
  projectList.querySelectorAll('.project').forEach(card => card.open = true);
});

collapseAllBtn.addEventListener('click', () => {
  projectList.querySelectorAll('.project').forEach(card => card.open = false);
});

// ---------- Scan Process ----------

window.addEventListener('pywebviewready', async () => {
  try {
    initTheme();
    const initialFolder = await api()?.get_initial_folder();
    if (initialFolder && !folderInput.value) folderInput.value = initialFolder;
  } catch (e) {
    console.warn('Initial folder load error:', e);
  }
});

$('browseBtn').addEventListener('click', async () => {
  if (!api()) return;
  try {
    const selected = await api().select_folder();
    if (selected) folderInput.value = selected;
  } catch (err) {
    showToast('Ordnerauswahl fehlgeschlagen: ' + err, 'error');
  }
});

$('scanForm').addEventListener('submit', (e) => {
  e.preventDefault();
  startScan();
});

async function startScan() {
  const folder = folderInput.value.trim();
  if (!folder) return showToast('Gib zuerst einen Ordner an oder wähle ihn über „Ordner wählen“.', 'error');
  if (!api()) return showToast('Die App startet noch. Versuch es in ein paar Sekunden erneut.', 'error');

  state.projects = [];
  state.selectedPaths.clear();
  projectList.innerHTML = '';
  projectList.style.setProperty('--max', 1);
  emptyState.hidden = true;
  scanBtn.hidden = true;

  itemProgressLabel.textContent = 'Suchvorgang';
  itemProgressText.textContent = 'Starte …';
  itemProgressBar.style.width = '30%';
  overallProgressText.textContent = '0 Projekte gefunden';
  overallProgressBar.style.width = '10%';
  progressMessage.textContent = 'Suche nach Projekten läuft …';

  setBusy(true, 'Scan läuft', 'scan');
  updateStats();

  try {
    const resp = await api().start_scan(folder);
    if (resp.status === 'error') {
      showToast(resp.message, 'error');
      finishScan(false);
    }
  } catch (err) {
    showToast('Scan konnte nicht starten: ' + err, 'error');
    finishScan(false);
  }
}

function finishScan(stopped) {
  setBusy(false, stopped ? 'Scan gestoppt' : 'Bereit');
  scanBtn.hidden = false;
  overallProgressBar.style.width = '100%';
  itemProgressBar.style.width = '100%';
  updateStats();
}

window.onScanProgress = (data) => {
  if (data?.message) {
    progressMessage.textContent = data.message;
    itemProgressText.textContent = data.message;
  }
  if (data?.total_projects !== undefined) {
    overallProgressText.textContent = `${plural(data.total_projects, 'Projekt', 'Projekte')} gefunden`;
  }
};

window.onProjectDiscovered = (project) => {
  if (state.projects.some(p => p.path === project.path)) return;
  state.projects.push(project);

  emptyState.hidden = true;
  sortProjects();
  updateStats();
};

window.onScanCompleted = (summary) => {
  finishScan(summary.stopped);
  const found = `${plural(summary.total_projects, 'Projekt', 'Projekte')}, ${formatBytes(summary.total_bytes)} freigebbar`;
  if (summary.error) {
    showToast('Scan abgebrochen: ' + summary.error, 'error');
  } else if (summary.stopped) {
    showToast(`Scan angehalten. Bis dahin: ${found}.`);
  } else if (summary.total_projects === 0) {
    showEmpty('Nichts zu entfernen', 'In diesem Ordner gibt es keine node_modules, .venv, Build-Ausgaben oder Caches. Wähle einen anderen Ordner.');
  } else {
    showToast(`Scan abgeschlossen. ${found}.`);
  }
};

// ---------- Project Rows Rendering ----------

const ICON_OPEN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const ICON_CHEVRON = '<svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function folderHtml(f) {
  const path = escapeHtml(f.path);
  const name = escapeHtml(f.name);
  const cat = escapeHtml(f.category);
  return `
    <li class="folder cat-${cat}" data-category="${cat}">
      <label class="folder-label">
        <input type="checkbox" data-folder="${path}">
        <span class="folder-name">${name}</span>
        <span class="tag">${CATEGORIES[f.category]?.short ?? cat}</span>
      </label>
      <span class="files">${plural(f.file_count, 'Datei', 'Dateien')}</span>
      <span class="size">${formatBytes(f.size_bytes)}</span>
      <button type="button" class="icon-btn danger" data-action="delete" data-folder="${path}" title="Diesen Ordner entfernen" aria-label="${name} entfernen">${ICON_TRASH}</button>
      <span class="spacer"></span>
    </li>`;
}

function projectCardHtml(project) {
  const name = escapeHtml(project.name);
  const eco = escapeHtml(project.ecosystem || 'Allgemein');
  const domCat = escapeHtml(CATEGORIES[project.dominant_category]?.label || 'Caches');
  return `
    <details class="project" open>
      <summary class="project-row">
        <input type="checkbox" data-project aria-label="Alle Ordner in ${name} markieren">
        <div class="project-meta">
          <div class="project-title-line">
            <span class="project-name">${name}</span>
            <span class="badge badge-eco">${eco}</span>
            <span class="badge badge-cat cat-${escapeHtml(project.dominant_category)}">${domCat}</span>
          </div>
          <div class="project-path">${escapeHtml(project.relative_path)}</div>
        </div>
        <div class="bar" aria-hidden="true"><span style="--size: ${project.total_disposable_size}"></span></div>
        <span class="size">${formatBytes(project.total_disposable_size)}</span>
        <button type="button" class="icon-btn" data-action="open" title="Im Explorer öffnen" aria-label="${name} im Explorer öffnen">${ICON_OPEN}</button>
        ${ICON_CHEVRON}
      </summary>
      <ul class="folders">${project.disposable_folders.map(folderHtml).join('')}</ul>
    </details>`;
}

function renderProjectList() {
  if (state.projects.length === 0) {
    projectList.innerHTML = '';
    return;
  }
  const maxSize = Math.max(...state.projects.map(p => p.total_disposable_size), 1);
  projectList.style.setProperty('--max', maxSize);
  projectList.innerHTML = state.projects.map(projectCardHtml).join('');
  updateAllCheckboxes();
  applyFilterAndSearch();
}

// Single delegated handler for all project list interactions
projectList.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action], input[type="checkbox"]');
  if (!target) return;
  const card = target.closest('.project');
  const projectIdx = [...projectList.children].indexOf(card);
  const project = state.projects[projectIdx];
  if (!project) return;

  if (target.dataset.action === 'open') {
    e.preventDefault();
    api()?.open_in_explorer(project.path);
  } else if (target.dataset.action === 'delete') {
    e.preventDefault();
    setSelection([target.dataset.folder]);
    showConfirmModal();
  } else if (target.hasAttribute('data-project')) {
    const paths = project.disposable_folders.map(f => f.path);
    const allSelected = paths.every(p => state.selectedPaths.has(p));
    paths.forEach(p => allSelected ? state.selectedPaths.delete(p) : state.selectedPaths.add(p));
    setSelection(state.selectedPaths);
  } else if (target.dataset.folder) {
    const path = target.dataset.folder;
    if (!state.selectedPaths.delete(path)) state.selectedPaths.add(path);
    setSelection(state.selectedPaths);
  }
});

// ---------- Filter & Search Execution ----------

$('searchInput').addEventListener('input', (e) => {
  state.searchQuery = e.target.value.toLowerCase().trim();
  applyFilterAndSearch();
});

function applyFilterAndSearch() {
  let visibleProjects = 0;

  projectList.querySelectorAll('.project').forEach((card, i) => {
    const project = state.projects[i];
    if (!project) return;
    const searchOk = matchesSearch(project);
    let hasVisibleFolder = false;

    card.querySelectorAll('.folder').forEach(item => {
      const show = searchOk && matchesFilter(item.dataset);
      item.hidden = !show;
      hasVisibleFolder ||= show;
    });

    card.hidden = !hasVisibleFolder;
    if (hasVisibleFolder) visibleProjects++;
  });

  if (state.projects.length === 0) return;
  if (visibleProjects === 0) {
    showEmpty('Keine Treffer', 'Passe deinen Suchbegriff an oder wähle oben „Alle“.');
  } else {
    emptyState.hidden = true;
  }
}

// ---------- Selection Controls ----------

function setSelection(paths) {
  state.selectedPaths = new Set(paths);
  updateAllCheckboxes();
  updateStats();
}

const clearSelection = () => setSelection([]);

$('selectAllBtn').addEventListener('click', () => {
  const visible = state.projects.filter(matchesSearch).flatMap(p => p.disposable_folders).filter(matchesFilter);
  setSelection([...state.selectedPaths, ...visible.map(f => f.path)]);
});

$('deselectAllBtn').addEventListener('click', clearSelection);
$('bottomClearBtn').addEventListener('click', clearSelection);

function updateAllCheckboxes() {
  projectList.querySelectorAll('.project').forEach(card => {
    const boxes = card.querySelectorAll('input[data-folder]');
    let selectedCount = 0;
    boxes.forEach(box => {
      box.checked = state.selectedPaths.has(box.dataset.folder);
      box.closest('.folder').classList.toggle('is-selected', box.checked);
      if (box.checked) selectedCount++;
    });

    const master = card.querySelector('input[data-project]');
    if (master) {
      master.checked = selectedCount > 0 && selectedCount === boxes.length;
      master.indeterminate = selectedCount > 0 && !master.checked;
    }
    card.classList.toggle('has-selected', selectedCount > 0);
  });
}

function updateStats() {
  const { count, bytes } = selectedTotals();
  renderOverview();
  $('bottomBar').classList.toggle('visible', count > 0);
  $('bottomSelectedSize').textContent = formatBytes(bytes);
  $('bottomSelectedCount').textContent = `${plural(count, 'Ordner', 'Ordner')} markiert`;
  $('bottomDeleteBtn').disabled = state.busy;
}

// ---------- Detailed Confirmation Modal with Deselection Safety ----------

$('bottomDeleteBtn').addEventListener('click', showConfirmModal);

function syncTrashOption() {
  const trash = modalTrashCheckbox.checked;
  modalConfirmBtn.textContent = trash ? 'In Papierkorb verschieben' : 'Endgültig löschen';
  modalConfirmBtn.classList.toggle('btn-primary', trash);
  modalConfirmBtn.classList.toggle('btn-danger', !trash);
  $('modalTrashHint').textContent = trash
    ? 'Du kannst die Ordner bei Bedarf dort wiederherstellen.'
    : 'Ohne Haken werden die Ordner sofort und unwiderruflich gelöscht.';
}

modalTrashCheckbox.addEventListener('change', syncTrashOption);

function updateModalSummary() {
  const folders = allFolders().filter(f => state.modalSelectedPaths.has(f.path));
  const bytes = folders.reduce((sum, f) => sum + f.size_bytes, 0);
  const projectsCount = new Set(
    state.projects.filter(p => p.disposable_folders.some(f => state.modalSelectedPaths.has(f.path))).map(p => p.path)
  ).size;

  modalSummaryCount.textContent = plural(folders.length, 'Ordner', 'Ordner');
  modalSummaryProjects.textContent = plural(projectsCount, 'Projekt', 'Projekten');
  modalFreedSpace.textContent = formatBytes(bytes);
  modalConfirmBtn.disabled = folders.length === 0;
}

function showConfirmModal() {
  if (state.busy) return;
  const { count } = selectedTotals();
  if (count === 0) return showToast('Markiere zuerst mindestens einen Ordner.');

  // Create an isolated working copy for the modal
  state.modalSelectedPaths = new Set(state.selectedPaths);

  // Build project-by-project checklist in the modal
  let html = '';
  state.projects.forEach(p => {
    const selectedInProj = p.disposable_folders.filter(f => state.modalSelectedPaths.has(f.path));
    if (selectedInProj.length === 0) return;

    html += `
      <div class="confirm-project-group">
        <div class="confirm-project-header">
          <span>${escapeHtml(p.name)}</span>
          <span class="badge badge-eco">${escapeHtml(p.ecosystem || 'Allgemein')}</span>
        </div>`;

    selectedInProj.forEach(f => {
      const fPath = escapeHtml(f.path);
      html += `
        <div class="confirm-folder-row">
          <label class="confirm-folder-left">
            <input type="checkbox" data-modal-folder="${fPath}" checked>
            <span class="folder-name">${escapeHtml(f.name)}</span>
            <span class="tag cat-${escapeHtml(f.category)}">${escapeHtml(CATEGORIES[f.category]?.short ?? f.category)}</span>
          </label>
          <div class="confirm-folder-right">
            <span>${plural(f.file_count, 'Datei', 'Dateien')}</span>
            <strong>${formatBytes(f.size_bytes)}</strong>
          </div>
        </div>`;
    });

    html += `</div>`;
  });

  modalItemsList.innerHTML = html;
  modalTrashCheckbox.checked = true;
  syncTrashOption();
  updateModalSummary();
  confirmModal.showModal();
}

// React to checkbox clicks inside the modal
modalItemsList.addEventListener('change', (e) => {
  const box = e.target.closest('input[data-modal-folder]');
  if (!box) return;
  const p = box.dataset.modalFolder;
  if (box.checked) {
    state.modalSelectedPaths.add(p);
  } else {
    state.modalSelectedPaths.delete(p);
  }
  updateModalSummary();
});

modalCancelBtn.addEventListener('click', () => {
  // Cancel preserves the original state.selectedPaths unmodified!
  confirmModal.close();
});

modalConfirmBtn.addEventListener('click', () => {
  if (state.modalSelectedPaths.size === 0) {
    showToast('Keine Ordner zum Löschen ausgewählt.', 'error');
    return;
  }
  // Apply changes confirmed in the dialog to active selection
  state.selectedPaths = new Set(state.modalSelectedPaths);
  updateAllCheckboxes();
  updateStats();
  confirmModal.close();
  executeDeletion();
});

// ---------- Deletion Process with 2-Stage Stop & Dual Progress ----------

async function executeDeletion() {
  if (state.busy || state.selectedPaths.size === 0 || !api()) return;

  state.removedPaths.clear();
  scanBtn.disabled = true;

  itemProgressLabel.textContent = 'Bereinigung';
  itemProgressText.textContent = 'Starte Vorgang …';
  itemProgressBar.style.width = '0%';
  overallProgressText.textContent = `0 von ${state.selectedPaths.size} Ordnern`;
  overallProgressBar.style.width = '0%';
  progressMessage.textContent = 'Bereite Löschung vor …';

  setBusy(true, 'Ordner werden entfernt', 'delete');
  updateStats();

  try {
    const res = await api().delete_items([...state.selectedPaths], modalTrashCheckbox.checked);
    if (res.status === 'error') {
      showToast(res.message, 'error');
      finishDeletion();
    }
  } catch (err) {
    showToast('Entfernen fehlgeschlagen: ' + err, 'error');
    finishDeletion();
  }
}

function finishDeletion() {
  scanBtn.disabled = false;
  setBusy(false, 'Bereit');
  updateStats();
}

window.onDeleteProgress = (data) => {
  // Update Overall Bar
  const overallPct = Math.round((data.current / data.total) * 100);
  overallProgressBar.style.width = `${overallPct}%`;
  overallProgressText.textContent = `${overallPct} % (${data.current} von ${data.total} Ordnern)`;

  // Update Project Bar
  const projPct = Math.round((data.project_current / data.project_total) * 100);
  itemProgressBar.style.width = `${projPct}%`;
  itemProgressLabel.textContent = `Projekt: ${data.project_name} (${data.project_index} von ${data.total_projects})`;
  itemProgressText.textContent = `Ordner ${data.project_current} von ${data.project_total} (${data.folder_name || data.path})`;
  progressMessage.textContent = `Entferne: ${data.path}`;

  if (data.success) {
    state.removedPaths.add(data.path);
  } else {
    showToast(`${data.path} wurde nicht entfernt: ${data.error}`, 'error');
  }
};

window.onDeleteCompleted = (summary) => {
  const removed = state.removedPaths;
  const freedBytes = allFolders().filter(f => removed.has(f.path)).reduce((sum, f) => sum + f.size_bytes, 0);
  const deletedRecords = summary.deleted_records || [];

  // Update models: drop removed folders
  state.projects.forEach(p => {
    p.disposable_folders = p.disposable_folders.filter(f => !removed.has(f.path));
    p.total_disposable_size = p.disposable_folders.reduce((sum, f) => sum + f.size_bytes, 0);
    p.total_file_count = p.disposable_folders.reduce((sum, f) => sum + f.file_count, 0);
  });
  state.projects = state.projects.filter(p => p.disposable_folders.length > 0);
  removed.forEach(p => state.selectedPaths.delete(p));

  renderProjectList();
  finishDeletion();

  if (state.projects.length === 0) {
    showEmpty('Alles aufgeräumt', 'Es sind keine löschbaren Ordner mehr übrig. Scanne erneut oder wähle einen anderen Ordner.');
  }

  // Build Report Data
  buildAndShowReport(summary, freedBytes, deletedRecords);
};

// ---------- Protocol & Report Modal + PDF Export ----------

function buildAndShowReport(summary, freedBytes, deletedRecords) {
  const catTotals = {
    node: { label: 'Node-Pakete', bytes: 0, folders: 0, files: 0, percentage: 0 },
    python: { label: 'Python-Umgebungen', bytes: 0, folders: 0, files: 0, percentage: 0 },
    build: { label: 'Build-Ausgaben', bytes: 0, folders: 0, files: 0, percentage: 0 },
    cache: { label: 'Caches', bytes: 0, folders: 0, files: 0, percentage: 0 },
  };

  let totalFiles = 0;
  deletedRecords.forEach(r => {
    if (r.success) {
      const c = catTotals[r.category] || catTotals.cache;
      c.bytes += r.size_bytes || 0;
      c.folders += 1;
      c.files += r.file_count || 0;
      totalFiles += r.file_count || 0;
    }
  });

  const totalCatBytes = Object.values(catTotals).reduce((sum, c) => sum + c.bytes, 0);
  Object.values(catTotals).forEach(c => {
    c.percentage = totalCatBytes > 0 ? (c.bytes / totalCatBytes) * 100 : 0;
  });

  // Group by project for report view and PDF
  const projectMap = new Map();
  deletedRecords.forEach(r => {
    if (!projectMap.has(r.project_name)) {
      projectMap.set(r.project_name, {
        name: r.project_name,
        path: r.path,
        ecosystem: r.ecosystem || '',
        freed_bytes: 0,
        files_deleted: 0,
        folders: [],
      });
    }
    const pGroup = projectMap.get(r.project_name);
    if (r.success) {
      pGroup.freed_bytes += r.size_bytes || 0;
      pGroup.files_deleted += r.file_count || 0;
    }
    pGroup.folders.push({
      name: r.folder_name,
      category: CATEGORIES[r.category]?.label || r.category,
      bytes: r.size_bytes || 0,
      files: r.file_count || 0,
      success: r.success,
    });
  });

  const reportPayload = {
    timestamp: new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }),
    total_freed_bytes: freedBytes,
    total_folders_deleted: summary.success_count,
    total_files_deleted: totalFiles,
    use_trash: summary.use_trash,
    stopped_early: summary.stopped,
    categories: catTotals,
    projects: Array.from(projectMap.values()),
  };

  state.lastReportData = reportPayload;

  // Populate Modal Elements
  const badge = $('reportBadge');
  if (summary.stopped) {
    badge.textContent = 'Vorgang vorzeitig angehalten';
    badge.className = 'report-badge stopped';
  } else {
    badge.textContent = 'Erfolgreich abgeschlossen';
    badge.className = 'report-badge';
  }

  $('reportTimestamp').textContent = `Erstellt am: ${reportPayload.timestamp}`;
  $('reportFreedBytes').textContent = formatBytes(freedBytes);
  $('reportFoldersCount').textContent = NF[0].format(summary.success_count);
  $('reportFilesCount').textContent = NF[0].format(totalFiles);
  $('reportMethod').textContent = summary.use_trash ? 'In den Papierkorb verschoben' : 'Endgültig gelöscht';

  // Render Category Bars
  let barsHtml = '';
  Object.entries(catTotals).forEach(([catKey, c]) => {
    if (c.folders === 0) return;
    barsHtml += `
      <div class="report-cat-row">
        <span class="report-cat-label">${escapeHtml(c.label)}</span>
        <div class="report-cat-bar-wrap">
          <div class="report-cat-bar-fill cat-${escapeHtml(catKey)}" style="width: ${c.percentage.toFixed(1)}%;"></div>
        </div>
        <span class="report-cat-stats">${formatBytes(c.bytes)} (${c.percentage.toFixed(1)} %)</span>
      </div>`;
  });
  $('reportCategoryBars').innerHTML = barsHtml || '<p style="color:var(--text-muted)">Keine Daten verfügbar.</p>';

  // Render Table
  let tableRows = '';
  reportPayload.projects.forEach(p => {
    tableRows += `
      <tr style="background:var(--bg-subtle); font-weight:600;">
        <td colspan="2">${escapeHtml(p.name)}</td>
        <td class="text-right">${NF[0].format(p.files_deleted)}</td>
        <td class="text-right">${formatBytes(p.freed_bytes)}</td>
        <td>Projekt</td>
      </tr>`;
    p.folders.forEach(f => {
      const statusColor = f.success ? 'var(--success)' : 'var(--danger)';
      const statusText = f.success ? 'Gelöscht' : 'Fehlgeschlagen';
      tableRows += `
        <tr>
          <td style="padding-left:24px;">&bull; ${escapeHtml(f.name)}</td>
          <td><span class="tag">${escapeHtml(f.category)}</span></td>
          <td class="text-right">${NF[0].format(f.files)}</td>
          <td class="text-right">${formatBytes(f.bytes)}</td>
          <td style="color:${statusColor}; font-weight:600;">${statusText}</td>
        </tr>`;
    });
  });
  $('reportTableBody').innerHTML = tableRows;

  reportModal.showModal();
}

reportExportPdfBtn.addEventListener('click', async () => {
  if (!state.lastReportData || !api()) return;
  try {
    const res = await api().export_pdf_report(state.lastReportData);
    if (res?.status === 'ok') {
      showToast(`PDF-Bericht erfolgreich gespeichert: ${res.path}`);
    } else if (res?.status === 'error') {
      showToast(`PDF-Erstellung fehlgeschlagen: ${res.message}`, 'error');
    }
  } catch (err) {
    showToast(`PDF-Export Fehler: ${err}`, 'error');
  }
});

reportCloseBtn.addEventListener('click', () => {
  reportModal.close();
});

// ---------- Initialization ----------

buildOverview();
updateStats();
