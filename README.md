# DaxTeacher

Herramienta web para aprender DAX viendo lo que cada función hace por detrás. Se escribe una expresión y se reproduce, paso a paso como un video, cómo se transforman las tablas hasta llegar al resultado: qué filas se recorren, cuáles se conservan, cómo cambia el contexto de filtro y por qué relación viaja cada filtro.

## Qué incluye

- **Reproductor**: editor con autocompletado, menú de funciones con explicación, tablas del modelo de ejemplo y un reproductor de pasos con el contexto de filtro, el contexto de fila y las relaciones siempre visibles.
- **Contextos**: vista interactiva para entender el contexto de filtro (una matriz como la de Power BI), el contexto de fila y la transición de contexto.
- **Motor DAX propio** que corre en el navegador, sin backend, sobre un modelo de ejemplo con dos tablas de hechos (`Ventas`, `Devoluciones`) y dos dimensiones (`Productos`, `Calendario`).

## Funciones soportadas

`CALCULATE`, `CALCULATETABLE`, `FILTER`, `ALL`, `VALUES`, `DISTINCT`, `KEEPFILTERS`, `REMOVEFILTERS`, `ADDCOLUMNS`, `SELECTCOLUMNS`, `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `DISTINCTCOUNT`, `COUNTROWS`, `SUMX`, `AVERAGEX`, `MINX`, `MAXX`, `COUNTX`, `RELATED`, `RELATEDTABLE`, `USERELATIONSHIP`, `UNION`, `INTERSECT`, `EXCEPT`, `CROSSJOIN`, `TREATAS`, `IF`, `AND`, `OR`, `NOT`, `ISBLANK`, `DIVIDE`, `DATE`, `BLANK`, `TRUE`, `FALSE`.

## Simplificaciones respecto a DAX real

Es una herramienta didáctica, no un motor completo:

- Las relaciones son de muchos a uno y de una sola dirección; no hay `CROSSFILTER` ni relaciones bidireccionales.
- No se modelan las tablas expandidas ni la fila en blanco de las relaciones.
- No hay medidas, `VAR`/`RETURN` ni inteligencia de tiempo.

## Desarrollo

```bash
npm install
npm run dev     # servidor de desarrollo
npm test        # pruebas (vitest)
npm run build   # compilación de producción en dist/
```

Hecho con Vite, React y TypeScript.
