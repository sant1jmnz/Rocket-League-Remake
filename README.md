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
| Air roll izq. / der. | Q / E | — |
| Ball cam | Espacio | Y (△) |
| Marcador | Tab | View / Share |
| Pausa | Esc | Menu / Options |
| Quick chat | 1 · 2 · 3 · 4 (dos veces) | Cruceta |
| Reiniciar balón (entrenamiento) | R | R3 |

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

Toda la física está en `packages/shared` (TypeScript puro, determinista, 120 ticks por segundo):

- **Estadio**: paredes en x = ±4096, fondos en y = ±5120, techo a 2044, esquinas a 45° y rampas curvas;
  arco de 1786 × 642.775 × 880. Es una función de distancia analítica, la misma que dibuja el render.
- **Auto** (hitbox Octane 118.01 × 84.20 × 36.16): curva de aceleración 1600→160→0 uu/s² hasta
  1410 uu/s, boost 991.67 uu/s² hasta 2300 uu/s, supersónico desde 2200, consumo 33.3/s, curva de
  giro real por velocidad, powerslide, adherencia en paredes (325 uu/s²), salto 291.67 + 1458.33 uu/s²
  sostenido (máx. 0.2 s), doble salto y flips con la ventana de 1.25 s, impulso y amortiguación
  vertical del flip, flip cancel, control aéreo con los torques y amortiguaciones reales, auto-flip.
- **Balón**: radio 91.25, rebote 0.6, velocidad máx. 6000, drag 0.0305 y el impulso extra de Psyonix
  al golpear.
- **Partida**: 5:00, cuenta regresiva 3-2-1, el reloj arranca con el primer toque, la regla de
  «balón al piso» en 0:00, tiempo extra con gol de oro, posiciones de kickoff reales, 34 boost pads
  (12/100, 4 s/10 s), demoliciones y reaparición a los 3 s, puntos (gol, asistencia, atajada, tiro,
  demolición).
- **Cámara**: FOV 110, distancia 270, altura 110, ángulo −3, rigidez 0.5, giro 5, transición 1.

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
