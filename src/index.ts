// lobby-server/src/index.ts
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { corsConfig, setupSocketAuth } from '@kwizar/shared';
import { initGameServers, setupReconnectHandlers } from './gameServers';
import { registerHandlers } from './handlers';

const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, { cors: corsConfig });

const SOCKET_SECRET = new TextEncoder().encode(process.env.INTERNAL_API_KEY!);
initGameServers(SOCKET_SECRET);

const lobbies = new Map<string, any>();
setupReconnectHandlers(lobbies);

setupSocketAuth(io, SOCKET_SECRET);

io.on('connection', (socket) => {
    console.log('nouvelle connexion lobby', socket.id);
    registerHandlers(io, socket, lobbies);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('[LOBBY] realtime listening on', PORT));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
