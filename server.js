const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// 클라이언트에게 보낼 때 타이머 객체(순환 참조)를 제거하는 헬퍼 함수
function getClientState(state) {
    if (!state) return null;
    const { timer, ...safeState } = state;
    return safeState;
}

// 점수 계산 함수 (표준 요트 다이스 룰 기준)
function calculateScore(category, dice) {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    let sum = 0;
    dice.forEach(d => {
        counts[d]++;
        sum += d;
    });

    switch (category) {
        case 'ones': return counts[1] * 1;
        case 'twos': return counts[2] * 2;
        case 'threes': return counts[3] * 3;
        case 'fours': return counts[4] * 4;
        case 'fives': return counts[5] * 5;
        case 'sixes': return counts[6] * 6;
        case 'choice': return sum;
        case 'fourOfAKind': return counts.some(c => c >= 4) ? sum : 0;
        case 'fullHouse': 
            const hasThree = counts.some(c => c === 3);
            const hasTwo = counts.some(c => c === 2);
            const hasFive = counts.some(c => c === 5);
            return (hasThree && hasTwo) || hasFive ? sum : 0;
        case 'smallStraight':
            const str = counts.slice(1).map(c => c > 0 ? 1 : 0).join('');
            return (str.includes('1111')) ? 15 : 0;
        case 'largeStraight':
            const str2 = counts.slice(1).map(c => c > 0 ? 1 : 0).join('');
            return (str2.includes('11111')) ? 30 : 0;
        case 'yacht': return counts.some(c => c === 5) ? 50 : 0;
        default: return 0;
    }
}

// 다음 턴으로 넘기는 공통 로직
function nextTurn(roomName) {
    const state = rooms[roomName];
    if (!state) return;

    state.turnIndex = (state.turnIndex + 1) % 2;
    state.keep = [false, false, false, false, false];
    state.rollsLeft = 3;
    state.dice = state.dice.map(() => Math.floor(Math.random() * 6) + 1);

    if (state.turnIndex === 0) {
        state.round++;
    }

    if (state.round > 12) {
        io.to(roomName).emit('gameOver', getClientState(state));
        if (state.timer) clearInterval(state.timer);
        
        // 5초 후 대기실로 자동 복귀
        setTimeout(() => {
            if (!rooms[roomName]) return; // 그 사이 방 폭파 시 예외처리
            state.gameStarted = false;
            state.round = 1;
            state.turnIndex = 0;
            state.players.forEach(p => {
                p.ready = false;
                p.start = false;
                for(let key in p.scores) p.scores[key] = null;
            });
            io.to(roomName).emit('updateLobby', state.players);
        }, 5000);

    } else {
        io.to(roomName).emit('updateGameState', getClientState(state));
        startTimer(roomName); // 턴 넘어갈 때 타이머 리셋
    }
}

// 120초 타이머 시작 로직
function startTimer(roomName) {
    const state = rooms[roomName];
    if (!state) return;

    if (state.timer) clearInterval(state.timer);
    state.timeLeft = 120; // 30을 120으로 변경
    io.to(roomName).emit('timerUpdate', state.timeLeft);

    state.timer = setInterval(() => {
        state.timeLeft--;
        io.to(roomName).emit('timerUpdate', state.timeLeft);

        if (state.timeLeft <= 0) {
            // 시간 초과: 첫 번째 빈 칸에 강제 점수 기록
            const currentPlayer = state.players[state.turnIndex];
            const emptyCategory = Object.keys(currentPlayer.scores).find(k => currentPlayer.scores[k] === null);
            
            if (emptyCategory) {
                currentPlayer.scores[emptyCategory] = calculateScore(emptyCategory, state.dice);
            }
            
            nextTurn(roomName);
        }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ name, room }) => {
        const roomNum = parseInt(room);
        if (roomNum < 1 || roomNum > 9) {
            socket.emit('errorMsg', '방 번호는 1부터 9까지 가능합니다.');
            return;
        }

        if (!rooms[room]) {
            rooms[room] = {
                players: [],
                turnIndex: 0,
                dice: [1, 1, 1, 1, 1],
                keep: [false, false, false, false, false],
                rollsLeft: 3,
                round: 1,
                gameStarted: false,
                timer: null,
                timeLeft: 120 // 30을 120으로 변경
            };
        }

        if (rooms[room].players.length >= 2) {
            socket.emit('errorMsg', '방이 가득 찼습니다.');
            return;
        }

        const player = {
            id: socket.id,
            name: name,
            ready: false,
            start: false,
            scores: {
                ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
                choice: null, fourOfAKind: null, fullHouse: null, smallStraight: null, largeStraight: null, yacht: null
            }
        };

        rooms[room].players.push(player);
        socket.join(room);
        socket.room = room;

        io.to(room).emit('updateLobby', rooms[room].players);
    });

    socket.on('toggleReady', () => {
        const room = socket.room;
        if (!room || !rooms[room]) return;
        
        const player = rooms[room].players.find(p => p.id === socket.id);
        if (player) {
            player.ready = !player.ready;
            io.to(room).emit('updateLobby', rooms[room].players);
        }
    });

    socket.on('toggleStart', () => {
        const room = socket.room;
        if (!room || !rooms[room]) return;

        const player = rooms[room].players.find(p => p.id === socket.id);
        if (player && rooms[room].players.every(p => p.ready)) {
            player.start = true;
            io.to(room).emit('updateLobby', rooms[room].players);

            if (rooms[room].players.length === 2 && rooms[room].players.every(p => p.start)) {
                rooms[room].gameStarted = true;
                rooms[room].dice = rooms[room].dice.map(() => Math.floor(Math.random() * 6) + 1);
                io.to(room).emit('gameStarted', getClientState(rooms[room]));
                startTimer(room); // 게임 시작 시 타이머 가동
            }
        }
    });

    socket.on('rollDice', () => {
        const room = socket.room;
        if (!room || !rooms[room] || !rooms[room].gameStarted) return;
        
        const state = rooms[room];
        const currentPlayer = state.players[state.turnIndex];

        if (currentPlayer.id !== socket.id) return;
        if (state.rollsLeft <= 0) return;

        state.dice = state.dice.map((d, i) => state.keep[i] ? d : Math.floor(Math.random() * 6) + 1);
        state.rollsLeft--;

        io.to(room).emit('updateGameState', getClientState(state));
    });

    socket.on('toggleKeep', (index) => {
        const room = socket.room;
        if (!room || !rooms[room] || !rooms[room].gameStarted) return;

        const state = rooms[room];
        const currentPlayer = state.players[state.turnIndex];

        if (currentPlayer.id !== socket.id) return;
        if (state.rollsLeft === 3) return; 

        state.keep[index] = !state.keep[index];
        io.to(room).emit('updateGameState', getClientState(state));
    });

    socket.on('submitScore', (category) => {
        const room = socket.room;
        if (!room || !rooms[room] || !rooms[room].gameStarted) return;

        const state = rooms[room];
        const currentPlayer = state.players[state.turnIndex];

        if (currentPlayer.id !== socket.id) return;
        if (state.rollsLeft === 3) return; 
        if (currentPlayer.scores[category] !== null) return; 

        currentPlayer.scores[category] = calculateScore(category, state.dice);
        
        nextTurn(room); // 턴 넘기기
    });

    socket.on('disconnect', () => {
        const room = socket.room;
        if (room && rooms[room]) {
            if (rooms[room].timer) clearInterval(rooms[room].timer);
            rooms[room].players = rooms[room].players.filter(p => p.id !== socket.id);
            if (rooms[room].players.length === 0) {
                delete rooms[room];
            } else {
                io.to(room).emit('playerDisconnected');
                delete rooms[room];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
