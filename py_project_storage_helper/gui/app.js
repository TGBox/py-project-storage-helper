/**
 * Project Storage Helper - Frontend Logic
 */

// Application State
const state = {
  projects: [],            // List of discovered projects
  selectedPaths: new Set(),// Set of disposable folder paths marked for deletion
  activeFilter: 'all',     // 'all' | 'node' | 'python' | 'build' | 'cache'
  searchQuery: '',
};

const $ = (id) => document.getElementById(id);

// DOM Elements
const folderInput = $('folderInput');
const scanBtn = $('scanBtn');
const stopBtn = $('stopBtn');
const progressContainer = $('progressContainer');
const progressMessage = $('progressMessage');
const statusDot = $('statusDot');
const statusText = $('statusText');
const searchInput = $('searchInput');
const filterBtns = document.querySelectorAll('.filter-btn');
const emptyState = $('emptyState');
const projectList = $('projectList');
const bottomBar = $('bottomBar');
const confirmModal = $('confirmModal');
const toastContainer = $('toastContainer');

const api = () => window.pywebview?.api;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[c]);
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function setBusy(busy, label) {
  statusDot.className = busy ? 'status-dot scanning' : 'status-dot active';
  statusText.textContent = label;
  progressContainer.style.display = busy ? 'flex' : 'none';
}

const matchesSearch = (project) => !state.searchQuery ||
  project.name.toLowerCase().includes(state.searchQuery) ||
  project.relative_path.toLowerCase().includes(state.searchQuery);

const matchesFilter = (folder) => state.activeFilter === 'all' || folder.category === state.activeFilter;

const allFolders = () => state.projects.flatMap(p => p.disposable_folders);

function selectedTotals() {
  const selected = allFolders().filter(f => state.selectedPaths.has(f.path));
  return { count: selected.length, bytes: selected.reduce((sum, f) => sum + f.size_bytes, 0) };
}

// Initialization
window.addEventListener('pywebviewready', async () => {
  try {
    const initialFolder = await api()?.get_initial_folder();
    if (initialFolder) folderInput.value = initialFolder;
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
    showToast('Fehler bei der Ordnerauswahl: ' + err, 'error');
  }
});

scanBtn.addEventListener('click', startScan);
stopBtn.addEventListener('click', async () => {
  if (!api()) return;
  await api().stop_scan();
  progressMessage.textContent = 'Scan wird angehalten...';
});
folderInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startScan();
});

async function startScan() {
  const folder = folderInput.value.trim();
  if (!folder) return showToast('Bitte wähle zuerst einen Ordner aus!', 'error');
  if (!api()) return showToast('Python-Backend noch nicht bereit.', 'error');

  state.projects = [];
  state.selectedPaths.clear();
  projectList.innerHTML = '';
  emptyState.style.display = 'none';
  scanBtn.style.display = 'none';
  stopBtn.style.display = 'inline-flex';
  setBusy(true, 'Scan läuft...');
  updateStats();

  try {
    const resp = await api().start_scan(folder);
    if (resp.status === 'error') {
      showToast(resp.message, 'error');
      finishScan(true);
    }
  } catch (err) {
    showToast('Scan-Start fehlgeschlagen: ' + err, 'error');
    finishScan(true);
  }
}

function finishScan(cancelled = false) {
  setBusy(false, cancelled ? 'Scan gestoppt' : 'Bereit');
  scanBtn.style.display = 'inline-flex';
  stopBtn.style.display = 'none';
  emptyState.style.display = state.projects.length === 0 ? 'flex' : 'none';
  updateStats();
}

// Global Callbacks invoked from Python
window.onScanProgress = (data) => {
  if (data?.message) progressMessage.textContent = data.message;
};

window.onProjectDiscovered = (project) => {
  if (state.projects.some(p => p.path === project.path)) return;
  state.projects.push(project);
  emptyState.style.display = 'none';
  projectList.insertAdjacentHTML('beforeend', projectCardHtml(project));
  updateStats();
};

window.onScanCompleted = (summary) => {
  finishScan(summary.stopped);
  const total = `${summary.total_projects} Projekte`;
  const size = formatBytes(summary.total_bytes);
  if (summary.error) {
    showToast('Fehler während des Scans: ' + summary.error, 'error');
  } else if (summary.stopped) {
    showToast(`Scan angehalten. ${total} erkannt (${size}).`, 'info');
  } else {
    showToast(`Scan abgeschlossen! ${total} gefunden (${size}).`, 'success');
  }
};

// Filter & Search Controls
filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    state.activeFilter = btn.dataset.filter;
    applyFilterAndSearch();
  });
});

searchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value.toLowerCase().trim();
  applyFilterAndSearch();
});

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

function applyFilterAndSearch() {
  let visibleProjectCount = 0;

  projectList.querySelectorAll('.project-card').forEach(card => {
    const project = state.projects.find(p => p.path === card.dataset.projectPath);
    if (!project) return;
    const searchOk = matchesSearch(project);
    let hasVisibleFolder = false;

    card.querySelectorAll('.folder-item').forEach(item => {
      const show = searchOk && matchesFilter(item.dataset);
      item.style.display = show ? 'flex' : 'none';
      hasVisibleFolder ||= show;
    });

    card.style.display = hasVisibleFolder ? 'block' : 'none';
    if (hasVisibleFolder) visibleProjectCount++;
  });

  if (state.projects.length === 0) return;
  if (visibleProjectCount === 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('.empty-title').textContent = 'Keine Treffer für diesen Filter';
    emptyState.querySelector('.empty-desc').textContent = 'Passe den Suchbegriff oder den Kategorie-Filter an.';
  } else {
    emptyState.style.display = 'none';
  }
}

// Project Card
const ICON_EXTERNAL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
const ICON_CHEVRON = '<svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

function projectCardHtml(project) {
  const folders = project.disposable_folders.map(f => `
    <div class="folder-item" data-folder-path="${escapeHtml(f.path)}" data-category="${escapeHtml(f.category)}">
      <label class="folder-item-left">
        <input type="checkbox" data-folder="${escapeHtml(f.path)}">
        <span class="folder-name">${escapeHtml(f.name)}</span>
        <span class="badge-category ${escapeHtml(f.category)}">${escapeHtml(f.category)}</span>
      </label>
      <div class="folder-item-right">
        <span class="folder-size">${formatBytes(f.size_bytes)} (${f.file_count.toLocaleString()} Dateien)</span>
        <button class="btn btn-ghost" style="padding: 4px 6px;" data-action="delete" data-folder="${escapeHtml(f.path)}" title="${escapeHtml(f.name)} sofort löschen">${ICON_TRASH}</button>
      </div>
    </div>`).join('');

  return `
    <details class="project-card" open data-project-path="${escapeHtml(project.path)}">
      <summary class="project-header">
        <div class="project-header-left">
          <input type="checkbox" data-project title="Alle Ordner dieses Projekts markieren">
          <div class="project-meta">
            <div class="project-title"><span>${escapeHtml(project.name)}</span></div>
            <div class="project-path">${escapeHtml(project.relative_path)}</div>
          </div>
        </div>
        <div class="project-header-right">
          <button class="btn btn-ghost" style="padding: 4px 8px;" data-action="open" title="In Windows Explorer öffnen">${ICON_EXTERNAL}</button>
          <span class="badge-size">${formatBytes(project.total_disposable_size)}</span>
          ${ICON_CHEVRON}
        </div>
      </summary>
      <div class="project-details">${folders}</div>
    </details>`;
}

// One delegated handler for all cards
projectList.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action], input[type="checkbox"]');
  if (!target) return;
  const card = target.closest('.project-card');
  const project = state.projects.find(p => p.path === card.dataset.projectPath);

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

// Sync checkbox UI with state
function updateAllCheckboxes() {
  projectList.querySelectorAll('.project-card').forEach(card => {
    const boxes = card.querySelectorAll('input[data-folder]');
    let selectedCount = 0;
    boxes.forEach(box => {
      box.checked = state.selectedPaths.has(box.dataset.folder);
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
  $('statProjectsCount').textContent = state.projects.length;
  $('statTotalReclaimable').textContent = formatBytes(state.projects.reduce((sum, p) => sum + p.total_disposable_size, 0));
  $('statSelectedReclaimable').textContent = `${formatBytes(bytes)} (${count} Ordner)`;
  bottomBar.classList.toggle('visible', count > 0);
  $('bottomSelectedSize').textContent = formatBytes(bytes);
  $('bottomSelectedCount').textContent = `${count} Ordner ausgewählt`;
}

// Modal handling
$('bottomDeleteBtn').addEventListener('click', showConfirmModal);
$('modalCloseBtn').addEventListener('click', hideConfirmModal);
$('modalCancelBtn').addEventListener('click', hideConfirmModal);
confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) hideConfirmModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideConfirmModal();
});

function showConfirmModal() {
  const { count, bytes } = selectedTotals();
  if (count === 0) return showToast('Keine Ordner ausgewählt.', 'info');
  $('modalFolderCount').textContent = count;
  $('modalFreedSpace').textContent = formatBytes(bytes);
  confirmModal.classList.add('open');
}

function hideConfirmModal() {
  confirmModal.classList.remove('open');
}

$('modalConfirmBtn').addEventListener('click', async () => {
  hideConfirmModal();
  if (!api()) return;

  setBusy(true, 'Bereinigung läuft...');
  progressMessage.textContent = 'Bereinige ausgewählte Ordner...';

  try {
    const res = await api().delete_items([...state.selectedPaths], $('modalTrashCheckbox').checked);
    if (res.status === 'error') {
      showToast(res.message, 'error');
      setBusy(false, 'Bereit');
    }
  } catch (err) {
    showToast('Fehler beim Löschen: ' + err, 'error');
    setBusy(false, 'Bereit');
  }
});

// Deletion Callbacks from Python
window.onDeleteProgress = (data) => {
  progressMessage.textContent = `Lösche (${data.current}/${data.total}): ${data.path}`;
  if (!data.success) showToast(`Fehler bei ${data.path}: ${data.error}`, 'error');
};

window.onDeleteCompleted = (summary) => {
  setBusy(false, 'Bereit');

  // Remove deleted paths from project model, drop projects with nothing left
  state.projects.forEach(p => {
    p.disposable_folders = p.disposable_folders.filter(f => !state.selectedPaths.has(f.path));
    p.total_disposable_size = p.disposable_folders.reduce((sum, f) => sum + f.size_bytes, 0);
  });
  state.projects = state.projects.filter(p => p.disposable_folders.length > 0);
  state.selectedPaths.clear();

  projectList.innerHTML = state.projects.map(projectCardHtml).join('');
  applyFilterAndSearch();
  updateStats();

  const msg = summary.use_trash ? 'in den Papierkorb verschoben' : 'dauerhaft gelöscht';
  showToast(
    `Erfolgreich: ${summary.success_count} Ordner ${msg} (${formatBytes(summary.total_freed_bytes)} freigegeben).`,
    'success'
  );
};
