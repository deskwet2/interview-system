const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- ROUTES ---

// 1. Home Route (Candidate Portal)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Examiner Route (Clean URL: /examiner)
app.get('/examiner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'examiner.html'));
});

// 3. Serve Static Files (CSS, JS, Images, Sounds)
app.use(express.static(path.join(__dirname, 'public')));


// --- REAL-TIME LOGIC ---
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // Candidate joins a specific room
    socket.on('join_interview', (candidateName) => {
        socket.join(candidateName); 
        console.log(`${candidateName} has joined the interview room.`);
        
        // Notify the examiner
        io.emit('candidate_online', { name: candidateName, id: socket.id });
    });

    // Handle typing notifications
    socket.on('typing', (candidateName) => {
        io.emit('is_typing', candidateName);
    });

    // Examiner directs the candidate
    socket.on('trigger_screen', (data) => {
        console.log(`Sending ${data.screenData} to ${data.candidateId}`);
        // Send command ONLY to the specific candidate's room
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