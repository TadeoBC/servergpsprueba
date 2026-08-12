# Canal de comandos S11L

## Fuentes verificadas

El manual oficial SEEWORLD `S11L中文说明书.pdf`, publicado el 9 de diciembre de
2024, documenta en sus páginas 7 y 8 los rangos y formatos implementados. La
especificación GT06 define el sobre binario `0x80`: longitud de comando, bandera
del servidor de cuatro bytes, texto ASCII compatible con SMS, idioma, serial,
CRC-ITU y terminador `0D0A`. La respuesta conserva la bandera para correlación.

## Flujo

1. El panel valida el tipo y parámetros contra `src/commands/catalog.js`.
2. Se inserta el comando con una bandera aleatoria única.
3. Si el equipo está online, se envía por su socket activo; si no, queda en cola.
4. Después de reconectar y recibir el ACK de login, salen los pendientes.
5. Una respuesta `0x15` o `0x21` actualiza el estado y se difunde por WebSocket.
6. Un comando enviado sin respuesta expira a los 10 minutos; uno nunca enviado,
   a los siete días.

El texto de respuesta que contiene `ERROR`, `FAIL`, `INVALID`, `INCORRECT` o
`ERR!` marca el comando como `failed`; el resto se marca `acknowledged` y queda
visible para revisión humana.

## Alarmas

Los modos del manual son:

- `0`: solo GPRS.
- `1`: SMS + GPRS.
- `2`: GPRS + SMS + llamada.
- `3`: GPRS + llamada.

Estas órdenes configuran qué eventos debe emitir el tracker; no fabrican una
alarma falsa. Las alarmas reales recibidas se guardan como eventos y pueden
generar una notificación del navegador.
