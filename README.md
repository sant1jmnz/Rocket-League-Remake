# Rocket Remake

Remake web de fútbol con autos que busca ser **1:1 con Rocket League** en lo que se siente al jugar: mismas
medidas del estadio, misma física (constantes de la comunidad: RLBot / RocketSim), mismos controles
por defecto, mismas reglas de partida y misma cámara. Se juega en el navegador, **online** (1v1, 2v2 y
3v3 con bots que llenan los lugares vacíos) o **offline** contra bots o en entrenamiento libre.

> Proyecto de fans sin fines de lucro. No usa modelos, sonidos, música ni logos del juego original y
> no tiene afiliación con Psyonix ni Epic Games.

## Cómo jugar

```bash
npm install
npm run dev      # cliente en http://localhost:5173 + servidor en :8080
```

Abre `http://localhost:5173`. Para jugar online con amigos, crea una sala, comparte el código (o el
enlace con «Copiar enlace») y el anfitrión inicia la partida.

### Producción

```bash
npm run build    # compila el cliente (Vite) y el servidor (esbuild)
npm start        # un solo proceso sirve la página y el WebSocket en el puerto $PORT (8080)
```

### Publicarlo para jugar con amigos (gratis, en Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sant1jmnz/Rocket-League-Remake)

1. Crear una cuenta en [render.com](https://render.com) y conectar GitHub.
2. **New → Blueprint**, elegir este repositorio (y la rama, si no es la principal). Render lee
   `render.yaml`: compila, arranca un solo servicio web y queda en `https://rocket-remake-xxxx.onrender.com`.
3. Compartir ese enlace: cada uno abre la página, entra a **Jugar online** y se une a una sala o a una
   partida rápida.

El plan gratuito «duerme» el servicio si nadie lo usa durante un rato; el primer ingreso después
tarda unos segundos en despertarlo.

Con Docker: `docker build -t rocket-remake . && docker run -p 8080:8080 rocket-remake`.
Sirve en cualquier hosting de Node con WebSockets (Render, Fly.io, Railway, un VPS…). Si el cliente se
sirve aparte, en **Ajustes → Servidor** se puede poner la URL `wss://…/ws`.

## Controles (por defecto, igual que el juego; todos reasignables en *Controles*)

| Acción | Teclado + mouse | Mando (Xbox / PlayStation) |
| --- | --- | --- |
| Acelerar / reversa | W / S | RT / LT (R2 / L2) |
| Girar · yaw | A / D | Stick izquierdo |
| Pitch (aire) | W (nariz abajo) / S (nariz arriba) | Stick izquierdo |
| Saltar · doble salto · flip | Clic derecho | A (✕) |
| Boost | Clic izquierdo | B (○) |
| Powerslide / air roll | Shift izquierdo | X (□) |
| Air roll izq. / der. | Q / E | LB / RB |
| Ball cam | Espacio | Y (△) |
| Marcador | Tab | View / Share |
| Pausa | Esc | Menu / Options |
| Quick chat | 1 · 2 · 3 · 4 (dos veces) | Cruceta |
| Reiniciar balón (entrenamiento) | R | R3 |

**Stall:** mantené un air roll (p. ej. Q) y, con el segundo salto, apretá la dirección contraria (D, o la otra tecla de air roll): el flip se cancela y el auto queda flotando casi quieto.


## Autos y gráficos

- **Octane** y **Fennec** reconstruidos por código a partir de proporciones medidas (vistas
  ortogonales con grilla en uu): el Octane con fuselaje angosto, cabina burbuja, guardabarros tipo
  aleta, paneles traseros, motor expuesto y alerón sobre poste; el Fennec como hatchback con capó
  largo, techo recto, cola vertical, arcos redondos y parrilla con faros redondos. Ventanas con
  máscara por píxel. Los dos usan la hitbox Octane, como en el juego. Se eligen en **Garaje**.
- Cancha con el diseño actual del DFH Stadium, medido sobre una vista cenital de referencia y
  dibujado por código:
  - pasto oliva con circuito hexagonal y franjas del color de cada equipo;
  - zonas oscuras de malla hexagonal frente a los arcos y junto a las paredes laterales;
  - cruz metálica central y pad hexagonal en el centro;
  - rampas de metal gris y una franja de pantallas sobre ellas;
  - paredes y techo de vidrio con un panal grande;
  - arcos con marcos redondeados luminosos.
- Estadio con sus proporciones: anillo de pasto, bandeja baja y una alta mucho más grande con público
  vestido del color de cada equipo, y un anillo de techo negro con vidrio y reflectores.
- Balón con el diseño del balón por defecto: caras tipo cubo, almohadillas con nervaduras opuestas a
  caras de malla hexagonal con luces turquesa, y ejes de tres brazos en los polos.
- Iluminación HDR (Poly Haven «Quarry 01», CC0), sombras, bloom y tipografías Exo 2 / Titillium Web
  (OFL) incluidas en el paquete.

## Fidelidad con el juego real

Toda la física está en `packages/shared` (TypeScript puro, determinista, 120 ticks por segundo) y es
un **port de [RocketSim](https://github.com/ZealanL/RocketSim)** (MIT), la reimplementación de la
física de Rocket League que usan los bots de RLBot y que coincide con el juego tick a tick:

- **Estadio**: la malla de colisión real del estadio estándar (~8.000 triángulos: esquinas, rampas,
  arcos con techo inclinado y fondo curvo), tomada de [rl_ball_sym](https://github.com/VirxEC/rl_ball_sym)
  (MIT; la geometría la extrajo RLUtilities del juego). Paredes en x = ±4096, fondos en y = ±5120,
  techo a 2048. El render dibuja esos mismos triángulos, así que lo que se ve es lo que choca.
  Se regenera con `node tools/gen-arena-mesh.mjs <rl_ball_sym/assets/standard>`.
- **Auto** (hitbox Octane 120.5 × 86.7 × 38.7, inercia de caja como el juego): vehículo de
  Bullet con **cuatro rayos de suspensión** (resorte 500, amortiguación 25/40, recorrido 12 uu, escalas
  35.75 / 54.27 delante/detrás), **fricción lateral por rueda** con la curva de deslizamiento real,
  motor y freno como fricción de rodadura (1600 → 160 → 0 uu/s² hasta 1410 uu/s, freno 3500,
  rodar libre 525), ángulo de dirección de las ruedas delanteras según la velocidad, powerslide
  analógico (sube 5/s, baja 2/s) que baja la fricción lateral, fuerza adhesiva a la superficie
  (325 uu/s², hasta 975 en paredes con acelerador) y fricción que cae en paredes sin acelerador.
- **Aire**: salto 291.67 + 1458.33 uu/s² sostenido (0.025–0.2 s), doble salto y flips con la ventana
  de 1.25 s, flips por torque (260 / 224 rad/s², tope 5.5 rad/s), impulso según dirección y velocidad,
  amortiguación vertical del flip (el auto "flota" al flipear), cancelación de flip, pitch lock,
  control aéreo con los torques 130 / 95 / 400 y amortiguaciones 30 / 20 / 50, auto-flip al saltar
  panza arriba y auto-roll. El reseteo de flip ocurre cuando ≥ 3 ruedas tocan el balón.
- **Balón**: radio 91.25 (apoyado a 93.15), masa 30, rebote 0.6, fricción 0.35, drag 0.03,
  velocidad máx. 6000; contacto auto-balón con fricción 2.0 y el impulso extra de Psyonix
  (curva 0.65 → 0.30, eje z × 0.35, componente frontal × 0.65) como máximo cada dos ticks.
- **Contactos**: solver de impulsos secuenciales como el de Bullet (10 iteraciones, contactos
  especulativos), auto-arena 0.3 / 0.3, auto-auto 0.09 / 0.1. Golpes y demoliciones con las curvas
  de RocketSim (con el paragolpes, a más de 64.5 uu del centro del auto).
- **Bots**: Novato, Pro y All-Star. Leen la predicción del balón y juegan como un jugador:
  intercepción, línea de tiro al arco, despejes, roles en equipo, boost, tiros con salto, dodges y
  aéreos (All-Star).
- **Partida**: 5:00, cuenta regresiva 3-2-1, el reloj arranca con el primer toque, la regla de
  «balón al piso» en 0:00, tiempo extra con gol de oro, posiciones de kickoff reales, 34 boost pads
  (12/100, 4 s/10 s, cilindro de 208/144 uu), demoliciones y reaparición a los 3 s, puntos (gol,
  asistencia, atajada, tiro, demolición).
- **Después del gol**: 3 s de festejo y la repetición de los últimos segundos con la cámara sobre el
  goleador; se omite cuando todos aprietan saltar, online también. Al final, la pantalla de
  resultados con las estadísticas de cada jugador y el MVP (el mejor puntaje del equipo ganador).
- **Cámara**: los valores por defecto y rangos del juego (Ajustes → Cámara): FOV 90 (60–110),
  distancia 270 (100–400), altura 100 (40–200), ángulo −3 (−15–0), rigidez 0.5 (0–1), velocidad de
  giro 2.5 (1–10), velocidad de transición 1.2 (1–2), sacudida activada e invertir giro. Anclada al
  auto (la rigidez solo la aleja a alta velocidad), estable durante flips, y con la sacudida leve al
  usar boost / ir supersónico y en golpes fuertes, goles y demoliciones.

## Multijugador

Servidor autoritativo a 120 Hz que envía snapshots binarios exactos a 30 Hz. Cada cliente predice
**todo el mundo** con la misma simulación y, al llegar un snapshot, rebobina y re-simula con sus
inputs (rollback, como el juego real). Las correcciones se suavizan visualmente. Para probar con
latencia simulada: `http://localhost:5173/?lag=150`.

## Estructura

```
packages/shared   simulación (física, reglas, bots, protocolo de red) + tests
packages/client   Vite + Three.js: render, cámara, controles, HUD, menús, audio, netcode cliente
packages/server   Node + ws: salas, partida rápida, simulación autoritativa
```

## Desarrollo

```bash
npm test          # tests de física, protocolo/rollback, bots y servidor
npm run typecheck
npm run lint
```
