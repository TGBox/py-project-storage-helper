# Project Storage Helper

Eine schlanke, moderne Desktop-Anwendung zur Erkennung und Bereinigung von speicherintensiven temporären Ordnern (wie `.venv`, `node_modules`, `build`, `dist`, `target`, Caches) in Entwickler-Projektverzeichnissen.

---

## Features

- **Desktop-GUI (PyWebView)**: Zeigt oben, wie viel Platz insgesamt freigebbar ist, aufgeteilt nach Kategorie (Node-Pakete, Python-Umgebungen, Build-Ausgaben, Caches). Ein Klick auf eine Kategorie filtert die Liste. Hell- und Dunkelmodus folgen der Windows-Einstellung.
- **Live-Scan**: Gefundene Projekte erscheinen während des Scans, sortiert nach Größe. Der Scan lässt sich jederzeit stoppen.
- **Projekterkennung**: Erkennt Projekte an Markern (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml` usw.), auch verschachtelte Pakete in Monorepos.
- **Auswahl**: Einzelne Ordner, ganze Projekte oder alle sichtbaren Ordner markieren. Markierte Ordner werden gelb hervorgehoben.
- **Sicherheit**:
  - Standardmäßig landen Ordner im **Windows-Papierkorb** (`send2trash`). Endgültiges Löschen muss im Bestätigungsdialog ausdrücklich gewählt werden.
  - Gelöscht werden nur Ordner, die der letzte Scan gefunden hat, und nur bekannte Wegwerf-Ordner. `.git` und alles darin ist tabu.
  - `env`, `venv` und `.venv` gelten nur als löschbar, wenn sie eine `pyvenv.cfg` enthalten. `.env` wird nie angeboten.
  - Symlinks und Junctions (z. B. von pnpm) werden beim Messen nicht verfolgt.
- **Explorer**: Projektordner mit einem Klick im Windows Explorer öffnen.

---

## Installation & Start

Voraussetzung: Python 3.14 (oder uv).

```powershell
# Abhängigkeiten installieren und GUI starten
uv run python main.py

# Alternativ als Konsolenbefehl
uv run py-project-storage-helper
```

### CLI-Modus (Schnellscan ohne GUI)

```powershell
uv run python main.py --scan "C:\Pfad\zu\deinen\Projekten"
```

---

## Tests ausführen

```powershell
uv run python -m unittest discover tests
```
