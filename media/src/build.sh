#!/bin/zsh
# Reconstruit les visuels de la fiche Orca à partir des captures brutes de media/raw.
# Usage : zsh media/src/build.sh (depuis n'importe où).
set -e
src=${0:A:h}
media=${src:h}
raw=$media/raw
img=$src/img
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p $img

# Recadrages : on ne coupe que sur un séparateur de ligne, jamais au milieu d'une rangée.
# Couverture : agents + 5 messages (séparateur à y=1073), fondu de bas de panneau géré en CSS.
magick $raw/panel-dark.png -crop 605x1073+0+0 +repage -background '#171717' -gravity south -splice 0x10 -filter Lanczos -resize '438x784!' $img/cover-panel.png
# Sombre : agents + 4 messages (séparateur à y=962), 10 px de fond ajoutés en bas.
magick $raw/panel-dark.png -crop 605x962+0+0 +repage -background '#171717' -gravity south -splice 0x10 -filter Lanczos -resize '500x803!' $img/panel-dark.png
# Clair : même cadrage (séparateur à y=960).
magick $raw/panel-light.png -crop 605x960+0+0 +repage -background '#FAFAFA' -gravity south -splice 0x10 -filter Lanczos -resize '500x802!' $img/panel-light.png
# Bloc Instructions : la capture s'arrête 10 px sous la dernière rangée (ligne de bord à y=1838 exclue),
# on restitue le fond pour que la rangée Antigravity garde sa respiration.
magick $raw/panel-dark.png -crop 605x318+0+1520 +repage -background '#171717' -gravity south -splice 0x14 $img/instructions.png
cp $media/icon.png $img/icon.png

for page in cover screenshot-dark screenshot-light screenshot-install; do
  $chrome --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1600,1000 --default-background-color=00000000 \
    --screenshot=$media/$page.png file://$src/$page.html 2>/dev/null
done
file $media/cover.png $media/screenshot-*.png
