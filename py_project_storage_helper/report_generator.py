"""PDF report generator for Project Storage Helper."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from py_project_storage_helper.scanner import format_size


def generate_deletion_report_pdf(output_path: str | Path, report_data: dict[str, Any]) -> str:
    """Generate a clean, structured PDF deletion protocol using ReportLab."""
    path = Path(output_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
    )

    styles = getSampleStyleSheet()

    # Custom styles
    title_style = ParagraphStyle(
        "ReportTitle",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=4,
    )

    subtitle_style = ParagraphStyle(
        "ReportSubtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=colors.HexColor("#64748b"),
        spaceAfter=12,
    )

    section_heading = ParagraphStyle(
        "SectionHeading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=16,
        textColor=colors.HexColor("#1e293b"),
        spaceBefore=12,
        spaceAfter=6,
    )

    body_style = ParagraphStyle(
        "ReportBody",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#334155"),
    )

    bold_cell_style = ParagraphStyle(
        "BoldCell",
        parent=body_style,
        fontName="Helvetica-Bold",
    )

    right_cell_style = ParagraphStyle(
        "RightCell",
        parent=body_style,
        alignment=2,  # TA_RIGHT
    )

    right_bold_cell_style = ParagraphStyle(
        "RightBoldCell",
        parent=bold_cell_style,
        alignment=2,  # TA_RIGHT
    )

    kpi_title_style = ParagraphStyle(
        "KpiTitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#64748b"),
    )

    kpi_value_style = ParagraphStyle(
        "KpiValue",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=15,
        leading=18,
        textColor=colors.HexColor("#0f172a"),
    )

    story = []

    # Title & Metadata Header
    story.append(Paragraph("Project Storage Helper &ndash; L&ouml;schprotokoll", title_style))
    timestamp = report_data.get("timestamp", "")
    method = "In den Papierkorb verschoben (wiederherstellbar)" if report_data.get("use_trash", True) else "Endg&uuml;ltig gel&ouml;scht"
    status_note = " (vorzeitig abgebrochen)" if report_data.get("stopped_early", False) else ""
    story.append(Paragraph(f"Erstellt am: {timestamp} &bull; Modus: {method}{status_note}", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#e2e8f0"), spaceAfter=14))

    # KPI Summary Cards Table
    freed_bytes = report_data.get("total_freed_bytes", 0)
    files_deleted = report_data.get("total_files_deleted", 0)
    folders_deleted = report_data.get("total_folders_deleted", 0)
    projects_count = len(report_data.get("projects", []))

    kpi_data = [
        [
            Paragraph("FREIGEGEBENER SPEICHER", kpi_title_style),
            Paragraph("GEL&Ouml;SCHTE ORDNER", kpi_title_style),
            Paragraph("GEL&Ouml;SCHTE DATEIEN", kpi_title_style),
            Paragraph("BETROFFENE PROJEKTE", kpi_title_style),
        ],
        [
            Paragraph(format_size(freed_bytes), kpi_value_style),
            Paragraph(str(folders_deleted), kpi_value_style),
            Paragraph(f"{files_deleted:,}".replace(",", "."), kpi_value_style),
            Paragraph(str(projects_count), kpi_value_style),
        ],
    ]

    col_w = (A4[0] - 72) / 4
    kpi_table = Table(kpi_data, colWidths=[col_w] * 4)
    kpi_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
                ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#e2e8f0")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ]
        )
    )
    story.append(kpi_table)
    story.append(Spacer(1, 14))

    # Category Breakdown Section
    categories = report_data.get("categories", {})
    if categories:
        story.append(Paragraph("Verteilung nach Kategorien", section_heading))
        cat_rows = [
            [
                Paragraph("Kategorie", bold_cell_style),
                Paragraph("Freigegebener Speicher", right_bold_cell_style),
                Paragraph("Ordner", right_bold_cell_style),
                Paragraph("Dateien", right_bold_cell_style),
                Paragraph("Anteil", right_bold_cell_style),
            ]
        ]
        for cat_info in categories.values():
            pct = cat_info.get("percentage", 0.0)
            cat_rows.append(
                [
                    Paragraph(cat_info.get("label", ""), body_style),
                    Paragraph(format_size(cat_info.get("bytes", 0)), right_cell_style),
                    Paragraph(str(cat_info.get("folders", 0)), right_cell_style),
                    Paragraph(f"{cat_info.get('files', 0):,}".replace(",", "."), right_cell_style),
                    Paragraph(f"{pct:.1f} %", right_cell_style),
                ]
            )

        # Total row
        cat_rows.append(
            [
                Paragraph("Gesamt", bold_cell_style),
                Paragraph(format_size(freed_bytes), right_bold_cell_style),
                Paragraph(str(folders_deleted), right_bold_cell_style),
                Paragraph(f"{files_deleted:,}".replace(",", "."), right_bold_cell_style),
                Paragraph("100.0 %", right_bold_cell_style),
            ]
        )

        cat_col_w = [140, 100, 70, 90, 80]
        cat_table = Table(cat_rows, colWidths=cat_col_w)
        cat_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                    ("LINEBELOW", (0, 0), (-1, 0), 1, colors.HexColor("#cbd5e1")),
                    ("LINEABOVE", (0, -1), (-1, -1), 1, colors.HexColor("#cbd5e1")),
                    ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f8fafc")),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ]
            )
        )
        story.append(cat_table)
        story.append(Spacer(1, 14))

    # Project and Items Details Section
    projects = report_data.get("projects", [])
    if projects:
        story.append(Paragraph("Detaillierte Liste der gel&ouml;schten Ordner", section_heading))
        detail_rows = [
            [
                Paragraph("Projekt / Ordner", bold_cell_style),
                Paragraph("Kategorie", bold_cell_style),
                Paragraph("Dateien", right_bold_cell_style),
                Paragraph("Speicherplatz", right_bold_cell_style),
                Paragraph("Status", bold_cell_style),
            ]
        ]

        for p in projects:
            p_name = p.get("name", "")
            p_eco = p.get("ecosystem", "")
            eco_badge = f" ({p_eco})" if p_eco else ""
            # Project header row
            detail_rows.append(
                [
                    Paragraph(f"<b>{p_name}</b>{eco_badge}", bold_cell_style),
                    Paragraph("", body_style),
                    Paragraph(f"{p.get('files_deleted', 0):,}".replace(",", "."), right_bold_cell_style),
                    Paragraph(format_size(p.get("freed_bytes", 0)), right_bold_cell_style),
                    Paragraph("Bereinigt", bold_cell_style),
                ]
            )

            for folder in p.get("folders", []):
                status_text = "Erfolgreich" if folder.get("success", True) else "Fehlgeschlagen"
                status_color = "#16a34a" if folder.get("success", True) else "#dc2626"
                status_para = Paragraph(f"<font color='{status_color}'>{status_text}</font>", body_style)
                detail_rows.append(
                    [
                        Paragraph(f"&nbsp;&nbsp;&bull; {folder.get('name', '')}", body_style),
                        Paragraph(folder.get("category", ""), body_style),
                        Paragraph(f"{folder.get('files', 0):,}".replace(",", "."), right_cell_style),
                        Paragraph(format_size(folder.get("bytes", 0)), right_cell_style),
                        status_para,
                    ]
                )

        detail_col_w = [210, 100, 60, 90, 60]
        detail_table = Table(detail_rows, colWidths=detail_col_w)
        table_styles = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
            ("LINEBELOW", (0, 0), (-1, 0), 1, colors.HexColor("#cbd5e1")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]
        # Highlight project header rows
        row_idx = 1
        for p in projects:
            table_styles.append(("BACKGROUND", (0, row_idx), (-1, row_idx), colors.HexColor("#f8fafc")))
            table_styles.append(("LINEABOVE", (0, row_idx), (-1, row_idx), 0.5, colors.HexColor("#e2e8f0")))
            row_idx += 1 + len(p.get("folders", []))

        detail_table.setStyle(TableStyle(table_styles))
        story.append(KeepTogether(detail_table))

    story.append(Spacer(1, 20))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cbd5e1"), spaceAfter=8))
    footer_text = "Automatisch generiert mit Project Storage Helper &bull; Alle Angaben basieren auf der Analyse des Dateisystems."
    story.append(Paragraph(footer_text, ParagraphStyle("Footer", parent=body_style, fontSize=8, textColor=colors.HexColor("#94a3b8"))))

    doc.build(story)
    return str(path)
