# Plan: View-abhängiger Gaussian-Splat-Optimierer (überprüft)

## Context

Ziel ist ein Editor, der Gaussian Splats importiert, von Artefakten bereinigt, abhängig von Betrachtungspunkt und Sichtrichtungen optimiert und web-fertig exportiert. Der erste Plan beruhte auf meinem Kenntnisstand. Die Überprüfung gegen den aktuellen Stand von SuperSplat (3.6, Oktober 2026) und `splat-transform` zeigt: Die Richtung (auf SuperSplat aufbauen) passt, aber drei Annahmen waren falsch und der Umfang verschiebt sich deutlich.

## Ergebnis der Überprüfung

| Annahme im ersten Plan | Befund | Folge |
|---|---|---|
| Core-Bibliothek aus SuperSplat extrahieren | SuperSplat 3.0 ist ein Neuaufbau; Laden und Speichern laufen bereits über `splat-transform` (MIT, Node + Browser, eigene API) | Keine eigene Core-Lib. `splat-transform` ist der Core und wird erweitert |
| Cleaning muss neu gebaut werden | `splat-transform` hat bereits `--filter-nan`, `--filter-floaters`, `--filter-cluster`, `--filter-value`, Box/Kugel | Cleaning ist überwiegend UI-Integration, nicht Algorithmik |
| Pruning/Vereinfachung muss neu gebaut werden | `--decimate` und `--decimate-adaptive` existieren, skalieren auf 100M+ Splats, sind aber nicht view-abhängig | Neu ist nur die View-Gewichtung, nicht die Vereinfachung selbst |
| WebGPU mit CPU-Fallback | SuperSplat 3.x ist WebGPU-only; Floater-/Cluster-Filter brauchen GPU | Kein Fallback. WebGPU-Browser ist Voraussetzung |
| SH-Reduktion pro Gaussian spart am meisten | Formate speichern die SH-Bandzahl pro Datei; SOG komprimiert SH über eine Palette | Pro-Gaussian-Reduktion bringt wenig. Realistisch ist eine globale Bandreduktion (`--filter-harmonics`), gewählt anhand des Sichtkegels |
| Formate "evtl." | Import: PLY, compressed PLY, SOG, Streamed SOG, SPZ, LCC/LCC2, KSPLAT, SPLAT, GLB (`KHR_gaussian_splatting`). Export: dieselben plus HTML-Viewer und Streamed-LOD | Import und Web-Export sind erledigt |

Bestätigt: MIT-Lizenz für beide Repos, TypeScript, PlayCanvas/PCUI. Kameraposen (`src/camera-poses.ts`), Undo (`src/edit-history.ts`, `src/edit-ops.ts`) und Selektion (`src/selection.ts`, `src/select-op.ts`) sind im Editor vorhanden.

Nicht geprüft: ob die SuperSplat-Oberfläche Floater-Filter und Decimation schon anbietet (die Release-Notes waren nicht erreichbar). Das klärt Schritt 1.

## Angepasster Ansatz

Der eigentliche Mehrwert schrumpft auf einen Kern: **ein View-Score pro Gaussian**, der die vorhandenen Werkzeuge steuert.

1. **Bestandsaufnahme (2–3 Tage).** Beide Repos klonen, bauen, prüfen: Welche `splat-transform`-Aktionen sind im Editor schon bedienbar? Wie werden Aktionen im Editor eingebunden (`src/data-processor/`, `src/io/`)? Ergebnis entscheidet, wie viel von Schritt 2 entfällt.
2. **Cleaning-Panel (ca. 1 Woche).** Vorhandene Filter als Vorschau-Selektion in den Editor bringen (markieren, bestätigen, Undo). Ergänzen nur, was fehlt: Nadel-Gaussians (Seitenverhältnis) und übergroße halbtransparente Blobs über `--filter-value`-artige Schwellen.
3. **Viewpoint-Definition (ca. 1 Woche).** Aufbauend auf `src/camera-poses.ts`: Betrachtungsvolumen plus Sichtkegel oder Kamerapfad, daraus gesampelte Kameras.
4. **View-Score (2–3 Wochen, Kernarbeit).** WebGPU-Pass, der pro Gaussian den Beitrag (Alpha × Transmittanz × Pixelfläche) über alle Kameras akkumuliert. Als neue Spalte in der Datentabelle ablegen, damit Histogramm und Filter des Editors sie direkt nutzen können.
5. **Score-gesteuerte Reduktion (1–2 Wochen).** Nie sichtbare Gaussians entfernen; Rest über den Score gewichtet an die vorhandene Decimation übergeben, mit Zielbudget (Anzahl oder MB). SH-Bandzahl global aus dem Sichtkegel vorschlagen.
6. **Qualitätskontrolle (ca. 1 Woche).** Vorher/Nachher aus den gesampelten Kameras, PSNR/SSIM. Der Bild-Renderer von `splat-transform` kann dafür headless genutzt werden.
7. **Export-Preset.** HTML-Viewer bzw. Streamed SOG mit auf den Sichtbereich begrenzter Kamera.
7. (Fortsetzung) Zwei gleichwertige Ausgabeziele: **SOG** (inkl. Streamed-LOD und HTML-Viewer, für PlayCanvas) und **SPZ** (für Spark/Three.js und glTF-Pipelines). Beide schreibt `splat-transform` bereits; Streamed-LOD gibt es nur für SOG. Export-Dialog zeigt Größe je Format.
8. **Optional: Fine-Tuning per Selbst-Distillation.** Originalbilder sind kaum vorhanden und werden nicht vorausgesetzt. Stattdessen dient der unveränderte Splat als Referenz: aus den definierten Kameras gerenderte Bilder sind die Zielbilder, gegen die der reduzierte Splat nachoptimiert wird. Braucht einen differenzierbaren Rasterizer (Python-Backend mit gsplat, CUDA-GPU).

Gesamt ohne Schritt 8: etwa 7–9 Wochen statt 8–11, mit deutlich weniger Risiko in den ersten Schritten.

## Risiken

- **Upstream-Tempo.** SuperSplat ging in sechs Wochen von 3.0 auf 3.6. Ein tiefer Fork veraltet schnell. Deshalb neue Logik möglichst als eigene Module und in `splat-transform` halten, den Editor nur dünn anfassen.
- **Decimation-Einschränkung.** `--decimate` muss die letzte Aktion sein und schreibt PLY; der Web-Export ist dann ein zweiter Durchlauf.
- **Qualität ohne Nachtraining.** Unverändert: starke Reduktion erzeugt Löcher; die vorhandene adaptive Decimation dürfte hier besser sein als reines Wegwerfen.
- **Überschneidung mit Upstream.** PlayCanvas könnte view-abhängige Optimierung selbst liefern. Ein Upstream-Beitrag ist eine Alternative zum Fork.

## Entschieden

- **Trainingsbilder:** kaum vorhanden, also kein Bestandteil des Plans. Sie würden nur zwei Dinge bringen: Artefakte des Originals korrigieren (statt nur entfernen) und Fine-Tuning gegen echte Fotos. Das Zweite ersetzt die Selbst-Distillation in Schritt 8 weitgehend; das Erste ist ohne Bilder nicht möglich und bleibt Aufgabe des Cleanings.
- **Formate:** SOG und SPZ als Exportziele.

## Offener Punkt

- Schritt 8 erst nach Schritt 6 entscheiden: Wenn die Qualitätsmessung zeigt, dass die gewünschte Reduktion ohne Nachoptimierung erreichbar ist, entfällt das Backend.

## Verifikation

- Schritt 1: `npm install` und Dev-Build beider Repos laufen; Liste der im Editor verfügbaren Aktionen dokumentiert.
- Schritt 4: Testszene mit bekannter Verdeckung (Objekt hinter Wand) – verdeckte Gaussians erhalten Score 0.
- Schritt 5/6: Referenzszene vor und nach der Optimierung aus den definierten Kameras rendern, PSNR/SSIM und Dateigröße vergleichen; Ziel z. B. 50 % weniger Splats bei über 35 dB PSNR innerhalb des Sichtbereichs.
- Export: erzeugten HTML-Viewer im Browser laden, Kamerabegrenzung und Ladezeit prüfen.

## Quellen

- https://github.com/playcanvas/supersplat
- https://github.com/playcanvas/splat-transform
- https://radiancefields.com/playcanvas-releases-supersplat-3.0
- https://radiancefields.com/supersplat-3.6-straightens-splats-from-a-vertical-edge
