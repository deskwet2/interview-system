const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// This tells Node to show people the files in the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// The Real-Time Logic
io.on('connection', (socket) => {
    console.log('Someone connected!');

    socket.on('disconnect', () => {
        console.log('Someone left.');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`System is running on port ${PORT}`);
});