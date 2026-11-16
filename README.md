# Gaussian-Splat-Optimierer – Projektstand

Stand: 2026-11-16, zweite Fassung. Der View-Score ist kein Prototyp mehr, sondern ein nutzbarer Filter in `splat-transform`: Er entfernt Gaussians, die zu einer Menge von Blickpunkten zu wenig beitragen, und ist über die Kommandozeile und als Bibliotheksfunktion aufrufbar.

## Inhalt

- `PLAN.md` – der überprüfte Projektplan.
- `splat-transform/` – Quellcode von playcanvas/splat-transform 3.11.2 mit allen Änderungen (ohne `node_modules`, ohne Upstream-Historie). MIT-Lizenz von PlayCanvas, siehe `splat-transform/LICENSE`.
- `patches/` – dieselben Änderungen als drei Git-Patches gegen Upstream-Commit `6f642939dd5d5db3094bf749d5821ce84e3938da`.
- `tools/bench.mjs` – Laufzeitvergleich Score gegen normales Rendern.
- `tools/real-scene/` – Skripte für den Praxistest: Kamerapfade erzeugen, filtern, rendern, PSNR messen, Vergleichsbilder bauen.
- `ergebnisse/` – zwei Vergleichsbilder aus dem Praxistest (nur im Zip, nicht im Repository, weil die Lizenz der gerenderten Beispielszene ungeklärt ist).

Nicht enthalten: SuperSplat (unverändert; untersucht wurde 3.8.1, Commit `f29e2b4a34ecee6e4e4886630d653324c5b07add`) und die Testszenen (siehe unten, öffentlich abrufbar).

## Benutzung

    # Alles entfernen, was ein Kamerapfad nie sieht (die Ansichten des Pfads bleiben unverändert)
    splat-transform --camera-track document.json input.ply --filter-view-score output.sog

    # Zusätzlich alles entfernen, was im besten Blick höchstens 0,25 Pixel malt
    splat-transform --camera-track views.json --resolution 1280x720 input.ply --filter-view-score 0.25 output.spz

    # Ein einzelner fester Blickpunkt
    splat-transform --camera-pos 0,1.6,4 --camera-target 0,1.6,0 input.ply --filter-view-score output.sog

Der Kamerapfad ist die `document.json` eines SuperSplat-Projekts, eine `settings.json` des Viewers oder eine einfache Liste: `{ "frames": [{ "position": [x, y, z], "target": [x, y, z], "fov": 60 }] }`. Im Editor gesetzte Kameraposen lassen sich so direkt verwenden.

Als Bibliothek: `computeViewScores(device, source, pool, cameras, options)` liefert die Scores, die Aktion `{ kind: 'filterViewScore', cameras, minPixels }` filtert in `processSourceBridged` und `processDataTable`.

## Was der Score misst

Pro Gaussian die Pixel, die er effektiv malt: die Summe seiner Blending-Gewichte (Transmittanz × Alpha) über das Bild. Geliefert werden die Summe über alle Ansichten und der beste Einzelblick; gefiltert wird nach dem besten Einzelblick. Verdeckte, hinter der Kamera liegende, außerhalb des Sichtfelds liegende und zu schwache Gaussians erhalten 0.

Die Scores sind in Pixeln des Bewertungsbilds angegeben. Eine Schwelle über 0 hängt deshalb von `--resolution` und vom Kameraabstand ab: Bewertet wird am besten in der Größe und Entfernung, in der die Szene später gezeigt wird.

## Praxistest an echten Szenen

Zwei öffentliche Beispielszenen aus dem PlayCanvas-Engine-Repository (`examples/assets/splats/biker.compressed.ply` und `guitar.compressed.ply`). Bewertet aus 13 Kameras auf einem 120°-Bogen ("Bogen") bzw. 12 Kameras rundum ("Orbit"), 640 × 360. Gemessen wurde die Bildqualität (PSNR gegen das Original) aus sechs Kameras, die im Bogen zwischen den bewerteten liegen, und aus einer Kamera auf der Gegenseite.

| Szene | Ansichten | Schwelle | Gaussians | Ersparnis | PSNR im Bogen | PSNR Gegenseite |
|---|---|---|---|---|---|---|
| Biker (152 746) | Bogen | 0 | 142 261 | 6,9 % | 67,6–68,8 dB | 42,8 dB |
| Biker | Bogen | 0,25 | 35 380 | 76,8 % | 35,6–38,9 dB | 28,6 dB |
| Biker | Bogen | 1 | 8 630 | 94,3 % | 28,3–29,0 dB | 27,7 dB |
| Biker | Orbit | 0 | 152 117 | 0,4 % | 68,0–69,2 dB | 70,1 dB |
| Gitarre (90 854) | Bogen | 0 | 87 868 | 3,3 % | 67,3–71,1 dB | 69,5 dB |
| Gitarre | Bogen | 0,25 | 23 356 | 74,3 % | 35,8–52,0 dB | 37,6 dB |
| Gitarre | Bogen | 1 | 6 892 | 92,4 % | 26,6–38,7 dB | 31,5 dB |
| Gitarre | Orbit | 0 | 88 882 | 2,2 % | 67,1–71,2 dB | 73,4 dB |

Was die Zahlen zeigen:

- **Schwelle 0 ist verlustfrei, bringt bei Objekt-Scans aber wenig** (0,4 bis 7 %). Solche Aufnahmen enthalten kaum Gaussians, die aus keiner Richtung sichtbar sind. In Innenräumen und großen Szenen mit festem Standpunkt ist mehr zu erwarten; das ist nicht gemessen. Die rund 68 dB statt "identisch" kommen vermutlich vom erneuten Quantisieren beim Schreiben; der Bibliothekstest ohne Neukodierung liefert ein bytegleiches Bild.
- **Schwelle 0,25 spart rund drei Viertel** bei 36 bis 39 dB im Sichtbereich. Auf dem Vergleichsbild `ergebnisse/biker-im-sichtbereich.webp` (Original, Schwelle 0, 0,25, 1) ist das bei dieser Größe kaum vom Original zu unterscheiden.
- **Schwelle 1 ist zu aggressiv**: sichtbare Löcher und Farbfehler.
- **Außerhalb des bewerteten Bereichs bricht die Szene zusammen**, sobald die Schwelle über 0 liegt (`ergebnisse/biker-gegenseite.webp`). Die Kamera des Viewers muss also auf den bewerteten Bereich begrenzt werden.

Export in die Web-Formate, Biker mit Schwelle 0,25: SOG 1,86 MB → 0,46 MB, SPZ 2,24 MB → 0,55 MB. Beide Dateien lesen sich mit 35 380 Gaussians zurück.

## Geänderte und neue Dateien in splat-transform

- `src/lib/gpu/shaders/rasterize-binned.ts` – zählende Shader-Variante mit 64-Bit-Zählern
- `src/lib/gpu/shaders/score-resolve.ts` – neu, überträgt die Zähler auf Zeilenindizes
- `src/lib/gpu/gpu-scene-rasterizer.ts` – `score`, `scoreStreamed`, `readScores`
- `src/lib/render/scene-renderer.ts` – `accumulateScores`, `readScores`
- `src/lib/render/view-score.ts` – neu, `computeViewScores` und `viewScoreRows`
- `src/lib/process.ts`, `src/lib/process-source.ts` – Aktion `filterViewScore`
- `src/cli/index.ts` – Option `--filter-view-score`
- `test/view-score.test.mjs` (neu, 12 Tests), `test/cli.test.mjs` (4 neue Tests)
- `README.md`, `AGENTS.md` – Dokumentation

## Seit der ersten Fassung behoben

- **Kein nutzbarer Filter:** Aktion und CLI-Option ergänzt.
- **Nur Szenen, die auf die GPU passen:** Die Streaming-Pfade des Renderers sind angebunden; große Szenen werden pro Ansicht aus der Quelle gestreamt und auf der CPU summiert. Das ist korrekt (Test gegen den GPU-Pfad), aber langsam.
- **Genauigkeit hing von der Bildgröße ab:** Die Zähler waren 32 Bit mit einer von der Bildgröße abhängigen Skalierung, wodurch bei großen Bildern schwache Beiträge verloren gingen. Jetzt 64 Bit mit fester Skalierung.
- **Nicht an echten Szenen erprobt:** siehe Praxistest.
- **Fest verdrahtete Pfade in den Hilfsskripten:** jetzt über `SPLAT_TRANSFORM` und `SAMPLE_DATA` einstellbar.

## Bauen und testen

    cd splat-transform
    npm ci
    npm run build
    node --import tsx --test --test-force-exit test/view-score.test.mjs

Voraussetzung: Node 22 und ein WebGPU-fähiges System (unter Linux ein Vulkan-Treiber). Ohne GPU werden die GPU-Tests übersprungen.

Patches statt des Quellbaums verwenden:

    git clone https://github.com/playcanvas/splat-transform.git
    cd splat-transform
    git checkout 6f642939dd5d5db3094bf749d5821ce84e3938da
    git am ../patches/*.patch

Praxistest wiederholen (Szenen vorher von raw.githubusercontent.com/playcanvas/engine/main/examples/assets/splats/ laden):

    cd tools/real-scene
    node mk-tracks.mjs
    SPLAT_TRANSFORM=/pfad/zu/splat-transform SAMPLE_DATA=/pfad/zu/szenen node run.mjs biker guitar

## Testergebnisse

Gemessen in einem Container ohne GPU, mit dem Software-Treiber SwiftShader:

- Neue Tests: 16 von 16 bestanden (12 in `view-score.test.mjs`, 4 in `cli.test.mjs`).
- Gesamte Suite: 974 von 981 bestanden, 1 übersprungen, 6 nicht bestanden. Alle sechs sind unveränderte Upstream-Tests:
  - 3 × "Render goldens": bytegenauer Vergleich mit Referenzbildern einer echten GPU. Es weichen 2 bis 166 von bis zu 921 600 Farbwerten ab, jeweils um eine Stufe.
  - 2 × "GpuRecost refresh parity": Toleranz von 0,001 knapp verfehlt (2002 von 2048 Werten innerhalb bzw. 0,00103 statt 0,001).
  - 1 × "decimateSourceAdaptive multi-block": Zeitlimit von 120 s überschritten.
  Die ersten fünf treten identisch auf dem unveränderten Upstream-Code auf. Der Zeitlimit-Test besteht einzeln ausgeführt in rund 75 s, auf Upstream wie mit den Änderungen; er scheitert nur unter der Last des Gesamtlaufs.
- SuperSplat 3.8.1: Build und die 56 eigenen Tests laufen durch.
- Laufzeit: Der Score kostet rund 3 % mehr als normales Rendern (300 000 Gaussians, 640 × 360). Der Praxistest brauchte 20 bis 27 s pro Szene für 12 bis 13 Ansichten; diese absoluten Zeiten gelten nur für den Software-Treiber.

## Offene Punkte

- **Löschen statt Zusammenführen:** Eine Schwelle über 0 entfernt Details. Der Plan sieht vor, den Score stattdessen als Gewicht an die vorhandene Decimation zu geben (Schritt 5); das ist nicht umgesetzt.
- **Blickbereich statt Einzelkameras:** Es gibt noch kein Sampling aus einem Betrachtungsvolumen mit Sichtkegel (Schritt 3). Die Kameras müssen als Pfad oder Liste vorliegen.
- **Editor:** In SuperSplat ist nichts eingebaut (Schritte 2 und 3: Cleaning-Panel, Viewpoint-Definition).
- **Nur einfache Objekt-Scans getestet:** keine Innenräume, keine Szenen mit Spherical Harmonics, keine sehr großen Szenen.
- **Kein Upstream-Beitrag:** Der Stand liegt im Repository `Kame-dev/gs-optimizer`. Für einen Pull Request an PlayCanvas sind die Patches in `patches/` die Grundlage; sie gelten gegen den oben genannten Upstream-Commit.
