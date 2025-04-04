import { Server } from 'socket.io'
import { createServer } from 'http'
import express from 'express'

const app = express();
const httpServer = createServer(app)

// Configure Socket.IO with proper CORS for remote connections
const io = new Server(httpServer, {
  cors: {
    origin: "*", // In production, limit this to your domain
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: true
  },
  // Configure transport options
  transports: ['polling', 'websocket'],
  allowEIO3: true, // For compatibility
  pingTimeout: 60000,
  pingInterval: 25000
});

const gameState = {
  rooms: {},
  players: {}
}

// Ball types definition
const BALL_TYPES = {
  CUE: 0,
  SOLID: [1, 2, 3, 4, 5, 6, 7],
  EIGHT: 8,
  STRIPED: [9, 10, 11, 12, 13, 14, 15]
};

// Initialize room game state
const createRoomGameState = () => ({
  players: [],
  currentTurn: null,
  scores: [0, 0], 
  ballsInHole: [],
  playerTypes: [null, null],
  gameWinner: null,
  phase: 'lobby', // 'lobby', 'playing', 'gameOver'
});

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id)

  // Updated joinGame handler for lobby system
  socket.on('joinGame', (data) => {
    const { playerName, roomId } = data;
    console.log(`Player ${playerName} (${socket.id}) is attempting to join a game.`)
    
    // Initialize player in our state
    gameState.players[socket.id] = {
      id: socket.id,
      name: playerName,
      room: null,
      isReady: false
    };
    
    let joinedRoom = false;
    let finalRoomId = roomId;
    
    // If a specific room was requested via invite
    if (roomId && gameState.rooms[roomId]) {
      const room = gameState.rooms[roomId];
      if (room.players.length < 2) {
        room.players.push({
          id: socket.id,
          name: playerName,
          isReady: false
        });
        socket.join(roomId);
        gameState.players[socket.id].room = roomId;
        joinedRoom = true;
        console.log(`Player ${playerName} (${socket.id}) joined room ${roomId} via invite.`);
      } else {
        console.log(`Room ${roomId} is full, can't join via invite.`);
        // Room is full, try to find or create another
      }
    }
    
    // Find available room or create new one
    if (!joinedRoom) {
      for (const [existingRoomId, room] of Object.entries(gameState.rooms)) {
        if (room.phase === 'lobby' && room.players.length < 2) {
          room.players.push({
            id: socket.id,
            name: playerName,
            isReady: false
          });
          socket.join(existingRoomId);
          gameState.players[socket.id].room = existingRoomId;
          joinedRoom = true;
          finalRoomId = existingRoomId;
          console.log(`Player ${playerName} (${socket.id}) joined room ${existingRoomId}.`);
          break;
        }
      }
    }

    // Create new room if needed
    if (!joinedRoom) {
      finalRoomId = `room_${Date.now()}`;
      gameState.rooms[finalRoomId] = {
        ...createRoomGameState(),
        players: [{
          id: socket.id,
          name: playerName,
          isReady: false
        }],
        currentTurn: socket.id
      };
      socket.join(finalRoomId);
      gameState.players[socket.id].room = finalRoomId;
      console.log(`Player ${playerName} (${socket.id}) created and joined new room ${finalRoomId}.`);
    }

    // Notify all clients in room about player changes
    io.to(finalRoomId).emit('roomJoined', {
      room: finalRoomId,
      players: gameState.rooms[finalRoomId].players
    });
  });

  // Handle player ready status
  socket.on('playerReady', ({ isReady }) => {
    const roomId = gameState.players[socket.id]?.room;
    if (!roomId) return;
    
    const room = gameState.rooms[roomId];
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    
    if (playerIndex !== -1) {
      room.players[playerIndex].isReady = isReady;
      
      // Check if all players are ready and there are 2 players
      const allReady = room.players.length === 2 && room.players.every(p => p.isReady);
      
      // Notify all clients about player status change
      io.to(roomId).emit('playerReadyUpdate', {
        players: room.players,
        allReady
      });
      
      // If all players ready, start game after a short delay
      if (allReady) {
        setTimeout(() => {
          room.phase = 'playing';
          io.to(roomId).emit('gameStart', { 
            players: room.players
          });
        }, 3000);
      }
    }
  });

  // Request rematch after game over
  socket.on('requestRematch', () => {
    const roomId = gameState.players[socket.id]?.room;
    if (!roomId) return;
    
    const room = gameState.rooms[roomId];
    if (room.phase === 'gameOver') {
      // Reset the room to lobby phase
      room.phase = 'lobby';
      room.scores = [0, 0];
      room.ballsInHole = [];
      room.playerTypes = [null, null];
      room.gameWinner = null;
      
      // Reset player ready status
      room.players.forEach(player => {
        player.isReady = false;
      });
      
      // Switch starting player for fairness
      room.currentTurn = room.players.find(p => p.id !== room.currentTurn).id;
      
      // Notify clients of lobby state
      io.to(roomId).emit('roomJoined', {
        room: roomId,
        players: room.players
      });
    }
  });

  socket.on('shot', (data) => {
    const room = gameState.players[socket.id]?.room;
    if (room) {
      console.log(`Player ${socket.id} shot with force ${data.force} in room ${room}.`);
      socket.to(room).emit('playerShot', {
        playerId: socket.id,
        force: data.force
      });
      
      // Update turn on the server side too
      const roomState = gameState.rooms[room];
      const otherPlayerId = roomState.players.find(p => p.id !== socket.id)?.id;
      roomState.currentTurn = otherPlayerId;
    } else {
      console.log(`Player ${socket.id} attempted to shoot but is not in a room.`);
    }
  });

  // Ball position reporting
  socket.on('ballPosition', (data) => {
    const { ballNumber, position } = data;
    const room = gameState.players[socket.id]?.room;
    
    if (!room) return;
    
    const roomState = gameState.rooms[room];
    
    // Check if this is a ball in a hole (y position below threshold)
    if (position.y < 3.7 && !roomState.ballsInHole.includes(ballNumber)) {
      console.log(`Ball ${ballNumber} fell in a hole in room ${room}`);
      
      // Add to tracked balls in hole
      roomState.ballsInHole.push(ballNumber);
      
      // Score logic
      const playerIndex = roomState.players.findIndex(p => p.id === socket.id);
      let scoreUpdated = false;
      
      // Handle the first scoring ball - determines player types
      if (roomState.playerTypes[0] === null && ballNumber !== 0 && ballNumber !== 8) {
        if (BALL_TYPES.SOLID.includes(ballNumber)) {
          roomState.playerTypes[playerIndex] = 'solid';
          roomState.playerTypes[1 - playerIndex] = 'striped';
        } else if (BALL_TYPES.STRIPED.includes(ballNumber)) {
          roomState.playerTypes[playerIndex] = 'striped';
          roomState.playerTypes[1 - playerIndex] = 'solid';
        }
        
        // Update scores for this first ball
        roomState.scores[playerIndex]++;
        scoreUpdated = true;
        
        console.log(`Player types assigned! Player ${playerIndex}: ${roomState.playerTypes[playerIndex]}, Player ${1-playerIndex}: ${roomState.playerTypes[1-playerIndex]}`);
      }
      // Score points based on ball type and player type
      else if (ballNumber !== 0 && ballNumber !== 8) {
        const isSolid = BALL_TYPES.SOLID.includes(ballNumber);
        const playerType = roomState.playerTypes[playerIndex];
        
        if ((isSolid && playerType === 'solid') || (!isSolid && playerType === 'striped')) {
          roomState.scores[playerIndex]++;
          scoreUpdated = true;
        } else {
          // Other player gets points for opponent potting wrong ball
          roomState.scores[1 - playerIndex]++; 
          scoreUpdated = true;
        }
      }
      else if (ballNumber === 8) {
        // Handle 8 ball logic - win or lose depending on if all your balls are potted
        const playerType = roomState.playerTypes[playerIndex];
        const playerBalls = playerType === 'solid' ? BALL_TYPES.SOLID : BALL_TYPES.STRIPED;
        
        // Check if all player's balls are in holes
        const allPlayerBallsPotted = playerBalls.every(ball => roomState.ballsInHole.includes(ball));
        
        if (allPlayerBallsPotted) {
          // Win!
          roomState.gameWinner = playerIndex;
          roomState.phase = 'gameOver';
          console.log(`Player ${playerIndex} won by potting the 8 ball!`);
        } else {
          // Lose - potted 8 ball too early
          roomState.gameWinner = 1 - playerIndex;
          roomState.phase = 'gameOver';
          console.log(`Player ${playerIndex} lost by potting the 8 ball too early!`);
        }
        
        io.to(room).emit('gameOver', {
          winner: roomState.gameWinner,
          finalScores: roomState.scores
        });
      }
      else if (ballNumber === 0) {
        // Handle cue ball potted - no penalty points
        console.log(`Cue ball potted by player ${playerIndex} in room ${room}`);
        
        // Add cue ball to holes temporarily
        roomState.ballsInHole.push(ballNumber);
        
        // Broadcast the ball in hole to update client state
        io.to(room).emit('ballInHole', {
          ballNumber,
          ballsInHole: roomState.ballsInHole
        });
        
        // Respawn the cue ball after a short delay
        setTimeout(() => {
          // Remove cue ball from holes list
          roomState.ballsInHole = roomState.ballsInHole.filter(b => b !== 0);
          
          // Broadcast respawn event to all clients in the room
          io.to(room).emit('respawnCueBall');
          
          console.log("Respawned cue ball in room:", room);
        }, 2000);
        
        scoreUpdated = true;
      }
      
      // Broadcast updated game state
      if (scoreUpdated) {
        io.to(room).emit('scoreUpdate', {
          scores: roomState.scores,
          playerTypes: roomState.playerTypes,
          ballsInHole: roomState.ballsInHole
        });
      }
    }
  });

  // Physics snapshot handling
  socket.on('physicsSnapshot', (snapshot) => {
    const room = gameState.players[socket.id]?.room;
    if (!room) return;
    
    // Throttle snapshots
    const now = Date.now();
    if (!socket.lastPhysicsUpdate || (now - socket.lastPhysicsUpdate > 50)) {
      socket.lastPhysicsUpdate = now;
      
      // Broadcast physics snapshot to other clients in the room
      socket.to(room).emit('physicsSnapshot', snapshot);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`)
    const roomId = gameState.players[socket.id]?.room;
    
    if (roomId && gameState.rooms[roomId]) {
      console.log(`Player ${socket.id} left room ${roomId}.`);
      
      // Remove player from room
      const room = gameState.rooms[roomId];
      room.players = room.players.filter(p => p.id !== socket.id);
      
      if (room.players.length === 0) {
        console.log(`Room ${roomId} is now empty and has been deleted.`);
        delete gameState.rooms[roomId];
      } else {
        // Notify remaining player
        io.to(roomId).emit('playerLeft', {
          players: room.players
        });
      }
    }
    
    delete gameState.players[socket.id];
  });
});

httpServer.listen(3000, () => {
  console.log('Server running on port 3000')
});