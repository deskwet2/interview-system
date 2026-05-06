const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/examiner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'examiner.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    socket.on('join_interview', (candidateName) => {
        socket.join(candidateName); 
        // Notify all examiners a new student is online
        io.emit('candidate_online', { name: candidateName, id: socket.id });
    });

    socket.on('typing', (candidateName) => {
        io.emit('is_typing', candidateName);
    });

    // NEW: Listen for when a candidate submits a task
    socket.on('task_submitted', (data) => {
        io.emit('notify_submission', data); 
    });

    socket.on('trigger_screen', (data) => {
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