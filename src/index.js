const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { io: socketClient } = require("socket.io-client");

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

const unoServerSocket = socketClient(
    process.env.UNO_SERVER_URL ?? "http://localhost:10001",
    { transports: ["websocket"] }
);

const lobbies = new Map();
const tabooGames = new Map();

// ── Lobby helpers ────────────────────────────────────────────────────────────

function emitLobbyState(io, lobbyId, lobby) {
    io.to(`lobby:${lobbyId}`).emit("lobby:state", {
        hostId: lobby.hostId,
        quizId: lobby.quizId,
        status: lobby.status,
        timePerQuestion: lobby.timePerQuestion,
        timeMode: lobby.timeMode,
        players: Array.from(lobby.players.values()),
        gameType: lobby.gameType ?? "quiz",
        unoOptions: lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" },
        tabooOptions: lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10 },
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
        orators: lobby.orators ?? { "0": null, "1": null }, //
    });
}

function removePlayerAndMaybeTransferHost({ io, lobbyId, userId }) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    if (lobby.resultViewers?.has(userId)) { lobby.resultViewers.delete(userId); return; }
    lobby.players.delete(userId);
    if (lobby.teams) lobby.teams.delete(userId);
    if (lobby.players.size === 0) { lobbies.delete(lobbyId); return; }
    if (lobby.hostId === userId) lobby.hostId = Array.from(lobby.players.values())[0].userId;
    emitLobbyState(io, lobbyId, lobby);
}

// ── Taboo helpers ────────────────────────────────────────────────────────────

function buildTabooPublicState(game) {
    return {
        phase: game.phase,
        currentTeam: game.currentTeam ?? null,
        currentWord: game.currentWord ?? null,
        currentTraps: game.currentTraps ?? [],
        attempts: game.attempts ?? [],
        turnTimeLeft: game.turnTimeLeft ?? 0,
        turnDuration: game.turnDuration,
        paused: game.paused ?? false,
        scores: game.scores ?? { "0": 0, "1": 0 },
        round: game.round ?? 1,
        totalRounds: game.totalRounds,
        maxAttempts: game.maxAttempts,
        trapWordCount: game.trapWordCount,
        players: Array.from(game.players.values()),
        teams: game.teams ? Object.fromEntries(game.teams) : null,
        hostId: game.hostId,
        trapDeadline: game.trapDeadline ?? null,
        trapTimeLeft: game.trapTimeLeft ?? null,
        trapStarted: game.trapStarted ?? false,
        team0Traps: game.team0Traps ?? [],
        team1Traps: game.team1Traps ?? [],
        team0Word: game.team0Word ?? null,
        team1Word: game.team1Word ?? null,
        firstTeam: game.firstTeam ?? null,
        gameStarted: game.gameStarted ?? false,
        trapsByPlayer: game.trapsByPlayer
            ? Object.fromEntries(game.trapsByPlayer)
            : {},
    };
}

function emitTabooState(io, lobbyId, game) {
    io.to(`taboo:${lobbyId}`).emit("taboo:state", buildTabooPublicState(game));
}

function startTrapTimer(io, lobbyId, game) {
    if (game.trapTimer) return;
    game.trapStarted = true;
    game.trapTimeLeft = 60;
    game.trapDeadline = Date.now() + 60000;
    game.trapTimer = setInterval(() => {
        game.trapTimeLeft--;
        emitTabooState(io, lobbyId, game);
        if (game.trapTimeLeft <= 0) {
            clearInterval(game.trapTimer);
            game.trapTimer = null;
        }
    }, 1000);
    emitTabooState(io, lobbyId, game);
}

function endTurn(io, lobbyId, game, reason) {
    if (game.turnTimer) { clearInterval(game.turnTimer); game.turnTimer = null; }

    game.teamTurnInRound[String(game.currentTeam)] = true;

    const bothPlayed = game.teamTurnInRound["0"] && game.teamTurnInRound["1"];

    if (bothPlayed) {
        game.round++;
        if (game.round > game.totalRounds) {
            game.phase = "finished";
            emitTabooState(io, lobbyId, game);
            io.to(`taboo:${lobbyId}`).emit("taboo:finished", {
                scores: game.scores,
                players: Array.from(game.players.values()),
                teams: game.teams ? Object.fromEntries(game.teams) : null,
            });
            tabooGames.delete(lobbyId);
            return;
        }
        game.teamTurnInRound = { "0": false, "1": false };
        game.phase = "between_turns";
        game.needNewWords = true;
        emitTabooState(io, lobbyId, game);
        io.to(`taboo:${lobbyId}`).emit("taboo:needWords", { round: game.round });
    } else {
        game.currentTeam = game.currentTeam === 0 ? 1 : 0;
        game.phase = "between_turns";
        game.currentWord = game.currentTeam === 0 ? game.team0Word : game.team1Word;
        game.currentTraps = game.currentTeam === 0 ? game.team0Traps : game.team1Traps;
        game.attempts = [];
        emitTabooState(io, lobbyId, game);
    }
}

function startTurnTimer(io, lobbyId, game) {
    if (game.turnTimer) clearInterval(game.turnTimer);
    game.turnTimer = setInterval(() => {
        if (game.paused) return;
        game.turnTimeLeft--;
        emitTabooState(io, lobbyId, game);
        if (game.turnTimeLeft <= 0) {
            clearInterval(game.turnTimer);
            game.turnTimer = null;
            endTurn(io, lobbyId, game, "timeout");
        }
    }, 1000);
}

// ── Socket connections ───────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("nouvelle connexion", socket.id);

    socket.on("lobby:join", ({ lobbyId, userId, username }) => {
        if (!lobbyId || !userId) return;
        socket.data = { lobbyId, userId, username };
        socket.join(`lobby:${lobbyId}`);
        let lobby = lobbies.get(lobbyId);
        if (!lobby) {
            lobby = {
                hostId: userId, quizId: null, status: "WAITING", timePerQuestion: 15, timeMode: "per_question",
                players: new Map(), resultViewers: new Set(), gameType: "quiz",
                unoOptions: { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" },
                tabooOptions: { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10 },
                teams: null,
            };
        }
        if (!lobby.hostId) lobby.hostId = userId;
        if (!lobby.resultViewers) lobby.resultViewers = new Set();
        if (!lobby.teams) lobby.teams = null;
        if (!lobby.tabooOptions) lobby.tabooOptions = { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10 };
        lobby.players.set(userId, { userId, username });
        lobbies.set(lobbyId, lobby);
        if (!lobby.orators) lobby.orators = { "0": null, "1": null };
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setOrator", ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        // Seul l'utilisateur lui-même peut se désigner/retirer
        if (userId !== targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        if (!lobby.orators) lobby.orators = { "0": null, "1": null };

        const team = lobby.teams?.get(userId);
        if (team === undefined || team === null) return;

        const teamKey = String(team); // "0" ou "1"

        if (lobby.orators[teamKey] === userId) {
            // Toggle OFF
            lobby.orators[teamKey] = null;
        } else if (lobby.orators[teamKey] === null) {
            // Toggle ON
            lobby.orators[teamKey] = userId;
        } else {
            // Slot pris par quelqu'un d'autre
            socket.emit("lobby:oratorTaken");
            return;
        }

        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:leave", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost({ io, lobbyId, userId });
    });

    socket.on("lobby:kick", ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId || targetUserId === userId) return;
        if (!lobby.players.has(targetUserId)) return;
        for (const [, s] of io.of("/").sockets) {
            if (s.data?.userId === targetUserId && s.data?.lobbyId === lobbyId) {
                s.emit("lobby:kicked"); s.leave(`lobby:${lobbyId}`); s.data = {}; break;
            }
        }
        lobby.players.delete(targetUserId);
        if (lobby.teams) lobby.teams.delete(targetUserId);
        if (lobby.players.size === 0) { lobbies.delete(lobbyId); return; }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:transferHost", ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId || targetUserId === userId) return;
        if (!lobby.players.has(targetUserId)) return;
        lobby.hostId = targetUserId;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTimeMode", ({ timeMode }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!["per_question", "total", "none"].includes(timeMode)) return;
        lobby.timeMode = timeMode;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTimePerQuestion", ({ timePerQuestion }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        const t = Number(timePerQuestion);
        if (!Number.isFinite(t) || t < 5 || t > 3600) return;
        lobby.timePerQuestion = t;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setQuiz", ({ quizId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.quizId = quizId ?? null;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setGameType", ({ gameType }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!["quiz", "uno", "taboo"].includes(gameType)) return;
        lobby.gameType = gameType;
        if (gameType === "uno" || gameType === "taboo") lobby.quizId = null;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setUnoOptions", ({ stackable, jumpIn, teamMode, teamWinMode }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!lobby.unoOptions) lobby.unoOptions = { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };
        if (typeof stackable === "boolean") lobby.unoOptions.stackable = stackable;
        if (typeof jumpIn === "boolean") lobby.unoOptions.jumpIn = jumpIn;
        if (teamMode === "none" || teamMode === "2v2") {
            lobby.unoOptions.teamMode = teamMode;
            lobby.teams = teamMode === "2v2" ? new Map() : null;
        }
        if (teamWinMode === "one" || teamWinMode === "both") lobby.unoOptions.teamWinMode = teamWinMode;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTabooOptions", ({ turnDuration, totalRounds, trapWordCount, maxAttempts }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!lobby.tabooOptions) lobby.tabooOptions = { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10 };
        const td = Number(turnDuration);
        if (Number.isFinite(td) && td >= 15 && td <= 300) lobby.tabooOptions.turnDuration = td;
        const tr = Number(totalRounds);
        if (Number.isFinite(tr) && tr >= 1 && tr <= 10) lobby.tabooOptions.totalRounds = tr;
        const tw = Number(trapWordCount);
        if (Number.isFinite(tw) && tw >= 1 && tw <= 10) lobby.tabooOptions.trapWordCount = tw;
        const ma = Number(maxAttempts);
        if (Number.isFinite(ma) && ma >= 1 && ma <= 30) lobby.tabooOptions.maxAttempts = ma;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTeam", ({ team }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        const teamNum = Number(team);
        if (!lobby || (teamNum !== 0 && teamNum !== 1)) return;
        if (!lobby.teams) lobby.teams = new Map();
        if (lobby.teams.get(userId) === teamNum) {
            lobby.teams.delete(userId);
        } else {
            lobby.teams.set(userId, teamNum);
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:shuffleTeams", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        const players = Array.from(lobby.players.keys()).sort(() => Math.random() - 0.5);
        const half = Math.floor(players.length / 2);
        if (!lobby.teams) lobby.teams = new Map();
        else lobby.teams.clear();
        players.forEach((id, i) => lobby.teams.set(id, i < half ? 0 : 1));

        // Assigner un orateur aléatoire par équipe (uniquement en mode taboo)
        if (lobby.gameType === "taboo") {
            if (!lobby.orators) lobby.orators = { "0": null, "1": null };
            const team0Players = players.filter((_, i) => i < half);
            const team1Players = players.filter((_, i) => i >= half);
            lobby.orators["0"] = team0Players[Math.floor(Math.random() * team0Players.length)] ?? null;
            lobby.orators["1"] = team1Players[Math.floor(Math.random() * team1Players.length)] ?? null;
        }

        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:start", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        const gameType = lobby.gameType ?? "quiz";
        if (gameType === "quiz" && !lobby.quizId) return;
        if (gameType === "taboo") {
            if (!lobby.teams || lobby.teams.size < 4) return;
            const t0 = Array.from(lobby.teams.values()).filter(t => t === 0).length;
            const t1 = Array.from(lobby.teams.values()).filter(t => t === 1).length;
            if (t0 < 2 || t1 < 2) return;
        }
        if (gameType === "uno" && lobby.unoOptions?.teamMode === "2v2") {
            if (lobby.players.size !== 4) return;
            if (!lobby.teams || lobby.teams.size !== 4) return;
            const t0 = Array.from(lobby.teams.values()).filter(t => t === 0).length;
            const t1 = Array.from(lobby.teams.values()).filter(t => t === 1).length;
            if (t0 !== 2 || t1 !== 2) return;
        }
        lobby.status = "PLAYING";
        emitLobbyState(io, lobbyId, lobby);
        if (gameType === "uno") {
            const opts = lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };
            unoServerSocket.emit("uno:configure", { lobbyId, options: opts, expectedCount: lobby.players.size, preAssignedTeams: lobby.teams ? Object.fromEntries(lobby.teams) : null });
            io.to(`lobby:${lobbyId}`).emit("game:start", { gameType: "uno", lobbyId });
        } else if (gameType === "taboo") {
            io.to(`lobby:${lobbyId}`).emit("game:start", { gameType: "taboo", lobbyId });
        } else {
            io.to(`lobby:${lobbyId}`).emit("game:start", { gameType: "quiz", quizId: lobby.quizId, timeMode: lobby.timeMode, timePerQuestion: lobby.timePerQuestion });
        }
    });

    socket.on("chat:send", ({ text }) => {
        const { lobbyId, userId, username } = socket.data || {};
        if (!lobbyId || !userId) return;
        io.to(`lobby:${lobbyId}`).emit("chat:new", { userId, username, text: String(text || "").slice(0, 500), sentAt: Date.now() });
    });

    // ── TABOO ─────────────────────────────────────────────────────────────────

    socket.on("taboo:join", ({ lobbyId, userId, username, teams: clientTeams, hostId: clientHostId }) => {
        if (!lobbyId || !userId) return;
        socket.data = { ...socket.data, lobbyId, userId, username };
        socket.join(`taboo:${lobbyId}`);

        let game = tabooGames.get(lobbyId);
        if (!game) {
            const lobby = lobbies.get(lobbyId);
            const opts = lobby?.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10 };

            let teamsMap;
            if (lobby?.teams) {
                teamsMap = new Map(Object.entries(lobby.teams).map(([k, v]) => [k, Number(v)]));
            } else if (clientTeams && Object.keys(clientTeams).length > 0) {
                teamsMap = new Map(Object.entries(clientTeams).map(([k, v]) => [k, Number(v)]));
            } else {
                teamsMap = new Map();
            }

            const hostId = lobby?.hostId ?? clientHostId ?? userId;

            game = {
                phase: "trap",
                hostId,
                turnDuration: opts.turnDuration,
                totalRounds: opts.totalRounds,
                trapWordCount: opts.trapWordCount,
                maxAttempts: opts.maxAttempts,
                players: new Map(),
                teams: teamsMap,
                team0Word: null,
                team1Word: null,
                team0Traps: [],
                team1Traps: [],
                trapsByPlayer: new Map(),
                trapDeadline: null,
                trapTimeLeft: null,
                trapStarted: false,
                trapTimer: null,
                currentTeam: null,
                firstTeam: null,
                gameStarted: false,
                currentWord: null,
                currentTraps: [],
                attempts: [],
                turnTimeLeft: 0,
                turnTimer: null,
                paused: false,
                scores: { "0": 0, "1": 0 },
                round: 1,
                teamTurnInRound: { "0": false, "1": false },
            };

            tabooGames.set(lobbyId, game);
        }

        game.players.set(userId, {
            userId, username,
            team: game.teams.get(userId) ?? null,
        });

        if (game.hostId === userId && !game.team0Word) {
            socket.emit("taboo:requestWords", { count: 2 });
        }

        emitTabooState(io, lobbyId, game);
    });

    socket.on("taboo:startTrap", ({ lobbyId }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.hostId !== userId || game.phase !== "trap") return;
        if (game.trapStarted) return;
        startTrapTimer(io, lobbyId, game);
    });

    socket.on("taboo:setWords", ({ lobbyId, team0Word, team1Word }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.hostId !== userId) return;
        if (team0Word) game.team0Word = String(team0Word).toUpperCase();
        if (team1Word) game.team1Word = String(team1Word).toUpperCase();
        emitTabooState(io, lobbyId, game);
    });

    socket.on("taboo:submitTraps", ({ lobbyId, traps }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.phase !== "trap") return;

        const myTeam = game.teams.get(userId);
        if (myTeam === undefined || myTeam === null) return;

        if (!game.trapsByPlayer) game.trapsByPlayer = new Map();

        // Stocker tous les slots (y compris vides) pour la sync positionnelle côté UI
        const allSlots = (traps ?? []).map(t =>
            typeof t === "string" ? t.trim().toUpperCase() : ''
        );
        game.trapsByPlayer.set(userId, allSlots);

        // Reconstruire les traps actifs de l'équipe (non-vides uniquement)
        const allTraps = [];
        for (const [pid, pTraps] of game.trapsByPlayer) {
            if (game.teams.get(pid) === myTeam) {
                allTraps.push(...pTraps.filter(t => t));
            }
        }
        const merged = [...new Set(allTraps)].slice(0, game.trapWordCount * 2);

        if (myTeam === 0) {
            game.team1Traps = merged;
        } else {
            game.team0Traps = merged;
        }

        emitTabooState(io, lobbyId, game);
    });

    socket.on("taboo:startGame", ({ lobbyId }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.hostId !== userId) return;
        if (!game.team0Word || !game.team1Word) return;
        if (game.gameStarted) return;

        if (game.trapTimer) { clearInterval(game.trapTimer); game.trapTimer = null; }

        const firstTeam = Math.random() < 0.5 ? 0 : 1;
        game.firstTeam = firstTeam;
        game.currentTeam = firstTeam;
        game.currentWord = firstTeam === 0 ? game.team0Word : game.team1Word;
        game.currentTraps = firstTeam === 0 ? game.team0Traps : game.team1Traps;
        game.attempts = [];
        game.phase = "between_turns";
        game.gameStarted = true;

        emitTabooState(io, lobbyId, game);
    });

    socket.on("taboo:startTurn", ({ lobbyId }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.phase !== "between_turns") return;
        if (game.hostId !== userId) return;

        game.phase = "playing";
        game.turnTimeLeft = game.turnDuration;
        game.paused = false;
        game.attempts = [];
        emitTabooState(io, lobbyId, game);
        startTurnTimer(io, lobbyId, game);
    });

    socket.on("taboo:attempt", ({ lobbyId, word }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.phase !== "playing") return;
        const myTeam = game.teams.get(userId);
        if (myTeam !== game.currentTeam) return;

        const attempt = String(word || "").trim().toUpperCase();
        if (!attempt) return;

        game.attempts.push({ word: attempt, userId, username: game.players.get(userId)?.username });
        emitTabooState(io, lobbyId, game);

        if (game.attempts.length >= game.maxAttempts) {
            endTurn(io, lobbyId, game, "max_attempts");
        }
    });

    socket.on("taboo:pause", ({ lobbyId }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.phase !== "playing") return;
        game.paused = !game.paused;
        emitTabooState(io, lobbyId, game);
    });

    socket.on("taboo:validate", ({ lobbyId }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.phase !== "playing") return;
        const myTeam = game.teams.get(userId);
        if (myTeam !== game.currentTeam) return;

        game.scores[String(game.currentTeam)] = (game.scores[String(game.currentTeam)] ?? 0) + 1;
        endTurn(io, lobbyId, game, "validated");
    });

    socket.on("taboo:fail", ({ lobbyId }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.phase !== "playing") return;
        const myTeam = game.teams.get(userId);
        if (myTeam === game.currentTeam) return;

        endTurn(io, lobbyId, game, "fail");
    });

    socket.on("taboo:setWordsForRound", ({ lobbyId, team0Word, team1Word }) => {
        const { userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const game = tabooGames.get(lobbyId);
        if (!game || game.hostId !== userId) return;
        game.team0Word = String(team0Word).toUpperCase();
        game.team1Word = String(team1Word).toUpperCase();
        game.team0Traps = [];
        game.team1Traps = [];
        game.trapsByPlayer = new Map();
        game.phase = "trap";
        game.trapStarted = false;
        game.trapTimeLeft = null;
        game.trapDeadline = null;
        if (game.trapTimer) { clearInterval(game.trapTimer); game.trapTimer = null; }

        emitTabooState(io, lobbyId, game);
    });

    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost({ io, lobbyId, userId });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("lobby-server listening on", PORT));
