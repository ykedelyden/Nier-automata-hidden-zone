Objectif final
Visualiser la géométrie complète de la Tour dans Blender — y compris ce qui existe sous la zone jouable — pour repérer de la géométrie cachée, des kill volumes absents, ou des structures inconnues.

Plan en 4 phases
Phase 1 — Préparation (toi, ~30 min)
Installer Blender (gratuit, blender.org)
Repérer le dossier d'installation de NieR: Automata sur ton PC
Typiquement : C:\Program Files (x86)\Steam\steamapps\common\NieRAutomata\data
Me dire exactement ce que tu vois dans ce dossier
Phase 2 — Extraction des fichiers (moi + toi)
J'écris un script Python simple que tu exécutes
Il extrait les fichiers .dat / .dtt correspondant à la Tour
On identifie les bons fichiers de zone (la Tour a des codes spécifiques)
Phase 3 — Visualisation dans Blender (moi + toi)
On installe le plugin NieR2Blender2NieR
On importe la géométrie de la Tour
Tu regardes la scène sous tous les angles, notamment par en dessous
Phase 4 — Analyse des collisions
On charge les fichiers .col de la même zone
On compare : là où il y a de la géométrie sans collision = suspect
