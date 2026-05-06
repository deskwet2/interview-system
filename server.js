const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static file hosting
app.use(express.static(path.join(__dirname, 'public')));

// Mock JSON database for screens
const screenDatabase = [
    { name: "Welcome Screen", category: "general", type: "info", isDefault: true },
    { name: "Personal Bio Form", category: "general", type: "form" },
    { name: "Upload CV", category: "general", type: "file" },
    { name: "Specialty CD Form", category: "banking", type: "form", isDefault: true },
    { name: "Affidavit Signature", category: "banking", type: "file" },
    { name: "Account Opening", category: "banking", type: "form" },
    { name: "Data Analysis Task", category: "data", type: "form", isDefault: true },
    { name: "System Logic Test", category: "data", type: "form" },
    { name: "Upload Report", category: "data", type: "file" }
];

io.on('connection', (socket) => {
    
    // Handle candidate joining
    socket.on('join_interview', (data) => {
        const { name, category } = data;
        
        // We use the candidate's name as a room name for targeted communication
        socket.join(name); 
        
        // 1. Find default screen for this category
        const defaultScreen = screenDatabase.find(s => s.category === category && s.isDefault);
        
        // 2. Notify examiner with full details (including the unique socket.id)
        io.emit('candidate_online', { name, category, id: socket.id });

        // 3. Auto-trigger default screen for candidate immediately
        if (defaultScreen) {
            socket.emit('new_task', { 
                taskName: defaultScreen.name, 
                type: defaultScreen.type 
            });
        }
    });

    // Examiner manually triggers a specific screen
    socket.on('trigger_screen', (data) => {
        // data.candidateId is the socket ID; data.screenData is the task name
        const screenInfo = screenDatabase.find(s => s.name === data.screenData);
        
        io.to(data.candidateId).emit('new_task', { 
            taskName: data.screenData,
            type: screenInfo ? screenInfo.type : 'info' 
        });
    });

    // Notify candidate of wrong answer (triggers shake effect and alert)
    socket.on('mark_wrong', (data) => {
        io.to(data.candidateId).emit('wrong_answer', { 
            message: "Your last submission was incorrect. Please review and try again." 
        });
    });

    // Forward candidate submissions to the examiner
    socket.on('task_submitted', (data) => {
        io.emit('notify_submission', data); 
    });

    // Real-time typing/interaction status
    socket.on('typing', (name) => {
        io.emit('is_typing', name);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`--- Bank Interview System Live ---`);
    console.log(`Server running on port ${PORT}`);
});