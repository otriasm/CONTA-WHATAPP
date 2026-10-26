# Primera prueba de Conta en WhatsApp, paso a paso

Meta: escribirle «quiero factura» al número de prueba desde tu celular y que te regrese una factura de prueba en PDF y XML.

## Las piezas, explicadas fácil

| Pieza | Qué es | Comparación |
| --- | --- | --- |
| **WhatsApp (Meta)** | El número que recibe y manda los mensajes | El teléfono de la tienda |
| **Facturapi** | El servicio que hace la factura y la timbra con el SAT | La máquina de hacer facturas |
| **Claude (Anthropic)** | La IA que lee la foto del ticket | Los ojos que leen el ticket |
| **El servidor** | Nuestro programa, prendido en una computadora | El cajero que atiende |
| **ngrok** | Un túnel para que Meta encuentre tu computadora en internet | La dirección de la tienda |
| **El archivo `.env`** | Un archivo con tus llaves secretas | El llavero |

## Paso 1 · Facturapi (la máquina de facturas)

1. Entra a **facturapi.io** y crea tu cuenta.
2. Crea una **organización**: es el negocio que va a facturar.
3. Llena sus datos fiscales. Para probar, puedes usar los **certificados de prueba** que trae la documentación de Facturapi.
4. Busca **API Keys** y copia la **Test Key**. Empieza con `sk_test_`.
5. Anota el **RFC** de esa organización.

✏️ Guardas: Test Key → `DEMO_FACTURAPI_KEY` · RFC → `DEMO_BUSINESS_RFC`

## Paso 2 · Claude (los ojos)

1. Entra a **console.anthropic.com** y crea tu cuenta.
2. Agrega saldo; con unos pocos dólares alcanza para muchas pruebas.
3. Ve a **API Keys**, crea una llave y cópiala. Solo se ve una vez.

✏️ Guardas: la llave → `ANTHROPIC_API_KEY`

## Paso 3 · WhatsApp (el teléfono)

1. Entra a **developers.facebook.com** con tu cuenta de Facebook.
2. **Mis apps › Crear app**, tipo **Empresa** (Business).
3. Agrégale el producto **WhatsApp**.
4. Abre **WhatsApp › Configuración de la API**. Ahí verás:
   - un **número de prueba** que te regala Meta;
   - su **Identificador del número de teléfono** (Phone number ID);
   - un **token de acceso temporal**, que dura 24 horas.
5. En «Para», agrega **tu celular** y confirma el código que te llega.
6. Presiona **Enviar mensaje**. Si te llega «Hello World» a tu WhatsApp, ¡funciona! 🎉
7. Ve a **Configuración › Básica** y copia la **Clave secreta de la app**.

✏️ Guardas: identificador → `DEMO_WA_PHONE_NUMBER_ID` · token → `DEMO_WA_TOKEN` · clave secreta → `WA_APP_SECRET`

## Paso 4 · Preparar tu computadora

1. Instala **Node.js 22** desde nodejs.org.
2. Instala **Git** desde git-scm.com.
3. Instala **ngrok** desde ngrok.com y crea tu cuenta gratis.
4. Abre la terminal y escribe, uno por uno:

```bash
git clone https://github.com/otriasm/conta-whatapp.git
cd conta-whatapp
npm install
```

## Paso 5 · Llenar el llavero (`.env`)

1. Copia el archivo `.env.example` y llama a la copia `.env`.
2. Ábrelo con el Bloc de notas y pega lo que guardaste en los pasos 1 a 3.
3. Inventa dos palabras:
   - `WA_VERIFY_TOKEN`: por ejemplo `conta-prueba-2026`;
   - `RECEPTOR_SALT`: cualquier texto de 16 letras o más.
4. En `DEMO_BUSINESS_NAME`, pon el **nombre de la tienda que sale en el ticket** que vas a usar (por ejemplo `OXXO`). Si no coincide, Conta dirá que el ticket es de otro negocio.
5. Lo que dice `pendiente`, déjalo así por ahora.

## Paso 6 · Prender el programa

En la terminal, dentro de `conta-whatapp`:

```bash
npm run dev
```

Abre **otra** terminal y escribe:

```bash
ngrok http 3000
```

ngrok te muestra una dirección como `https://abcd-1234.ngrok-free.app`. Cópiala.

## Paso 7 · Decirle a Meta dónde está el programa

1. En Meta: **WhatsApp › Configuración › Webhook › Editar**.
2. **URL de devolución de llamada**: tu dirección de ngrok + `/webhooks/whatsapp`. Ejemplo: `https://abcd-1234.ngrok-free.app/webhooks/whatsapp`.
3. **Token de verificación**: la misma palabra que pusiste en `WA_VERIFY_TOKEN`.
4. Presiona **Verificar y guardar**.
5. En «Campos del webhook», suscríbete a **messages**.

## Paso 8 · ¡Probar! 📱

Desde tu celular, al número de prueba:

1. Escribe **quiero factura**.
2. Manda tu **constancia fiscal en PDF**, la que bajas del SAT.
3. Revisa tus datos y toca **Sí, son correctos**.
4. Manda la **foto de un ticket** de la tienda que pusiste en `DEMO_BUSINESS_NAME`, de **menos de $2,000** y de los **últimos 3 días**.
5. Toca **Sí, facturar**.
6. Te deben llegar el **PDF** y el **XML** de la factura de prueba.

## Si algo falla

- Copia lo que sale en la terminal donde corre `npm run dev` y pégaselo a Claude. **Borra antes cualquier llave o token.**
- El token de Meta venció (pasaron 24 h): copia uno nuevo y reinicia `npm run dev`.
- ngrok cambió de dirección: actualízala en el webhook de Meta.

## Todavía no se puede probar en esta primera vuelta

- Aprobaciones del operador: necesitan el número «Conta Operación».
- Editar datos con formulario: necesita los Flows publicados en Meta.
- Usar el número real del negocio (coexistencia): necesita que Conta sea Tech Provider.
