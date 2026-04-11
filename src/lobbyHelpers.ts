// lobby-server/src/lobbyHelpers.ts
import { Server } from 'socket.io';

export function emitLobbyState(io: Server, lobbyId: string, lobby: any): void {
    io.to(`lobby:${lobbyId}`).emit('lobby:state', {
        hostId:          lobby.hostId,
        quizId:          lobby.quizId,
        status:          lobby.status,
        timePerQuestion: lobby.timePerQuestion,
        timeMode:        lobby.timeMode,
        players:         Array.from<any>(lobby.players.values()),
        gameType:        lobby.gameType ?? 'quiz',
        unoOptions:      lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' },
        tabooOptions:    lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 },
        teams:           lobby.teams ? Object.fromEntries(lobby.teams) : null,
        orators:         lobby.orators ?? { '0': null, '1': null },
        skyjowOptions:   lobby.skyjowOptions ?? { eliminateRows: false },
        impostorOptions: lobby.impostorOptions ?? { rounds: 1 },
        title:           lobby.title ?? null,
        description:     lobby.description ?? null,
        maxPlayers:      lobby.maxPlayers ?? 8,
        isPublic:        lobby.isPublic ?? false,
        gameId:          lobby.gameStartPayload?.gameId ?? null,
        bots:            lobby.bots ?? 0,
    });
}

export function broadcastLobbies(io: Server, lobbies: Map<string, any>): void {
    const lobbyList = Array.from(lobbies.entries())
        .filter(([, lobby]) => lobby.isPublic !== false)
        .map(([id, lobby]) => ({
            id,
            title:          lobby.title ?? `Lobby de ${Array.from<any>(lobby.players.values())[0]?.username ?? '?'}`,
            description:    lobby.description ?? '',
            gameType:       lobby.gameType ?? 'quiz',
            maxPlayers:     lobby.maxPlayers ?? 8,
            currentPlayers: lobby.players.size,
            status:         lobby.status === 'WAITING' ? 'waiting' : 'in-progress',
            host:           Array.from<any>(lobby.players.values()).find((p: any) => p.userId === lobby.hostId)?.username ?? '?',
            playerNames:    Array.from<any>(lobby.players.values()).map((p: any) => p.username),
        }));
    io.emit('lobbies', lobbyList);
}

export function removePlayerAndMaybeTransferHost(
    io: Server,
    lobbies: Map<string, any>,
    lobbyId: string,
    userId: string,
): void {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    if (lobby.resultViewers?.has(userId)) { lobby.resultViewers.delete(userId); return; }
    lobby.players.delete(userId);
    if (lobby.teams) lobby.teams.delete(userId);
    if (lobby.players.size === 0) { lobbies.delete(lobbyId); broadcastLobbies(io, lobbies); return; }
    if (lobby.hostId === userId) lobby.hostId = (Array.from<any>(lobby.players.values())[0] as any).userId;
    emitLobbyState(io, lobbyId, lobby);
    broadcastLobbies(io, lobbies);
}
