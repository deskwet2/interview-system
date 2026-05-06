const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Logic for when someone connects
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // 1. Candidate Joins a specific "Room" based on their ID
    socket.on('join_interview', (candidateName) => {
        socket.join(candidateName); 
        console.log(`${candidateName} has joined the interview room.`);
        
        // Notify the examiner (we'll build the examiner side next)
        io.emit('candidate_online', { name: candidateName, id: socket.id });
    });

    // 2. Listen for Candidate Typing
    socket.on('typing', (candidateName) => {
        io.emit('is_typing', candidateName);
    });

    socket.on('trigger_screen', (data) => {
        console.log(`Sending ${data.screenData} to ${data.candidateId}`);
        // This sends the command ONLY to the room named after the candidate
        io.to(data.candidateId).emit('new_task', data.screenData);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is live on port ${PORT}`);
});