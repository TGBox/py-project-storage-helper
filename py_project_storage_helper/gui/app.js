/**
 * Project Storage Helper - Frontend Logic
 */

// Application State
const state = {
  projects: [],           // List of discovered projects
  selectedPaths: new Set(),// Set of disposable folder paths marked for deletion
  activeFilter: 'all',    // 'all' | 'node' | 'python' | 'build' | 'cache'
  searchQuery: '',
  isScanning: false,
  isDeleting: false,
};

// DOM Elements
const folderInput = document.getElementById('folderInput');
const browseBtn = document.getElementById('browseBtn');
const scanBtn = document.getElementById('scanBtn');
const stopBtn = document.getElementById('stopBtn');

const progressContainer = document.getElementById('progressContainer');
const progressMessage = document.getElementById('progressMessage');
const progressStats = document.getElementById('progressStats');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

const statProjectsCount = document.getElementById('statProjectsCount');
const statTotalReclaimable = document.getElementById('statTotalReclaimable');
const statSelectedReclaimable = document.getElementById('statSelectedReclaimable');

const searchInput = document.getElementById('searchInput');
const filterBtns = document.querySelectorAll('.filter-btn');
const selectAllBtn = document.getElementById('selectAllBtn');
const deselectAllBtn = document.getElementById('deselectAllBtn');

const emptyState = document.getElementById('emptyState');
const projectList = document.getElementById('projectList');

const bottomBar = document.getElementById('bottomBar');
const bottomSelectedSize = document.getElementById('bottomSelectedSize');
const bottomSelectedCount = document.getElementById('bottomSelectedCount');
const bottomClearBtn = document.getElementById('bottomClearBtn');
const bottomDeleteBtn = document.getElementById('bottomDeleteBtn');

const confirmModal = document.getElementById('confirmModal');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
const modalFolderCount = document.getElementById('modalFolderCount');
const modalFreedSpace = document.getElementById('modalFreedSpace');
const modalTrashCheckbox = document.getElementById('modalTrashCheckbox');

const toastContainer = document.getElementById('toastContainer');

// Utility: Format size
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Toast Notifications
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

// Wait for pywebview API to be ready
function getApi() {
  return window.pywebview ? window.pywebview.api : null;
}

// Initialization
window.addEventListener('pywebviewready', async () => {
  const api = getApi();
  if (api) {
    try {
      const initialFolder = await api.get_initial_folder();
      if (initialFolder) {
        folderInput.value = initialFolder;
      }
    } catch (e) {
      console.warn('Initial folder error:', e);
    }
  }
});

// Event Listeners for Controls
browseBtn.addEventListener('click', async () => {
  const api = getApi();
  if (!api) return;
  try {
    const selected = await api.select_folder();
    if (selected) {
      folderInput.value = selected;
    }
  } catch (err) {
    showToast('Fehler bei der Ordnerauswahl: ' + err, 'error');
  }
});

scanBtn.addEventListener('click', startScan);
stopBtn.addEventListener('click', stopScan);

folderInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startScan();
});

async function startScan() {
  const folder = folderInput.value.trim();
  if (!folder) {
    showToast('Bitte wähle zuerst einen Ordner aus!', 'error');
    return;
  }

  const api = getApi();
  if (!api) {
    showToast('Python-Backend noch nicht bereit.', 'error');
    return;
  }

  // Reset state
  state.projects = [];
  state.selectedPaths.clear();
  state.isScanning = true;

  projectList.innerHTML = '';
  emptyState.style.display = 'none';
  progressContainer.style.display = 'flex';
  scanBtn.style.display = 'none';
  stopBtn.style.display = 'inline-flex';
  statusDot.className = 'status-dot scanning';
  statusText.textContent = 'Scan läuft...';

  updateStats();

  try {
    const resp = await api.start_scan(folder);
    if (resp.status === 'error') {
      showToast(resp.message, 'error');
      finishScan(true);
    }
  } catch (err) {
    showToast('Scan-Start fehlgeschlagen: ' + err, 'error');
    finishScan(true);
  }
}

async function stopScan() {
  const api = getApi();
  if (api) {
    await api.stop_scan();
    progressMessage.textContent = 'Scan wird angehalten...';
  }
}

function finishScan(cancelled = false) {
  state.isScanning = false;
  progressContainer.style.display = 'none';
  scanBtn.style.display = 'inline-flex';
  stopBtn.style.display = 'none';
  statusDot.className = 'status-dot active';
  statusText.textContent = cancelled ? 'Scan gestoppt' : 'Bereit';

  if (state.projects.length === 0) {
    emptyState.style.display = 'flex';
  } else {
    emptyState.style.display = 'none';
  }
  updateStats();
}

// Global Callbacks invoked from Python
window.onScanProgress = function(data) {
  if (data && data.message) {
    progressMessage.textContent = data.message;
  }
};

window.onProjectDiscovered = function(project) {
  // Prevent duplicate additions
  if (state.projects.some(p => p.path === project.path)) return;

  state.projects.push(project);
  emptyState.style.display = 'none';
  renderProjectCard(project);
  updateStats();
};

window.onScanCompleted = function(summary) {
  finishScan(summary.stopped);
  if (summary.error) {
    showToast('Fehler während des Scans: ' + summary.error, 'error');
  } else if (summary.stopped) {
    showToast(`Scan angehalten. ${summary.total_projects} Projekte erkannt (${summary.total_human}).`, 'info');
  } else {
    showToast(`Scan abgeschlossen! ${summary.total_projects} Projekte gefunden (${summary.total_human}).`, 'success');
  }
};

// Filter & Search Controls
filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    state.activeFilter = btn.dataset.filter;
    applyFilterAndSearch();
  });
});

searchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value.toLowerCase().trim();
  applyFilterAndSearch();
});

selectAllBtn.addEventListener('click', () => {
  const visibleFolders = getCurrentlyVisibleFolders();
  visibleFolders.forEach(f => state.selectedPaths.add(f.path));
  updateAllCheckboxes();
  updateStats();
});

deselectAllBtn.addEventListener('click', () => {
  state.selectedPaths.clear();
  updateAllCheckboxes();
  updateStats();
});

bottomClearBtn.addEventListener('click', () => {
  state.selectedPaths.clear();
  updateAllCheckboxes();
  updateStats();
});

// Helper: Get visible disposable folders according to active filter and search
function getCurrentlyVisibleFolders() {
  const folders = [];
  state.projects.forEach(project => {
    const matchesSearch = !state.searchQuery || 
      project.name.toLowerCase().includes(state.searchQuery) ||
      project.relative_path.toLowerCase().includes(state.searchQuery);

    if (matchesSearch) {
      project.folders.forEach(f => {
        if (state.activeFilter === 'all' || f.category === state.activeFilter) {
          folders.push(f);
        }
      });
    }
  });
  return folders;
}

function applyFilterAndSearch() {
  const cards = projectList.querySelectorAll('.project-card');
  let visibleProjectCount = 0;

  cards.forEach(card => {
    const projectPath = card.dataset.projectPath;
    const project = state.projects.find(p => p.path === projectPath);
    if (!project) return;

    const matchesSearch = !state.searchQuery || 
      project.name.toLowerCase().includes(state.searchQuery) ||
      project.relative_path.toLowerCase().includes(state.searchQuery);

    // Filter folder items inside the card
    const folderItems = card.querySelectorAll('.folder-item');
    let hasVisibleFolder = false;

    folderItems.forEach(item => {
      const folderCat = item.dataset.category;
      const isCatMatch = (state.activeFilter === 'all' || folderCat === state.activeFilter);
      if (matchesSearch && isCatMatch) {
        item.style.display = 'flex';
        hasVisibleFolder = true;
      } else {
        item.style.display = 'none';
      }
    });

    if (matchesSearch && hasVisibleFolder) {
      card.style.display = 'block';
      visibleProjectCount++;
    } else {
      card.style.display = 'none';
    }
  });

  if (visibleProjectCount === 0 && state.projects.length > 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('.empty-title').textContent = 'Keine Treffer für diesen Filter';
    emptyState.querySelector('.empty-desc').textContent = 'Passe den Suchbegriff oder den Kategorie-Filter an.';
  } else if (state.projects.length > 0) {
    emptyState.style.display = 'none';
  }
}

// Render Project Card
function renderProjectCard(project) {
  const card = document.createElement('div');
  card.className = 'project-card';
  card.dataset.projectPath = project.path;

  // Header
  const header = document.createElement('div');
  header.className = 'project-header';
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');

  // Checkbox for whole project
  const masterCheck = document.createElement('div');
  masterCheck.className = 'custom-checkbox';
  masterCheck.setAttribute('role', 'checkbox');
  masterCheck.setAttribute('aria-checked', 'false');
  masterCheck.setAttribute('title', 'Alle Ordner dieses Projekts markieren');

  masterCheck.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleProjectFolders(project);
  });

  // Meta info
  const meta = document.createElement('div');
  meta.className = 'project-meta';
  meta.innerHTML = `
    <div class="project-title">
      <span>${escapeHtml(project.name)}</span>
    </div>
    <div class="project-path">${escapeHtml(project.relative_path)}</div>
  `;

  const headerLeft = document.createElement('div');
  headerLeft.className = 'project-header-left';
  headerLeft.appendChild(masterCheck);
  headerLeft.appendChild(meta);

  // Right side: Badges & Actions
  const headerRight = document.createElement('div');
  headerRight.className = 'project-header-right';

  // Open Explorer button
  const explorerBtn = document.createElement('button');
  explorerBtn.className = 'btn btn-ghost';
  explorerBtn.style.padding = '4px 8px';
  explorerBtn.setAttribute('title', 'In Windows Explorer öffnen');
  explorerBtn.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
  `;
  explorerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const api = getApi();
    if (api) api.open_in_explorer(project.path);
  });

  const sizeBadge = document.createElement('span');
  sizeBadge.className = 'badge-size';
  sizeBadge.textContent = project.total_size_human;

  const chevronBtn = document.createElement('button');
  chevronBtn.className = 'chevron-btn expanded';
  chevronBtn.setAttribute('aria-label', 'Details anzeigen');
  chevronBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `;

  headerRight.appendChild(explorerBtn);
  headerRight.appendChild(sizeBadge);
  headerRight.appendChild(chevronBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  // Details Container (Folder Items)
  const details = document.createElement('div');
  details.className = 'project-details show';

  project.folders.forEach(folder => {
    const folderItem = document.createElement('div');
    folderItem.className = 'folder-item';
    folderItem.dataset.folderPath = folder.path;
    folderItem.dataset.category = folder.category;

    const fCheck = document.createElement('div');
    fCheck.className = 'custom-checkbox';
    fCheck.setAttribute('role', 'checkbox');
    fCheck.setAttribute('aria-checked', 'false');

    fCheck.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSingleFolder(folder.path);
    });

    const fLeft = document.createElement('div');
    fLeft.className = 'folder-item-left';
    fLeft.appendChild(fCheck);

    const fName = document.createElement('span');
    fName.className = 'folder-name';
    fName.textContent = folder.name;
    fLeft.appendChild(fName);

    const catBadge = document.createElement('span');
    catBadge.className = `badge-category ${folder.category}`;
    catBadge.textContent = folder.category;
    fLeft.appendChild(catBadge);

    const fRight = document.createElement('div');
    fRight.className = 'folder-item-right';

    const fSize = document.createElement('span');
    fSize.className = 'folder-size';
    fSize.textContent = `${folder.size_human} (${folder.file_count.toLocaleString()} Dateien)`;

    // Individual delete icon button
    const deleteSingleBtn = document.createElement('button');
    deleteSingleBtn.className = 'btn btn-ghost';
    deleteSingleBtn.style.padding = '4px 6px';
    deleteSingleBtn.setAttribute('title', `${folder.name} sofort löschen`);
    deleteSingleBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"></path>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `;
    deleteSingleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selectedPaths.clear();
      state.selectedPaths.add(folder.path);
      updateAllCheckboxes();
      updateStats();
      showConfirmModal();
    });

    fRight.appendChild(fSize);
    fRight.appendChild(deleteSingleBtn);

    folderItem.appendChild(fLeft);
    folderItem.appendChild(fRight);
    details.appendChild(folderItem);
  });

  // Toggle expand / collapse on header click
  header.addEventListener('click', () => {
    const isShowing = details.classList.contains('show');
    if (isShowing) {
      details.classList.remove('show');
      chevronBtn.classList.remove('expanded');
    } else {
      details.classList.add('show');
      chevronBtn.classList.add('expanded');
    }
  });

  card.appendChild(header);
  card.appendChild(details);
  projectList.appendChild(card);
}

// Toggle individual folder
function toggleSingleFolder(folderPath) {
  if (state.selectedPaths.has(folderPath)) {
    state.selectedPaths.delete(folderPath);
  } else {
    state.selectedPaths.add(folderPath);
  }
  updateAllCheckboxes();
  updateStats();
}

// Toggle all folders of a project
function toggleProjectFolders(project) {
  const allSelected = project.folders.every(f => state.selectedPaths.has(f.path));
  if (allSelected) {
    project.folders.forEach(f => state.selectedPaths.delete(f.path));
  } else {
    project.folders.forEach(f => state.selectedPaths.add(f.path));
  }
  updateAllCheckboxes();
  updateStats();
}

// Update Checkbox UI states
function updateAllCheckboxes() {
  const cards = projectList.querySelectorAll('.project-card');

  cards.forEach(card => {
    const projectPath = card.dataset.projectPath;
    const project = state.projects.find(p => p.path === projectPath);
    if (!project) return;

    let selectedCount = 0;
    const folderItems = card.querySelectorAll('.folder-item');

    folderItems.forEach(item => {
      const folderPath = item.dataset.folderPath;
      const isSelected = state.selectedPaths.has(folderPath);
      const fCheck = item.querySelector('.custom-checkbox');

      if (isSelected) {
        selectedCount++;
        fCheck.classList.add('checked');
        fCheck.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
      } else {
        fCheck.classList.remove('checked');
        fCheck.innerHTML = '';
      }
    });

    const masterCheck = card.querySelector('.project-header .custom-checkbox');
    masterCheck.classList.remove('checked', 'indeterminate');
    masterCheck.innerHTML = '';

    if (selectedCount === project.folders.length && project.folders.length > 0) {
      masterCheck.classList.add('checked');
      masterCheck.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
      card.classList.add('has-selected');
    } else if (selectedCount > 0) {
      masterCheck.classList.add('indeterminate');
      masterCheck.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      `;
      card.classList.add('has-selected');
    } else {
      card.classList.remove('has-selected');
    }
  });
}

// Recalculate stats & bottom bar
function updateStats() {
  statProjectsCount.textContent = state.projects.length;

  let totalReclaimableBytes = 0;
  state.projects.forEach(p => totalReclaimableBytes += p.total_size);
  statTotalReclaimable.textContent = formatBytes(totalReclaimableBytes);

  let selectedBytes = 0;
  let selectedCount = 0;

  state.projects.forEach(p => {
    p.folders.forEach(f => {
      if (state.selectedPaths.has(f.path)) {
        selectedBytes += f.size_bytes;
        selectedCount++;
      }
    });
  });

  statSelectedReclaimable.textContent = `${formatBytes(selectedBytes)} (${selectedCount} Ordner)`;

  if (selectedCount > 0) {
    bottomBar.classList.add('visible');
    bottomSelectedSize.textContent = formatBytes(selectedBytes);
    bottomSelectedCount.textContent = `${selectedCount} Ordner ausgewählt`;
  } else {
    bottomBar.classList.remove('visible');
  }
}

// Modal handling
bottomDeleteBtn.addEventListener('click', showConfirmModal);
modalCloseBtn.addEventListener('click', hideConfirmModal);
modalCancelBtn.addEventListener('click', hideConfirmModal);

confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) hideConfirmModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && confirmModal.classList.contains('open')) {
    hideConfirmModal();
  }
});

function showConfirmModal() {
  const selectedCount = state.selectedPaths.size;
  if (selectedCount === 0) {
    showToast('Keine Ordner ausgewählt.', 'info');
    return;
  }

  let selectedBytes = 0;
  state.projects.forEach(p => {
    p.folders.forEach(f => {
      if (state.selectedPaths.has(f.path)) {
        selectedBytes += f.size_bytes;
      }
    });
  });

  modalFolderCount.textContent = selectedCount;
  modalFreedSpace.textContent = formatBytes(selectedBytes);
  confirmModal.classList.add('open');
}

function hideConfirmModal() {
  confirmModal.classList.remove('open');
}

modalConfirmBtn.addEventListener('click', async () => {
  hideConfirmModal();
  const api = getApi();
  if (!api) return;

  const pathsToDelete = Array.from(state.selectedPaths);
  const useTrash = modalTrashCheckbox.checked;

  state.isDeleting = true;
  statusDot.className = 'status-dot scanning';
  statusText.textContent = 'Bereinigung läuft...';
  progressContainer.style.display = 'flex';
  progressMessage.textContent = 'Bereinige ausgewählte Ordner...';

  try {
    const res = await api.delete_items(pathsToDelete, useTrash);
    if (res.status === 'error') {
      showToast(res.message, 'error');
      state.isDeleting = false;
      progressContainer.style.display = 'none';
      statusDot.className = 'status-dot active';
      statusText.textContent = 'Bereit';
    }
  } catch (err) {
    showToast('Fehler beim Löschen: ' + err, 'error');
    state.isDeleting = false;
    progressContainer.style.display = 'none';
  }
});

// Deletion Callbacks from Python
window.onDeleteProgress = function(data) {
  progressMessage.textContent = `Lösche (${data.current}/${data.total}): ${data.path}`;
  if (!data.success) {
    showToast(`Fehler bei ${data.path}: ${data.error}`, 'error');
  }
};

window.onDeleteCompleted = function(summary) {
  state.isDeleting = false;
  progressContainer.style.display = 'none';
  statusDot.className = 'status-dot active';
  statusText.textContent = 'Bereit';

  // Remove deleted paths from project model
  const deletedSet = new Set(state.selectedPaths);
  state.projects.forEach(p => {
    p.folders = p.folders.filter(f => !deletedSet.has(f.path));
    p.total_size = p.folders.reduce((sum, f) => sum + f.size_bytes, 0);
    p.total_size_human = formatBytes(p.total_size);
  });

  // Remove projects that have 0 disposable folders left
  state.projects = state.projects.filter(p => p.folders.length > 0);
  state.selectedPaths.clear();

  // Re-render UI
  projectList.innerHTML = '';
  state.projects.forEach(p => renderProjectCard(p));
  applyFilterAndSearch();
  updateStats();

  const msg = summary.use_trash ? 'in den Papierkorb verschoben' : 'dauerhaft gelöscht';
  showToast(
    `Erfolgreich: ${summary.success_count} Ordner ${msg} (${summary.total_freed_human} freigegeben).`,
    'success'
  );
};

// HTML escape helper
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}
