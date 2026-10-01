import { startServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
const server = await startServer(port, process.env.STATIC_DIR);
console.log(`Servidor listo en http://localhost:${server.port} (WebSocket en /ws)`);
