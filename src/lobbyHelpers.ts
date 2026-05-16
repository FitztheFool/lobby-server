// lobby-server/src/lobbyHelpers.ts
import { Server } from 'socket.io';

export function isTeamModeActive(lobby: any): boolean {
    return (lobby.gameType === 'uno' && lobby.unoOptions?.teamMode === '2v2')
        || (lobby.gameType === 'ludo' && lobby.ludoOptions?.teamMode === '2v2');
}

export function autoFillBotTeams(lobby: any): void {
    if (!isTeamModeActive(lobby)) return;
    const slots = (lobby.botSlots ?? []) as Array<{ userId: string; username: string }>;
    if (slots.length === 0) return;
    lobby.teams ||= new Map();
    const teams: Map<string, number> = lobby.teams;
    const botIds = new Set(slots.map(b => b.userId));
    for (const id of Array.from(teams.keys())) {
        if (botIds.has(id)) teams.delete(id);
    }
    for (const slot of slots) {
        const t0 = Array.from(teams.values()).filter(v => v === 0).length;
        const t1 = Array.from(teams.values()).filter(v => v === 1).length;
        teams.set(slot.userId, t0 <= t1 ? 0 : 1);
    }
}

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
        tabooOptions:    lobby.tabooOptions ?? { turnDuration: 120, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 90 },
        teams:           lobby.teams ? Object.fromEntries(lobby.teams) : null,
        orators:         lobby.orators ?? { '0': null, '1': null },
        skyjowOptions:   lobby.skyjowOptions ?? { eliminateRows: false },
        impostorOptions: lobby.impostorOptions ?? { rounds: 1 },
        ludoOptions:     lobby.ludoOptions ?? { pawnExit: '6', bonusOn6: 'unlimited', winMode: 'first_done', teamMode: 'none' },
        title:           lobby.title ?? null,
        description:     lobby.description ?? null,
        maxPlayers:      lobby.maxPlayers ?? 8,
        isPublic:        lobby.isPublic ?? false,
        gameId:          lobby.gameStartPayload?.gameId ?? null,
        bots:            lobby.botSlots?.length ?? lobby.bots ?? 0,
        botSlots:        lobby.botSlots ?? [],
    });
}

export function buildLobbyList(lobbies: Map<string, any>): any[] {
    return Array.from(lobbies.entries())
        .filter(([, lobby]) => lobby.isPublic !== false)
        .map(([id, lobby]) => ({
            id,
            title:          lobby.title ?? `Lobby de ${Array.from<any>(lobby.players.values())[0]?.username ?? '?'}`,
            description:    lobby.description ?? '',
            gameType:       lobby.gameType ?? 'quiz',
            maxPlayers:     lobby.maxPlayers ?? 8,
            currentPlayers: lobby.players.size + (lobby.bots ?? 0),
            status:         lobby.status === 'WAITING' ? 'waiting' : 'in-progress',
            host:           Array.from<any>(lobby.players.values()).find((p: any) => p.userId === lobby.hostId)?.username ?? '?',
            playerNames:    [
                ...Array.from<any>(lobby.players.values()).map((p: any) => p.username),
                ...(lobby.botSlots ?? []).map((b: any) => b.username),
            ],
        }));
}

export function broadcastLobbies(io: Server, lobbies: Map<string, any>): void {
    io.emit('lobbies', buildLobbyList(lobbies));
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
    autoFillBotTeams(lobby);
    emitLobbyState(io, lobbyId, lobby);
    broadcastLobbies(io, lobbies);
}
