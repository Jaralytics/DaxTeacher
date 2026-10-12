export type FunctionReturns = 'tabla' | 'escalar' | 'modificador'

export interface FunctionParam {
  name: string
  description: string
}

export interface FunctionDoc {
  name: string
  /** Agrupa la funcion en el menu lateral. */
  category: string
  syntax: string
  parameters: FunctionParam[]
  returns: FunctionReturns
  /** Una frase sobre lo que devuelve. */
  returnsDescription: string
  /** Que hace por dentro: contextos que lee, crea o cambia. */
  description: string
  /** Formula de ejemplo sobre la tabla Ventas que el motor puede ejecutar. */
  example: string
  /** Texto que se inserta en el editor; termina en el parentesis de apertura. */
  snippet: string
}

function fn(
  name: string,
  category: string,
  syntax: string,
  parameters: FunctionParam[],
  returns: FunctionReturns,
  returnsDescription: string,
  description: string,
  example: string,
): FunctionDoc {
  return { name, category, syntax, parameters, returns, returnsDescription, description, example, snippet: `${name}(` }
}

const p = (name: string, description: string): FunctionParam => ({ name, description })

export const functionCatalog: FunctionDoc[] = [
  // ---------- Lógicas ----------
  fn(
    'IF',
    'Lógicas',
    'IF(<condición>, <si_verdadero>[, <si_falso>])',
    [
      p('condición', 'Expresión que da VERDADERO o FALSO.'),
      p('si_verdadero', 'Valor que se devuelve cuando la condición es verdadera.'),
      p('si_falso', 'Opcional. Valor cuando es falsa; si se omite se devuelve BLANK.'),
    ],
    'escalar',
    'Un único valor: el de la rama elegida.',
    'Evalúa la condición en el contexto actual (el de fila si está dentro de un iterador o FILTER) y evalúa solo la rama que corresponde. No crea ni cambia ningún contexto.',
    'SUMX(Ventas, IF(Ventas[Cantidad] >= 5, Ventas[Precio], 0))',
  ),
  fn(
    'AND',
    'Lógicas',
    'AND(<lógico1>, <lógico2>)',
    [p('lógico1', 'Primera condición.'), p('lógico2', 'Segunda condición.')],
    'escalar',
    'VERDADERO solo si las dos condiciones son verdaderas.',
    'Evalúa ambas condiciones con el contexto de fila actual y las combina. Equivale al operador &&; no cambia ningún contexto.',
    'FILTER(Ventas, AND(Ventas[Cantidad] = 5, Ventas[Producto] = "Aceite"))',
  ),
  fn(
    'OR',
    'Lógicas',
    'OR(<lógico1>, <lógico2>)',
    [p('lógico1', 'Primera condición.'), p('lógico2', 'Segunda condición.')],
    'escalar',
    'VERDADERO si al menos una condición es verdadera.',
    'Evalúa ambas condiciones con el contexto de fila actual y devuelve VERDADERO si alguna se cumple. Equivale al operador ||; no cambia ningún contexto.',
    'FILTER(Ventas, OR(Ventas[Producto] = "Aceite", Ventas[Producto] = "Leche"))',
  ),
  fn(
    'NOT',
    'Lógicas',
    'NOT(<lógico>)',
    [p('lógico', 'Condición que se quiere invertir.')],
    'escalar',
    'VERDADERO si la condición es falsa y viceversa.',
    'Evalúa la condición en el contexto de fila actual y niega su resultado. No cambia ningún contexto.',
    'FILTER(Ventas, NOT(Ventas[Ciudad] = "Bogota"))',
  ),
  fn(
    'ISBLANK',
    'Lógicas',
    'ISBLANK(<valor>)',
    [p('valor', 'Expresión o columna que se quiere comprobar.')],
    'escalar',
    'VERDADERO si el valor es BLANK.',
    'Evalúa el valor en el contexto actual y comprueba si es BLANK. Cero y texto vacío no son BLANK. No cambia ningún contexto.',
    'ISBLANK(CALCULATE(SUM(Ventas[Cantidad]), Ventas[Producto] = "Pan"))',
  ),
  fn(
    'DIVIDE',
    'Lógicas',
    'DIVIDE(<numerador>, <denominador>[, <alternativo>])',
    [
      p('numerador', 'Valor que se divide.'),
      p('denominador', 'Valor por el que se divide.'),
      p('alternativo', 'Opcional. Resultado cuando el denominador es 0; por defecto BLANK.'),
    ],
    'escalar',
    'El cociente, o el valor alternativo si el denominador es 0.',
    'Evalúa numerador y denominador en el contexto actual y divide. A diferencia del operador /, una división entre cero no produce error sino BLANK (o el valor alternativo).',
    'DIVIDE(SUM(Ventas[Cantidad]), COUNTROWS(Ventas))',
  ),
  fn(
    'BLANK',
    'Lógicas',
    'BLANK()',
    [],
    'escalar',
    'Un valor BLANK.',
    'Devuelve el valor vacío de DAX, distinto de cero y de texto vacío. Se usa para indicar ausencia de valor, por ejemplo en una rama de IF.',
    'IF(SUM(Ventas[Cantidad]) > 100, SUM(Ventas[Cantidad]), BLANK())',
  ),
  fn(
    'TRUE',
    'Lógicas',
    'TRUE()',
    [],
    'escalar',
    'El valor lógico VERDADERO.',
    'Devuelve la constante VERDADERO. No lee ni cambia ningún contexto.',
    'IF(TRUE(), 1, 0)',
  ),
  fn(
    'FALSE',
    'Lógicas',
    'FALSE()',
    [],
    'escalar',
    'El valor lógico FALSO.',
    'Devuelve la constante FALSO. No lee ni cambia ningún contexto.',
    'IF(FALSE(), 1, 0)',
  ),

  // ---------- Agregación ----------
  fn(
    'SUM',
    'Agregación',
    'SUM(<columna>)',
    [p('columna', 'Columna numérica que se suma.')],
    'escalar',
    'La suma de la columna sobre las filas visibles.',
    'Lee el contexto de filtro actual, toma las filas de la tabla que siguen visibles y suma los valores de la columna. Si el filtro viene de otra tabla relacionada, ya llegó a esta por la relación activa. No crea contexto de fila: es la forma abreviada de SUMX sobre esa columna.',
    'SUM(Ventas[Cantidad])',
  ),
  fn(
    'AVERAGE',
    'Agregación',
    'AVERAGE(<columna>)',
    [p('columna', 'Columna numérica.')],
    'escalar',
    'El promedio de la columna sobre las filas visibles.',
    'Lee el contexto de filtro actual y promedia los valores de la columna en las filas visibles, ignorando los BLANK.',
    'AVERAGE(Ventas[Precio])',
  ),
  fn(
    'MIN',
    'Agregación',
    'MIN(<columna>)',
    [p('columna', 'Columna numérica.')],
    'escalar',
    'El valor más pequeño de la columna entre las filas visibles.',
    'Lee el contexto de filtro actual y devuelve el mínimo de la columna considerando solo las filas visibles.',
    'MIN(Ventas[Precio])',
  ),
  fn(
    'MAX',
    'Agregación',
    'MAX(<columna>)',
    [p('columna', 'Columna numérica.')],
    'escalar',
    'El valor más grande de la columna entre las filas visibles.',
    'Lee el contexto de filtro actual y devuelve el máximo de la columna considerando solo las filas visibles.',
    'MAX(Ventas[Precio])',
  ),
  fn(
    'COUNT',
    'Agregación',
    'COUNT(<columna>)',
    [p('columna', 'Columna cuyos valores no vacíos se cuentan.')],
    'escalar',
    'La cantidad de valores no BLANK de la columna en las filas visibles.',
    'Lee el contexto de filtro actual y cuenta, entre las filas visibles, las que tienen valor en la columna. Los BLANK no cuentan.',
    'COUNT(Ventas[Cantidad])',
  ),
  fn(
    'DISTINCTCOUNT',
    'Agregación',
    'DISTINCTCOUNT(<columna>)',
    [p('columna', 'Columna cuyos valores distintos se cuentan.')],
    'escalar',
    'La cantidad de valores distintos de la columna en las filas visibles.',
    'Lee el contexto de filtro actual, toma los valores de la columna en las filas visibles y cuenta cuántos son distintos.',
    'DISTINCTCOUNT(Ventas[Producto])',
  ),
  fn(
    'COUNTROWS',
    'Agregación',
    'COUNTROWS(<tabla>)',
    [p('tabla', 'Tabla o expresión de tabla cuyas filas se cuentan.')],
    'escalar',
    'El número de filas de la tabla.',
    'Evalúa la expresión de tabla en el contexto de filtro actual y cuenta sus filas. Con una tabla de modelo cuenta solo las filas visibles; con FILTER cuenta las que pasan la condición.',
    'COUNTROWS(FILTER(Ventas, Ventas[Ciudad] = "Bogota"))',
  ),

  // ---------- Iteradores ----------
  fn(
    'SUMX',
    'Iteradores',
    'SUMX(<tabla>, <expresión>)',
    [
      p('tabla', 'Tabla que se recorre fila por fila.'),
      p('expresión', 'Se evalúa en cada fila; los resultados se suman.'),
    ],
    'escalar',
    'La suma de la expresión evaluada en cada fila.',
    'Obtiene las filas visibles de la tabla según el contexto de filtro y crea un contexto de fila por cada una. Evalúa la expresión en ese contexto y suma los resultados.',
    'SUMX(Ventas, Ventas[Cantidad] * Ventas[Precio])',
  ),
  fn(
    'AVERAGEX',
    'Iteradores',
    'AVERAGEX(<tabla>, <expresión>)',
    [p('tabla', 'Tabla que se recorre.'), p('expresión', 'Se evalúa en cada fila; se promedian los resultados.')],
    'escalar',
    'El promedio de la expresión evaluada en cada fila.',
    'Crea un contexto de fila por cada fila visible de la tabla, evalúa la expresión en cada una y promedia los resultados que no son BLANK.',
    'AVERAGEX(Ventas, Ventas[Cantidad] * Ventas[Precio])',
  ),
  fn(
    'MINX',
    'Iteradores',
    'MINX(<tabla>, <expresión>)',
    [p('tabla', 'Tabla que se recorre.'), p('expresión', 'Se evalúa en cada fila; se toma el menor resultado.')],
    'escalar',
    'El menor valor de la expresión entre todas las filas.',
    'Crea un contexto de fila por cada fila visible de la tabla, evalúa la expresión en cada una y devuelve el mínimo.',
    'MINX(Ventas, Ventas[Cantidad] * Ventas[Precio])',
  ),
  fn(
    'MAXX',
    'Iteradores',
    'MAXX(<tabla>, <expresión>)',
    [p('tabla', 'Tabla que se recorre.'), p('expresión', 'Se evalúa en cada fila; se toma el mayor resultado.')],
    'escalar',
    'El mayor valor de la expresión entre todas las filas.',
    'Crea un contexto de fila por cada fila visible de la tabla, evalúa la expresión en cada una y devuelve el máximo.',
    'MAXX(Ventas, Ventas[Cantidad] * Ventas[Precio])',
  ),
  fn(
    'COUNTX',
    'Iteradores',
    'COUNTX(<tabla>, <expresión>)',
    [p('tabla', 'Tabla que se recorre.'), p('expresión', 'Se evalúa en cada fila; se cuentan los resultados no BLANK.')],
    'escalar',
    'La cantidad de filas donde la expresión no es BLANK.',
    'Crea un contexto de fila por cada fila visible de la tabla, evalúa la expresión y cuenta los resultados que no son BLANK.',
    'COUNTX(Ventas, Ventas[Precio])',
  ),

  // ---------- Filtro ----------
  fn(
    'CALCULATE',
    'Filtro',
    'CALCULATE(<expresión>[, <filtro>, ...])',
    [
      p('expresión', 'Expresión escalar que se evalúa en el contexto modificado.'),
      p('filtro', 'Predicado, tabla de filtro o modificador (ALL, REMOVEFILTERS, KEEPFILTERS).'),
    ],
    'escalar',
    'El valor de la expresión calculado con el contexto de filtro modificado.',
    'Convierte cada argumento de filtro en un filtro y lo aplica sobre una copia del contexto de filtro: reemplaza el que existía sobre las mismas columnas, salvo con KEEPFILTERS, y ALL lo quita. Los filtros sobre una tabla se propagan por las relaciones activas hacia las tablas relacionadas (del lado uno al lado muchos). Después evalúa la expresión en ese nuevo contexto.',
    'CALCULATE(SUM(Ventas[Cantidad]), Ventas[Producto] = "Aceite")',
  ),
  fn(
    'CALCULATETABLE',
    'Filtro',
    'CALCULATETABLE(<tabla>[, <filtro>, ...])',
    [
      p('tabla', 'Expresión de tabla que se evalúa en el contexto modificado.'),
      p('filtro', 'Predicado, tabla de filtro o modificador.'),
    ],
    'tabla',
    'La tabla evaluada con el contexto de filtro modificado.',
    'Funciona como CALCULATE pero devuelve una tabla: transforma los argumentos de filtro en filtros, modifica una copia del contexto de filtro y evalúa la expresión de tabla dentro de él. Los filtros se propagan por las relaciones activas a las tablas relacionadas.',
    'CALCULATETABLE(Ventas, Ventas[Cantidad] = 5 && Ventas[Producto] = "Aceite")',
  ),
  fn(
    'FILTER',
    'Filtro',
    'FILTER(<tabla>, <condición>)',
    [
      p('tabla', 'Tabla o expresión de tabla que se recorre.'),
      p('condición', 'Expresión VERDADERO o FALSO evaluada en cada fila.'),
    ],
    'tabla',
    'Las filas de la tabla que cumplen la condición.',
    'Es un iterador: obtiene la tabla en el contexto de filtro actual y crea un contexto de fila por cada fila. Evalúa la condición en ese contexto y conserva las filas donde da VERDADERO. No modifica el contexto de filtro.',
    'FILTER(Ventas, Ventas[Cantidad] = 5)',
  ),
  fn(
    'ALL',
    'Filtro',
    'ALL(<tabla> | <columna>[, <columna>, ...])',
    [p('tabla o columna', 'Tabla o columnas cuyos filtros se ignoran.')],
    'tabla',
    'Todas las filas o valores, sin importar el contexto de filtro.',
    'Devuelve la tabla o las columnas completas ignorando el contexto de filtro actual. Dentro de CALCULATE actúa como modificador y quita los filtros existentes sobre esas columnas, y con ello también el efecto que esos filtros tenían sobre tablas relacionadas.',
    'ALL(Ventas[Producto], Ventas[Categoria])',
  ),
  fn(
    'REMOVEFILTERS',
    'Filtro',
    'REMOVEFILTERS(<tabla> | <columna>[, <columna>, ...])',
    [p('tabla o columna', 'Tabla o columnas cuyos filtros se quitan.')],
    'modificador',
    'No devuelve datos: indica a CALCULATE qué filtros quitar.',
    'Solo se puede usar como argumento de filtro de CALCULATE o CALCULATETABLE. Al modificar el contexto de filtro elimina los filtros existentes sobre las columnas indicadas, y después se evalúa la expresión.',
    'CALCULATE(SUM(Ventas[Cantidad]), REMOVEFILTERS(Ventas[Producto]))',
  ),
  fn(
    'KEEPFILTERS',
    'Filtro',
    'KEEPFILTERS(<filtro>)',
    [p('filtro', 'Predicado o tabla de filtro que se agrega sin reemplazar.')],
    'modificador',
    'No devuelve datos: cambia cómo CALCULATE combina el filtro.',
    'Solo se puede usar como argumento de filtro de CALCULATE o CALCULATETABLE. En lugar de reemplazar el filtro existente sobre las mismas columnas, lo conserva y agrega el nuevo: una fila debe cumplir ambos (intersección).',
    'CALCULATE(SUM(Ventas[Cantidad]), KEEPFILTERS(Ventas[Producto] = "Aceite"))',
  ),

  // ---------- Tabla ----------
  fn(
    'VALUES',
    'Tabla',
    'VALUES(<columna>)',
    [p('columna', 'Columna de la que se obtienen los valores únicos.')],
    'tabla',
    'Una tabla de una columna con los valores distintos visibles.',
    'Lee el contexto de filtro actual y devuelve los valores distintos de la columna en las filas visibles. También refleja los filtros que llegan de tablas relacionadas por una relación activa. Es la forma habitual de iterar sobre los grupos de una columna.',
    'VALUES(Ventas[Producto])',
  ),
  fn(
    'DISTINCT',
    'Tabla',
    'DISTINCT(<columna>)',
    [p('columna', 'Columna de la que se obtienen los valores únicos.')],
    'tabla',
    'Una tabla de una columna con los valores distintos visibles.',
    'Lee el contexto de filtro actual y devuelve los valores distintos de la columna en las filas visibles. Se comporta como VALUES en este modelo, respetando también los filtros que llegan por relaciones.',
    'DISTINCT(Ventas[Ciudad])',
  ),
  fn(
    'ADDCOLUMNS',
    'Tabla',
    'ADDCOLUMNS(<tabla>, "<nombre>", <expresión>[, ...])',
    [
      p('tabla', 'Tabla base.'),
      p('nombre', 'Texto con el nombre de la columna nueva.'),
      p('expresión', 'Se evalúa en cada fila para llenar la columna nueva.'),
    ],
    'tabla',
    'La tabla original con columnas calculadas adicionales.',
    'Recorre la tabla creando un contexto de fila por cada fila y evalúa cada expresión en él. Si la expresión usa CALCULATE, el contexto de fila se convierte en filtro (transición de contexto).',
    'ADDCOLUMNS(FILTER(Ventas, Ventas[Cantidad] >= 5), "Importe", Ventas[Cantidad] * Ventas[Precio])',
  ),
  fn(
    'SELECTCOLUMNS',
    'Tabla',
    'SELECTCOLUMNS(<tabla>, "<nombre>", <expresión>[, ...])',
    [
      p('tabla', 'Tabla de origen.'),
      p('nombre', 'Texto con el nombre de cada columna del resultado.'),
      p('expresión', 'Se evalúa en cada fila para llenar la columna.'),
    ],
    'tabla',
    'Una tabla nueva que solo contiene las columnas indicadas.',
    'Recorre la tabla creando un contexto de fila por cada fila y evalúa las expresiones en él. A diferencia de ADDCOLUMNS, descarta las columnas originales.',
    'SELECTCOLUMNS(Ventas, "Producto", Ventas[Producto], "Importe", Ventas[Cantidad] * Ventas[Precio])',
  ),

  // ---------- Relaciones ----------
  fn(
    'RELATED',
    'Relaciones',
    'RELATED(<columna>)',
    [p('columna', 'Columna de la tabla del lado uno de una relación activa.')],
    'escalar',
    'El valor de la columna en la fila relacionada del lado uno.',
    'Necesita un contexto de fila en la tabla del lado muchos (por ejemplo dentro de un iterador o de ADDCOLUMNS). Sigue la relación activa desde esa fila hasta la única fila del lado uno y devuelve el valor de la columna indicada. Si no hay fila relacionada devuelve BLANK.',
    'ADDCOLUMNS(Ventas, "Marca", RELATED(Productos[Marca]))',
  ),
  fn(
    'RELATEDTABLE',
    'Relaciones',
    'RELATEDTABLE(<tabla>)',
    [p('tabla', 'Tabla del lado muchos cuyas filas relacionadas se quieren obtener.')],
    'tabla',
    'Las filas de la tabla relacionadas con la fila actual.',
    'Equivale a CALCULATETABLE(<tabla>): realiza una transición de contexto, convierte la fila actual en filtro y, al propagarse por la relación activa del lado uno al lado muchos, deja solo las filas de la otra tabla que corresponden a esa fila.',
    'ADDCOLUMNS(Productos, "Ventas", COUNTROWS(RELATEDTABLE(Ventas)))',
  ),
  fn(
    'USERELATIONSHIP',
    'Relaciones',
    'USERELATIONSHIP(<columna1>, <columna2>)',
    [
      p('columna1', 'Columna del lado muchos de la relación, por ejemplo Ventas[FechaEntrega].'),
      p('columna2', 'Columna del lado uno de la relación, por ejemplo Calendario[Fecha].'),
    ],
    'modificador',
    'No devuelve datos: indica a CALCULATE qué relación usar.',
    'Solo se puede usar como argumento de filtro de CALCULATE o CALCULATETABLE. Activa una relación inactiva existente durante ese cálculo y desactiva la que estaba activa entre las mismas tablas. Al terminar, el modelo vuelve a su estado original.',
    'CALCULATE(SUM(Ventas[Cantidad]), Calendario[NombreMes] = "Febrero", USERELATIONSHIP(Ventas[FechaEntrega], Calendario[Fecha]))',
  ),
  fn(
    'DATE',
    'Relaciones',
    'DATE(<año>, <mes>, <día>)',
    [
      p('año', 'Año de cuatro dígitos.'),
      p('mes', 'Número de mes, de 1 a 12.'),
      p('día', 'Número de día del mes.'),
    ],
    'escalar',
    'Una fecha construida a partir de sus partes.',
    'Construye un valor de fecha sin leer ningún contexto. Sirve para comparar con columnas de fecha, por ejemplo en el filtro de una tabla de calendario.',
    'FILTER(Calendario, Calendario[Fecha] >= DATE(2026, 2, 1))',
  ),

  // ---------- Combinar tablas ----------
  fn(
    'UNION',
    'Combinar tablas',
    'UNION(<tabla1>, <tabla2>[, ...])',
    [
      p('tabla1', 'Primera tabla; sus nombres de columna se conservan.'),
      p('tabla2', 'Tabla con el mismo número de columnas, cuyas filas se agregan al final.'),
    ],
    'tabla',
    'Las filas de la primera tabla seguidas de las de la segunda.',
    'Evalúa cada tabla en el contexto actual y agrega las filas una debajo de otra, sin quitar duplicados. Las columnas se emparejan por posición, no por nombre, y los nombres del resultado son los de la primera tabla.',
    'UNION(VALUES(Ventas[Producto]), VALUES(Devoluciones[Producto]))',
  ),
  fn(
    'INTERSECT',
    'Combinar tablas',
    'INTERSECT(<tabla1>, <tabla2>)',
    [
      p('tabla1', 'Tabla de la que se conservan filas.'),
      p('tabla2', 'Tabla contra la que se comparan las filas.'),
    ],
    'tabla',
    'Las filas de la primera tabla que también existen en la segunda.',
    'Evalúa ambas tablas en el contexto actual y recorre la primera fila por fila, buscando una fila igual en la segunda. Conserva solo las que la tienen; el resultado usa las columnas de la primera tabla.',
    'INTERSECT(VALUES(Ventas[Producto]), VALUES(Devoluciones[Producto]))',
  ),
  fn(
    'EXCEPT',
    'Combinar tablas',
    'EXCEPT(<tabla1>, <tabla2>)',
    [
      p('tabla1', 'Tabla de la que se conservan filas.'),
      p('tabla2', 'Tabla cuyas filas se excluyen.'),
    ],
    'tabla',
    'Las filas de la primera tabla que no existen en la segunda.',
    'Evalúa ambas tablas en el contexto actual y recorre la primera fila por fila, buscando una fila igual en la segunda. Conserva solo las que no la tienen; es la resta de conjuntos.',
    'EXCEPT(VALUES(Ventas[Producto]), VALUES(Devoluciones[Producto]))',
  ),
  fn(
    'CROSSJOIN',
    'Combinar tablas',
    'CROSSJOIN(<tabla1>, <tabla2>[, ...])',
    [
      p('tabla1', 'Primera tabla.'),
      p('tabla2', 'Segunda tabla, cuyas filas se combinan con cada fila de la primera.'),
    ],
    'tabla',
    'Todas las combinaciones de una fila de cada tabla.',
    'Evalúa cada tabla en el contexto actual y forma el producto cartesiano: si las tablas tienen m y n filas, el resultado tiene m por n filas con las columnas de ambas. No usa relaciones entre ellas.',
    'CROSSJOIN(VALUES(Productos[Proveedor]), VALUES(Calendario[NombreMes]))',
  ),
  fn(
    'TREATAS',
    'Combinar tablas',
    'TREATAS(<tabla>, <columna>[, <columna>, ...])',
    [
      p('tabla', 'Tabla cuyos valores se quieren aplicar como filtro.'),
      p('columna', 'Columnas del modelo que recibirán esos valores, en el mismo orden.'),
    ],
    'tabla',
    'La misma tabla de valores, ahora asociada a las columnas indicadas.',
    'Conserva los valores pero les asigna el linaje de las columnas indicadas. Usada como filtro de CALCULATE, filtra esas columnas aunque no exista una relación con la tabla de origen: es una relación virtual creada solo para ese cálculo.',
    'CALCULATE(SUM(Devoluciones[Cantidad]), TREATAS(VALUES(Ventas[Producto]), Devoluciones[Producto]))',
  ),
]
