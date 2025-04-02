import express from 'express'
import { Server } from 'socket.io'
import { createServer } from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const httpsServer = createServer({
  key: fs.readFileSync(path.join(__dirname, '../certificates/private.key')),
  cert: fs.readFileSync(path.join(__dirname, '../certificates/certificate.crt'))
}, app)

const io = new Server(httpsServer, {
  cors: {
    origin: "https://localhost:5173", // Your Vite dev server
    methods: ["GET", "POST"],
    credentials: true
  }
})

const gameState = {
  rooms: {},
  players: {}
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id)

  socket.on('joinGame', (playerName) => {
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
        
        if (room.players.length === 2) {
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
    }
  })

  socket.on('shot', (data) => {
    const room = gameState.players[socket.id]?.room
    if (room) {
      socket.to(room).emit('playerShot', {
        playerId: socket.id,
        force: data.force
      })
    }
  })

  socket.on('disconnect', () => {
    const room = gameState.players[socket.id]?.room
    if (room) {
      gameState.rooms[room].players = gameState.rooms[room].players.filter(id => id !== socket.id)
      if (gameState.rooms[room].players.length === 0) {
        delete gameState.rooms[room]
      } else {
        io.to(room).emit('playerLeft', socket.id)
      }
    }
    delete gameState.players[socket.id]
  })
})

httpsServer.listen(3000, () => {
    console.log('Secure server running on port 3000')
  })