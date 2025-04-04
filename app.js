import { Server } from 'socket.io'
import { createServer } from 'http'
import express from 'express'

const app = express();

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173", // Your Vite dev server
    methods: ["GET", "POST"]
  }
})

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
  scores: [0, 0], // [player1Score, player2Score]
  ballsInHole: [],
  playerTypes: [null, null], // [player1Type, player2Type] - 'solid' or 'striped'
  gameWinner: null
});

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id)

  socket.on('joinGame', (playerName) => {
    console.log(`Player ${playerName} (${socket.id}) is attempting to join a game.`)
    gameState.players[socket.id] = {
      id: socket.id,
      name: playerName,
      room: null
    }
    
    // Find available room or create new one
    let joinedRoom = false
    for (const [roomId, room] of Object.entries(gameState.rooms)) {
      if (room.players.length < 2) {
        room.players.push(socket.id)
        socket.join(roomId)
        gameState.players[socket.id].room = roomId
        joinedRoom = true
        console.log(`Player ${playerName} (${socket.id}) joined room ${roomId}.`)

        if (room.players.length === 2) {
          console.log(`Room ${roomId} is now full. Starting game.`)
          io.to(roomId).emit('gameStart', {
            players: room.players.map(id => gameState.players[id])
          })
        }
        break
      }
    }

    if (!joinedRoom) {
      const roomId = `room_${Date.now()}`
      gameState.rooms[roomId] = {
        ...createRoomGameState(),
        players: [socket.id],
        currentTurn: socket.id
      }
      socket.join(roomId)
      gameState.players[socket.id].room = roomId
      console.log(`Player ${playerName} (${socket.id}) created and joined new room ${roomId}.`)
    }

    // Log the room the player is in after joining
    const playerRoom = gameState.players[socket.id]?.room
    console.log(`Player ${playerName} (${socket.id}) is now in room: ${playerRoom}`)
  })

  socket.on('shot', (data) => {
    const room = gameState.players[socket.id]?.room
    if (room) {
      console.log(`Player ${socket.id} shot with force ${data.force} in room ${room}.`)
      socket.to(room).emit('playerShot', {
        playerId: socket.id,
        force: data.force
      })
      
      // Update turn on the server side too
      const roomState = gameState.rooms[room];
      const otherPlayerId = roomState.players.find(id => id !== socket.id);
      roomState.currentTurn = otherPlayerId;
    } else {
      console.log(`Player ${socket.id} attempted to shoot but is not in a room.`)
    }
  })

  // New event for ball position reporting
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
      const playerIndex = roomState.players.findIndex(id => id === socket.id);
      let scoreUpdated = false;
      
      // Handle the first scoring ball - determines player types
      if (roomState.playerTypes[0] === null && ballNumber !== 0 && ballNumber !== 8) {
        if (BALL_TYPES.SOLID.includes(ballNumber)) {
          roomState.playerTypes[playerIndex] = 'solid';
          roomState.playerTypes[1 - playerIndex] = 'striped'; // Other player gets opposite
        } else if (BALL_TYPES.STRIPED.includes(ballNumber)) {
          roomState.playerTypes[playerIndex] = 'striped';
          roomState.playerTypes[1 - playerIndex] = 'solid'; // Other player gets opposite
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
          console.log(`Player ${playerIndex} won by potting the 8 ball!`);
        } else {
          // Lose - potted 8 ball too early
          roomState.gameWinner = 1 - playerIndex; 
          console.log(`Player ${playerIndex} lost by potting the 8 ball too early!`);
        }
        
        io.to(room).emit('gameOver', {
          winner: roomState.gameWinner,
          finalScores: roomState.scores
        });
      }
      else if (ballNumber === 0) {
        // Handle cue ball potted - NO penalty points now
        console.log(`Cue ball potted by player ${playerIndex} in room ${room}`);
        
        // Add cue ball to holes temporarily (without scoring points)
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
        }, 2000); // 2 second delay before respawning
        
        // Turn still goes to the opponent but no penalty point
        // We'll update the game state but not increment scores
        scoreUpdated = true; // Still need to broadcast updated state
      }
      
      // Broadcast updated game state to all players in the room
      if (scoreUpdated) {
        io.to(room).emit('scoreUpdate', {
          scores: roomState.scores,
          playerTypes: roomState.playerTypes,
          ballsInHole: roomState.ballsInHole
        });
      }
    }
  });

  // Add a throttle for physics snapshots to reduce network traffic
  const lastPhysicsUpdate = {};

  socket.on('physicsSnapshot', (snapshot) => {
    const room = gameState.players[socket.id]?.room;
    if (!room) return;
    
    // Throttle snapshots from each client
    const now = Date.now();
    if (!lastPhysicsUpdate[socket.id] || (now - lastPhysicsUpdate[socket.id] > 50)) {
      lastPhysicsUpdate[socket.id] = now;
      
      // Broadcast physics snapshot to other clients in the room
      socket.to(room).emit('physicsSnapshot', snapshot);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`)
    const room = gameState.players[socket.id]?.room
    if (room) {
      console.log(`Player ${socket.id} left room ${room}.`)
      gameState.rooms[room].players = gameState.rooms[room].players.filter(id => id !== socket.id)
      if (gameState.rooms[room].players.length === 0) {
        console.log(`Room ${room} is now empty and has been deleted.`)
        delete gameState.rooms[room]
      } else {
        io.to(room).emit('playerLeft', socket.id)
      }
    }
    delete gameState.players[socket.id]
  })
})

httpServer.listen(3000, () => {
  console.log('Server running on port 3000')
})