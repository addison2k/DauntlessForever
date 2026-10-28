# Builds v2 - Dauntless Forever 0.3.18

Esta version agrega: vista de equipamiento de tres paneles, imagenes locales y sugerencias filtrables que respetan las piezas bloqueadas.

La figura central es una ILUSTRACION, no un modelo 3D del personaje.

## Sugerir
Seleccionar personaje, elegir filtros y pulsar Sugerir build. Use L/- en cada equipo o celula para fijar o liberar el espacio.
La recomendacion usa disponibilidad del inventario y coincidencias de nombres/elementos; NO representa la mejor build en dano ni calcula perks ni puntuaciones reales.
Las celulas son desconocidas para el lector actual y no se sugieren como poseidas. Marcar Permitir equipo faltante si se desean sugerencias no verificadas.

## Imagenes
Iconos en src/renderer/build-icons. El indice builds-icons.json une IDs de las dos versiones con iconos por coincidencia estricta de nombre. Al no existir coincidencia usa uno generico.
Los iconos vienen del ZIP del usuario dauntless-builder-master; VERIFICAR derechos y licencia antes de enviarlos al repositorio oficial o redistribuir.

## Seguridad
No se escribe en los datos de personaje. Las builds se guardan aparte y conservan las piezas fijadas. El ranking publico sigue pendiente de servidor.

## Probar
Dentro de DauntlessForever-main: npm.cmd install y npm.cmd start. En Windows, si Electron queda incompleto, reutilizar el procedimiento anterior del usuario para el ejecutable.

No se sugieren piezas de arma automaticamente hasta disponer de datos fiables de compatibilidad; estas pueden seleccionarse manualmente.
