# Project Storage Helper

Eine schlanke, moderne Desktop-Anwendung zur Erkennung und Bereinigung von speicherintensiven temporären Ordnern (wie `.venv`, `node_modules`, `build`, `dist`, `target`, Caches) in Entwickler-Projektverzeichnissen.

---

## Features

- **Schicke Desktop-GUI (PyWebView)**: Reibungslose native Fensteroberfläche mit modernem Dark-Mode-Design, Live-Statistiken und flüssigen Interaktionen.
- **Echtzeit Live-Scanning**: Gefundene Projekte und freigebbarer Speicherplatz werden während des Scannens in Echtzeit gestreamt (mit Stop-Möglichkeit).
- **Intelligente Projekterkennung**: Erkennt Entwicklungsprojekte automatisch anhand von Markern (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, etc.) oder enthaltener Umgebungen, ohne unnötig tief in Bibliotheksordner abzusteigen.
- **Granulare Auswahl**:
  - Aufklappbare Projekt-Karten mit genauer Pfad- und Größenauflistung pro Ordner.
  - Checkboxen für einzelne Ordner sowie Projekt- und globale Sammelauswahl.
  - Filter nach Kategorien: `node_modules`, `.venv / venv`, `Build & Dist`, `Caches` sowie Live-Suche.
- **Sicherheitsmechanismen**:
  - Standardmäßig Verschieben in den **Windows-Papierkorb** (`send2trash`), sodass versehentliche Löschungen jederzeit wiederhergestellt werden können.
  - Option für dauerhaftes Löschen im Bestätigungsdialog.
  - Sicherheitsfilter: `.git`-Verzeichnisse, Systemordner und Projekt-Quelldateien sind strikt vor dem Löschen geschützt.
- **Direktintegration**: Mit einem Klick das Projektverzeichnis direkt im Windows Explorer öffnen.

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
