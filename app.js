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
        players: [socket.id],
        currentTurn: socket.id
      }
      socket.join(roomId)
      gameState.players[socket.id].room = roomId
      console.log(`Player ${playerName} (${socket.id}) created and joined new room ${roomId}.`)
    }
  })

  socket.on('shot', (data) => {
    const room = gameState.players[socket.id]?.room
    if (room) {
      console.log(`Player ${socket.id} shot with force ${data.force} in room ${room}.`)
      socket.to(room).emit('playerShot', {
        playerId: socket.id,
        force: data.force
      })
    } else {
      console.log(`Player ${socket.id} attempted to shoot but is not in a room.`)
    }
  })

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