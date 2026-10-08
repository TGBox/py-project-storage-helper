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
  projects: [],             // sorted by size, largest first
  selectedPaths: new Set(), // folder paths marked for removal
  removedPaths: new Set(),  // folders removed during the current deletion run
  activeFilter: 'all',
  searchQuery: '',
  busy: false,
};

const $ = (id) => document.getElementById(id);

const folderInput = $('folderInput');
const scanBtn = $('scanBtn');
const stopBtn = $('stopBtn');
const progressContainer = $('progressContainer');
const progressMessage = $('progressMessage');
const projectList = $('projectList');
const emptyState = $('emptyState');
const meter = $('meter');
const legend = $('legend');
const confirmModal = $('confirmModal');
const trashCheckbox = $('modalTrashCheckbox');
const confirmBtn = $('modalConfirmBtn');

const api = () => window.pywebview?.api;

// ---------- Formatting ----------

const nf = (digits) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF = [nf(0), nf(1), nf(2)];

// Three significant digits: 3,20 MB, 92,3 MB, 486 MB, 1,78 GB
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  if (i === 0) return `${bytes} B`;
  const digits = bytes < 10 ? 2 : bytes < 100 ? 1 : 0;
  return `${NF[digits].format(bytes)} ${units[i]}`;
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
    setTimeout(() => toast.remove(), 300);
  }, type === 'error' ? 6000 : 3500);
}

function setBusy(busy, label) {
  state.busy = busy;
  $('status').dataset.state = busy ? 'busy' : 'idle';
  $('statusText').textContent = label;
  progressContainer.hidden = !busy;
}

function showEmpty(title, desc) {
  emptyState.hidden = false;
  emptyState.querySelector('.empty-title').textContent = title;
  emptyState.querySelector('.empty-desc').textContent = desc;
}

// ---------- Selection helpers ----------

const matchesSearch = (project) => !state.searchQuery ||
  project.name.toLowerCase().includes(state.searchQuery) ||
  project.relative_path.toLowerCase().includes(state.searchQuery);

const matchesFilter = (folder) => state.activeFilter === 'all' || folder.category === state.activeFilter;

const allFolders = () => state.projects.flatMap(p => p.disposable_folders);

function selectedTotals() {
  const selected = allFolders().filter(f => state.selectedPaths.has(f.path));
  return { count: selected.length, bytes: selected.reduce((sum, f) => sum + f.size_bytes, 0) };
}

// ---------- Overview: total, meter, legend ----------

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
    seg.style.setProperty('--marked', `${(t.marked / t.bytes) * 100}%`);
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

// ---------- Scan ----------

window.addEventListener('pywebviewready', async () => {
  try {
    const initialFolder = await api()?.get_initial_folder();
    if (initialFolder && !folderInput.value) folderInput.value = initialFolder;
  } catch (e) {
    console.warn('Initial folder error:', e);
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

stopBtn.addEventListener('click', async () => {
  if (!api()) return;
  await api().stop_scan();
  progressMessage.textContent = 'Scan wird gestoppt …';
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
  stopBtn.hidden = false;
  progressMessage.textContent = 'Scan läuft …';
  setBusy(true, 'Scan läuft');
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
  stopBtn.hidden = true;
  updateStats();
}

window.onScanProgress = (data) => {
  if (data?.message) progressMessage.textContent = data.message;
};

window.onProjectDiscovered = (project) => {
  if (state.projects.some(p => p.path === project.path)) return;

  // Keep the list sorted by size, largest first
  const idx = state.projects.findIndex(p => p.total_disposable_size < project.total_disposable_size);
  const html = projectCardHtml(project);
  if (idx === -1) {
    state.projects.push(project);
    projectList.insertAdjacentHTML('beforeend', html);
  } else {
    state.projects.splice(idx, 0, project);
    projectList.children[idx].insertAdjacentHTML('beforebegin', html);
  }

  emptyState.hidden = true;
  projectList.style.setProperty('--max', state.projects[0].total_disposable_size || 1);
  if (state.searchQuery || state.activeFilter !== 'all') applyFilterAndSearch();
  updateStats();
};

window.onScanCompleted = (summary) => {
  finishScan(summary.stopped);
  const found = `${plural(summary.total_projects, 'Projekt', 'Projekte')}, ${formatBytes(summary.total_bytes)} freigebbar`;
  if (summary.error) {
    showToast('Scan abgebrochen: ' + summary.error, 'error');
  } else if (summary.stopped) {
    showToast(`Scan gestoppt. Bis dahin: ${found}.`);
  } else if (summary.total_projects === 0) {
    showEmpty('Nichts zu entfernen', 'In diesem Ordner gibt es keine node_modules, .venv, Build-Ausgaben oder Caches. Wähle einen anderen Ordner.');
  } else {
    showToast(`Scan fertig. ${found}.`);
  }
};

// ---------- Filter & search ----------

$('searchInput').addEventListener('input', (e) => {
  state.searchQuery = e.target.value.toLowerCase().trim();
  applyFilterAndSearch();
});

function applyFilterAndSearch() {
  let visibleProjects = 0;

  projectList.querySelectorAll('.project').forEach((card, i) => {
    const project = state.projects[i];
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
    showEmpty('Keine Treffer', 'Ändere den Suchbegriff oder wähle oben „Alle“.');
  } else {
    emptyState.hidden = true;
  }
}

// ---------- Selection ----------

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

// ---------- Project rows ----------

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
      <button type="button" class="icon-btn danger" data-action="delete" data-folder="${path}" title="Entfernen" aria-label="${name} entfernen">${ICON_TRASH}</button>
      <span class="spacer"></span>
    </li>`;
}

function projectCardHtml(project) {
  const name = escapeHtml(project.name);
  return `
    <details class="project" open>
      <summary class="project-row">
        <input type="checkbox" data-project aria-label="Alle Ordner in ${name} markieren">
        <div class="project-meta">
          <div class="project-name">${name}</div>
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

// One delegated handler for all rows
projectList.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action], input[type="checkbox"]');
  if (!target) return;
  const card = target.closest('.project');
  const project = state.projects[[...projectList.children].indexOf(card)];

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
  } else {
    const path = target.dataset.folder;
    if (!state.selectedPaths.delete(path)) state.selectedPaths.add(path);
    setSelection(state.selectedPaths);
  }
});

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
    master.checked = selectedCount > 0 && selectedCount === boxes.length;
    master.indeterminate = selectedCount > 0 && !master.checked;
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

// ---------- Confirm & delete ----------

$('bottomDeleteBtn').addEventListener('click', showConfirmModal);

function syncTrashOption() {
  const trash = trashCheckbox.checked;
  confirmBtn.textContent = trash ? 'In Papierkorb verschieben' : 'Endgültig löschen';
  confirmBtn.classList.toggle('btn-primary', trash);
  confirmBtn.classList.toggle('btn-danger', !trash);
  $('modalTrashHint').textContent = trash
    ? 'Du kannst die Ordner dort wiederherstellen.'
    : 'Ohne Haken werden die Ordner sofort und endgültig gelöscht.';
}

trashCheckbox.addEventListener('change', syncTrashOption);

function showConfirmModal() {
  if (state.busy) return;
  const { count, bytes } = selectedTotals();
  if (count === 0) return showToast('Markiere zuerst mindestens einen Ordner.');
  $('modalTitle').textContent = `${plural(count, 'Ordner', 'Ordner')} entfernen?`;
  $('modalFreedSpace').textContent = formatBytes(bytes);
  trashCheckbox.checked = true;
  syncTrashOption();
  confirmModal.showModal();
}

confirmModal.addEventListener('close', async () => {
  if (confirmModal.returnValue !== 'confirm' || !api()) return;
  confirmModal.returnValue = '';

  state.removedPaths.clear();
  scanBtn.disabled = true;
  progressMessage.textContent = 'Entferne markierte Ordner …';
  setBusy(true, 'Ordner werden entfernt');
  updateStats();

  try {
    const res = await api().delete_items([...state.selectedPaths], trashCheckbox.checked);
    if (res.status === 'error') {
      showToast(res.message, 'error');
      finishDeletion();
    }
  } catch (err) {
    showToast('Entfernen fehlgeschlagen: ' + err, 'error');
    finishDeletion();
  }
});

function finishDeletion() {
  scanBtn.disabled = false;
  setBusy(false, 'Bereit');
  updateStats();
}

window.onDeleteProgress = (data) => {
  progressMessage.textContent = `Entferne ${data.current} von ${data.total}: ${data.path}`;
  if (data.success) {
    state.removedPaths.add(data.path);
  } else {
    showToast(`${data.path} wurde nicht entfernt: ${data.error}`, 'error');
  }
};

window.onDeleteCompleted = (summary) => {
  // Only drop folders that were actually removed; failed ones stay listed and marked
  const removed = state.removedPaths;
  const freedBytes = allFolders().filter(f => removed.has(f.path)).reduce((sum, f) => sum + f.size_bytes, 0);
  state.projects.forEach(p => {
    p.disposable_folders = p.disposable_folders.filter(f => !removed.has(f.path));
    p.total_disposable_size = p.disposable_folders.reduce((sum, f) => sum + f.size_bytes, 0);
  });
  state.projects = state.projects
    .filter(p => p.disposable_folders.length > 0)
    .sort((a, b) => b.total_disposable_size - a.total_disposable_size);
  removed.forEach(p => state.selectedPaths.delete(p));

  projectList.innerHTML = state.projects.map(projectCardHtml).join('');
  projectList.style.setProperty('--max', state.projects[0]?.total_disposable_size || 1);
  updateAllCheckboxes();
  applyFilterAndSearch();
  finishDeletion();

  if (state.projects.length === 0) {
    showEmpty('Alles aufgeräumt', 'Es sind keine löschbaren Ordner mehr übrig. Scanne erneut oder wähle einen anderen Ordner.');
  }

  const verb = summary.use_trash ? 'in den Papierkorb verschoben' : 'endgültig gelöscht';
  if (summary.success_count > 0) {
    showToast(`${plural(summary.success_count, 'Ordner', 'Ordner')} ${verb}, ${formatBytes(freedBytes)} frei.`);
  }
};

buildOverview();
updateStats();
